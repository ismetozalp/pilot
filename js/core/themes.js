// core/themes.js — the theme registry and resolution. PURE: no DOM, no cockpit.
//
// Themes are applied by setting `data-bs-theme` on <html>, which Bootstrap 5.3
// already understands. Each custom palette is a block in css/themes.css overriding
// the Bootstrap variables; Pilot's own accents (--pl-*) derive from those, so a
// theme never has to know this plugin exists.
//
// 'system' is not a palette — it resolves to light or dark from the OS preference
// at the moment it is asked, which is why resolution takes prefersDark rather than
// reading matchMedia itself. That is what keeps this file testable under node and
// keeps every DOM concern in js/features/theme-ui.js.
'use strict';
(function (root) {

    // Spec 11.1, verbatim and in order.
    const THEMES = [
        { id: 'system',     label: 'System',      base: null },
        { id: 'light',      label: 'Light',       base: 'light' },
        { id: 'dark',       label: 'Dark',        base: 'dark' },
        { id: 'aqua',       label: 'Aqua',        base: 'dark' },
        { id: 'nord',       label: 'Nord',        base: 'dark' },
        { id: 'solarized',  label: 'Solarized',   base: 'dark' },
        { id: 'dracula',    label: 'Dracula',     base: 'dark' },
        { id: 'gruvbox',    label: 'Gruvbox',     base: 'dark' },
        { id: 'catppuccin', label: 'Catppuccin',  base: 'dark' },
        { id: 'tokyonight', label: 'Tokyo Night', base: 'dark' },
        { id: 'rosepine',   label: 'Ros\u00e9 Pine', base: 'dark' },
        { id: 'sunset',     label: 'Sunset',      base: 'dark' },
        { id: 'sepia',      label: 'Sepia',       base: 'light' }
    ];

    const DEFAULT_THEME = 'system';

    // Own-property lookup only: a theme id of "constructor" or "__proto__" arrives
    // straight from a hand-edited settings.json, and a bare index would return
    // something from Object.prototype rather than falling back to the default.
    const BY_ID = THEMES.reduce(function (m, t) { m[t.id] = t; return m; }, Object.create(null));

    // Case-SENSITIVE by design (spec 11.1): 'Dark' is not 'dark'. Accepting it would
    // mean the same preference has two spellings and the picker cannot highlight one.
    function isValid(id) {
        return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY_ID, id);
    }

    function get(id) { return isValid(id) ? BY_ID[id] : null; }

    function ids() { return THEMES.map(function (t) { return t.id; }); }

    function labelFor(id) {
        const t = get(id);
        return t ? t.label : '';
    }

    function resolveSystem(prefersDark) {
        return prefersDark ? { attr: 'dark', base: 'dark' } : { attr: 'light', base: 'light' };
    }

    // -> { attr, base }. `attr` is what goes on data-bs-theme; `base` says whether
    // the palette is fundamentally light or dark, which is what any contrast
    // decision should key off rather than the id.
    //
    // An unknown id resolves like system rather than throwing: a stale or
    // hand-edited theme name must leave the plugin usable, not blank.
    function resolve(id, prefersDark) {
        if (id === 'system' || !isValid(id)) return resolveSystem(!!prefersDark);
        const t = BY_ID[id];
        return { attr: t.id, base: t.base };
    }

    // A copy: the picker iterates this, and a mutation there must not reach the
    // registry every other module reads.
    function selectable() { return THEMES.slice(); }

    const PilotThemes = {
        THEMES, DEFAULT_THEME, isValid, get, ids, labelFor, resolve, resolveSystem, selectable
    };
    root.PilotThemes = PilotThemes;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotThemes;
})(typeof window !== 'undefined' ? window : globalThis);
