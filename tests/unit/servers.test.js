'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Errors = require('../../js/core/errors.js');
const C = require('../../js/core/api-client.js');   // puts PilotApiClient on the global
const S = require('../../js/core/servers.js');

const SRC = path.join(__dirname, '../../js/core/servers.js');
const INDEX = path.join(__dirname, '../../index.html');

const C7 = ['js/alpine.min.js', 'js/bootstrap.bundle.min.js', 'js/core/errors.js',
    'js/core/semver.js', 'js/core/themes.js', 'js/core/settings.js', 'js/core/ostarget.js',
    'js/core/ports.js', 'js/core/firewall.js', 'js/core/tls.js', 'js/core/provision-plan.js',
    'js/core/redact.js', 'js/core/servers.js', 'js/core/api-io.js', 'js/core/api-client.js',
    'js/core/addressbook.js', 'js/features/update.js', 'js/features/setup-ui.js',
    'js/features/devices-ui.js', 'js/features/addressbook-ui.js', 'js/features/users-ui.js',
    'js/features/audit-ui.js', 'js/features/server-ops-ui.js', 'js/features/overview.js',
    'js/app.js', 'js/boot.js'];

function typed(fn, kind, what) {
    let caught = null;
    try { fn(); } catch (e) { caught = e; }
    assert.ok(caught, 'no throw for ' + what);
    assert.equal(caught.name, 'PilotError', 'untyped error for ' + what);
    assert.equal(caught.kind, kind, 'wrong kind for ' + what);
}

function dropCockpit() { delete globalThis.cockpit; }

function fakeCockpit(opts) {
    opts = opts || {};
    const calls = { spawn: [], file: [], replace: [], closes: 0 };
    globalThis.cockpit = {
        spawn(argv, o) {
            calls.spawn.push({ argv, opts: o });
            if (opts.spawnRejectsWith && argv[0] === 'find') {
                return Promise.reject(opts.spawnRejectsWith);
            }
            if (opts.spawnFailsOn && argv[0] === opts.spawnFailsOn) {
                return Promise.reject(new Error(argv[0] + ': failed'));
            }
            if (argv[0] === 'find') return Promise.resolve(opts.listing === undefined ? '' : opts.listing);
            return Promise.resolve('');
        },
        file(p, o) {
            calls.file.push({ path: p, opts: o });
            return {
                read() {
                    if (opts.readFails) return Promise.reject(opts.readFails);
                    const files = opts.files || {};
                    return Promise.resolve(p in files ? files[p] : null);
                },
                replace(v) {
                    calls.replace.push({ path: p, value: v });
                    if (opts.replaceFails) return Promise.reject(opts.replaceFails);
                    return Promise.resolve();
                },
                close() { calls.closes++; }
            };
        }
    };
    return calls;
}

// Real cockpit.js does NOT hand back a native Promise from cockpit.file()/
// cockpit.spawn() -- it is a home-grown "deferred" (cockpit.defer()) whose
// .then() invokes the resolve/reject callbacks SYNCHRONOUSLY, directly from
// whatever dispatched the underlying channel's close event, with no
// surrounding try/catch of its own. A callback that THROWS therefore escapes
// as a genuine, unhandled top-level exception -- never a promise rejection --
// because the throw happens deep inside a real browser event dispatch, long
// after any of Pilot's own try/catch blocks have returned. This is invisible
// to a fakeCockpit built on native Promise.resolve/reject (GAP A task 33):
// those settle asynchronously via the microtask queue, which already has the
// safety net real cockpit.js lacks. hostileFileCockpit reproduces the real
// shape closely enough to catch a `throw e` regression before it reaches a
// live Cockpit session.
function hostileFileCockpit(opts) {
    opts = opts || {};
    const calls = { spawn: [], file: [], replace: [], closes: 0 };
    const handlers = []; // one entry per handle.read()/replace() call
    globalThis.cockpit = {
        spawn(argv, o) {
            calls.spawn.push({ argv, opts: o });
            return Promise.resolve('');
        },
        file(p, o) {
            calls.file.push({ path: p, opts: o });
            function hostileThenable(kind) {
                return {
                    then(onFulfilled, onRejected) {
                        handlers.push({ path: p, kind, onFulfilled, onRejected });
                        // Real cockpit.js returns the SAME deferred's .promise
                        // from further .then() calls under the hood; nothing
                        // here needs to chain further for this test.
                        return { then() {} };
                    }
                };
            }
            return {
                read() { return hostileThenable('read'); },
                replace(v) {
                    calls.replace.push({ path: p, value: v });
                    return hostileThenable('replace');
                },
                close() { calls.closes++; }
            };
        }
    };
    return { calls, handlers };
}

