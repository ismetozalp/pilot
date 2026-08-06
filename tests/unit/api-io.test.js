'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Errors = require('../../js/core/errors.js');
const IO = require('../../js/core/api-io.js');

const SRC = path.join(__dirname, '../../js/core/api-io.js');
const INDEX = path.join(__dirname, '../../index.html');

const C7 = ['js/alpine.min.js', 'js/bootstrap.bundle.min.js', 'js/core/errors.js',
    'js/core/semver.js', 'js/core/themes.js', 'js/core/settings.js', 'js/core/ostarget.js',
    'js/core/ports.js', 'js/core/firewall.js', 'js/core/tls.js', 'js/core/provision-plan.js',
    'js/core/redact.js', 'js/core/servers.js', 'js/core/api-io.js', 'js/core/api-client.js',
    'js/core/addressbook.js', 'js/features/update.js', 'js/features/setup-ui.js',
    'js/features/devices-ui.js', 'js/features/addressbook-ui.js', 'js/features/users-ui.js',
    'js/features/audit-ui.js', 'js/features/server-ops-ui.js', 'js/features/overview.js',
    'js/app.js', 'js/boot.js'];

const CONN = { address: '10.0.0.5', port: 21114, token: 'T0KEN' };

function typed(fn, kind, what) {
    let caught = null;
    try { fn(); } catch (e) { caught = e; }
    assert.ok(caught, 'no throw for ' + what);
    assert.equal(caught.name, 'PilotError', 'untyped error for ' + what);
    assert.equal(caught.kind, kind, 'wrong kind for ' + what);
    assert.ok(caught.detail && typeof caught.detail === 'object', 'no detail for ' + what);
}

function dropCockpit() { delete globalThis.cockpit; }

// A stand-in for cockpit.http with the real semantics: request() resolves with the
// body TEXT, response(cb) reports the status, and a non-2xx REJECTS with (ex, data).
function fakeCockpit(script) {
    const calls = [];
    globalThis.cockpit = {
        http(opts) {
            return {
                request(req) {
                    calls.push({ opts, req });
                    const r = typeof script === 'function' ? script(req) : script;
                    const handlers = [];
                    const p = {
                        response(cb) { handlers.push(cb); return p; },
                        then(onOk, onFail) {
                            return new Promise(function (resolve) {
                                setTimeout(function () {
                                    if (r && r.hang) return;
                                    if (r && r.status) handlers.forEach((cb) => cb(r.status, {}));
                                    if (r && r.reject) resolve(onFail(r.reject, r.data));
                                    else resolve(onOk(r ? r.text : ''));
                                }, 0);
                            });
                        }
                    };
                    return p;
                }
            };
        }
    };
    return calls;
}

// ------------------------------------------------------------- httpOptions ---

test('httpOptions: builds the cockpit.http address/port options', () => {
    assert.deepEqual(IO.httpOptions({ address: '10.0.0.5', port: 21114 }),
        { address: '10.0.0.5', port: 21114 });
});

test('httpOptions: adds an empty tls object only when tls is requested', () => {
    assert.deepEqual(IO.httpOptions({ address: 'h', port: 443, tls: true }),
        { address: 'h', port: 443, tls: {} });
    assert.equal('tls' in IO.httpOptions({ address: 'h', port: 443, tls: false }), false);
});

test('httpOptions: never copies the token into the channel options', () => {
    const o = IO.httpOptions(CONN);
    assert.equal(JSON.stringify(o).indexOf('T0KEN'), -1);
});

test('httpOptions: accepts an IDN host and an IPv6 literal is rejected as unsupported', () => {
    assert.equal(IO.httpOptions({ address: 'rüstdesk.example', port: 80 }).address,
        'rüstdesk.example');
    typed(() => IO.httpOptions({ address: '[::1]', port: 80 }), Errors.KIND.GENERIC, 'ipv6');
});

[['empty', ''], ['null', null], ['undefined', undefined], ['whitespace only', '   '],
    ['space inside', 'a b'], ['tab', 'a\tb'], ['newline', 'a\nb'], ['CR', 'a\rb'],
    ['NUL', 'a\x00b'], ['DEL', 'a\x7fb'], ['slash', 'host/x'], ['backslash', 'host\\x'],
    ['query', 'host?a=1'], ['fragment', 'host#f'], ['userinfo', 'user@host'],
    ['scheme', 'http://host'], ['number', 42], ['object', {}], ['array', ['h']]
].forEach(([label, address]) => {
    test('httpOptions: rejects an address that is ' + label, () => {
        typed(() => IO.httpOptions({ address, port: 21114 }), Errors.KIND.GENERIC, label);
    });
});

