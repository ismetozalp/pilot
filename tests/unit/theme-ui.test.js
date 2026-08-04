// Unit tests for js/features/theme-ui.js.
//
// Two things killed the previous round here and are pinned by tests below:
// (1) the picker applied a theme but never persisted it, because it demanded
//     load()/save() from a store that exposes read()/write();
// (2) js/features/theme-ui.js was added to index.html but not to the C7 array the
//     skeleton test asserts against.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../../js/core/themes.js');
const UI = require('../../js/features/theme-ui.js');

const ROOT = path.join(__dirname, '..', '..');

function fakeDoc() {
    const attrs = {};
    return {
        attrs,
        documentElement: {
            setAttribute(k, v) { attrs[k] = v; },
            getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; }
        }
    };
}

// --- pure: settings projection -------------------------------------------

test('themeFromSettings reads ui.theme', () => {
    assert.equal(UI.themeFromSettings({ ui: { theme: 'nord' } }), 'nord');
});

test('themeFromSettings falls back to system for every unusable settings document', () => {
    const bad = [null, undefined, 42, 'x', [], {}, { ui: null }, { ui: 'dark' }, { ui: [] },
        { ui: { theme: null } }, { ui: { theme: 'neon' } }, { ui: { theme: 'Dark' } },
        { ui: { theme: 42 } }, { ui: { theme: '__proto__' } }, { theme: 'nord' }];
    for (const s of bad)
        assert.equal(UI.themeFromSettings(s), 'system', JSON.stringify(s));
});

test('settingsWithTheme preserves every other key, including the update block', () => {
    const before = { update: { repo: 'a/b', checkOnStartup: true }, ui: { sidebar: 'wide' } };
    const after = UI.settingsWithTheme(before, 'nord');
    assert.deepEqual(after, {
        update: { repo: 'a/b', checkOnStartup: true },
        ui: { sidebar: 'wide', theme: 'nord' }
    });
});

test('settingsWithTheme does not mutate its argument', () => {
    const before = { ui: { theme: 'dark' } };
    UI.settingsWithTheme(before, 'nord');
    assert.equal(before.ui.theme, 'dark');
});

test('settingsWithTheme refuses to persist an invalid id', () => {
    for (const id of ['neon', '', null, undefined, 42, 'Dark', '__proto__', {}])
        assert.equal(UI.settingsWithTheme({}, id).ui.theme, 'system', JSON.stringify(id));
});

test('settingsWithTheme repairs a corrupt settings document instead of throwing', () => {
    for (const s of [null, undefined, 42, 'x', [], { ui: 'dark' }, { ui: [] }])
        assert.equal(UI.settingsWithTheme(s, 'nord').ui.theme, 'nord', JSON.stringify(s));
});

// Hostile stored-theme values: a hand-edited or corrupted settings.json must never
// apply the value verbatim (a control byte or a prototype key must never reach a
// data-bs-theme attribute or a CSS selector) and must never throw.
test('themeFromSettings and settingsWithTheme both refuse hostile theme values', () => {
    const hostile = [
        'nord\x00',                         // embedded NUL
        'nord\x1b[31m',                     // embedded ESC / ANSI
        '\u202enord',                        // RTL override (escaped, no literal RTL char)
        'th\u00e8me',                       // unicode, not ascii-only (escaped)
        'nord'.repeat(10000),               // very long string
        '__proto__',
        'constructor',
        'prototype'
    ];
    for (const v of hostile) {
        assert.equal(UI.themeFromSettings({ ui: { theme: v } }), 'system', JSON.stringify(v));
        const out = UI.settingsWithTheme({}, v);
        assert.equal(out.ui.theme, 'system', JSON.stringify(v));
        // The hostile value must not have leaked into the prototype chain either.
        assert.equal(Object.prototype.hasOwnProperty.call({}, v), false);
    }
});

test('apply never writes a hostile theme id to the DOM', () => {
    const hostile = ['nord\x00', '\u202enord', 'constructor'.repeat(1000), '__proto__'];
    for (const v of hostile) {
        const doc = fakeDoc();
        UI.apply(doc, v, false);
        assert.equal(doc.attrs['data-bs-theme'], 'light', JSON.stringify(v));
        assert.equal(doc.attrs['data-pl-theme'], 'system', JSON.stringify(v));
    }
});

// --- the store shim: the round-2 persistence defect -----------------------

test('adaptStore accepts read/write, load/save and get/set', async () => {
    for (const [r, w] of [['read', 'write'], ['load', 'save'], ['get', 'set']]) {
        let written = null;
        const store = { [r]: () => ({ ui: { theme: 'nord' } }), [w]: (o) => { written = o; } };
        const a = UI.adaptStore(store);
        assert.ok(a, r + '/' + w + ' was not recognised as a store');
        assert.deepEqual(await a.read(), { ui: { theme: 'nord' } });
        assert.equal(await a.write({ ui: { theme: 'sepia' } }), true);
        assert.deepEqual(written, { ui: { theme: 'sepia' } });
    }
});

