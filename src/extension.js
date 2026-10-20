import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {Extension, gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

// Docker is only queried while the menu is open: the panel shows just the icon
const REFRESH_INTERVAL_S = 5;
const NAME_MAX = 40;
const NO_PROJECT = Symbol('no-project');
const DISK_KEY = Symbol('disk');
const CORES = GLib.get_num_processors();

const UNITS = {
    B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12,
    KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4,
};

// Translated lazily: gettext only works once the extension is loaded
function diskType(type) {
    switch (type) {
    case 'Images':
        return [_('Images'), _('templates that containers are created from')];
    case 'Containers':
        return [_('Containers'), _('files written inside them; reclaimable = stopped containers')];
    case 'Local Volumes':
        return [_('Volumes'), _('persistent data, such as databases')];
    case 'Build Cache':
        return [_('Build cache'), _('speeds up rebuilds, safe to delete')];
    default:
        return [type, ''];
    }
}

async function run(argv, cancellable) {
    const proc = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);
    if (!proc.get_successful())
        throw new Error(stderr.trim() || `${argv.join(' ')} failed`);
    return stdout.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function parseBytes(s) {
    const m = /^([\d.]+)\s*([A-Za-z]+)/.exec(s.trim());
    return m ? parseFloat(m[1]) * (UNITS[m[2]] ?? 1) : 0;
}

function fmtBytes(b) {
    if (b >= 1024 ** 3)
        return `${(b / 1024 ** 3).toFixed(1)} GB`;
    if (b >= 1024 ** 2)
        return `${Math.round(b / 1024 ** 2)} MB`;
    return b > 0 ? `${Math.round(b / 1024)} KB` : '0';
}

// Docker reports CPU as % of one core; shown here as % of the whole processor
function fmtCpu(c) {
    const p = c / CORES;
    return `${p.toFixed(p < 10 ? 1 : 0)}%`;
}

const truncate = s => s.length > NAME_MAX ? `${s.slice(0, NAME_MAX - 1)}…` : s;

function projectOf(labels) {
    const m = /(?:^|,)com\.docker\.compose\.project=([^,]+)/.exec(labels ?? '');
    return m ? m[1] : NO_PROJECT;
}

function label(text, styleClass = '', expand = false) {
    return new St.Label({
        text,
        x_expand: expand,
        y_align: Clutter.ActorAlign.CENTER,
        style_class: styleClass,
    });
}

// Data row: main text (with optional explanation below) and numeric columns on the right
function infoRow(text, cols = [], {styleClass = '', sub = '', arrow = false} = {}) {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    // GNOME dims non-clickable items; these hold data, so keep the normal color
    item.remove_style_class_name('popup-inactive-menu-item');
    item.remove_style_pseudo_class('insensitive');
    item.syncSensitive = () => false;

    const left = new St.BoxLayout({vertical: true, x_expand: true});
    left.add_child(label(text, `docker-monitor-name ${styleClass}`));
    if (sub) {
        item._sub = label(sub, 'docker-monitor-hint');
        left.add_child(item._sub);
    }
    item.add_child(left);
    for (const c of cols)
        item.add_child(label(c, `docker-monitor-num ${styleClass}`));
    // Takes the place of the ▸ arrow so columns line up with expandable rows
    if (arrow)
        item.add_child(new St.Widget({style_class: 'docker-monitor-arrow-space'}));
    return item;
}

function hintRow(text) {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    const l = label(text, 'docker-monitor-hint', true);
    l.clutter_text.line_wrap = true;
    item.add_child(l);
    item._label = l;
    return item;
}

// Row that expands on click, with numeric columns before the arrow
function expandable(key, text, cols, styleClass = '') {
    const sub = new PopupMenu.PopupSubMenuMenuItem(text);
    sub._key = key;
    sub.label.x_expand = true;
    if (styleClass)
        sub.label.add_style_class_name(styleClass);
    for (const c of cols)
        sub.insert_child_below(label(c, 'docker-monitor-num'), sub._triangleBin);
    return sub;
}

const DockerIndicator = GObject.registerClass(
class DockerIndicator extends PanelMenu.Button {
    _init(iconPath) {
        super._init(0.5, _('Docker Monitor'));

        this.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(iconPath),
            style_class: 'system-status-icon',
        }));

        this._cancellable = new Gio.Cancellable();
        this._busy = false;
        this._timerId = 0;
        this._expanded = new Set();

        this.menu.box.add_style_class_name('docker-monitor-menu');

        this._title = infoRow('Docker', [], {styleClass: 'docker-monitor-title', sub: _('Loading…')});
        this.menu.addMenuItem(this._title);

        this._summary = this._addSection(_('Total usage'));
        this._alerts = this._addSection(_('Needs attention'));
        this._projects = this._addSection(_('Containers by project'));
        this._disk = this._addSection(_('Disk space'));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._updated = hintRow('');
        this.menu.addMenuItem(this._updated);

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._refresh();
                this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_INTERVAL_S, () => {
                    this._refresh();
                    return GLib.SOURCE_CONTINUE;
                });
            } else {
                this._stopTimer();
            }
        });
    }

    _addSection(title) {
        const separator = new PopupMenu.PopupSeparatorMenuItem(title);
        const section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(separator);
        this.menu.addMenuItem(section);
        section._separator = separator;
        return section;
    }

    _stopTimer() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
    }

    async _refresh() {
        if (this._busy)
            return;
        this._busy = true;
        try {
            const [stats, ps, df] = await Promise.all([
                run(['docker', 'stats', '--no-stream', '--format', '{{json .}}'], this._cancellable),
                run(['docker', 'ps', '--format', '{{json .}}'], this._cancellable),
                run(['docker', 'system', 'df', '--format', '{{json .}}'], this._cancellable),
            ]);
            this._render(stats, ps, df);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._renderError(e);
        } finally {
            this._busy = false;
        }
    }

    _renderError(e) {
        this._title._sub.text = _('Docker is not responding');
        for (const s of [this._summary, this._alerts, this._projects, this._disk]) {
            s.removeAll();
            s._separator.visible = false;
        }
        this._summary._separator.visible = true;
        this._summary.addMenuItem(hintRow(e.message.split('\n')[0]));
        this._summary.addMenuItem(hintRow(_('Check that the service is running: systemctl status docker')));
    }

    _render(stats, ps, df) {
        const info = new Map(ps.map(c => [c.Names, c]));
        const groups = new Map();
        const alerts = [];
        let totalCpu = 0, totalMem = 0, hostMem = 0;

        for (const s of stats) {
            const c = info.get(s.Name);
            const [used, limit] = s.MemUsage.split('/');
            const cpu = parseFloat(s.CPUPerc) || 0;
            const mem = parseBytes(used);
            hostMem = Math.max(hostMem, parseBytes(limit ?? ''));
            totalCpu += cpu;
            totalMem += mem;

            const warn = c && (c.State !== 'running' || /unhealthy/.test(c.Status));
            if (warn)
                alerts.push({name: s.Name, status: c.Status});

            const project = projectOf(c?.Labels);
            if (!groups.has(project))
                groups.set(project, {cpu: 0, mem: 0, warn: false, items: []});
            const g = groups.get(project);
            g.cpu += cpu;
            g.mem += mem;
            g.warn ||= warn;
            g.items.push({name: s.Name, cpu, mem, warn, status: c?.Status ?? ''});
        }

        // Title
        let subtitle = ngettext('%d container running', '%d containers running', stats.length)
            .format(stats.length);
        if (alerts.length) {
            subtitle += `  ·  ${ngettext('%d needs attention', '%d need attention', alerts.length)
                .format(alerts.length)}`;
        }
        this._title._sub.text = subtitle;

        // Total usage
        this._summary.removeAll();
        this._summary._separator.visible = true;
        this._summary.addMenuItem(infoRow(_('Processor'), [fmtCpu(totalCpu)], {
            sub: _('all containers combined, as a share of all %d cores').format(CORES),
        }));
        const memSub = hostMem
            ? _('of %s on this computer (%d%%)').format(fmtBytes(hostMem), Math.round(totalMem / hostMem * 100))
            : '';
        this._summary.addMenuItem(infoRow(_('Memory'), [fmtBytes(totalMem)], {sub: memSub}));

        // Alerts
        this._alerts.removeAll();
        this._alerts._separator.visible = alerts.length > 0;
        for (const a of alerts) {
            this._alerts.addMenuItem(infoRow(truncate(a.name), [], {
                styleClass: 'docker-monitor-warn',
                sub: _('%s  ·  check with: docker logs %s').format(a.status, a.name),
            }));
        }

        // Remember what was expanded so a refresh does not collapse it
        for (const section of [this._projects, this._disk]) {
            for (const item of section._getMenuItems()) {
                if (item._key && item.menu.isOpen)
                    this._expanded.add(item._key);
                else if (item._key)
                    this._expanded.delete(item._key);
            }
        }

        // Projects
        this._projects.removeAll();
        this._projects._separator.visible = true;
        this._projects.addMenuItem(infoRow('', [_('CPU'), _('RAM')],
            {styleClass: 'docker-monitor-hint', arrow: true}));

        const sorted = [...groups.entries()].sort((a, b) => b[1].mem - a[1].mem);
        for (const [project, g] of sorted) {
            const name = project === NO_PROJECT ? _('No Compose') : project;
            const count = ngettext('%d container', '%d containers', g.items.length).format(g.items.length);
            const sub = expandable(project, `${name}  ·  ${count}`,
                [fmtCpu(g.cpu), fmtBytes(g.mem)], g.warn ? 'docker-monitor-warn' : '');

            g.items.sort((a, b) => b.mem - a.mem);
            for (const c of g.items) {
                sub.menu.addMenuItem(infoRow(truncate(c.name), [fmtCpu(c.cpu), fmtBytes(c.mem)], {
                    styleClass: c.warn ? 'docker-monitor-warn' : '',
                    sub: c.warn ? c.status : '',
                    arrow: true,
                }));
            }
            this._projects.addMenuItem(sub);
            if (this._expanded.has(project))
                sub.setSubmenuShown(true);
        }
        this._projects.addMenuItem(hintRow(_('Click a project to see its containers.')));

        // Disk
        this._disk.removeAll();
        this._disk._separator.visible = true;
        this._disk.addMenuItem(infoRow('', [_('Size'), _('Reclaimable')],
            {styleClass: 'docker-monitor-hint', arrow: true}));
        let total = 0, reclaimable = 0;
        const rows = df.map(r => {
            const [name, desc] = diskType(r.Type);
            const size = parseBytes(r.Size), free = parseBytes(r.Reclaimable);
            total += size;
            reclaimable += free;
            return infoRow(_('%s  ·  %s of %s in use').format(name, r.Active, r.TotalCount),
                [fmtBytes(size), fmtBytes(free)], {sub: desc, arrow: true});
        });
        const disk = expandable(DISK_KEY, _('Total used by Docker'), [fmtBytes(total), fmtBytes(reclaimable)]);
        rows.forEach(r => disk.menu.addMenuItem(r));
        this._disk.addMenuItem(disk);
        if (this._expanded.has(DISK_KEY))
            disk.setSubmenuShown(true);
        this._disk.addMenuItem(hintRow(reclaimable > 0
            ? _('%s can be freed with: docker system prune. Click above for details.').format(fmtBytes(reclaimable))
            : _('Nothing to free: everything is in use. Click above for details.')));

        const now = GLib.DateTime.new_now_local().format('%X');
        this._updated._label.text = _('Updated at %s. Refreshes every %d s while this menu is open.')
            .format(now, REFRESH_INTERVAL_S);
    }

    destroy() {
        this._cancellable.cancel();
        this._stopTimer();
        super.destroy();
    }
});

export default class DockerMonitorExtension extends Extension {
    enable() {
        const iconPath = this.dir.get_child('icons').get_child('docker-monitor-symbolic.svg').get_path();
        this._indicator = new DockerIndicator(iconPath);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
