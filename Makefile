UUID    := docker-monitor@vasapolin
DOMAIN  := docker-monitor
BUILD   := build/$(UUID)
ZIP     := build/$(UUID).shell-extension.zip
MSGFMT  ?= msgfmt
LINGUAS := $(shell cat po/LINGUAS)
SOURCES := $(shell find src -type f)

.PHONY: all pack install uninstall pot clean

all: pack

$(ZIP): $(SOURCES) $(wildcard po/*.po)
	rm -rf $(BUILD)
	mkdir -p $(BUILD)
	cp -r src/. $(BUILD)/
	for lang in $(LINGUAS); do \
		mkdir -p $(BUILD)/locale/$$lang/LC_MESSAGES; \
		$(MSGFMT) -o $(BUILD)/locale/$$lang/LC_MESSAGES/$(DOMAIN).mo po/$$lang.po; \
	done
	gnome-extensions pack $(BUILD) --force --out-dir=build \
		--extra-source=icons --extra-source=locale

pack: $(ZIP)

install: $(ZIP)
	gnome-extensions install --force $(ZIP)
	@echo "Installed. Log out and back in, then run: gnome-extensions enable $(UUID)"

uninstall:
	gnome-extensions uninstall $(UUID)

pot:
	xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --keyword=ngettext:1,2 \
		--package-name=$(DOMAIN) --output=po/$(DOMAIN).pot src/extension.js
	for lang in $(LINGUAS); do msgmerge --update --backup=none po/$$lang.po po/$(DOMAIN).pot; done

clean:
	rm -rf build