[['zero', 0], ['negative', -1], ['too large', 65536], ['float', 80.5], ['NaN', NaN],
    ['Infinity', Infinity], ['numeric string', '21114'], ['null', null],
    ['undefined', undefined], ['boolean', true], ['array', [80]]
].forEach(([label, port]) => {
    test('httpOptions: rejects a port that is ' + label, () => {
        typed(() => IO.httpOptions({ address: 'h', port }), Errors.KIND.GENERIC, label);
    });
});

test('httpOptions: accepts the boundary ports', () => {
    assert.equal(IO.httpOptions({ address: 'h', port: 1 }).port, 1);
    assert.equal(IO.httpOptions({ address: 'h', port: 65535 }).port, 65535);
});

// --------------------------------------------------------------- applyAuth ---

test('applyAuth: an admin marker sends api-token with NO Bearer prefix', () => {
    assert.deepEqual(IO.applyAuth({}, { header: 'api-token', scheme: '' }, 'T0KEN'),
        { 'api-token': 'T0KEN' });
});

test('applyAuth: a user marker sends Authorization: Bearer', () => {
    assert.deepEqual(IO.applyAuth({}, { header: 'Authorization', scheme: 'Bearer ' }, 'T0KEN'),
        { Authorization: 'Bearer T0KEN' });
});

test('applyAuth: with no token no auth header is invented', () => {
    const m = { header: 'api-token', scheme: '' };
    assert.deepEqual(IO.applyAuth({}, m, ''), {});
    assert.deepEqual(IO.applyAuth({}, m, null), {});
    assert.deepEqual(IO.applyAuth({}, null, 'T0KEN'), {});
});

test('applyAuth: a token carrying a control character is refused, not sent', () => {
    typed(() => IO.applyAuth({}, { header: 'api-token', scheme: '' }, 'T\r\nX-Evil: 1'),
        Errors.KIND.GENERIC, 'CRLF token');
    typed(() => IO.applyAuth({}, { header: 'api-token', scheme: '' }, 'T\x00'),
        Errors.KIND.GENERIC, 'NUL token');
});

test('applyAuth: an invalid header name is refused', () => {
    typed(() => IO.applyAuth({}, { header: 'api token', scheme: '' }, 'T'),
        Errors.KIND.GENERIC, 'space in header name');
    typed(() => IO.applyAuth({}, { header: 'a\nb', scheme: '' }, 'T'),
        Errors.KIND.GENERIC, 'newline in header name');
});

// ------------------------------------------------------------ normalizeWire ---

test('normalizeWire: defaults to GET, Accept JSON, no body', () => {
    const w = IO.normalizeWire({ path: '/api/peers' }, '');
    assert.equal(w.method, 'GET');
    assert.equal(w.path, '/api/peers');
    assert.equal(w.body, null);
    assert.equal(w.headers.Accept, 'application/json');
});

test('normalizeWire: a body implies a JSON content type', () => {
    const w = IO.normalizeWire({ method: 'post', path: '/api/x', body: '{"a":1}' }, '');
    assert.equal(w.method, 'POST');
    assert.equal(w.headers['Content-Type'], 'application/json');
    assert.equal(w.body, '{"a":1}');
});

test('normalizeWire: applies the auth marker with the transport token', () => {
    const w = IO.normalizeWire({ path: '/admin/user', auth: { header: 'api-token', scheme: '' } }, 'T0KEN');
    assert.equal(w.headers['api-token'], 'T0KEN');
    assert.equal('Authorization' in w.headers, false);
});

[['no leading slash', 'api/peers'], ['empty', ''], ['newline', '/api/x\nHost: evil'],
    ['CR', '/api/x\r'], ['NUL', '/api/\x00x'], ['vertical tab', '/api/\x0bx'],
    ['DEL', '/api/\x7fx'], ['protocol-relative', '//evil.example/x']
].forEach(([label, p]) => {
    test('normalizeWire: rejects a path that is ' + label, () => {
        typed(() => IO.normalizeWire({ path: p }, ''), Errors.KIND.GENERIC, label);
    });
});