const REC = {
    id: 'prod', host: 'rd.example.com', sshPort: 22, apiPort: 21114, tls: true,
    domain: 'rd.example.com', hbbsKey: 'AbC+/123=', hbbsPorts: [21115, 21116, 21117],
    installDir: '/opt/rustdesk-api', createdAt: '2026-08-03T20:45:00Z'
};

// ------------------------------------------------------------------ validateId ---

test('validateId: accepts the documented id shape', () => {
    ['prod', 'a', '9', 'staging-2', 'a-b-c', 'a'.repeat(64)].forEach((id) =>
        assert.equal(S.validateId(id), id));
});

[['empty', ''], ['null', null], ['undefined', undefined], ['number', 1], ['object', {}],
    ['array', ['prod']], ['boolean', true], ['uppercase', 'Prod'], ['underscore', 'a_b'],
    ['dot', 'a.b'], ['leading dash', '-prod'], ['leading digit is fine but bare dash is not', '-'],
    ['space', 'a b'], ['leading space', ' prod'], ['trailing space', 'prod '],
    ['slash', 'a/b'], ['backslash', 'a\\b'], ['dot dot', '..'], ['traversal', '../../etc/shadow'],
    ['leading slash', '/etc/passwd'], ['NUL', 'prod\x00'], ['newline', 'prod\nx'],
    ['CR', 'prod\r'], ['tab', 'prod\tx'], ['DEL', 'prod\x7f'], ['unicode', 'pröd'],
    ['emoji', 'prod\u{1f4be}'], ['zero width joiner', 'pro\u200dd'],
    ['url encoded traversal', '%2e%2e%2f'], ['too long', 'a'.repeat(65)],
    ['pathological', 'a'.repeat(100000)]
].forEach(([label, id]) => {
    test('validateId: rejects an id that is ' + label, () => {
        typed(() => S.validateId(id), Errors.KIND.GENERIC, label);
    });
});

test('validateId: a pathological id is rejected promptly, on length first', () => {
    const started = Date.now();
    typed(() => S.validateId('a'.repeat(1000000)), Errors.KIND.GENERIC, 'huge');
    assert.ok(Date.now() - started < 1000, 'length guard is not short-circuiting');
});

// -------------------------------------------------------------------- paths ---

test('recordPath and secretPath stay inside the registry directory', () => {
    assert.equal(S.recordPath('prod'), '/etc/pilot/servers/prod.json');
    assert.equal(S.secretPath('prod', 'token'), '/etc/pilot/servers/prod.token');
    assert.equal(S.secretPath('prod', 'ssh'), '/etc/pilot/servers/prod.ssh');
    ['prod', 'a', 'staging-2'].forEach((id) => {
        const p = S.recordPath(id);
        assert.equal(p, path.normalize(p));
        assert.equal(path.dirname(p), S.SERVER_DIR);
    });
});

test('secretPath rejects an unknown secret kind and a hostile id', () => {
    typed(() => S.secretPath('prod', 'passwd'), Errors.KIND.GENERIC, 'unknown kind');
    typed(() => S.secretPath('prod', '../shadow'), Errors.KIND.GENERIC, 'traversal kind');
    typed(() => S.secretPath('../../etc/shadow', 'token'), Errors.KIND.GENERIC, 'traversal id');
});

// ------------------------------------------------------------- parseListing ---

test('parseListing: keeps only .json files that really live in the registry directory', () => {
    const listing = [
        '/etc/pilot/servers/prod.json',
        '/etc/pilot/servers/staging-2.json',
        '/etc/pilot/servers/../../etc/shadow.json',   // the round-2 regression
        '/etc/pilot/servers/nested/evil.json',
        '/etc/pilot/servers/notes.txt',
        '/etc/pilot/servers/.json',
        '/etc/pilot/servers/UPPER.json',
        '/etc/pilot/servers/prod.json',               // duplicate
        '/etc/shadow.json',
        'prod.json',
        '',
        '   '
    ].join('\n');
    assert.deepEqual(S.parseListing(listing), ['prod', 'staging-2']);
});

test('parseListing: an over-long or malformed basename never becomes an id', () => {
    const listing = [
        '/etc/pilot/servers/' + 'a'.repeat(65) + '.json',
        '/etc/pilot/servers/a b.json',
        '/etc/pilot/servers/a\x00b.json',
        '/etc/pilot/servers/-lead.json'
    ].join('\n');
    assert.deepEqual(S.parseListing(listing), []);
});

test('parseListing: tolerates CRLF, a trailing newline and non-string input', () => {
    assert.deepEqual(S.parseListing('/etc/pilot/servers/prod.json\r\n'), ['prod']);
    assert.deepEqual(S.parseListing(''), []);
    assert.deepEqual(S.parseListing(null), []);
    assert.deepEqual(S.parseListing(undefined), []);
    assert.deepEqual(S.parseListing(42), []);
});

