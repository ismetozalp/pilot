// Unit tests for the startup wiring that Task 19 closes: nothing before this task
// ever calls PilotApi.setTransport(...), so every surface built on top of it would
// render against an unset transport (spec: "the console is dead on arrival").
//
// js/app.js's init() is the natural place this runs — it already loads settings
// there. This file proves: the active server is resolved from the registry, a
// transport is built from it and handed to PilotApi.setTransport, the wiring runs
// as part of init(), a compatibility mismatch is recorded without blocking the
// wiring, and switching the active server re-wires the transport.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

require('../../js/core/errors.js');
require('../../js/core/api-client.js');   // sets globalThis.PilotApi / PilotApiClient
require('../../js/core/servers.js');
require('../../js/core/api-io.js');
const App = require('../../js/app.js');

const REC = {
    id: 'prod', host: 'rd.example.com', sshPort: 22, apiPort: 21114, tls: true,
    domain: null, hbbsKey: null, hbbsPorts: [], installDir: '/opt/rustdesk-api', createdAt: null
};

function fakeCockpit(overrides) {
    // A mutable store — not a frozen snapshot — so that setActive()'s write is
    // visible to the NEXT active()/read() call, exactly as the real file system
    // would behave. A prior version of this fixture used a static object and
    // switchServer() appeared to do nothing because the write never "landed".
    const files = Object.assign({
        '/etc/pilot/config.json': '{"activeServer":"prod"}',
        '/etc/pilot/servers/prod.json': JSON.stringify(REC),
        '/etc/pilot/servers/prod.token': 'TOK123\n'
    }, overrides || {});
    globalThis.cockpit = {
        spawn(argv) {
            if (argv[0] === 'find') return Promise.resolve('/etc/pilot/servers/prod.json\n');
            return Promise.resolve('');
        },
        file(p) {
            return {
                read() { return Promise.resolve(p in files ? files[p] : null); },
                replace(v) { files[p] = v; return Promise.resolve(); },
                close() {}
            };
        }
        // Deliberately no .http: proves wiring never needs the HTTP channel to
        // build the transport function, only to later USE it.
    };
}

function dropCockpit() { delete globalThis.cockpit; }

// setTransport is spied non-destructively: the real function still runs (so
// PilotApi stays usable for the probe), we just also record what it was given.
function spyOnSetTransport(t) {
    const real = globalThis.PilotApi.setTransport;
    const seen = [];
    globalThis.PilotApi.setTransport = function (fn) {
        seen.push(fn);
        return real(fn);
    };
    t.after(() => {
        globalThis.PilotApi.setTransport = real;
        real(null);
    });
    return seen;
}

test('wireApi: resolves the active server and calls PilotApi.setTransport with a function', async (t) => {
    fakeCockpit();
    t.after(dropCockpit);
    const seen = spyOnSetTransport(t);

    const c = App.pilotApp();
    await c.wireApi();

    assert.equal(seen.length, 1, 'setTransport was not called');
    assert.equal(typeof seen[0], 'function', 'setTransport was not given a function');
    assert.equal(c.activeServerId, 'prod');
    assert.equal(c.apiReady, true);
});

test('wireApi: no active server leaves the API unset, without throwing', async (t) => {
    fakeCockpit({ '/etc/pilot/config.json': '{}' });
    t.after(dropCockpit);
    const seen = spyOnSetTransport(t);

    const c = App.pilotApp();
    const result = await c.wireApi();

    assert.equal(result, null);
    assert.equal(c.apiReady, false);
    assert.equal(c.activeServerId, null);
    assert.equal(seen.length, 0, 'setTransport must not be called with nothing to wire');
});

test('wireApi: no Cockpit bridge at all does not throw', async (t) => {
    dropCockpit();
    const c = App.pilotApp();
    await assert.doesNotReject(c.wireApi());
    assert.equal(c.apiReady, false);
});

test('init() performs the wiring as part of startup', async (t) => {
    fakeCockpit();
    t.after(dropCockpit);
    const seen = spyOnSetTransport(t);

    const c = App.pilotApp();
    const self = await c.init();

    assert.equal(self, c, 'init() still returns the component');
    assert.equal(seen.length, 1, 'init() did not wire the transport');
    assert.equal(typeof seen[0], 'function');
});

test('wireApi: a compatibility mismatch is recorded but does not block the wiring', async (t) => {
    // The fake bridge above has no .http, so PilotApiIo's transport reports the
    // channel unavailable when the probe actually sends — API_UNREACHABLE, not a
    // thrown exception, and it must not undo the setTransport call already made.
    fakeCockpit();
    t.after(dropCockpit);
    spyOnSetTransport(t);

    const c = App.pilotApp();
    await c.wireApi();

    assert.equal(c.apiReady, true, 'a probe failure must not un-wire the transport');
    assert.equal(c.activeServerId, 'prod');
    assert.ok(c.compatError, 'the probe failure was silently dropped');
    assert.equal(c.compatError.kind, 'API_UNREACHABLE');
});

