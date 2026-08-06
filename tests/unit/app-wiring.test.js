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
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

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

// Task 34: this USED to assert switchServer('local') was a flat no-op here
// (the guard compared against `this.activeServerId || 'local'`, so "nothing
// configured" and "local already active" looked identical). That fallback is
// gone now: js/features/setup-ui.js's registerServer() can create a REAL
// /etc/pilot/servers/local.json for the very first time mid-session, and the
// shell's switchServer('local') -- fired by wireApi()'s own initial
// notifyServerChanged(null) fallback -- has to be able to notice that once it
// exists (see the NEXT test). Here nothing was ever registered, so the
// outcome is unchanged in the one way that matters (no transport gets wired
// to a server with no record) -- it is simply reached by genuinely trying
// and failing safe (wireApi()'s own read() catch), not by a guard refusing
// to try at all.
test('switchServer: "local" with nothing configured genuinely tries to wire it and fails safe ' +
    '(no record exists yet -- there is simply nothing TO wire)', async (t) => {
    fakeCockpit({ '/etc/pilot/config.json': '{}' });
    t.after(dropCockpit);
    const seen = spyOnSetTransport(t);

    const c = App.pilotApp();
    await c.wireApi();                 // no active server -> activeServerId stays null, event carries 'local'
    await c.switchServer('local');     // the shell listener re-dispatching that same 'local' id

    assert.equal(c.activeServerId, null, 'no transport was ever successfully wired to "local"');
    assert.equal(seen.length, 0, 'no setTransport call -- there is still no local.json to wire it from');
    assert.ok(c.compatError, 'the failed read (no such record) is recorded, not silently dropped');
});

// The scenario the fix above exists for: once a real record for "local"
// shows up (exactly what registerServer() does), the SAME re-dispatch that
// used to be swallowed as "already active" must now really wire it.
test('switchServer: "local" DOES get wired once a real record for it appears mid-session', async (t) => {
    const LOCAL_REC = Object.assign({}, REC, { id: 'local', host: 'localhost' });
    fakeCockpit({
        '/etc/pilot/config.json': '{}',
        '/etc/pilot/servers/local.json': JSON.stringify(LOCAL_REC)
    });
    t.after(dropCockpit);
    const seen = spyOnSetTransport(t);

    const c = App.pilotApp();
    await c.wireApi();                 // nothing configured yet -> activeServerId stays null
    assert.equal(seen.length, 0, 'nothing to wire on the very first attempt');

    await c.switchServer('local');     // the exact re-dispatch registerServer() triggers after writing the record

    assert.equal(c.activeServerId, 'local', 'the newly-registered server must actually become active');
    assert.equal(c.apiReady, true);
    assert.equal(seen.length, 1, 'the transport must actually get wired now that a record exists');
});

// The real live-Cockpit regression this task's own live tier caught: with no
// try/catch, a PilotServers.setActive() rejection (e.g. /etc/pilot not yet
// writable in this session) was an UNHANDLED exception on every ordinary page
// load with nothing configured, not merely a failed switch -- because the
// old guard's blanket no-op meant this line was, in practice, never reached
// before.
test('switchServer: a setActive() rejection is recorded, never thrown, and wireApi() still runs', async (t) => {
    fakeCockpit({ '/etc/pilot/config.json': '{}' });
    t.after(dropCockpit);
    spyOnSetTransport(t);
    const realSetActive = globalThis.PilotServers.setActive;
    globalThis.PilotServers.setActive = function () {
        return Promise.reject(Object.assign(new Error('could not setActive /etc/pilot/config.json'),
            { name: 'PilotError', kind: 'GENERIC' }));
    };
    t.after(() => { globalThis.PilotServers.setActive = realSetActive; });

    const c = App.pilotApp();
    await c.wireApi();
    await assert.doesNotReject(c.switchServer('local'));

    assert.ok(c.switchError, 'the rejection must be recorded somewhere the shell can see');
    assert.match(c.switchError.message, /could not setActive/);
});