// ---------------------------------------------------------- normalizeRecord ---

test('normalizeRecord: round-trips a complete record', () => {
    assert.deepEqual(S.normalizeRecord(REC), REC);
});

test('normalizeRecord: strips every secret-looking field, structurally', () => {
    const out = S.normalizeRecord(Object.assign({}, REC, {
        token: 'T0KEN', password: 'hunter2', pem: '-----BEGIN', ssh: 'x', secret: 'y',
        __proto__: { injected: true }
    }));
    const text = JSON.stringify(out);
    ['T0KEN', 'hunter2', 'BEGIN', 'token', 'password', 'pem', 'secret'].forEach((needle) =>
        assert.equal(text.indexOf(needle), -1, 'record leaked ' + needle + ': ' + text));
    assert.deepEqual(Object.keys(out).sort(), Object.keys(REC).sort());
});

test('normalizeRecord: applies the documented defaults', () => {
    const out = S.normalizeRecord({ id: 'prod', host: 'h' });
    assert.equal(out.sshPort, 22);
    assert.equal(out.apiPort, 21114);
    assert.equal(out.tls, false);
    assert.equal(out.domain, null);
    assert.equal(out.hbbsKey, null);
    assert.deepEqual(out.hbbsPorts, []);
    assert.equal(out.installDir, '/opt/rustdesk-api');
});

[['no id', { host: 'h' }], ['bad id', { id: 'A', host: 'h' }], ['no host', { id: 'prod' }],
    ['empty host', { id: 'prod', host: '' }], ['host with a space', { id: 'prod', host: 'a b' }],
    ['host with a newline', { id: 'prod', host: 'a\nb' }],
    ['host with a NUL', { id: 'prod', host: 'a\x00b' }],
    ['oversized host', { id: 'prod', host: 'a'.repeat(256) }],
    ['bad apiPort', { id: 'prod', host: 'h', apiPort: 0 }],
    ['float sshPort', { id: 'prod', host: 'h', sshPort: 22.5 }],
    ['string apiPort', { id: 'prod', host: 'h', apiPort: '21114' }],
    ['domain with a control byte', { id: 'prod', host: 'h', domain: 'a\x1fb.com' }],
    ['relative installDir', { id: 'prod', host: 'h', installDir: 'opt/x' }],
    ['traversal installDir', { id: 'prod', host: 'h', installDir: '/opt/../etc' }],
    ['installDir with a newline', { id: 'prod', host: 'h', installDir: '/opt/x\ny' }],
    ['hbbsKey with a control byte', { id: 'prod', host: 'h', hbbsKey: 'a\x00b' }],
    ['oversized hbbsKey', { id: 'prod', host: 'h', hbbsKey: 'a'.repeat(513) }],
    ['hbbsPorts not an array', { id: 'prod', host: 'h', hbbsPorts: 21115 }],
    ['hbbsPorts with a bad port', { id: 'prod', host: 'h', hbbsPorts: [21115, 70000] }],
    ['too many hbbsPorts', { id: 'prod', host: 'h', hbbsPorts: [1, 2, 3, 4, 5, 6, 7, 8, 9] }],
    ['not an object', 'prod'], ['null', null], ['array', []]
].forEach(([label, input]) => {
    test('normalizeRecord: rejects a record with ' + label, () => {
        typed(() => S.normalizeRecord(input), Errors.KIND.GENERIC, label);
    });
});

// ----------------------------------------------------- parseRecord / config ---

test('parseRecord: parses a stored record and pins it to its filename', () => {
    assert.deepEqual(S.parseRecord(JSON.stringify(REC), 'prod'), REC);
});

test('parseRecord: refuses a record whose id disagrees with its filename', () => {
    // Multi-server isolation: prod.json claiming to be staging would let one
    // server's settings answer for another.
    typed(() => S.parseRecord(JSON.stringify(Object.assign({}, REC, { id: 'staging' })), 'prod'),
        Errors.KIND.GENERIC, 'id mismatch');
});

[['truncated', '{"id":"prod","host":'], ['empty', ''], ['whitespace', '  '],
    ['null', null], ['an array', '[]'], ['a string', '"prod"'], ['a number', '7'],
    ['JSON null', 'null'], ['noise before JSON', 'oops{"id":"prod"}']
].forEach(([label, text]) => {
    test('parseRecord: rejects a record file that is ' + label, () => {
        typed(() => S.parseRecord(text, 'prod'), Errors.KIND.GENERIC, label);
    });
});

test('parseConfig: reads the active server id', () => {
    assert.deepEqual(S.parseConfig('{"activeServer":"prod"}'), { activeServer: 'prod' });
});