test('switchServer: re-wires the transport for the newly active server', async (t) => {
    const REC2 = Object.assign({}, REC, { id: 'staging', host: 'staging.example.com' });
    fakeCockpit({
        '/etc/pilot/servers/staging.json': JSON.stringify(REC2),
        '/etc/pilot/servers/staging.token': 'TOK456\n'
    });
    t.after(dropCockpit);
    const seen = spyOnSetTransport(t);

    const c = App.pilotApp();
    await c.wireApi();                 // wires 'prod'
    await c.switchServer('staging');   // must re-wire to 'staging'

    assert.equal(c.activeServerId, 'staging');
    assert.equal(seen.length, 2, 'switchServer must call setTransport again');
    assert.notEqual(seen[0], seen[1], 'switchServer reused the old server\'s transport function');
});

// Regression test for the CRITICAL review finding on Task 21: index.html now
// listens for 'pilot:server-changed' (the very event notifyServerChanged()
// dispatches below) and calls switchServer() again with that same id, so that
// js/features/overview.js's switcher — which only dispatches the event, never
// calls switchServer() directly — actually re-wires the transport. Without
// this guard that is switchServer() -> wireApi() -> notifyServerChanged() ->
// the shell listener -> switchServer() -> ... forever.
test('switchServer: a request for the server that is ALREADY active is a no-op (re-entrancy guard)', async (t) => {
    fakeCockpit();
    t.after(dropCockpit);
    const seen = spyOnSetTransport(t);
    let setActiveCalls = 0;
    const realSetActive = globalThis.PilotServers.setActive;
    globalThis.PilotServers.setActive = function (id) { setActiveCalls += 1; return realSetActive(id); };
    t.after(() => { globalThis.PilotServers.setActive = realSetActive; });

    const c = App.pilotApp();
    await c.wireApi();                // wires 'prod', activeServerId === 'prod'
    await c.switchServer('prod');      // the exact re-entrant call the shell listener would make

    assert.equal(c.activeServerId, 'prod', 'still prod');
    assert.equal(seen.length, 1, 'setTransport was not called a second time');
    assert.equal(setActiveCalls, 0, 'the registry was not written to again for a no-op switch');
});

test('switchServer: "local" is recognised as already-active when nothing is configured', async (t) => {
    fakeCockpit({ '/etc/pilot/config.json': '{}' });
    t.after(dropCockpit);
    const seen = spyOnSetTransport(t);

    const c = App.pilotApp();
    await c.wireApi();                 // no active server -> activeServerId stays null, event carries 'local'
    await c.switchServer('local');     // the shell listener re-dispatching that same 'local' id

    assert.equal(c.activeServerId, null);
    // wireApi() itself never calls setTransport when there is no active server
    // at all (it returns early) -- the guard's job here is simply to confirm
    // switchServer('local') does not try to proceed past that early return a
    // second, pointless time either.
    assert.equal(seen.length, 0, 'no setTransport call for the "nothing configured" case, either time');
});

test('wireApi: no token file at all is ordinary — tokenError stays null', async (t) => {
    // An explicit null (rather than omitting the key) exercises the same path
    // fakeCockpit's read() takes for a genuinely absent file: `p in files` is
    // true but the value is null, matching readSecret()'s own "absent" case.
    fakeCockpit({ '/etc/pilot/servers/prod.token': null });
    t.after(dropCockpit);
    spyOnSetTransport(t);

    const c = App.pilotApp();
    await c.wireApi();

    assert.equal(c.apiReady, true);
    assert.equal(c.tokenError, null, 'no token configured must not be reported as an error');
});

test('wireApi: a permissions error reading the token is recorded, distinct from "no token configured"', async (t) => {
    // MINOR fix: readSecret() rejecting (as it would on a genuine EACCES
    // reading the 0600 secret file) must not look identical to the ordinary
    // "no token was ever set" case — both previously left `token` as `null`
    // with nothing else to tell them apart.
    fakeCockpit();
    t.after(dropCockpit);
    spyOnSetTransport(t);
    const realFile = globalThis.cockpit.file;
    globalThis.cockpit.file = function (p, o) {
        if (p === '/etc/pilot/servers/prod.token') {
            return {
                read() { return Promise.reject(new Error('permission denied')); },
                replace(v) { return Promise.resolve(); },
                close() {}
            };
        }
        return realFile(p, o);
    };

    const c = App.pilotApp();
    await c.wireApi();

    assert.equal(c.apiReady, true,
        'an unreadable token must still fail safe to an anonymous request, not block wiring');
    assert.ok(c.tokenError, 'a genuine read failure on the token file must be recorded');
    assert.equal(c.tokenError.name, 'PilotError');
});

test('switchServer: rejects a hostile id before touching the transport', async (t) => {
    fakeCockpit();
    t.after(dropCockpit);
    const seen = spyOnSetTransport(t);

    const c = App.pilotApp();
    await c.wireApi();
    await assert.rejects(c.switchServer('../../etc'));

    assert.equal(seen.length, 1, 'a rejected switch must not have re-wired anything');
    assert.equal(c.activeServerId, 'prod', 'a rejected switch must not change the active server');
});

