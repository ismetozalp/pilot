// Unit tests for js/core/themes.js and the palettes it promises exist.
//
// The registry is pure data, so the interesting properties are structural: the
// documented ids exactly once each, a valid base on every non-system theme, a
// case-SENSITIVE validity test, and a resolve() that never returns something the
// DOM layer cannot put in an attribute.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../../js/core/themes.js');

const CSS = path.join(__dirname, '..', '..', 'css', 'themes.css');

// Spec 11.1, verbatim.
const EXPECTED = [
    ['system', 'System', null],
    ['light', 'Light', 'light'],
    ['dark', 'Dark', 'dark'],
    ['aqua', 'Aqua', 'dark'],
    ['nord', 'Nord', 'dark'],
    ['solarized', 'Solarized', 'dark'],
    ['dracula', 'Dracula', 'dark'],
    ['gruvbox', 'Gruvbox', 'dark'],
    ['catppuccin', 'Catppuccin', 'dark'],
    ['tokyonight', 'Tokyo Night', 'dark'],
    ['rosepine', 'Ros\u00e9 Pine', 'dark'],
    ['sunset', 'Sunset', 'dark'],
    ['sepia', 'Sepia', 'light']
];

test('the registry is exactly the 13 documented themes, in order', () => {
    assert.equal(T.THEMES.length, 13);
    assert.deepEqual(T.THEMES.map((t) => [t.id, t.label, t.base]), EXPECTED);
});

test('every id appears exactly once', () => {
    assert.equal(new Set(T.ids()).size, T.ids().length);
});

test('every theme except system has a base of light or dark', () => {
    for (const t of T.THEMES) {
        if (t.id === 'system') assert.equal(t.base, null);
        else assert.ok(t.base === 'light' || t.base === 'dark', t.id);
    }
});

test('the default theme is system', () => {
    assert.equal(T.DEFAULT_THEME, 'system');
    assert.equal(T.isValid(T.DEFAULT_THEME), true);
});

test('isValid is true for every registered id', () => {
    for (const id of T.ids()) assert.equal(T.isValid(id), true, id);
});

test('isValid is case-sensitive', () => {
    for (const id of ['Dark', 'DARK', 'System', 'Nord', 'ROSEPINE', 'Sepia'])
        assert.equal(T.isValid(id), false, id);
});

test('isValid rejects unknown, empty, nullish and non-string ids', () => {
    for (const id of ['', ' ', 'dark ', ' dark', 'neon', null, undefined, 0, 1, {}, [],
        true, 'da\x00rk', 'dark\n', '\u0064ark\u200b'])
        assert.equal(T.isValid(id), false, JSON.stringify(id));
});

test('isValid does not answer yes for inherited Object properties', () => {
    // A hand-edited settings.json can carry "__proto__" or "constructor"; a bare
    // index lookup would find something on Object.prototype and treat it as a theme.
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])
        assert.equal(T.isValid(id), false, id);
});

test('get returns the entry for a known id and null otherwise', () => {
    assert.equal(T.get('nord').label, 'Nord');
    for (const id of ['neon', '', null, undefined, '__proto__', 'Nord'])
        assert.equal(T.get(id), null, JSON.stringify(id));
});

test('labelFor is the empty string for anything unknown', () => {
    assert.equal(T.labelFor('tokyonight'), 'Tokyo Night');
    assert.equal(T.labelFor('rosepine'), 'Ros\u00e9 Pine');
    for (const id of ['neon', '', null, undefined]) assert.equal(T.labelFor(id), '');
});

test('resolve returns exactly attr and base', () => {
    assert.deepEqual(T.resolve('nord', false), { attr: 'nord', base: 'dark' });
    assert.deepEqual(Object.keys(T.resolve('nord', false)).sort(), ['attr', 'base']);
});

test('resolve maps every custom theme to its own base for both prefersDark values', () => {
    for (const t of T.THEMES) {
        if (t.id === 'system') continue;
        for (const dark of [true, false]) {
            assert.deepEqual(T.resolve(t.id, dark), { attr: t.id, base: t.base },
                t.id + ' prefersDark=' + dark);
        }
    }
});

test('system resolves from the OS preference', () => {
    assert.deepEqual(T.resolve('system', true), { attr: 'dark', base: 'dark' });
    assert.deepEqual(T.resolve('system', false), { attr: 'light', base: 'light' });
});

test('an invalid, empty or nullish id resolves like system rather than throwing', () => {
    // A stale or hand-edited theme name must leave the plugin usable, not blank.
    for (const id of ['neon', '', null, undefined, 42, {}, [], 'Dark', '__proto__']) {
        assert.deepEqual(T.resolve(id, true), { attr: 'dark', base: 'dark' }, JSON.stringify(id));
        assert.deepEqual(T.resolve(id, false), { attr: 'light', base: 'light' }, JSON.stringify(id));
    }
});

test('resolve coerces a truthy or falsy prefersDark rather than trusting it', () => {
    assert.equal(T.resolve('system', 1).attr, 'dark');
    assert.equal(T.resolve('system', 'yes').attr, 'dark');
    assert.equal(T.resolve('system', 0).attr, 'light');
    assert.equal(T.resolve('system', undefined).attr, 'light');
    assert.equal(T.resolve('system', null).attr, 'light');
});

test('selectable is a copy — mutating it cannot corrupt the registry', () => {
    const list = T.selectable();
    assert.equal(list.length, T.THEMES.length);
    list.pop();
    assert.equal(T.THEMES.length, 13);
});

// --- the registry-to-palette link, tested here as well as in smoke rule 7 -----

test('every custom theme has a data-bs-theme block in css/themes.css', () => {
    const css = fs.readFileSync(CSS, 'utf8');
    for (const t of T.THEMES) {
        if (['system', 'light', 'dark'].includes(t.id)) continue;
        assert.ok(css.includes('[data-bs-theme="' + t.id + '"]'),
            'css/themes.css has no palette for ' + t.id);
    }
});

test('system, light and dark intentionally have no palette block', () => {
    const css = fs.readFileSync(CSS, 'utf8');
    for (const id of ['system', 'light', 'dark'])
        assert.equal(css.includes('[data-bs-theme="' + id + '"]'), false,
            id + ' must use Bootstrap\u2019s built-in mode, not a custom block');
});

test('every documented --pl-* accent variable has a default', () => {
    const css = fs.readFileSync(CSS, 'utf8');
    for (const v of ['--pl-log-bg', '--pl-log-fg', '--pl-step-ok', '--pl-step-fail',
        '--pl-step-running', '--pl-dot-online', '--pl-dot-offline',
        '--pl-progress-fg', '--pl-row-selected-bg'])
        assert.ok(new RegExp('^\\s*' + v + ':', 'm').test(css), v + ' has no default');
});

test('every theme has a swatch colour for the picker', () => {
    const css = fs.readFileSync(CSS, 'utf8');
    for (const id of T.ids())
        assert.ok(css.includes('.pl-swatch-' + id), 'no swatch for ' + id);
});

test('css/themes.css contains no literal control byte', () => {
    // Invisible in an editor, survives copy-paste unpredictably.
    const css = fs.readFileSync(CSS, 'utf8');
    assert.equal(/[\x00-\x08\x0b-\x1f\x7f]/.test(css), false);
});
