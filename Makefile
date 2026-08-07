PREFIX ?= /usr/share/cockpit
NAME = pilot
INSTALL_DIR = $(PREFIX)/$(NAME)
SYSCONF ?= /etc/$(NAME)
STATE ?= /var/lib/$(NAME)
LIBEXEC ?= /usr/libexec/$(NAME)
VERSION := $(shell cat VERSION)
TAG := v$(VERSION)
RELEASE_NOTES ?= Release $(VERSION)
export RELEASE_NOTES

ALPINE_URL = https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js
BOOTSTRAP_JS_URL = https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js
BOOTSTRAP_CSS_URL = https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css

FILES = manifest.json index.html VERSION Makefile README.md CHANGELOG.md LICENSE css js html libexec

.PHONY: all help version test install uninstall zip publish vendor clean

all: help

help:
	@echo "pilot plugin — version $(VERSION)"
	@echo "  make vendor     Fetch the third-party bundles into js/ and css/"
	@echo "  make install    Copy plugin to $(INSTALL_DIR) (use sudo)"
	@echo "  make uninstall  Remove plugin (use sudo)"
	@echo "  make test       Run unit tests"
	@echo "  make zip        Produce pilot-$(VERSION).zip"
	@echo "  make publish    Publish zip as GitHub release $(TAG)"
	@echo "  make version    Print current version"

version:
	@echo $(VERSION)

test:
	@node --test tests/unit/*.test.js

vendor:
	@command -v curl >/dev/null 2>&1 || { echo "curl not found"; exit 1; }
	install -d js css
	curl -fsSL "$(ALPINE_URL)" -o js/alpine.min.js
	curl -fsSL "$(BOOTSTRAP_JS_URL)" -o js/bootstrap.bundle.min.js
	curl -fsSL "$(BOOTSTRAP_CSS_URL)" -o css/bootstrap.min.css
	@echo "Vendored Alpine and Bootstrap"

install:
	@if [ "$$(id -u)" != "0" ]; then echo "install requires root (use sudo)"; exit 1; fi
	@if [ -d $(INSTALL_DIR) ]; then echo "Removing previous install"; rm -rf $(INSTALL_DIR); fi
	install -d $(INSTALL_DIR)
	@# The plugin is built incrementally, so html/ or libexec/ may not exist yet.
	@# A missing entry must not abort the install.
	@for f in $(FILES); do if [ -e "$$f" ]; then cp -r "$$f" $(INSTALL_DIR)/; fi; done
	@# FILES includes libexec/ and the recipe copies it wholesale, so a stale
	@# __pycache__ from a test run would otherwise ship 67 KB of bytecode into
	@# $(INSTALL_DIR) -- which is also what the self-updater installs over.
	@find $(INSTALL_DIR) -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
	@find $(INSTALL_DIR) -name '*.py[co]' -type f -delete 2>/dev/null || true
	install -d $(LIBEXEC)
	@if [ -f libexec/pilot-exec ]; then install -m 0755 libexec/pilot-exec $(LIBEXEC)/pilot-exec; fi
	install -d -m 0755 $(SYSCONF)
	install -d -m 0700 $(SYSCONF)/servers
	install -d -m 0750 $(STATE)/runs
	printf '%s\n' "$(VERSION)" > $(SYSCONF)/installed-version
	@echo "Installed pilot $(VERSION) to $(INSTALL_DIR)"
	@echo "Restart Cockpit with: systemctl try-restart cockpit"

uninstall:
	@if [ "$$(id -u)" != "0" ]; then echo "uninstall requires root (use sudo)"; exit 1; fi
	rm -rf $(INSTALL_DIR)
	rm -rf $(LIBEXEC)
	@echo "Removed $(INSTALL_DIR) and $(LIBEXEC)"
	@echo "Configuration in $(SYSCONF) was left in place — remove it manually if desired."

zip:
	@tmp=$$(mktemp -d); \
	mkdir "$$tmp/pilot"; \
	for f in $(FILES); do [ -e "$$f" ] && cp -r "$$f" "$$tmp/pilot/"; done; \
	find "$$tmp/pilot" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true; \
	find "$$tmp/pilot" -name '*.py[co]' -type f -delete 2>/dev/null || true; \
	(cd "$$tmp" && zip -rq "pilot-$(VERSION).zip" pilot); \
	mv "$$tmp/pilot-$(VERSION).zip" .; \
	rm -rf "$$tmp"; \
	echo "Wrote pilot-$(VERSION).zip"

publish: zip
	@command -v gh >/dev/null 2>&1 || { echo "gh CLI not found"; exit 1; }
	@gh auth status >/dev/null 2>&1 || { echo "gh not authenticated — run: gh auth login"; exit 1; }
	@notes="$$(mktemp)"; trap 'rm -f "$$notes"' EXIT; \
	printf '%s\n' "$$RELEASE_NOTES" > "$$notes"; \
	if gh release view "$(TAG)" >/dev/null 2>&1; then \
	  gh release upload "$(TAG)" "pilot-$(VERSION).zip" --clobber; \
	  gh release edit "$(TAG)" --notes-file "$$notes"; \
	else \
	  gh release create "$(TAG)" "pilot-$(VERSION).zip" --title "pilot $(VERSION)" --notes-file "$$notes"; \
	fi
	@rm -f "pilot-$(VERSION).zip"
	@echo "Published $(TAG)"

clean:
	rm -f pilot-*.zip
