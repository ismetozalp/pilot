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
