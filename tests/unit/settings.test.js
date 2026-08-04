// Unit tests for js/core/settings.js — the per-user settings file (§11.3).
//
// This file is a parser fed by something the user can hand-edit, so hostile input is
// the point: truncated JSON, a theme id smuggling a path separator, a repo carrying
// a newline, a document trying to poison Object.prototype. Every rejection literal
// below is written with a VISIBLE escape (\x00, \n, ...) so copy-paste cannot
// silently turn a hostile case into a valid one.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../js/core/settings.js');

test('module loads with no cockpit global — the pure half must run under node', () => {
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof S.merge, 'function');
});

test('the documented defaults are exactly §11.3', () => {
    assert.deepEqual(S.DEFAULTS, {
        ui: { theme: 'system' },
        update: { repo: 'ismetozalp/pilot', checkOnStartup: true }
    });
    assert.equal(S.REL_PATH, '.config/cockpit/pilot/settings.json');
    assert.equal(S.REL_DIR, '.config/cockpit/pilot');
});

test('load/save are the same functions as read/write', () => {
    // Pinned because a consumer duck-typing either pair must find a working store.
    assert.equal(S.load, S.read);
    assert.equal(S.save, S.write);
    assert.equal(typeof S.read, 'function');
    assert.equal(typeof S.write, 'function');
});

test('isSafeTheme accepts registry-shaped ids', () => {
    for (const v of ['system', 'light', 'dark', 'aqua', 'nord', 'solarized', 'dracula',
        'gruvbox', 'catppuccin', 'tokyonight', 'rosepine', 'sunset', 'sepia',
        'a', 'a-b-c', 'x9', 'a'.repeat(32)]) {
        assert.equal(S.isSafeTheme(v), true, JSON.stringify(v));
    }
});

test('isSafeTheme rejects anything that could escape a CSS selector or a path', () => {
    // A theme id becomes a data-bs-theme attribute value AND part of a CSS selector.
    const hostile = [
        '', ' ', 'Dark', 'DARK', 'dark ', ' dark', '-dark', '9dark',
        'dark\n', 'dark\r', 'dark\t', 'dark\x00', 'da\x1frk', 'dark\x7f',
        'a/b', '../../etc/passwd', 'a\\b', 'a.b', 'a_b', 'a"b', "a'b",
        'dárk', '\u202edark', 'a'.repeat(33),
        null, undefined, 0, 1, {}, [], ['dark'], true, false, () => 'dark'
    ];
    for (const v of hostile) {
        assert.equal(S.isSafeTheme(v), false, JSON.stringify(String(v)));
    }
});

test('isSafeRepo accepts real owner/name pairs', () => {
    for (const v of ['ismetozalp/pilot', 'a/b', 'lejianwen/rustdesk-api',
        'Owner-9/name.with.dots', 'o/n_1', 'a'.repeat(100) + '/' + 'b'.repeat(100)]) {
        assert.equal(S.isSafeRepo(v), true, JSON.stringify(v));
    }
});

test('isSafeRepo rejects everything that is not exactly owner/name', () => {
    const hostile = [
        '', '/', 'pilot', 'a/b/c', '/name', 'owner/', 'a//b',
        '../..', 'owner/../..', './a', 'a/.', 'a/..', '../a',
        'owner/name\n', 'owner/na\x00me', 'ow ner/name', 'owner/na me',
        'https://github.com/owner/name',       // a URL, not owner/name
        'öwner/name', 'owner/nàme', 'owner:name', 'owner/name?x=1', 'owner/name#f',
        '-owner/name', '.owner/name', 'owner/-name'.replace('-', '.'),
        'a'.repeat(101) + '/b', 'a/' + 'b'.repeat(101),
        null, undefined, 0, {}, [], true, () => 'a/b'
    ];
    for (const v of hostile) {
        assert.equal(S.isSafeRepo(v), false, JSON.stringify(String(v)));
    }
});