test('adaptStore returns null for anything that is not a usable store', () => {
    for (const s of [null, undefined, 42, 'x', [], {}, { read: 1, write: 2 },
        { read: () => ({}) }, { write: () => {} }, { save: () => {} }])
        assert.equal(UI.adaptStore(s), null, JSON.stringify(s));
});

test('adaptStore never lets a throwing or rejecting store break the picker', async () => {
    const a = UI.adaptStore({
        read: () => { throw new Error('boom'); },
        write: () => Promise.reject(new Error('read-only filesystem'))
    });
    assert.deepEqual(await a.read(), {});
    assert.equal(await a.write({}), false);
});

test('adaptStore normalises a non-object read result to an empty object', async () => {
    for (const v of [null, undefined, 'x', 42, []]) {
        const a = UI.adaptStore({ read: () => v, write: () => {} });
        assert.deepEqual(await a.read(), {}, JSON.stringify(v));
    }
});

// --- DOM application ------------------------------------------------------

test('apply writes the resolved attr and remembers the chosen id', () => {
    const doc = fakeDoc();
    assert.deepEqual(UI.apply(doc, 'nord', false), { attr: 'nord', base: 'dark' });
    assert.equal(doc.attrs['data-bs-theme'], 'nord');
    assert.equal(doc.attrs['data-pl-theme'], 'nord');
});

test('apply resolves system from the OS preference and keeps the id as system', () => {
    const doc = fakeDoc();
    assert.deepEqual(UI.apply(doc, 'system', true), { attr: 'dark', base: 'dark' });
    assert.equal(doc.attrs['data-bs-theme'], 'dark');
    // Without this the reload cannot tell "system, currently dark" from "dark".
    assert.equal(doc.attrs['data-pl-theme'], 'system');
});

test('apply turns an invalid id into system rather than writing it to the DOM', () => {
    const doc = fakeDoc();
    UI.apply(doc, 'neon', false);
    assert.equal(doc.attrs['data-bs-theme'], 'light');
    assert.equal(doc.attrs['data-pl-theme'], 'system');
});

test('apply is a no-op on a missing or malformed document', () => {
    for (const d of [null, undefined, {}, { documentElement: null }, { documentElement: {} }])
        assert.deepEqual(UI.apply(d, 'nord', false), { attr: 'nord', base: 'dark' },
            JSON.stringify(d));
});

test('apply sets the expected data-bs-theme for every one of the 13 registry themes', () => {
    for (const id of T.ids()) {
        const doc = fakeDoc();
        const expected = T.resolve(id, false);
        assert.deepEqual(UI.apply(doc, id, false), expected, id);
        assert.equal(doc.attrs['data-bs-theme'], expected.attr, id);
        assert.equal(doc.attrs['data-pl-theme'], id, id);
    }
});

test('prefersDark is false when matchMedia is missing or throws', () => {
    assert.equal(UI.prefersDark({}), false);
    assert.equal(UI.prefersDark({ matchMedia: () => { throw new Error('nope'); } }), false);
    assert.equal(UI.prefersDark({ matchMedia: () => ({ matches: true }) }), true);
    assert.equal(UI.prefersDark({ matchMedia: () => ({ matches: false }) }), false);
    assert.equal(UI.prefersDark({ matchMedia: () => null }), false);
});

// --- the component --------------------------------------------------------

test('initTheme restores the persisted theme and applies it', async () => {
    const doc = fakeDoc();
    const c = UI.pilotThemeUi();
    c._doc = doc;
    await c.initTheme({ read: () => ({ ui: { theme: 'gruvbox' } }), write: () => {} });
    assert.equal(c.theme, 'gruvbox');
    assert.equal(doc.attrs['data-bs-theme'], 'gruvbox');
});

test('initTheme with no usable store still applies the default theme', async () => {
    const doc = fakeDoc();
    const c = UI.pilotThemeUi();
    c._doc = doc;
    await c.initTheme(undefined);
    assert.equal(c.theme, 'system');
    assert.ok(doc.attrs['data-bs-theme'] === 'light' || doc.attrs['data-bs-theme'] === 'dark');
});