test('parseConfig: a missing, corrupt or hostile config degrades to no active server', () => {
    [null, undefined, '', '   ', 'not json', '{', '[]', '"x"', '7', 'null',
        '{"activeServer":null}', '{"activeServer":42}', '{"activeServer":"../../etc"}',
        '{"activeServer":"UPPER"}', '{"activeServer":""}', '{"other":1}'
    ].forEach((text) => {
        assert.deepEqual(S.parseConfig(text), { activeServer: null },
            'not degraded for ' + JSON.stringify(text));
    });
});

// ---------------------------------------------------------------------- I/O ---

test('list: lists the registry with find and returns normalized records', async (t) => {
    const calls = fakeCockpit({
        listing: '/etc/pilot/servers/prod.json\n/etc/pilot/servers/staging-2.json\n',
        files: {
            '/etc/pilot/servers/prod.json': JSON.stringify(REC),
            '/etc/pilot/servers/staging-2.json': JSON.stringify(
                Object.assign({}, REC, { id: 'staging-2', tls: false, domain: null }))
        }
    });
    t.after(dropCockpit);
    const out = await S.list();
    assert.deepEqual(out.map((r) => r.id), ['prod', 'staging-2']);
    assert.equal(calls.spawn[0].argv[0], 'find');
    assert.equal(calls.spawn[0].argv[1], '/etc/pilot/servers');
    assert.equal(calls.spawn[0].opts.superuser, 'require');
});

test('list: an empty or missing registry is an empty list, not an error', async (t) => {
    fakeCockpit({ listing: '' });
    t.after(dropCockpit);
    assert.deepEqual(await S.list(), []);
});

test('list: one corrupt record does not hide the others', async (t) => {
    fakeCockpit({
        listing: '/etc/pilot/servers/prod.json\n/etc/pilot/servers/bad.json\n',
        files: {
            '/etc/pilot/servers/prod.json': JSON.stringify(REC),
            '/etc/pilot/servers/bad.json': '{"id":'
        }
    });
    t.after(dropCockpit);
    const out = await S.list();
    assert.deepEqual(out.map((r) => r.id), ['prod']);
});

// --- GAP A (task 33): the "not permitted" callback must never be able to ---
// --- throw synchronously out of cockpit.js's own event dispatch.         ---

test('GAP A: read() never lets an access-denied close synchronously escape ' +
    'as an uncaught exception, even though cockpit.js dispatches it synchronously', async (t) => {
    const { handlers } = hostileFileCockpit();
    t.after(dropCockpit);

    const pending = S.read('prod');
    // readFile() must have registered against the record file's real (hostile)
    // read thenable by now; whether that happens synchronously or after a
    // microtask depends on whether the raw thenable was wrapped -- flush a
    // macrotask turn so either implementation has had its chance to attach.
    await new Promise((resolve) => setImmediate(resolve));
    const readCall = handlers.find((h) => h.path === '/etc/pilot/servers/prod.json' && h.kind === 'read');
    assert.ok(readCall, 'servers.js never registered a read handler against the record file');

    const denied = Object.assign(new Error(), { problem: 'access-denied', message: 'Not permitted to perform this action.' });
    let escaped = null;
    try {
        // This is exactly what real cockpit.js does: call the rejection
        // callback directly, synchronously, from inside the channel's close
        // event -- no promise machinery, no try/catch of its own.
        readCall.onRejected(denied);
    } catch (e) {
        escaped = e;
    }
    assert.equal(escaped, null,
        'servers.js\'s own reject handler threw synchronously back into cockpit.js\'s dispatch -- ' +
        'in a real browser this is an uncaught top-level exception, not a promise rejection ' +
        '(see GAP A: js/core/servers.js readFile/writeFile/run must wrap the raw cockpit ' +
        'thenable in Promise.resolve() before chaining .then())');

    // The outer read() promise must still end up properly (asynchronously)
    // rejected with a typed PilotError -- the fix must not just swallow the
    // failure, it must convert the escape hazard into an ordinary rejection.
    await assert.rejects(pending, (e) => e && e.name === 'PilotError');
});

test('GAP A: write() never lets an access-denied close synchronously escape ' +
    'as an uncaught exception on the record write', async (t) => {
    const { handlers } = hostileFileCockpit();
    t.after(dropCockpit);

    const pending = S.write(REC);
    await new Promise((resolve) => setImmediate(resolve));
    const writeCall = handlers.find((h) => h.path === '/etc/pilot/servers/prod.json' && h.kind === 'replace');
    assert.ok(writeCall, 'servers.js never registered a replace handler against the record file');

    const denied = Object.assign(new Error(), { problem: 'access-denied', message: 'Not permitted to perform this action.' });
    let escaped = null;
    try {
        writeCall.onRejected(denied);
    } catch (e) {
        escaped = e;
    }
    assert.equal(escaped, null,
        'writeFile\'s reject handler threw synchronously back into cockpit.js\'s dispatch');
    await assert.rejects(pending, (e) => e && e.name === 'PilotError');
});

