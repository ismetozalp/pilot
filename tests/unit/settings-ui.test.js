// tests/unit/settings-ui.test.js — the Settings surface.
//
// The point of this surface is that Pilot installs THREE separate projects from
// three separate upstreams, and they are easy to conflate: the fork adopted for
// hbbs/hbbr is not the API, and neither is Pilot. Pointing a field at the wrong
// one produces update checks against software the operator does not run, which
// fails quietly -- so most of what is asserted here is that the three stay
// distinct and that a bad value is refused where it was typed.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

require('../../js/core/errors.js');
const Settings = require('../../js/core/settings.js');
const Update = require('../../js/features/update.js');
const UI = require('../../js/features/settings-ui.js');

function fakeStore(doc) {
    const state = { written: null, doc: doc === undefined ? { ui: { theme: 'nord' }, update: Settings.DEFAULTS.update } : doc };
    return {
        DEFAULTS: Settings.DEFAULTS,
        isSafeRepo: Settings.isSafeRepo,
        read: async () => state.doc,
        write: async (v) => { state.written = v; state.doc = v; return v; },
        state
    };
}

test('module loads with no DOM and no cockpit', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof UI.settingsUi, 'function');
    assert.equal(typeof globalThis.pilotSettings, 'function');
});

test('the form offers exactly the three components, each explained', () => {
    assert.deepEqual(UI.FIELD_KEYS, ['repo', 'apiRepo', 'serverRepo']);
    for (const f of UI.FIELDS) {
        assert.ok(f.label && f.label.length > 3, f.key + ' needs a label');
        // "API repository" alone does not say WHICH RustDesk project it means.
        assert.ok(f.why && f.why.length > 30, f.key + ' must say which project it is');
    }
    const api = UI.FIELDS.find((f) => f.key === 'apiRepo');
    assert.match(api.why, /NOT the same project/i,
        'the API and the server are the pair most likely to be confused');
});

test('validateRepo accepts owner/name and a github URL, and refuses the rest', () => {
    for (const good of ['ismetozalp/pilot', 'lejianwen/rustdesk-api',
        'https://github.com/wy414012/rustdesk-server', 'https://github.com/a/b.git'])
        assert.equal(UI.validateRepo(good).ok, true, good);
    for (const bad of ['one', 'a/b/c', '../etc', 'a b/c', 'https://evil.example/a/b'])
        assert.equal(UI.validateRepo(bad).ok, false, bad);
});

test('an empty repo is valid and means "stop checking this one"', () => {
    // Not an error: it is how a component is opted out of update checks.
    for (const v of ['', '   ']) {
        const r = UI.validateRepo(v);
        assert.equal(r.ok, true, JSON.stringify(v));
        assert.equal(r.value, '');
    }
});

test('validation agrees with BOTH owners of the rule, not a third copy', () => {
    // A value that may be stored but cannot be fetched would be saved and then
    // silently never checked. Both gates must pass.
    for (const v of ['ismetozalp/pilot', 'lejianwen/rustdesk-api', 'wy414012/rustdesk-server']) {
        assert.equal(Settings.isSafeRepo(v), true, v + ' storable');
        assert.ok(Update.releasesApiUrl(v), v + ' fetchable');
        assert.equal(UI.validateRepo(v).ok, true, v);
    }
});

test('a pasted github URL is stored as owner/name', () => {
    assert.equal(UI.normalizeRepo('https://github.com/ismetozalp/pilot'), 'ismetozalp/pilot');
    assert.equal(UI.normalizeRepo('https://github.com/a/b.git'), 'a/b');
    assert.equal(UI.normalizeRepo('a/b'), 'a/b');
    assert.equal(UI.normalizeRepo('  '), '');
});

test('load() fills every field from the stored document', async () => {
    const c = UI.settingsUi({ settings: fakeStore() });
    await c.load();
    assert.equal(c.values.repo, 'ismetozalp/pilot');
    assert.equal(c.values.apiRepo, 'lejianwen/rustdesk-api');
    assert.equal(c.values.serverRepo, 'wy414012/rustdesk-server');
    assert.equal(c.checkOnStartup, true);
});

test('save() preserves the theme -- another surface owns it in the same file', async () => {
    const store = fakeStore();
    const c = UI.settingsUi({ settings: store });
    await c.load();
    c.values.apiRepo = 'me/myapi';
    assert.equal(await c.save(), true);
    assert.equal(store.state.written.update.apiRepo, 'me/myapi');
    assert.equal(store.state.written.ui.theme, 'nord',
        'a wholesale write would erase the theme this surface does not own');
});

test('save() refuses an invalid field and says which one', async () => {
    const store = fakeStore();
    const c = UI.settingsUi({ settings: store });
    await c.load();
    c.values.serverRepo = 'not a repo';
    assert.equal(await c.save(), false);
    assert.ok(c.fieldError('serverRepo'), 'the error belongs on the field that caused it');
    assert.equal(c.fieldError('repo'), '', 'and not on the others');
    assert.equal(store.state.written, null, 'nothing may be written when a field is invalid');
});

test('save() normalises a URL before storing it', async () => {
    const store = fakeStore();
    const c = UI.settingsUi({ settings: store });
    await c.load();
    c.values.repo = 'https://github.com/ismetozalp/pilot';
    assert.equal(await c.save(), true);
    assert.equal(store.state.written.update.repo, 'ismetozalp/pilot');
});

test('a cleared field is saved as empty, not silently restored', async () => {
    const store = fakeStore();
    const c = UI.settingsUi({ settings: store });
    await c.load();
    c.values.apiRepo = '';
    assert.equal(await c.save(), true);
    assert.equal(store.state.written.update.apiRepo, '',
        'clearing must stick, or the field can never be turned off');
});

test('restore defaults writes the three real upstreams', async () => {
    const store = fakeStore();
    const c = UI.settingsUi({ settings: store });
    await c.load();
    c.values.repo = 'x/y'; c.values.apiRepo = ''; c.values.serverRepo = 'p/q';
    assert.equal(await c.resetDefaults(), true);
    assert.deepEqual(store.state.written.update.repo, Settings.DEFAULTS.update.repo);
    assert.deepEqual(store.state.written.update.apiRepo, Settings.DEFAULTS.update.apiRepo);
    assert.deepEqual(store.state.written.update.serverRepo, Settings.DEFAULTS.update.serverRepo);
});

test('no store available is reported, never thrown', async () => {
    const c = UI.settingsUi({ settings: { DEFAULTS: Settings.DEFAULTS } });
    await c.load();
    assert.ok(c.error, 'a missing store must surface as an error');
    assert.equal(await c.save(), false);
});

test('the template renders every field, its explanation and its error slot', () => {
    const t = UI.TEMPLATE;
    assert.match(t, /x-for="f in fields"/, 'the form is driven by the table, not hand-written thrice');
    assert.match(t, /x-text="f\.why"/, 'each field explains which project it is');
    assert.match(t, /data-testid="settings-save"/);
    assert.match(t, /data-testid="settings-reset"/);
    assert.match(t, /x-model="checkOnStartup"/);
    // The spinner trap this codebase already hit twice: x-show loses to a
    // Bootstrap display utility marked !important.
    const spinner = /<span class="spinner-border[^>]*>/.exec(t);
    assert.ok(spinner && !/x-show/.test(spinner[0]), 'the spinner must be x-if, not x-show');
    assert.ok(t.indexOf('x-html') === -1, 'no x-html anywhere');
});
