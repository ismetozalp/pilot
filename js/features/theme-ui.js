// features/theme-ui.js — applying and persisting the theme. The ONLY file that
// touches the DOM for theming; js/core/themes.js stays pure.
//
// Persistence goes to the per-user settings file of spec 11.3
// (~/.config/cockpit/pilot/settings.json), through js/core/settings.js. That module
// belongs to another section and the contracts do not pin its method names, so this
// file DUCK-TYPES the store: read/write, load/save or get/set all work, and
// anything else degrades to in-memory-only instead of silently never persisting.
// Round 2 shipped a picker that demanded load()/save() from a store exposing
// read()/write(), so the theme was applied on every click and restored on none.
'use strict';
(function (root) {
    const Themes = root.PilotThemes ||
        (typeof require === 'function' ? require('../core/themes.js') : null);

    const ATTR = 'data-bs-theme';
    // The resolved attr cannot distinguish "system, currently dark" from "dark", so
    // the chosen id is recorded separately for anything that reads the DOM back.
    const ID_ATTR = 'data-pl-theme';

    const READERS = ['read', 'load', 'get'];
    const WRITERS = ['write', 'save', 'set'];

    function isPlainObject(v) {
        return !!v && typeof v === 'object' && !Array.isArray(v);
    }

    // ---------------------------------------------------------------- pure

    function themeFromSettings(settings) {
        const ui = isPlainObject(settings) && isPlainObject(settings.ui) ? settings.ui : null;
        const id = ui ? ui.theme : undefined;
        return Themes.isValid(id) ? id : Themes.DEFAULT_THEME;
    }

    // Non-mutating, and it preserves every sibling key — the same file carries the
    // self-update repo (spec 11.3), which a wholesale replacement would erase.
    function settingsWithTheme(settings, id) {
        const base = isPlainObject(settings) ? settings : {};
        const ui = isPlainObject(base.ui) ? base.ui : {};
        const safe = Themes.isValid(id) ? id : Themes.DEFAULT_THEME;
        return Object.assign({}, base, { ui: Object.assign({}, ui, { theme: safe }) });
    }

    // -> { read(): Promise<object>, write(obj): Promise<boolean> } or null.
    // Never rejects: a settings file that cannot be read or written must cost the
    // user persistence, not the ability to change theme.
    function adaptStore(store) {
        if (!isPlainObject(store)) return null;
        const r = READERS.find((n) => typeof store[n] === 'function');
        const w = WRITERS.find((n) => typeof store[n] === 'function');
        if (!r || !w) return null;
        return {
            read: function () {
                return Promise.resolve()
                    .then(() => store[r]())
                    .then((v) => (isPlainObject(v) ? v : {}))
                    .catch(() => ({}));
            },
            write: function (obj) {
                return Promise.resolve()
                    .then(() => store[w](obj))
                    .then(() => true)
                    .catch(() => false);
            }
        };
    }

    // ---------------------------------------------------------------- DOM

    function prefersDark(win) {
        const w = win || root;
        if (!w || typeof w.matchMedia !== 'function') return false;
        try {
            const mq = w.matchMedia('(prefers-color-scheme: dark)');
            return !!(mq && mq.matches);
        } catch (e) {
            return false;
        }
    }

    function apply(doc, id, dark) {
        const res = Themes.resolve(id, dark);
        const el = doc && doc.documentElement;
        if (el && typeof el.setAttribute === 'function') {
            el.setAttribute(ATTR, res.attr);
            el.setAttribute(ID_ATTR, Themes.isValid(id) ? id : Themes.DEFAULT_THEME);
        }
        return res;
    }

    // ---------------------------------------------------------------- component

    function pilotThemeUi() {
        return {
            theme: Themes.DEFAULT_THEME,
            themes: Themes.selectable(),
            // Overridable so the unit tests can drive a fake document and window
            // without a DOM; in the browser these are the real ones.
            _doc: root.document || null,
            _win: root,
            _store: null,

            async initTheme(store) {
                this._store = adaptStore(store);
                if (this._store) this.theme = themeFromSettings(await this._store.read());
                apply(this._doc, this.theme, prefersDark(this._win));
                this.watchSystem();
                return this.theme;
            },

            watchSystem() {
                const w = this._win;
                if (!w || typeof w.matchMedia !== 'function') return false;
                let mq;
                try {
                    mq = w.matchMedia('(prefers-color-scheme: dark)');
                } catch (e) {
                    return false;
                }
                if (!mq || typeof mq.addEventListener !== 'function') return false;
                const self = this;
                mq.addEventListener('change', function (ev) {
                    // Only 'system' follows the OS. An explicitly chosen palette must
                    // not flip at dusk.
                    if (self.theme === Themes.DEFAULT_THEME)
                        apply(self._doc, Themes.DEFAULT_THEME, !!(ev && ev.matches));
                });
                return true;
            },

            async setTheme(id) {
                const safe = Themes.isValid(id) ? id : Themes.DEFAULT_THEME;
                this.theme = safe;
                // Apply first: persistence is a nicety, restyling is the point.
                apply(this._doc, safe, prefersDark(this._win));
                if (!this._store) return false;
                const current = await this._store.read();
                return await this._store.write(settingsWithTheme(current, safe));
            },

            isActiveTheme(id) { return this.theme === id; },
            themeLabel(id) { return Themes.labelFor(id); },
            swatchClass(id) {
                return Themes.isValid(id) ? 'pl-swatch pl-swatch-' + id : 'pl-swatch';
            }
        };
    }

    const PilotThemeUi = {
        ATTR, ID_ATTR,
        themeFromSettings, settingsWithTheme, adaptStore, prefersDark, apply, pilotThemeUi
    };
    root.PilotThemeUi = PilotThemeUi;
    root.pilotThemeUi = pilotThemeUi;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotThemeUi;
})(typeof window !== 'undefined' ? window : globalThis);