test('switchServer: a hostile id still rejects loudly, even with the setActive() try/catch in place', async (t) => {
    fakeCockpit();
    t.after(dropCockpit);
    spyOnSetTransport(t);

    const c = App.pilotApp();
    await c.wireApi();
    await assert.rejects(c.switchServer('../../etc'));
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

// ============================================== FINAL REVIEW, FINDING 2 ======
//
// Every piece of state js/app.js writes must be rendered by index.html or not
// exist. apiReady, compatError, switchError and tokenError were all write-only:
// the shell recorded them and no template ever read one. This is the structural
// guard against that class returning — a new property that nothing renders now
// has to be added to this list deliberately, with a reason.
test('every state slot js/app.js writes is actually rendered by index.html', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    // Inside a real Alpine binding — not merely mentioned in a comment or a
    // data-testid, which is how a "rendered" claim can be true of a string and
    // false of the page.
    for (const name of ['apiReady', 'compatError', 'switchError', 'tokenError', 'activeServerId']) {
        const bound = new RegExp('(?:x-show|x-text)="[^"]*\\b' + name + '\\b');
        assert.ok(bound.test(html),
            `js/app.js writes ${name} but no x-show/x-text in index.html reads it — render it or delete it`);
    }
});

// ------------------------------- the TLS endpoint is the domain, not the host

// Captures the Conn that wireApi() hands to PilotApiIo.transport(), which is
// the whole decision under test: an https request to the wrong address fails
// no matter how healthy the server is.
// app.js reads root.PilotServers directly, so that object IS the seam.
function fakeRecord(t, rec) {
    const S = globalThis.PilotServers;
    const saved = { active: S.active, read: S.read, readSecret: S.readSecret,
        probeCompatibility: S.probeCompatibility };
    S.active = () => Promise.resolve(rec.id);
    S.read = () => Promise.resolve(rec);
    S.readSecret = () => Promise.resolve(null);
    S.probeCompatibility = () => Promise.resolve({ ok: true });
    const restore = () => Object.assign(S, saved);
    t.after(restore);
    return restore;
}

function spyOnTransport(t) {
    const Io = globalThis.PilotApiIo;
    const real = Io.transport;
    const seen = [];
    Io.transport = function (conn) { seen.push(conn); return real(conn); };
    t.after(() => { Io.transport = real; });
    return seen;
}

test('wireApi: a TLS server is reached at its DOMAIN on 443, not at host:apiPort', async (t) => {
    // FROM THE FIELD. The record read:
    //   host ec2-203-0-113-10...amazonaws.com, apiPort 21114, tls true,
    //   domain 203.0.113.10.sslip.io
    // and wireApi() built {address: host, port: apiPort, tls: true} -- an https
    // request to port 21114, which serves plain HTTP and has no certificate for
    // that name. The console reported "the API server could not be reached"
    // while https://203.0.113.10.sslip.io/api/version returned 200.
    fakeCockpit();
    t.after(dropCockpit);
    const conns = spyOnTransport(t);

    const restore = fakeRecord(t, {
        id: 's1', host: 'ec2-1-2-3-4.compute.amazonaws.com', apiPort: 21114,
        tls: true, domain: 'rd.example.com'
    });
    const c = App.pilotApp();
    await c.wireApi();
    restore();

    assert.equal(conns.length, 1, 'exactly one transport should be built');
    assert.equal(conns[0].address, 'rd.example.com',
        'the certificate is issued for the domain, not the instance hostname');
    assert.equal(conns[0].port, 443,
        'Caddy holds 443 and proxies to 21114 on loopback; the client appends no port (C17)');
    assert.equal(conns[0].tls, true);
});

test('wireApi: without TLS it still goes to host:apiPort in plain HTTP', async (t) => {
    fakeCockpit();
    t.after(dropCockpit);
    const conns = spyOnTransport(t);

    const restore = fakeRecord(t, { id: 's1', host: 'rd.internal', apiPort: 21114, tls: false, domain: '' });
    const c = App.pilotApp();
    await c.wireApi();
    restore();
    assert.equal(conns[0].address, 'rd.internal');
    assert.equal(conns[0].port, 21114);
    assert.equal(conns[0].tls, false);
});

test('wireApi: tls true with NO domain falls back rather than inventing an endpoint', async (t) => {
    // tls:true and no domain is a contradiction the record should never hold,
    // but if it does, connecting to ""|443 would be strictly worse than
    // connecting to the host that at least exists.
    fakeCockpit();
    t.after(dropCockpit);
    const conns = spyOnTransport(t);

    const restore = fakeRecord(t, { id: 's1', host: 'rd.internal', apiPort: 21114, tls: true, domain: null });
    const c = App.pilotApp();
    await c.wireApi();
    restore();
    assert.equal(conns[0].address, 'rd.internal');
    assert.equal(conns[0].port, 21114);
});
