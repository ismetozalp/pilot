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

// The picker used to show one square per theme, filled with that theme's
// --bs-body-bg alone. Every dark palette's background sits between #1a1b26 and
// #2e3440, so on screen they were ten indistinguishable near-black squares and
// only the label told them apart -- reported from the running console. The
// swatch now carries the palette's accent too, which is the part that actually
// differs. These two tests pin that, because a swatch is the one piece of CSS
// whose whole job is to be *recognisable*: nothing else fails when it drifts.

function swatchRule(css, id) {
    const m = new RegExp('\\.pl-swatch-' + id + '\\s*\\{([^}]*)\\}').exec(css);
    return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

test('each theme swatch shows that palette\u2019s own accent, not just its background', () => {
    const css = fs.readFileSync(CSS, 'utf8');
    for (const id of T.ids()) {
        // 'system' resolves to light or dark at runtime and has no palette of
        // its own; its swatch is the split square that says exactly that.
        if (id === 'system' || id === 'light' || id === 'dark') continue;
        const block = new RegExp('\\[data-bs-theme="' + id + '"\\]\\s*\\{([^}]*)\\}').exec(css);
        assert.ok(block, id + ' has no palette block');
        const accent = /--bs-primary:\s*(#[0-9a-fA-F]{3,8})/.exec(block[1]);
        assert.ok(accent, id + ' declares no --bs-primary');
        const rule = swatchRule(css, id);
        assert.ok(rule, 'no swatch rule for ' + id);
        assert.ok(rule.toLowerCase().includes(accent[1].toLowerCase()),
            id + ' swatch omits its own accent ' + accent[1] + ': ' + rule);
    }
});

test('no two theme swatches are identical', () => {
    const css = fs.readFileSync(CSS, 'utf8');
    const seen = new Map();
    for (const id of T.ids()) {
        const rule = swatchRule(css, id);
        assert.ok(rule, 'no swatch rule for ' + id);
        const prev = seen.get(rule);
        assert.equal(prev, undefined,
            'the picker cannot tell ' + id + ' from ' + prev + ': both are ' + rule);
        seen.set(rule, id);
    }
    assert.equal(seen.size, T.ids().length);
});

test('css/themes.css contains no literal control byte', () => {
    // Invisible in an editor, survives copy-paste unpredictably.
    const css = fs.readFileSync(CSS, 'utf8');
    assert.equal(/[\x00-\x08\x0b-\x1f\x7f]/.test(css), false);
});

// --- the built-in dark theme must keep pilot.css's transcript shades ----------
//
// tools/pilot-wire.mjs links css/themes.css after css/pilot.css. :root and
// [data-bs-theme="dark"] have equal specificity, so a plain :root declaration in
// the later file wins over the earlier file's attribute-scoped one. css/pilot.css
// (Task 1) declares --pl-log-bg/--pl-log-fg at :root AND overrides them for the
// built-in "dark" theme; if css/themes.css's :root ever redeclared those same two
// vars, it would silently flatten the dark theme's transcript back to pilot.css's
// light-mode shade. This regression was caught in review by rendering the actual
// computed values under data-bs-theme="dark" (actual #1c1f24/#d7dae0 vs intended
// #101317/#e6e9ef) and is guarded here so a future edit can't reintroduce it.

const PILOT_CSS = path.join(__dirname, '..', '..', 'css', 'pilot.css');
const INDEX_HTML = path.join(__dirname, '..', '..', 'index.html');

test('css/themes.css loads after css/pilot.css (the ordering the shadow risk depends on)', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const pilotAt = html.indexOf('href="css/pilot.css"');
    const themesAt = html.indexOf('href="css/themes.css"');
    assert.notEqual(pilotAt, -1, 'index.html does not link css/pilot.css');
    assert.notEqual(themesAt, -1, 'index.html does not link css/themes.css');
    assert.ok(pilotAt < themesAt, 'css/themes.css must load after css/pilot.css');
});

test('css/themes.css does not redeclare --pl-log-bg/--pl-log-fg at :root (would shadow pilot.css\'s dark override)', () => {
    const css = fs.readFileSync(CSS, 'utf8');
    const rootBlock = /:root\s*\{([^}]*)\}/.exec(css);
    assert.ok(rootBlock, 'css/themes.css has no :root block');
    assert.equal(/--pl-log-bg\s*:/.test(rootBlock[1]), false,
        ':root must leave --pl-log-bg to css/pilot.css');
    assert.equal(/--pl-log-fg\s*:/.test(rootBlock[1]), false,
        ':root must leave --pl-log-fg to css/pilot.css');
});