test('setTheme applies AND persists, merging into the existing settings document', async () => {
    // The round-2 defect in one test: the theme was applied but never written.
    const doc = fakeDoc();
    let saved = null;
    const store = {
        read: () => (saved || { update: { repo: 'a/b', checkOnStartup: true } }),
        write: (o) => { saved = o; }
    };
    const c = UI.pilotThemeUi();
    c._doc = doc;
    await c.initTheme(store);
    assert.equal(await c.setTheme('tokyonight'), true);
    assert.equal(doc.attrs['data-bs-theme'], 'tokyonight');
    assert.deepEqual(saved, {
        update: { repo: 'a/b', checkOnStartup: true },
        ui: { theme: 'tokyonight' }
    });
});

test('setTheme persists through a load/save store as well', async () => {
    let saved = null;
    const c = UI.pilotThemeUi();
    c._doc = fakeDoc();
    await c.initTheme({ load: () => ({}), save: (o) => { saved = o; } });
    await c.setTheme('sepia');
    assert.deepEqual(saved, { ui: { theme: 'sepia' } });
});

test('setTheme rejects an invalid id and falls back to system', async () => {
    const doc = fakeDoc();
    const c = UI.pilotThemeUi();
    c._doc = doc;
    await c.initTheme(null);
    await c.setTheme('neon');
    assert.equal(c.theme, 'system');
    assert.equal(doc.attrs['data-pl-theme'], 'system');
});

test('setTheme still applies when persistence fails', async () => {
    const doc = fakeDoc();
    const c = UI.pilotThemeUi();
    c._doc = doc;
    await c.initTheme({ read: () => ({}), write: () => Promise.reject(new Error('EROFS')) });
    assert.equal(await c.setTheme('dracula'), false);
    assert.equal(doc.attrs['data-bs-theme'], 'dracula', 'the theme must still be applied');
    assert.equal(c.theme, 'dracula');
});

test('the picker offers every registry theme with a label and a swatch', () => {
    const c = UI.pilotThemeUi();
    assert.deepEqual(c.themes.map((t) => t.id), T.ids());
    assert.equal(c.themeLabel('tokyonight'), 'Tokyo Night');
    assert.equal(c.swatchClass('nord'), 'pl-swatch pl-swatch-nord');
    assert.equal(c.swatchClass('neon'), 'pl-swatch');
    c.theme = 'nord';
    assert.equal(c.isActiveTheme('nord'), true);
    assert.equal(c.isActiveTheme('dark'), false);
});

test('a system-preference change restyles only while the theme is system', async () => {
    const doc = fakeDoc();
    let handler = null;
    const win = {
        matchMedia: () => ({
            matches: false,
            addEventListener: (name, fn) => { if (name === 'change') handler = fn; }
        })
    };
    const c = UI.pilotThemeUi();
    c._doc = doc;
    c._win = win;
    await c.initTheme(null);
    assert.equal(typeof handler, 'function', 'no change listener was registered');
    handler({ matches: true });
    assert.equal(doc.attrs['data-bs-theme'], 'dark');
    await c.setTheme('sepia');
    handler({ matches: true });
    assert.equal(doc.attrs['data-bs-theme'], 'sepia', 'an explicit theme must not follow the OS');
});

// --- wiring ---------------------------------------------------------------

test('the theme partial exists and binds the component', () => {
    const html = fs.readFileSync(path.join(ROOT, 'html', 'modals', 'theme.html'), 'utf8');
    assert.match(html, /x-data="pilotThemeUi\(\)"/);
    assert.match(html, /initTheme\(window\.PilotSettings\)/);
    assert.match(html, /id="pilot-theme"/);
    assert.match(html, /setTheme\(t\.id\)/);
});

test('boot.js injects the theme partial', () => {
    const boot = fs.readFileSync(path.join(ROOT, 'js', 'boot.js'), 'utf8');
    assert.ok(boot.includes('html/modals/theme.html'),
        'js/boot.js does not register html/modals/theme.html');
});

test('index.html loads theme-ui.js immediately after update.js', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const u = html.indexOf('src="js/features/update.js"');
    const t = html.indexOf('src="js/features/theme-ui.js"');
    assert.notEqual(u, -1, 'index.html does not load js/features/update.js');
    assert.notEqual(t, -1, 'index.html does not load js/features/theme-ui.js');
    assert.ok(u < t, 'theme-ui.js must load after update.js (C7 order)');
});

test('the skeleton C7 array knows about theme-ui.js', () => {
    // Round 2 added the script tag but not the array entry, and the skeleton test
    // then failed with "script not in the C7 order".
    const p = path.join(ROOT, 'tests', 'unit', 'skeleton.test.js');
    if (!fs.existsSync(p)) return;
    const src = fs.readFileSync(p, 'utf8');
    assert.ok(src.includes("'js/features/theme-ui.js'") || src.includes('"js/features/theme-ui.js"'),
        'tests/unit/skeleton.test.js has no js/features/theme-ui.js entry in its C7 array');
});