test('read: rejects typed when the record file is absent', async (t) => {
    fakeCockpit({ files: {} });
    t.after(dropCockpit);
    await assert.rejects(S.read('prod'), (e) => {
        assert.equal(e.kind, Errors.KIND.GENERIC);
        assert.equal(e.detail.path, '/etc/pilot/servers/prod.json');
        return true;
    });
});

test('write: creates a 0700 registry directory and stores no secret', async (t) => {
    const calls = fakeCockpit({});
    t.after(dropCockpit);
    await S.write(Object.assign({}, REC, { token: 'T0KEN' }));
    assert.deepEqual(calls.spawn[0].argv,
        ['install', '-d', '-m', '0700', '-o', 'root', '-g', 'root', '/etc/pilot/servers']);
    assert.equal(calls.replace[0].path, '/etc/pilot/servers/prod.json');
    assert.equal(calls.replace[0].value.indexOf('T0KEN'), -1, 'the record leaked a token');
    assert.deepEqual(JSON.parse(calls.replace[0].value), REC);
    calls.spawn.forEach((c) => assert.equal(c.opts.superuser, 'require'));
});

test('write: validates before any I/O', async (t) => {
    const calls = fakeCockpit({});
    t.after(dropCockpit);
    await assert.rejects(S.write({ id: '../../etc/shadow', host: 'h' }));
    assert.equal(calls.spawn.length, 0);
    assert.equal(calls.replace.length, 0);
});

test('writeSecret: writes 0600 root:root and never puts the value in argv', async (t) => {
    const calls = fakeCockpit({});
    t.after(dropCockpit);
    const p = await S.writeSecret('prod', 'token', 'T0KEN');
    assert.equal(p, '/etc/pilot/servers/prod.token');
    assert.deepEqual(calls.replace, [{ path: p, value: 'T0KEN' }]);
    assert.deepEqual(calls.spawn[1].argv, ['chmod', '0600', p]);
    assert.deepEqual(calls.spawn[2].argv, ['chown', 'root:root', p]);
    calls.spawn.forEach((c) =>
        assert.equal(JSON.stringify(c.argv).indexOf('T0KEN'), -1, 'secret reached argv'));
});

test('writeSecret: refuses an empty or non-string value', async (t) => {
    const calls = fakeCockpit({});
    t.after(dropCockpit);
    for (const v of ['', null, undefined, 42, {}, []]) {
        await assert.rejects(S.writeSecret('prod', 'token', v), (e) => e.name === 'PilotError');
    }
    assert.equal(calls.replace.length, 0);
});

test('writeSecret: a chmod failure is reported, not swallowed', async (t) => {
    fakeCockpit({ spawnFailsOn: 'chmod' });
    t.after(dropCockpit);
    await assert.rejects(S.writeSecret('prod', 'token', 'T0KEN'), (e) => {
        assert.equal(e.kind, Errors.KIND.GENERIC);
        assert.equal(JSON.stringify(e.detail).indexOf('T0KEN'), -1);
        assert.equal(e.message.indexOf('T0KEN'), -1);
        return true;
    });
});

test('readSecret: a missing secret is null, not a failure', async (t) => {
    fakeCockpit({ files: {} });
    t.after(dropCockpit);
    assert.equal(await S.readSecret('prod', 'token'), null);
});

test('readSecret: strips exactly one trailing newline', async (t) => {
    fakeCockpit({ files: { '/etc/pilot/servers/prod.token': 'T0KEN\n' } });
    t.after(dropCockpit);
    assert.equal(await S.readSecret('prod', 'token'), 'T0KEN');
});

// --- GAP C (task 33): writeSecret() had zero callers, so the "remember for  ---
// --- day-2 operations" checkbox persisted nothing, and the stored secret   ---
// --- had no auth-type discriminator (a PEM would later be sent as a       ---
// --- password). encodeSshCredential/decodeSshCredential and the           ---
// --- the writeSshCredential wrapper built on the existing,                 ---
// --- UNCHANGED writeSecret/readSecret are the fix.

test('encodeSshCredential/decodeSshCredential round-trip password and pem, tagged', () => {
    for (const authType of ['password', 'pem', 'agent']) {
        const raw = S.encodeSshCredential(authType, 'S3CR3T');
        assert.equal(typeof raw, 'string');
        assert.equal(raw.indexOf('S3CR3T') >= 0, true);
        const decoded = S.decodeSshCredential(raw);
        assert.deepEqual(decoded, { authType, secret: 'S3CR3T' });
    }
});