test('normalizeWire: rejects an unsupported method', () => {
    typed(() => IO.normalizeWire({ method: 'TRACE', path: '/x' }, ''), Errors.KIND.GENERIC, 'TRACE');
    typed(() => IO.normalizeWire({ method: 'GET\nX: 1', path: '/x' }, ''), Errors.KIND.GENERIC, 'injected');
});

test('normalizeWire: rejects a header value or name that could split the request', () => {
    typed(() => IO.normalizeWire({ path: '/x', headers: { 'X-A': 'v\r\nX-B: 1' } }, ''),
        Errors.KIND.GENERIC, 'CRLF header value');
    typed(() => IO.normalizeWire({ path: '/x', headers: { 'X A': 'v' } }, ''),
        Errors.KIND.GENERIC, 'space header name');
});

test('normalizeWire: a non-object request is still normalized, not crashed', () => {
    typed(() => IO.normalizeWire(null, ''), Errors.KIND.GENERIC, 'null request');
    typed(() => IO.normalizeWire('/x', ''), Errors.KIND.GENERIC, 'string request');
});

// ---------------------------------------------------------------- parseBody ---

test('parseBody: parses a JSON object and a JSON array', () => {
    assert.deepEqual(IO.parseBody('{"code":0,"data":{"a":1}}'), { code: 0, data: { a: 1 } });
    assert.deepEqual(IO.parseBody('[1,2]'), [1, 2]);
});

test('parseBody: empty, null and undefined become null', () => {
    assert.equal(IO.parseBody(''), null);
    assert.equal(IO.parseBody('   '), null);
    assert.equal(IO.parseBody(null), null);
    assert.equal(IO.parseBody(undefined), null);
});

test('parseBody: non-JSON text is handed back verbatim, not guessed at', () => {
    assert.equal(IO.parseBody('<html>gateway timeout</html>'), '<html>gateway timeout</html>');
    assert.equal(IO.parseBody('plain'), 'plain');
});

test('parseBody: truncated JSON is a typed GENERIC with a snippet, never a raw SyntaxError', () => {
    typed(() => IO.parseBody('{"code":0,"data":'), Errors.KIND.GENERIC, 'truncated');
    typed(() => IO.parseBody('[{"a":1},'), Errors.KIND.GENERIC, 'truncated array');
    try { IO.parseBody('{"code":0,'); } catch (e) {
        assert.ok(e.detail.snippet.indexOf('{"code":0,') === 0);
    }
});

test('parseBody: preserves unicode and embedded newlines inside JSON strings', () => {
    assert.deepEqual(IO.parseBody('{"n":"a\\nb","u":"ü\\ud83d\\udcbe"}'),
        { n: 'a\nb', u: 'ü\u{1f4be}' });
});

test('parseBody: an oversized body is refused rather than parsed', () => {
    const big = '{"x":"' + 'a'.repeat(IO.MAX_BODY_BYTES) + '"}';
    typed(() => IO.parseBody(big), Errors.KIND.GENERIC, 'oversized');
});

test('parseBody: an already-parsed object passes through', () => {
    const o = { code: 0 };
    assert.equal(IO.parseBody(o), o);
});

// ----------------------------------------------------------------- classify ---

test('classify: a missing address capability is BRIDGE_NO_ADDRESS_CAP', () => {
    assert.equal(IO.classify({ problem: 'not-supported' }), Errors.KIND.BRIDGE_NO_ADDRESS_CAP);
    assert.equal(IO.classify({ problem: 'protocol-error', message: 'unsupported capability: address' }),
        Errors.KIND.BRIDGE_NO_ADDRESS_CAP);
});

test('classify: an ordinary not-found is unreachable, not a capability problem', () => {
    assert.equal(IO.classify({ problem: 'not-found', message: 'address not found' }),
        Errors.KIND.API_UNREACHABLE);
});

test('classify: auth problems map to API_AUTH_FAILED', () => {
    assert.equal(IO.classify({ problem: 'authentication-failed' }), Errors.KIND.API_AUTH_FAILED);
    assert.equal(IO.classify({ problem: 'access-denied' }), Errors.KIND.API_AUTH_FAILED);
});

test('classify: every transport problem maps to a real C6 kind', () => {
    Object.keys(IO.PROBLEM_KIND).forEach((p) => {
        assert.ok(Errors.KIND[IO.PROBLEM_KIND[p]], p + ' maps to a non-C6 kind');
    });
});