test('merge fills every default from an empty document', () => {
    assert.deepEqual(S.merge({}), S.DEFAULTS);
    assert.deepEqual(S.merge(null), S.DEFAULTS);
    assert.deepEqual(S.merge(undefined), S.DEFAULTS);
});

test('merge keeps valid values and replaces only the invalid leaf', () => {
    // Per-field fallback matters: one bad theme must not also reset the update repo.
    const out = S.merge({ ui: { theme: 'a/b' }, update: { repo: 'me/mine', checkOnStartup: false } });
    assert.deepEqual(out, {
        ui: { theme: 'system' },
        update: { repo: 'me/mine', checkOnStartup: false }
    });
});

test('merge drops unknown keys so a newer Pilot cannot inject surprises into an older one', () => {
    const out = S.merge({
        ui: { theme: 'nord', fontSize: 99 },
        update: { repo: 'me/mine', checkOnStartup: true, channel: 'beta' },
        secrets: { token: 'hunter2' },
        extra: 1
    });
    assert.deepEqual(out, {
        ui: { theme: 'nord' },
        update: { repo: 'me/mine', checkOnStartup: true }
    });
    assert.equal(out.secrets, undefined);
    // §11.3: this file NEVER contains secrets — they stay in the 0600 files of §5.
    assert.ok(!JSON.stringify(out).includes('hunter2'));
});

test('merge rejects non-object shapes at every level', () => {
    for (const v of ['a string', 42, true, [], [1, 2], () => ({}), Symbol('x')]) {
        assert.deepEqual(S.merge(v), S.DEFAULTS, String(typeof v));
    }
    assert.deepEqual(S.merge({ ui: 'nord', update: [] }), S.DEFAULTS);
    assert.deepEqual(S.merge({ ui: ['nord'], update: 'x' }), S.DEFAULTS);
});

test('merge coerces nothing — checkOnStartup must be a real boolean', () => {
    // 'false', 0 and 1 are what a hand-edited file most often contains, and silently
    // treating 'false' as truthy would turn the startup check back on.
    for (const v of ['true', 'false', 0, 1, '', null, undefined, {}, []]) {
        assert.equal(S.merge({ update: { checkOnStartup: v } }).update.checkOnStartup,
            true, JSON.stringify(String(v)));
    }
    assert.equal(S.merge({ update: { checkOnStartup: false } }).update.checkOnStartup, false);
    assert.equal(S.merge({ update: { checkOnStartup: true } }).update.checkOnStartup, true);
});

test('merge returns a fresh object that does not alias its input', () => {
    const stored = { ui: { theme: 'nord' }, update: { repo: 'me/mine', checkOnStartup: false } };
    const out = S.merge(stored);
    out.ui.theme = 'sepia';
    assert.equal(stored.ui.theme, 'nord', 'merge must not hand back the caller-owned object');
});

test('merge cannot be used to pollute Object.prototype', () => {
    const evil = JSON.parse('{"__proto__":{"pwned":1},"ui":{"__proto__":{"pwned":2},"theme":"nord"}}');
    const out = S.merge(evil);
    assert.equal(out.ui.theme, 'nord');
    assert.equal(({}).pwned, undefined);
    assert.equal(Object.prototype.pwned, undefined);
    assert.equal(out.pwned, undefined);
});

test('parse recovers to defaults from every malformed document', () => {
    const bad = [
        '', '   ', '\n', '{', '}', '[', '{"ui":', '{"ui":{"theme":}',
        '{"ui":{"theme":"nord"}', 'null', 'true', '42', '"a string"', '[]', '[1,2]',
        'not json at all', '\x00', '{"ui":{"theme":"nord"}}trailing',
        '<!DOCTYPE html>', '\ufeff{"ui":{"theme":"nord"}}'
    ];
    for (const t of bad) {
        assert.deepEqual(S.parse(t), S.DEFAULTS, JSON.stringify(t));
    }
});