test('decodeSshCredential: an unrecognised auth type in stored JSON degrades to password, not a throw', () => {
    const raw = JSON.stringify({ v: 1, authType: 'nonesuch', secret: 'x' });
    assert.deepEqual(S.decodeSshCredential(raw), { authType: 'password', secret: 'x' });
});

test('decodeSshCredential: a legacy bare-string secret (the only shape that could ever ' +
    'have existed before this fix — writeSecret() had no caller) decodes as a password, ' +
    'exactly what server-ops-ui.js\'s envelopeFor() unconditionally assumed', () => {
    assert.deepEqual(S.decodeSshCredential('s3cr3tpassword'), { authType: 'password', secret: 's3cr3tpassword' });
});

test('decodeSshCredential: null/undefined/empty is null, not a failure', () => {
    assert.equal(S.decodeSshCredential(null), null);
    assert.equal(S.decodeSshCredential(undefined), null);
    assert.equal(S.decodeSshCredential(''), null);
});

test('encodeSshCredential: refuses an empty or non-string secret, same guarantee as writeSecret', () => {
    for (const v of ['', null, undefined, 42, {}, []]) {
        assert.throws(() => S.encodeSshCredential('password', v), (e) => e.name === 'PilotError');
    }
});

test('writeSshCredential: writes 0600 root:root, tags the auth type, and the ' +
    'secret never reaches argv', async (t) => {
    const calls = fakeCockpit({});
    t.after(dropCockpit);
    const p = await S.writeSshCredential('prod', 'pem', 'BEGIN PEM DATA');
    assert.equal(p, '/etc/pilot/servers/prod.ssh');
    assert.equal(calls.replace.length, 1);
    assert.equal(calls.replace[0].value.indexOf('BEGIN PEM DATA') >= 0, true, 'the secret is in the FILE');
    calls.spawn.forEach((c) =>
        assert.equal(JSON.stringify(c.argv).indexOf('BEGIN PEM DATA'), -1, 'the secret reached argv'));
    assert.deepEqual(calls.spawn[1].argv, ['chmod', '0600', p]);
    assert.deepEqual(calls.spawn[2].argv, ['chown', 'root:root', p]);
    // What actually landed on disk (fakeCockpit's write side does not mutate
    // its own read-side `files` map) decodes back to exactly what was written
    // -- decodeSshCredential's own tests above cover the read half, including
    // the legacy bare-string shape.
    assert.deepEqual(S.decodeSshCredential(calls.replace[0].value), { authType: 'pem', secret: 'BEGIN PEM DATA' });
});

test('remove: unlinks the record and both secrets', async (t) => {
    const calls = fakeCockpit({});
    t.after(dropCockpit);
    await S.remove('prod');
    assert.deepEqual(calls.replace.map((r) => r.path).sort(), [
        '/etc/pilot/servers/prod.json',
        '/etc/pilot/servers/prod.ssh',
        '/etc/pilot/servers/prod.token'
    ]);
    calls.replace.forEach((r) => assert.equal(r.value, null));
});

test('active and setActive round-trip through /etc/pilot/config.json', async (t) => {
    const calls = fakeCockpit({ files: { '/etc/pilot/config.json': '{"activeServer":"prod"}' } });
    t.after(dropCockpit);
    assert.equal(await S.active(), 'prod');
    await S.setActive('staging-2');
    const written = calls.replace.find((r) => r.path === '/etc/pilot/config.json');
    assert.equal(JSON.parse(written.value).activeServer, 'staging-2');
});

test('active: a corrupt config reports no active server rather than failing', async (t) => {
    fakeCockpit({ files: { '/etc/pilot/config.json': '{"activeServer":' } });
    t.after(dropCockpit);
    assert.equal(await S.active(), null);
});

test('setActive: preserves the other keys already in the config', async (t) => {
    const calls = fakeCockpit({
        files: { '/etc/pilot/config.json': '{"activeServer":"prod","theme":"dark"}' }
    });
    t.after(dropCockpit);
    await S.setActive('staging-2');
    const written = JSON.parse(calls.replace.find((r) => r.path === '/etc/pilot/config.json').value);
    assert.equal(written.theme, 'dark');
    assert.equal(written.activeServer, 'staging-2');
});

test('setActive: rejects a hostile id before writing anything', async (t) => {
    const calls = fakeCockpit({});
    t.after(dropCockpit);
    await assert.rejects(S.setActive('../../etc'));
    assert.equal(calls.replace.length, 0);
});