test('classify: an unknown problem is unreachable and no problem at all is GENERIC', () => {
    assert.equal(IO.classify({ problem: 'brand-new-problem' }), Errors.KIND.API_UNREACHABLE);
    assert.equal(IO.classify({}), Errors.KIND.GENERIC);
    assert.equal(IO.classify(null), Errors.KIND.GENERIC);
    assert.equal(IO.classify('a string'), Errors.KIND.GENERIC);
});

// ---------------------------------------------------------------- transport ---

test('transport: validates the connection eagerly, before any request', () => {
    typed(() => IO.transport({ address: '', port: 21114 }), Errors.KIND.GENERIC, 'bad conn');
    typed(() => IO.transport(null), Errors.KIND.GENERIC, 'null conn');
});

test('transport: under node it degrades to a rejecting no-op instead of throwing', async () => {
    dropCockpit();
    const send = IO.transport(CONN);
    assert.equal(typeof send, 'function');
    await assert.rejects(send({ method: 'GET', path: '/api/peers' }), (e) => {
        assert.equal(e.kind, Errors.KIND.API_UNREACHABLE);
        assert.equal(e.detail.reason, 'no-bridge');
        return true;
    });
});

test('transport: sends method, path, headers and the auth token through cockpit.http', async (t) => {
    const calls = fakeCockpit({ status: 200, text: '{"code":0,"data":[]}' });
    t.after(dropCockpit);
    const res = await IO.transport(CONN)({
        method: 'GET', path: '/admin/peer', auth: { header: 'api-token', scheme: '' }
    });
    assert.deepEqual(res, { status: 200, body: { code: 0, data: [] } });
    assert.deepEqual(calls[0].opts, { address: '10.0.0.5', port: 21114 });
    assert.equal(calls[0].req.method, 'GET');
    assert.equal(calls[0].req.path, '/admin/peer');
    assert.equal(calls[0].req.headers['api-token'], 'T0KEN');
});

test('transport: a non-2xx status RESOLVES with that status so the probe can see a 404', async (t) => {
    fakeCockpit({ reject: { status: 404, problem: null, message: 'Not Found' }, data: '404 page not found' });
    t.after(dropCockpit);
    const res = await IO.transport(CONN)({ method: 'GET', path: '/admin/nope' });
    assert.equal(res.status, 404);
    assert.equal(res.body, '404 page not found');
});

test('transport: a 500 with a JSON body resolves with the parsed body', async (t) => {
    fakeCockpit({ reject: { status: 500 }, data: '{"code":1,"message":"boom"}' });
    t.after(dropCockpit);
    const res = await IO.transport(CONN)({ method: 'GET', path: '/admin/user' });
    assert.deepEqual(res, { status: 500, body: { code: 1, message: 'boom' } });
});

test('transport: a channel failure REJECTS with the classified kind', async (t) => {
    fakeCockpit({ reject: { problem: 'not-supported', message: 'unsupported capability' } });
    t.after(dropCockpit);
    await assert.rejects(IO.transport(CONN)({ method: 'GET', path: '/api/peers' }), (e) => {
        assert.equal(e.kind, Errors.KIND.BRIDGE_NO_ADDRESS_CAP);
        assert.equal(e.detail.path, '/api/peers');
        assert.equal(e.detail.problem, 'not-supported');
        return true;
    });
});

test('transport: a hung request times out as API_UNREACHABLE', async (t) => {
    fakeCockpit({ hang: true });
    t.after(dropCockpit);
    await assert.rejects(IO.transport({ address: 'h', port: 80, timeoutMs: 15 })({
        method: 'GET', path: '/api/peers'
    }), (e) => {
        assert.equal(e.kind, Errors.KIND.API_UNREACHABLE);
        assert.equal(e.detail.reason, 'timeout');
        return true;
    });
});

test('transport: never throws synchronously for a hostile request', async (t) => {
    fakeCockpit({ status: 200, text: '{}' });
    t.after(dropCockpit);
    for (const req of [null, undefined, {}, { path: 'x' }, { path: '/x\n' }, 42, 'str',
        { method: 'TRACE', path: '/x' }]) {
        let p;
        assert.doesNotThrow(() => { p = IO.transport(CONN)(req); }, 'sync throw');
        await p.then(() => assert.fail('should have rejected'), (e) => {
            assert.equal(e.name, 'PilotError');
        });
    }
});

