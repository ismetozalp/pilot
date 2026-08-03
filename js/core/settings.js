// core/settings.js — the per-user settings file, ~/.config/cockpit/pilot/settings.json.
//
// Deliberately separate from the root-owned system config in §5: the theme is a
// per-user preference, and this file is also what Explorer's multi-plugin updater
// registry reads for the update repo (§11.3). It NEVER contains secrets — those stay
// in the root-owned 0600 files under /etc/pilot.
//
// Everything that decides a value is pure and unit-testable with no bridge; the four
// I/O functions at the bottom are the only part that touches cockpit, and this module
// is in smoke's IO_MODULES for exactly that reason.
'use strict';
(function (root) {
    const E = root.PilotErrors || (typeof require !== 'undefined' ? require('./errors.js') : null);

    const REL_DIR = '.config/cockpit/pilot';
    const REL_PATH = REL_DIR + '/settings.json';

    // A settings file is a handful of scalars. Anything larger is a mistake or an
    // attack, and parsing it would only turn a broken file into a slow broken file.
    const MAX_BYTES = 64 * 1024;

    const DEFAULTS = {
        ui: { theme: 'system' },
        // Pilot's own upstream, so a fresh install can offer updates without being
        // configured first. Clearing this disables update checking entirely.
        update: { repo: 'ismetozalp/pilot', checkOnStartup: true }
    };

    // Validation is by exclusion, not by an anchored regex: in JavaScript `$` also
    // matches before a trailing newline, so /^[a-z-]+$/.test('dark\n') is TRUE. A
    // theme id smuggling a newline into a CSS selector is exactly the class of bug
    // that pattern hides, so every check below tests for a forbidden character
    // instead of for a well-formed whole.
    const THEME_BAD = /[^a-z0-9-]/;
    const REPO_BAD = /[^A-Za-z0-9._\/-]/;

    // A theme id becomes a data-bs-theme attribute value and part of a CSS selector.
    // settings.js deliberately does NOT know the theme registry — that is
    // js/core/themes.js, a different module owned by a different task. This is only
    // the syntactic guarantee; PilotThemes.isValid is the semantic check.
    function isSafeTheme(v) {
        if (typeof v !== 'string') return false;
        if (v.length < 1 || v.length > 32) return false;
        if (THEME_BAD.test(v)) return false;
        return v.charAt(0) >= 'a' && v.charAt(0) <= 'z';
    }

    // GitHub owner/name. Accepted verbatim into a URL by the update feature, so a
    // separator, a control byte or a second slash must never get through.
    function isSafeRepo(v) {
        if (typeof v !== 'string') return false;
        if (v.length < 3 || v.length > 201) return false;
        if (REPO_BAD.test(v)) return false;
        const parts = v.split('/');
        if (parts.length !== 2) return false;
        for (const p of parts) {
            if (p.length < 1 || p.length > 100) return false;
            const c = p.charAt(0);
            const alnum = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
            if (!alnum) return false;
        }
        return true;
    }

    // Own-property read. A settings file is attacker-influenced text, so an
    // inherited "__proto__" or "constructor" must never be treated as a value.
    function pick(obj, key) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
        if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
        return obj[key];
    }

    // Pure: project a stored document onto the documented shape. Always returns a
    // FRESH object with exactly three leaves — unknown keys are dropped, and each
    // invalid leaf falls back on its own so one bad theme does not also reset the
    // update repo. Nothing from `stored` is retained by reference.
    function merge(stored) {
        const ui = pick(stored, 'ui');
        const update = pick(stored, 'update');
        const theme = pick(ui, 'theme');
        const repo = pick(update, 'repo');
        const check = pick(update, 'checkOnStartup');
        return {
            ui: { theme: isSafeTheme(theme) ? theme : DEFAULTS.ui.theme },
            update: {
                repo: isSafeRepo(repo) ? repo : DEFAULTS.update.repo,
                // Strict boolean: a hand-edited "false" must not read as true.
                checkOnStartup: typeof check === 'boolean' ? check : DEFAULTS.update.checkOnStartup
            }
        };
    }

    // Pure: any unusable document yields the defaults. A user who breaks this file
    // by hand gets a working plugin, not a blank screen.
    function parse(text) {
        if (typeof text !== 'string') return merge(null);
        if (text.length === 0 || text.length > MAX_BYTES) return merge(null);
        let obj = null;
        try {
            obj = JSON.parse(text);
        } catch (e) {
            return merge(null);
        }
        return merge(obj);
    }

    // Pure: normalise before writing, so a hostile object handed to write() can never
    // be persisted verbatim.
    function serialize(value) {
        return JSON.stringify(merge(value), null, 2) + '\n';
    }

    function checkHome(home) {
        if (typeof home !== 'string' || home.length === 0 || home.charAt(0) !== '/' ||
            home.indexOf(' ') !== -1 || home.indexOf('\n') !== -1 ||
            home.indexOf('\r') !== -1 || home.indexOf('\x00') !== -1 ||
            home.indexOf('..') !== -1) {
            throw E.create('GENERIC',
                'Cockpit reported an unusable home directory: ' + JSON.stringify(home),
                { home: home });
        }
        let h = home.length > 1 && home.charAt(home.length - 1) === '/'
            ? home.slice(0, -1) : home;
        // '/' trims to itself above (length 1), so normalise it to '' here — every
        // caller appends '/' + REL_DIR, and '/' + '/' + REL_DIR would double the slash.
        return h === '/' ? '' : h;
    }

    function dirFor(home) { return checkHome(home) + '/' + REL_DIR; }
    function pathFor(home) { return checkHome(home) + '/' + REL_PATH; }

    // Pure: pull the home directory out of whatever cockpit.user() resolved to.
    function pickHome(info) {
        const h = pick(info, 'home');
        if (typeof h === 'string' && h !== '') return h;
        throw E.create('GENERIC', 'Cockpit did not report a home directory.',
            { user: info === undefined ? null : info });
    }

    // ---- I/O layer -------------------------------------------------------
    // Guarded so the pure half above loads and runs under node.

    function hasCockpit() { return typeof cockpit !== 'undefined'; }

    function requireCockpit() {
        if (!hasCockpit() || typeof cockpit.user !== 'function') {
            throw E.create('GENERIC',
                'Cockpit is not available in this context, so the settings file cannot be reached.');
        }
    }

    async function home() {
        requireCockpit();
        return pickHome(await cockpit.user());
    }

    async function path() {
        return pathFor(await home());
    }

    // Never throws: a first run has no file, and a broken file must not block the UI.
    async function read() {
        if (!hasCockpit()) return merge(null);
        try {
            const text = await cockpit.file(await path()).read();
            return parse(text);
        } catch (e) {
            return merge(null);
        }
    }

    // Throws a PilotError the caller can surface: a save that silently failed would
    // leave the user believing their theme was remembered.
    async function write(value) {
        const merged = merge(value);
        const h = await home();
        // No superuser: this is the invoking user's own dotfile. 0700 because the
        // directory sits inside the user's home and nothing else belongs in it.
        await cockpit.spawn(['install', '-d', '-m', '0700', dirFor(h)], { err: 'message' });
        try {
            // replace() is atomic, so a half-written file is never observed.
            await cockpit.file(pathFor(h)).replace(serialize(merged));
        } catch (e) {
            throw E.create('GENERIC', 'Could not write ' + pathFor(h) + '.',
                { path: pathFor(h), cause: String(e && (e.problem || e.message) || e) });
        }
        return merged;
    }

    const PilotSettings = {
        REL_DIR, REL_PATH, MAX_BYTES, DEFAULTS,
        isSafeTheme, isSafeRepo, merge, parse, serialize,
        pathFor, dirFor, pickHome,
        home, path, read, write,
        // Aliases, pinned so a consumer duck-typing either name pair finds a working
        // store. They are the SAME function objects, not wrappers, so no behaviour
        // can drift between the two spellings.
        load: read, save: write
    };
    root.PilotSettings = PilotSettings;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotSettings;
})(typeof window !== 'undefined' ? window : globalThis);
