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


// ============ FIELD REPORT: "where is the check for update and update buttons"
//
// The tab showed three repositories and no way to act on any of them. The fields
// choose WHERE Pilot looks; they do not perform an update. Pilot updates itself
// from the header badge, and the two server-side components are day-2 operations
// on a remote host, so they live on Server Ops with the other ones -- but
// nothing on this page said so.

test('the tab explains where each update is actually applied', () => {
    const t = UI.TEMPLATE;
    assert.match(t, /Applying updates/, 'the page must answer "so where do I click"');
    assert.match(t, /version badge/, 'Pilot updates itself from the header');
    assert.match(t, /Server Ops/, 'the two server-side components are day-2 operations');
    assert.match(t, /Check for updates/, 'and it names the action to run first');
});

test('the page routes to Server Ops rather than only describing it', () => {
    const t = UI.TEMPLATE;
    assert.match(t, /data-testid="settings-goto-ops"/);
    // A generic tab event, not the wizard-specific one: this is not the wizard.
    assert.match(t, /pilot:open-tab/);
    assert.match(t, /id: 'server-ops'/);
});


// ===== FIELD REPORT: "put somewhere check for updates for api server and rustdesk server repository"
//
// The Server Ops check answers "is there something newer than what is
// INSTALLED", and needs the target host to do it. This one is narrower and
// belongs beside the fields: does this repository exist, can Pilot reach it,
// and what is the newest thing in it. That catches a typo'd repo immediately
// instead of it staying silent until an update check quietly finds nothing.

function fakeSpawn(handler) {
    const calls = [];
    globalThis.cockpit = { spawn: (argv, opts) => { calls.push(argv); return handler(argv, opts); } };
    return calls;
}

test('checkRepos looks up each configured repository and reports the newest release', async () => {
    const calls = fakeSpawn(async () => JSON.stringify({ tag_name: 'v2.7', published_at: '2025-09-28T15:12:00Z' }));
    try {
        const c = UI.settingsUi({ settings: fakeStore() });
        await c.load();
        await c.checkRepos();
        assert.equal(calls.length, 3, 'one lookup per configured field');
        for (const k of UI.FIELD_KEYS) {
            assert.equal(c.latestFor(k).ok, true, k);
            assert.equal(c.latestFor(k).tag, 'v2.7');
            assert.equal(c.latestFor(k).published, '2025-09-28', 'the date is trimmed to a day');
        }
        // Every request must go through the host: manifest.json sets
        // connect-src 'self', so a browser fetch() to api.github.com is blocked.
        for (const argv of calls) {
            assert.equal(argv[0], 'curl');
            assert.ok(argv.some((a) => /^https:\/\/api\.github\.com\/repos\//.test(a)), argv.join(' '));
        }
    } finally { delete globalThis.cockpit; }
});

test('an empty field is skipped, not reported as a failure', async () => {
    const calls = fakeSpawn(async () => JSON.stringify({ tag_name: 'v1' }));
    try {
        const c = UI.settingsUi({ settings: fakeStore() });
        await c.load();
        c.values.apiRepo = '';
        await c.checkRepos();
        assert.equal(c.latestFor('apiRepo'), null, 'an opt-out is not an error');
        assert.equal(calls.length, 2, 'and it costs no request');
    } finally { delete globalThis.cockpit; }
});

test('a repository that does not exist says so plainly, not "curl exited 22"', async () => {
    fakeSpawn(async () => { throw new Error('curl: (22) The requested URL returned error: 404'); });
    try {
        const c = UI.settingsUi({ settings: fakeStore() });
        await c.load();
        await c.checkRepos();
        const r = c.latestFor('apiRepo');
        assert.equal(r.ok, false);
        assert.match(r.message, /No such repository, or it is private/,
            'the operator needs the cause, not curl\'s exit status');
    } finally { delete globalThis.cockpit; }
});

test('a repository with no releases is distinguished from one that is missing', async () => {
    fakeSpawn(async () => JSON.stringify({ message: 'Not Found' }));
    try {
        const c = UI.settingsUi({ settings: fakeStore() });
        await c.load();
        await c.checkRepos();
        assert.equal(c.latestFor('repo').ok, false);
        assert.match(c.latestFor('repo').message, /published no release/);
    } finally { delete globalThis.cockpit; }
});

test('checking never throws, and always clears its busy flag', async () => {
    fakeSpawn(async () => { throw new Error('network is unreachable'); });
    try {
        const c = UI.settingsUi({ settings: fakeStore() });
        await c.load();
        await c.checkRepos();
        assert.equal(c.checking, false, 'a failed check must not leave the button spinning');
        assert.equal(c.latestFor('repo').ok, false);
    } finally { delete globalThis.cockpit; }
});

test('with no cockpit the check reports it rather than crashing the surface', async () => {
    const c = UI.settingsUi({ settings: fakeStore() });
    await c.load();
    await c.checkRepos();
    assert.equal(c.latestFor('repo').ok, false);
    assert.match(c.latestFor('repo').message, /Cockpit is not available/);
});

test('the result renders per field, and distinguishes success from failure', () => {
    const t = UI.TEMPLATE;
    assert.match(t, /data-testid="settings-check"/, 'the button exists');
    assert.ok(t.indexOf("'settings-' + f.key + '-latest'") !== -1,
        'each field shows its own result');
    assert.match(t, /text-success/);
    assert.match(t, /text-danger/, 'a failure must not read like a success');
    assert.match(t, /Latest release: /);
    // Same spinner trap as everywhere else in this codebase.
    const spinners = t.match(/<span class="spinner-border[^>]*>/g) || [];
    assert.ok(spinners.length >= 2, 'both the check and the save button spin');
    for (const sp of spinners) assert.ok(!/x-show/.test(sp), 'x-show loses to a display utility');
});