test('transport: a malformed success body rejects typed and leaks no token', async (t) => {
    fakeCockpit({ status: 200, text: '{"code":0,' });
    t.after(dropCockpit);
    await assert.rejects(IO.transport(CONN)({ method: 'GET', path: '/api/peers' }), (e) => {
        assert.equal(e.kind, Errors.KIND.GENERIC);
        assert.equal(JSON.stringify(e.detail).indexOf('T0KEN'), -1);
        return true;
    });
});

// ------------------------------------------------------------ module shape ---

test('module shape: plain script, dual export, guarded cockpit access', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    assert.equal(/^\s*(import|export)\s/m.test(src), false, 'ES module syntax present');
    assert.ok(src.indexOf("typeof cockpit !== 'undefined'") >= 0, 'unguarded cockpit access');
    assert.ok(src.indexOf('module.exports') > 0);
    assert.equal(typeof globalThis.PilotApiIo, 'object');
});

test('index.html loads js/core/api-io.js in its C7 position', () => {
    const html = fs.readFileSync(INDEX, 'utf8');
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    const me = srcs.indexOf('js/core/api-io.js');
    assert.ok(me >= 0, 'index.html does not load js/core/api-io.js');
    const at = C7.indexOf('js/core/api-io.js');
    // Presence-conditional on both sides: later tasks add the neighbours, and this
    // assertion must keep passing before and after they do.
    C7.slice(0, at).forEach((m) => {
        const i = srcs.indexOf(m);
        if (i >= 0) assert.ok(i < me, m + ' must load before js/core/api-io.js');
    });
    C7.slice(at + 1).forEach((m) => {
        const i = srcs.indexOf(m);
        if (i >= 0) assert.ok(i > me, m + ' must load after js/core/api-io.js');
    });
});

// ---------------- connFor: one place decides the endpoint, or it drifts again

test('connFor: a TLS record is addressed at its DOMAIN on 443', () => {
    // The bug this exists to prevent, seen in the field: the console reported
    // "the API server could not be reached" while https://<domain>/api/version
    // returned 200. The record carried the domain; two separate call sites
    // built the Conn by hand from host+apiPort and neither read it.
    const c = IO.connFor({ host: 'ec2-1-2-3-4.compute.amazonaws.com', apiPort: 21114,
        tls: true, domain: 'rd.example.com' }, 'T0KEN');
    assert.equal(c.address, 'rd.example.com', 'the certificate is for the domain, not the hostname');
    assert.equal(c.port, 443, 'Caddy holds 443; the client appends no port (C17)');
    assert.equal(c.tls, true);
    assert.equal(c.token, 'T0KEN');
});

test('connFor: without TLS it is host:apiPort in plain HTTP', () => {
    const c = IO.connFor({ host: 'rd.internal', apiPort: 21114, tls: false, domain: '' });
    assert.deepEqual(c, { address: 'rd.internal', port: 21114, tls: false, token: null });
});

test('connFor: tls without a usable domain falls back rather than inventing an endpoint', () => {
    // tls:true with no domain is a record that should not exist; connecting to
    // ""|443 would be strictly worse than the host that at least resolves.
    for (const domain of ['', null, undefined, '   ']) {
        const c = IO.connFor({ host: 'rd.internal', apiPort: 21114, tls: true, domain: domain });
        assert.equal(c.address, 'rd.internal', JSON.stringify(domain));
        assert.equal(c.port, 21114);
        assert.equal(c.tls, false);
    }
});

test('connFor: hostile or absent records never throw', () => {
    for (const bad of [null, undefined, 'nope', 7, [], {}])
        assert.equal(typeof IO.connFor(bad), 'object', JSON.stringify(bad));
});

test('no module builds a Conn by hand — connFor is the only decision point', () => {
    // Two hand-built Conns existed and both were wrong the same way; fixing one
    // left the other broken. This is what stops a third.
    const ROOT = path.join(__dirname, '..', '..');
    for (const rel of ['js/app.js', 'js/features/setup-ui.js', 'js/features/server-ops-ui.js']) {
        const p = path.join(ROOT, rel);
        if (!fs.existsSync(p)) continue;
        const src = fs.readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, '');
        assert.ok(!/address:\s*\w+\.host/.test(src),
            rel + ' builds a Conn from record.host by hand; use PilotApiIo.connFor()');
        assert.ok(!/port:\s*\w+\.apiPort/.test(src),
            rel + ' builds a Conn from record.apiPort by hand; use PilotApiIo.connFor()');
    }
});