test('I/O: every entry point rejects typed when cockpit is absent', async () => {
    dropCockpit();
    for (const call of [() => S.list(), () => S.read('prod'), () => S.write(REC),
        () => S.remove('prod'), () => S.readSecret('prod', 'token'),
        () => S.writeSecret('prod', 'token', 'x'), () => S.active(), () => S.setActive('prod')]) {
        let p;
        assert.doesNotThrow(() => { p = call(); }, 'sync throw with no cockpit');
        await p.then(() => assert.fail('should have rejected'),
            (e) => assert.equal(e.name, 'PilotError'));
    }
});

// ------------------------------------------------------- probeCompatibility ---
//
// The swagger docs below are SYNTHETIC — hand-built for these cases and named as
// such. app.show-swagger is 0 on a stock install (C17), so the probe must treat an
// absent doc as ordinary and decide on live routes instead.

function synthSwaggerDoc(paths) {
    return { swagger: '2.0', basePath: '/api', paths: paths };
}

function prober(answers) {
    const seen = [];
    return {
        seen: seen,
        send: function (req) {
            seen.push(req.path);
            const a = answers[req.path];
            if (a === undefined) return Promise.resolve({ status: 200, body: { code: 0, data: {} } });
            if (a.reject) return Promise.reject(a.reject);
            return Promise.resolve(a);
        }
    };
}

test('probeCompatibility: a stock server with swagger off still passes on live routes', async () => {
    const p = prober({ '/admin/swagger/doc.json': { status: 404, body: '404 page not found' } });
    const report = await S.probeCompatibility(p.send);
    assert.equal(report.ok, true);
    assert.equal(report.swagger, 'absent');
    assert.deepEqual(report.missing, []);
    assert.equal(report.checked.length, C.probeTargets().length);
    C.probeTargets().forEach((ep) =>
        assert.ok(p.seen.indexOf(ep.path) >= 0, 'never probed ' + ep.path));
});

test('probeCompatibility: probes only side-effect-free GETs', async () => {
    const seenMethods = [];
    await S.probeCompatibility(function (req) {
        seenMethods.push(req.method);
        return Promise.resolve({ status: 200, body: { code: 0, data: {} } });
    });
    assert.deepEqual([...new Set(seenMethods)], ['GET']);
});

test('probeCompatibility: 401 means the route exists — auth is not what is being tested', async () => {
    const answers = { '/admin/swagger/doc.json': { status: 404, body: '' } };
    C.probeTargets().forEach((ep) => { answers[ep.path] = { status: 401, body: { code: 1, message: 'token' } }; });
    const report = await S.probeCompatibility(prober(answers).send);
    assert.equal(report.ok, true);
    assert.deepEqual(report.missing, []);
});

test('probeCompatibility: a 404 on a route Pilot needs fails and names it', async () => {
    const target = C.probeTargets()[1];
    const answers = { '/admin/swagger/doc.json': { status: 404, body: '' } };
    answers[target.path] = { status: 404, body: '404 page not found' };
    await assert.rejects(S.probeCompatibility(prober(answers).send), (e) => {
        assert.equal(e.kind, Errors.KIND.API_VERSION_MISMATCH);
        assert.ok(e.message.indexOf(target.path) >= 0, 'message does not name ' + target.path);
        assert.deepEqual(e.detail.missing.map((m) => m.path), [target.path]);
        assert.equal(e.detail.swagger, 'absent');
        return true;
    });
});

test('probeCompatibility: several missing routes are all named, not just the first', async () => {
    const targets = C.probeTargets();
    const answers = { '/admin/swagger/doc.json': { status: 404, body: '' } };
    targets.forEach((ep) => { answers[ep.path] = { status: 404, body: '' }; });
    await assert.rejects(S.probeCompatibility(prober(answers).send), (e) => {
        assert.equal(e.detail.missing.length, targets.length);
        return true;
    });
});

test('probeCompatibility: a present swagger doc is recorded but never overrules a live route', async () => {
    // The committed doc is partially stale (C17): a route missing from the doc but
    // answering on the wire is fine, and only appears as advisory notInDoc.
    const answers = {
        '/admin/swagger/doc.json': { status: 200, body: synthSwaggerDoc({ '/currentUser2': {} }) }
    };
    const report = await S.probeCompatibility(prober(answers).send);
    assert.equal(report.ok, true);
    assert.equal(report.swagger, 'present');
    assert.deepEqual(report.missing, []);
    assert.ok(report.notInDoc.length > 0, 'stale doc entries were not reported as advisory');
    assert.equal(report.notInDoc.indexOf('/api/currentUser2'), -1,
        'a path present in the doc was reported as missing from it');
});