// --- pilot:server-changed ------------------------------------------------
//
// Every feature surface (starting with js/features/devices-ui.js) mounts
// with a placeholder server id and corrects it by listening for this event,
// so nothing downstream is reachable unless wireApi()/switchServer() ACTUALLY
// dispatch it. This is exactly the class of bug the project has hit twice
// before (a real trigger a surface's own tests never exercised) -- proven
// here directly against a fake document, and again live in
// tests/e2e/devices.e2e.mjs against the real DOM.

function installFakeDocument(t) {
    const events = [];
    const had = typeof globalThis.document !== 'undefined';
    const prior = had ? globalThis.document : undefined;
    globalThis.document = { dispatchEvent(ev) { events.push(ev); return true; } };
    t.after(() => { if (had) globalThis.document = prior; else delete globalThis.document; });
    return events;
}

test('wireApi: dispatches pilot:server-changed with the resolved server id', async (t) => {
    fakeCockpit();
    t.after(dropCockpit);
    spyOnSetTransport(t);
    const events = installFakeDocument(t);

    const c = App.pilotApp();
    await c.wireApi();

    assert.equal(events.length, 1, 'wireApi() must notify every listening surface');
    assert.equal(events[0].type, 'pilot:server-changed');
    assert.deepEqual(events[0].detail, { id: 'prod' });
});

test('wireApi: dispatches pilot:server-changed with "local" when nothing is configured', async (t) => {
    fakeCockpit({ '/etc/pilot/config.json': '{}' });
    t.after(dropCockpit);
    spyOnSetTransport(t);
    const events = installFakeDocument(t);

    const c = App.pilotApp();
    await c.wireApi();

    assert.equal(events.length, 1, 'a surface still needs to hear SOMETHING, even with no active server');
    assert.deepEqual(events[0].detail, { id: 'local' });
});

test('switchServer: dispatches pilot:server-changed again for the newly active server', async (t) => {
    const REC2 = Object.assign({}, REC, { id: 'staging', host: 'staging.example.com' });
    fakeCockpit({
        '/etc/pilot/servers/staging.json': JSON.stringify(REC2),
        '/etc/pilot/servers/staging.token': 'TOK456\n'
    });
    t.after(dropCockpit);
    spyOnSetTransport(t);
    const events = installFakeDocument(t);

    const c = App.pilotApp();
    await c.wireApi();                 // dispatches 'prod'
    await c.switchServer('staging');   // must dispatch 'staging' too

    assert.equal(events.length, 2, 'switchServer must notify surfaces again, not just re-wire the transport');
    assert.deepEqual(events[0].detail, { id: 'prod' });
    assert.deepEqual(events[1].detail, { id: 'staging' });
});

// --- GAP B (task 33): 'pilot:open-wizard' had zero production listeners ---
// js/features/server-ops-ui.js's "Run setup" and js/features/overview.js's
// "Set up TLS" both dispatch this event, and until now nothing outside a test
// harness ever listened — clicking either button left #pilot-setup hidden and
// the tab unchanged. index.html wires @pilot:open-wizard.document="openWizard(...)"
// on .pilot-shell, exactly the same shape as its existing pilot:server-changed
// listener.

test('openWizard: switches to the Setup tab', () => {
    const c = App.pilotApp();
    c.tab = 'overview';
    c.openWizard({});
    assert.equal(c.tab, 'setup');
});

test('openWizard: switches to the Setup tab even with a step-carrying detail ' +
    '(overview.js sends {step:"tls", serverId})', () => {
    const c = App.pilotApp();
    c.tab = 'overview';
    c.openWizard({ step: 'tls', serverId: 'prod' });
    assert.equal(c.tab, 'setup');
});

// Unlike switchServer()'s re-entrancy guard against notifyServerChanged()
// re-dispatching the very event its own listener reacts to, openWizard()
// never dispatches 'pilot:open-wizard' itself — there is no cycle to guard
// against, only a plain state change. This proves it stays that way.
test('openWizard: never dispatches pilot:open-wizard itself (no re-entrancy loop to build a guard for)', () => {
    const c = App.pilotApp();
    const events = [];
    const fakeDoc = { dispatchEvent(ev) { events.push(ev); return true; } };
    const realDoc = typeof globalThis.document !== 'undefined' ? globalThis.document : undefined;
    globalThis.document = fakeDoc;
    try {
        c.openWizard({});
    } finally {
        if (realDoc === undefined) delete globalThis.document; else globalThis.document = realDoc;
    }
    assert.equal(events.length, 0);
});

test('openWizard: a malformed or missing detail never throws', () => {
    const c = App.pilotApp();
    for (const bad of [null, undefined, 'x', 42, []]) {
        c.tab = 'overview';
        assert.doesNotThrow(() => c.openWizard(bad));
        assert.equal(c.tab, 'setup');
    }
});