test('parse rejects a document larger than MAX_BYTES instead of processing it', () => {
    const huge = '{"ui":{"theme":"nord"},"pad":"' + 'x'.repeat(S.MAX_BYTES) + '"}';
    assert.ok(huge.length > S.MAX_BYTES);
    assert.deepEqual(S.parse(huge), S.DEFAULTS);
});

test('parse accepts the real thing, including a trailing newline', () => {
    const good = '{"ui":{"theme":"gruvbox"},"update":{"repo":"me/mine","checkOnStartup":false}}\n';
    assert.deepEqual(S.parse(good), {
        ui: { theme: 'gruvbox' },
        update: { repo: 'me/mine', checkOnStartup: false }
    });
});

test('parse rejects non-string input', () => {
    for (const v of [null, undefined, 42, {}, [], true, Buffer.from('{}')]) {
        assert.deepEqual(S.parse(v), S.DEFAULTS, String(typeof v));
    }
});

test('serialize round-trips through parse and ends with a newline', () => {
    const value = { ui: { theme: 'rosepine' }, update: { repo: 'a/b', checkOnStartup: false } };
    const text = S.serialize(value);
    assert.ok(text.endsWith('\n'), 'a config file is a text file');
    assert.deepEqual(S.parse(text), value);
    // serialize normalises too, so a hostile object cannot be written verbatim.
    assert.deepEqual(S.parse(S.serialize({ ui: { theme: 'a/b' }, secrets: { t: 'x' } })), S.DEFAULTS);
    assert.ok(!S.serialize({ secrets: { t: 'hunter2' } }).includes('hunter2'));
});

test('pathFor builds the documented per-user path', () => {
    assert.equal(S.pathFor('/home/user'), '/home/user/.config/cockpit/pilot/settings.json');
    assert.equal(S.pathFor('/home/user/'), '/home/user/.config/cockpit/pilot/settings.json');
    assert.equal(S.pathFor('/root'), '/root/.config/cockpit/pilot/settings.json');
    assert.equal(S.pathFor('/'), '/.config/cockpit/pilot/settings.json');
    assert.equal(S.dirFor('/home/user'), '/home/user/.config/cockpit/pilot');
    assert.equal(S.dirFor('/home/user/'), '/home/user/.config/cockpit/pilot');
});

test('pathFor rejects a home directory that is not a plain absolute path', () => {
    const hostile = [
        '', ' ', 'home/ismet', './home', '../home', '/home/../root',
        '/home/user/..', '/home/is\x00met', '/home/user\n', '/home/user\r',
        null, undefined, 42, {}, [], true
    ];
    for (const v of hostile) {
        assert.throws(() => S.pathFor(v), (e) => e.kind === 'GENERIC', JSON.stringify(String(v)));
        assert.throws(() => S.dirFor(v), (e) => e.kind === 'GENERIC', JSON.stringify(String(v)));
    }
});

test('pickHome extracts the home directory Cockpit reports, and rejects the rest', () => {
    assert.equal(S.pickHome({ home: '/home/user', user: 'ismet' }), '/home/user');
    for (const v of [null, undefined, {}, { home: '' }, { home: 42 }, { home: null },
        'string', 42, [], Object.create({ home: '/inherited' })]) {
        assert.throws(() => S.pickHome(v), (e) => e.kind === 'GENERIC', JSON.stringify(String(v)));
    }
});

test('read() falls back to defaults when Cockpit is absent rather than throwing', () => {
    // Units must run with no bridge. A settings read that threw at load would make
    // every consumer defensive for no reason.
    return S.read().then((v) => assert.deepEqual(v, S.DEFAULTS));
});

test('write() reports a clear PilotError when Cockpit is absent', () => {
    return S.write({ ui: { theme: 'nord' } }).then(
        () => assert.fail('write must not silently succeed with no bridge'),
        (e) => {
            assert.equal(e.kind, 'GENERIC');
            assert.match(e.message, /Cockpit/);
        });
});