test('probeCompatibility: a swagger doc that is not a doc counts as absent, not as an error', async () => {
    for (const body of [null, '', 'not json at all', 42, [], {}, { paths: null }, { paths: 'x' }]) {
        const report = await S.probeCompatibility(prober({
            '/admin/swagger/doc.json': { status: 200, body: body }
        }).send);
        assert.equal(report.ok, true, 'failed for swagger body ' + JSON.stringify(body));
        assert.equal(report.swagger, 'absent');
    }
});

test('probeCompatibility: a transport failure is unreachable, NOT a version mismatch', async () => {
    const answers = {
        '/admin/swagger/doc.json': { status: 404, body: '' },
        [C.probeTargets()[0].path]: {
            reject: Errors.create(Errors.KIND.API_UNREACHABLE, 'connection refused', {})
        }
    };
    await assert.rejects(S.probeCompatibility(prober(answers).send), (e) => {
        assert.equal(e.kind, Errors.KIND.API_UNREACHABLE);
        return true;
    });
});

test('probeCompatibility: a bridge with no address capability surfaces that kind unchanged', async () => {
    const answers = {
        '/admin/swagger/doc.json': {
            reject: Errors.create(Errors.KIND.BRIDGE_NO_ADDRESS_CAP, 'no cap', {})
        }
    };
    await assert.rejects(S.probeCompatibility(prober(answers).send), (e) => {
        assert.equal(e.kind, Errors.KIND.BRIDGE_NO_ADDRESS_CAP);
        return true;
    });
});

test('probeCompatibility: rejects typed when handed something that is not a transport', async () => {
    for (const bad of [null, undefined, 42, {}, 'send']) {
        await assert.rejects(S.probeCompatibility(bad), (e) => {
            assert.equal(e.kind, Errors.KIND.GENERIC);
            return true;
        });
    }
});

test('probeCompatibility: needs no cockpit at all', async () => {
    dropCockpit();
    const report = await S.probeCompatibility(prober({
        '/admin/swagger/doc.json': { status: 404, body: '' }
    }).send);
    assert.equal(report.ok, true);
});

// ---------------------------------------------------------------- module shape ---

test('module shape: plain script, dual export, guarded cockpit, no cockpit.http', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    assert.equal(/^\s*(import|export)\s/m.test(src), false, 'ES module syntax present');
    assert.ok(src.indexOf("typeof cockpit !== 'undefined'") >= 0, 'unguarded cockpit access');
    assert.equal(/cockpit\.http/.test(src), false, 'only api-io.js may call cockpit.http');
    assert.ok(src.indexOf('module.exports') > 0);
    assert.equal(typeof globalThis.PilotServers, 'object');
});

test('index.html loads js/core/servers.js in its C7 position', () => {
    const html = fs.readFileSync(INDEX, 'utf8');
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    const me = srcs.indexOf('js/core/servers.js');
    assert.ok(me >= 0, 'index.html does not load js/core/servers.js');
    const at = C7.indexOf('js/core/servers.js');
    C7.slice(0, at).forEach((m) => {
        const i = srcs.indexOf(m);
        if (i >= 0) assert.ok(i < me, m + ' must load before js/core/servers.js');
    });
    C7.slice(at + 1).forEach((m) => {
        const i = srcs.indexOf(m);
        if (i >= 0) assert.ok(i > me, m + ' must load after js/core/servers.js');
    });
});

// ------------- an unreadable registry is not an empty one

test('list(): a permission failure is raised, never reported as "no servers"', async () => {
    // FROM THE FIELD: a reload dropped the Cockpit session back to Limited
    // access -- which is how EVERY session starts -- and Pilot answered with an
    // empty server switcher, "Devices 0", "Server: local" and "TLS is not
    // configured on this server". Four confident falsehoods about a server that
    // was configured, running and serving TLS. list() caught the spawn failure
    // and returned [], so "I cannot read /etc/pilot" became "there are none".
    fakeCockpit({ spawnRejectsWith: Object.assign(new Error('access-denied'), { problem: 'access-denied' }) });
    try {
        await assert.rejects(S.list(), (e) => {
            assert.equal(e.kind, 'API_AUTH_FAILED');
            assert.match(e.message, /administrative access/i,
                'the message must name the actual remedy: ' + e.message);
            assert.equal(e.detail.problem, 'access-denied');
            return true;
        });
    } finally { dropCockpit(); }
});

test('list(): a MISSING registry really is "none yet", and stays quiet', async () => {
    // A fresh install has no /etc/pilot at all: find exits non-zero with no
    // permission problem, and that genuinely means no servers are configured.
    // Raising there would make first-run setup impossible.
    fakeCockpit({ spawnRejectsWith: Object.assign(new Error('No such file or directory'), { exit_status: 1 }) });
    try {
        assert.deepEqual(await S.list(), []);
    } finally { dropCockpit(); }
});