test('css/pilot.css still carries its dark-theme transcript override', () => {
    const pilotCss = fs.readFileSync(PILOT_CSS, 'utf8');
    const darkBlock = /\[data-bs-theme="dark"\]\s*\{([^}]*)\}/.exec(pilotCss);
    assert.ok(darkBlock, 'css/pilot.css has no [data-bs-theme="dark"] override');
    assert.ok(/--pl-log-bg\s*:\s*#101317/.test(darkBlock[1]),
        'css/pilot.css lost its dark --pl-log-bg override (#101317)');
    assert.ok(/--pl-log-fg\s*:\s*#e6e9ef/.test(darkBlock[1]),
        'css/pilot.css lost its dark --pl-log-fg override (#e6e9ef)');
});

// --- computed WCAG contrast, enforced rather than merely asserted in a report --
//
// WCAG 2.x relative-luminance / contrast-ratio formulas, straight from the spec:
// linearize each sRGB channel, weight-sum to relative luminance, then
// (L_lighter + 0.05) / (L_darker + 0.05).

function srgbToLinear(c) {
    const n = c / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}

function relLuminance(hex) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(hexA, hexB) {
    const l1 = relLuminance(hexA);
    const l2 = relLuminance(hexB);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
}

function themeBlocks(css) {
    const blocks = {};
    const re = /\[data-bs-theme="([a-z]+)"\]\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
        const vars = {};
        const varRe = /--([a-z-]+)\s*:\s*(#[0-9a-fA-F]{6})/g;
        let vm;
        while ((vm = varRe.exec(m[2]))) vars[vm[1]] = vm[2];
        blocks[m[1]] = vars;
    }
    return blocks;
}

test('every custom theme\'s body text clears WCAG AA (>=4.5:1) against its own background', () => {
    const css = fs.readFileSync(CSS, 'utf8');
    const blocks = themeBlocks(css);
    for (const t of T.THEMES) {
        if (['system', 'light', 'dark'].includes(t.id)) continue;
        const v = blocks[t.id];
        assert.ok(v && v['bs-body-bg'] && v['bs-body-color'], t.id + ' is missing body colours');
        const ratio = contrastRatio(v['bs-body-bg'], v['bs-body-color']);
        assert.ok(ratio >= 4.5, t.id + ' body text is ' + ratio.toFixed(2) + ':1, below WCAG AA');
    }
});

test('every custom theme\'s transcript text clears WCAG AA (>=4.5:1) against --pl-log-bg', () => {
    const css = fs.readFileSync(CSS, 'utf8');
    const blocks = themeBlocks(css);
    for (const t of T.THEMES) {
        if (['system', 'light', 'dark'].includes(t.id)) continue;
        const v = blocks[t.id];
        assert.ok(v && v['pl-log-bg'] && v['pl-log-fg'], t.id + ' is missing --pl-log-bg/--pl-log-fg');
        const ratio = contrastRatio(v['pl-log-bg'], v['pl-log-fg']);
        assert.ok(ratio >= 4.5, t.id + ' transcript text is ' + ratio.toFixed(2) + ':1, below WCAG AA');
    }
});

test('every custom theme\'s primary/success/warning/danger accent clears the WCAG 1.4.11 graphical floor (>=3:1) against its own background', () => {
    // These back --pl-step-ok/--pl-step-fail/--pl-step-running/--pl-dot-online and,
    // for warning, other UI chrome outside the --pl-* namespace. --pl-step-fail in
    // particular signals a failed provisioning step -- the most safety-relevant
    // colour in the product -- so this is enforced, not merely eyeballed.
    const css = fs.readFileSync(CSS, 'utf8');
    const blocks = themeBlocks(css);
    for (const t of T.THEMES) {
        if (['system', 'light', 'dark'].includes(t.id)) continue;
        const v = blocks[t.id];
        for (const role of ['bs-primary', 'bs-success', 'bs-warning', 'bs-danger']) {
            assert.ok(v && v[role], t.id + ' is missing --' + role);
            const ratio = contrastRatio(v['bs-body-bg'], v[role]);
            assert.ok(ratio >= 3, t.id + ' --' + role + ' is ' + ratio.toFixed(2) +
                ':1 against its background, below the WCAG 1.4.11 floor');
        }
    }
});
