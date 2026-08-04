'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Errors = require('../../js/core/errors.js');
const IO = require('../../js/core/api-io.js');
const C = require('../../js/core/api-client.js');
const Api = C.PilotApi;

const SRC = path.join(__dirname, '../../js/core/api-client.js');
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

// Records every WireRequest and answers from a scripted reply.
function recorder(reply) {
    const calls = [];
    const fn = function (req) {
        calls.push(req);
        const r = typeof reply === 'function' ? reply(req) : reply;
        if (r && r.throwSync) throw new Error('transport exploded');
        if (r && r.reject) return Promise.reject(r.reject);
        return Promise.resolve(r || { status: 200, body: { code: 0, data: null } });
    };
    fn.calls = calls;
    Api.setTransport(fn);
    return calls;
}

// ------------------------------------------------------------------- C12 shape ---

test('PilotApi exposes exactly the C12 surface', () => {
    ['setTransport', 'request'].forEach((k) => assert.equal(typeof Api[k], 'function', k));
    assert.deepEqual(Object.keys(Api.devices).sort(),
        ['addToAddressBook', 'list', 'remove', 'rename']);
    assert.deepEqual(Object.keys(Api.addressbook).sort(),
        ['addPeer', 'addTag', 'books', 'peers', 'removePeer', 'removeTag', 'renameTag',
            'tags', 'updatePeer']);
    assert.deepEqual(Object.keys(Api.users).sort(),
        ['create', 'groups', 'list', 'resetPassword', 'setEnabled', 'setGroup', 'update']);
    assert.deepEqual(Object.keys(Api.audit).sort(), ['conn', 'file', 'login']);
});

// -------------------------------------------------------------------- auth seam ---

test('AUTH.admin is api-token with NO Bearer prefix — verified through the real api-io', () => {
    assert.deepEqual(C.AUTH.admin, { header: 'api-token', scheme: '' });
    assert.deepEqual(IO.applyAuth({}, C.AUTH.admin, 'T0KEN'), { 'api-token': 'T0KEN' });
});

test('AUTH.user is Authorization: Bearer — verified through the real api-io', () => {
    assert.deepEqual(C.AUTH.user, { header: 'Authorization', scheme: 'Bearer ' });
    assert.deepEqual(IO.applyAuth({}, C.AUTH.user, 'T0KEN'), { Authorization: 'Bearer T0KEN' });
});

test('every request api-client builds is accepted by api-io.normalizeWire', () => {
    // The exact seam that broke rounds 1 and 2: two modules agreeing on paper and
    // disagreeing in code. Every endpoint, filled in, must survive the transport's
    // own validation.
    C.ENDPOINTS.forEach((ep) => {
        const filled = ep.path.replace(/\{\w+\}/g, 'sample-1');
        const wire = C.buildRequest({ method: ep.method, path: filled, admin: ep.admin });
        const out = IO.normalizeWire(wire, 'T0KEN');
        assert.equal(out.method, ep.method, ep.id);
        assert.equal(out.path, filled, ep.id);
        assert.equal(out.headers[ep.admin ? 'api-token' : 'Authorization'] !== undefined, true, ep.id);
    });
});

// ----------------------------------------------------------------- encodeQuery ---

test('encodeQuery: empty input produces no query string', () => {
    assert.equal(C.encodeQuery(null), '');
    assert.equal(C.encodeQuery(undefined), '');
    assert.equal(C.encodeQuery({}), '');
    assert.equal(C.encodeQuery({ a: null, b: undefined }), '');
});

test('encodeQuery: sorts keys so the same query always renders identically', () => {
    assert.equal(C.encodeQuery({ page_size: 20, page: 1 }), '?page=1&page_size=20');
});

test('encodeQuery: percent-encodes everything dangerous in a value', () => {
    assert.equal(C.encodeQuery({ q: 'a b' }), '?q=a%20b');
    assert.equal(C.encodeQuery({ q: 'a\nb' }), '?q=a%0Ab');
    assert.equal(C.encodeQuery({ q: 'a&b=c' }), '?q=a%26b%3Dc');
    assert.equal(C.encodeQuery({ q: '../../etc' }), '?q=..%2F..%2Fetc');
    assert.equal(C.encodeQuery({ q: 'a\x00b' }), '?q=a%00b');
    assert.equal(C.encodeQuery({ q: 'ü\u{1f4be}' }), '?q=%C3%BC%F0%9F%92%BE');
});

test('encodeQuery: keeps an empty string, which is a real filter value', () => {
    assert.equal(C.encodeQuery({ q: '' }), '?q=');
});

test('encodeQuery: an array becomes repeated parameters', () => {
    assert.equal(C.encodeQuery({ tag: ['a', 'b'] }), '?tag=a&tag=b');
});

test('encodeQuery: booleans and finite numbers are allowed, other types are not', () => {
    assert.equal(C.encodeQuery({ on: true, n: 0 }), '?n=0&on=true');
    typed(() => C.encodeQuery({ n: NaN }), Errors.KIND.GENERIC, 'NaN');
    typed(() => C.encodeQuery({ n: Infinity }), Errors.KIND.GENERIC, 'Infinity');
    typed(() => C.encodeQuery({ o: {} }), Errors.KIND.GENERIC, 'object value');
    typed(() => C.encodeQuery({ f: () => 1 }), Errors.KIND.GENERIC, 'function value');
});

test('encodeQuery: rejects a hostile parameter NAME rather than encoding it', () => {
    ['a b', 'a\nb', 'a&b', 'a=b', '', 'a\x00'].forEach((name) => {
        typed(() => C.encodeQuery({ [name]: 'v' }), Errors.KIND.GENERIC, 'name ' + JSON.stringify(name));
    });
});

test('encodeQuery: rejects a non-object query', () => {
    typed(() => C.encodeQuery('a=1'), Errors.KIND.GENERIC, 'string');
    typed(() => C.encodeQuery([['a', 1]]), Errors.KIND.GENERIC, 'array');
});

// -------------------------------------------------------------------------- seg ---

test('seg: encodes a path segment so it can never escape its route', () => {
    assert.equal(C.seg('abc'), 'abc');
    assert.equal(C.seg(42), '42');
    assert.equal(C.seg('../../etc/shadow'), '..%2F..%2Fetc%2Fshadow');
    assert.equal(C.seg('a b'), 'a%20b');
    assert.equal(C.seg('ü'), '%C3%BC');
});

[['empty', ''], ['null', null], ['undefined', undefined], ['object', {}], ['array', ['a']],
    ['boolean', true], ['NaN', NaN], ['newline', 'a\nb'], ['CR', 'a\rb'], ['NUL', 'a\x00b'],
    ['DEL', 'a\x7fb'], ['oversized', 'a'.repeat(257)]
].forEach(([label, v]) => {
    test('seg: rejects a segment that is ' + label, () => {
        typed(() => C.seg(v), Errors.KIND.GENERIC, label);
    });
});

// ----------------------------------------------------------------- buildRequest ---

test('buildRequest: GET with a query and a user auth marker', () => {
    const w = C.buildRequest({ method: 'GET', path: '/api/ab/peers', query: { ab: 'x' } });
    assert.deepEqual(w, {
        method: 'GET', path: '/api/ab/peers?ab=x', headers: {}, body: null, auth: C.AUTH.user
    });
});

test('buildRequest: admin true selects the admin marker', () => {
    assert.equal(C.buildRequest({ method: 'GET', path: '/admin/user', admin: true }).auth,
        C.AUTH.admin);
    // Only a literal true, so a truthy accident cannot silently switch schemes.
    assert.equal(C.buildRequest({ method: 'GET', path: '/admin/user', admin: 1 }).auth, C.AUTH.user);
});

test('buildRequest: a body is serialised to JSON with a content type', () => {
    const w = C.buildRequest({ method: 'POST', path: '/admin/user', body: { name: 'a' } });
    assert.equal(w.body, '{"name":"a"}');
    assert.equal(w.headers['Content-Type'], 'application/json');
});

test('buildRequest: a body that cannot be serialised is a typed error', () => {
    const cyclic = {}; cyclic.self = cyclic;
    typed(() => C.buildRequest({ method: 'POST', path: '/x', body: cyclic }),
        Errors.KIND.GENERIC, 'cyclic body');
    typed(() => C.buildRequest({ method: 'POST', path: '/x', body: { n: 10n } }),
        Errors.KIND.GENERIC, 'bigint body');
});

[['no leading slash', 'api/x'], ['empty', ''], ['traversal', '/api/../admin/user'],
    ['newline', '/api/x\ny'], ['NUL', '/api/\x00'], ['oversized', '/' + 'a'.repeat(2100)]
].forEach(([label, p]) => {
    test('buildRequest: rejects a path that is ' + label, () => {
        typed(() => C.buildRequest({ method: 'GET', path: p }), Errors.KIND.GENERIC, label);
    });
});

// --------------------------------------------------------------- errorKindFor ---

test('errorKindFor: HTTP 200 with code 0 is success', () => {
    assert.equal(C.errorKindFor(200, 0, ''), Errors.KIND.OK);
    assert.equal(C.errorKindFor(204, null, ''), Errors.KIND.OK);
});

test('errorKindFor: HTTP 200 with a non-zero code is a failure', () => {
    assert.equal(C.errorKindFor(200, 1, 'peer not found'), Errors.KIND.GENERIC);
    assert.equal(C.errorKindFor(200, -1, 'bad request'), Errors.KIND.GENERIC);
});

test('errorKindFor: an auth-flavoured message at code!==0 is API_AUTH_FAILED', () => {
    ['token expired', 'Unauthorized', 'please login', 'no permission', 'forbidden']
        .forEach((m) => assert.equal(C.errorKindFor(200, 1, m), Errors.KIND.API_AUTH_FAILED, m));
});

test('errorKindFor: 401 and 403 are API_AUTH_FAILED whatever the body says', () => {
    assert.equal(C.errorKindFor(401, 0, ''), Errors.KIND.API_AUTH_FAILED);
    assert.equal(C.errorKindFor(403, 0, 'ok'), Errors.KIND.API_AUTH_FAILED);
});

test('errorKindFor: 404 is a version mismatch — the route does not exist', () => {
    assert.equal(C.errorKindFor(404, null, ''), Errors.KIND.API_VERSION_MISMATCH);
});

test('errorKindFor: 5xx and status 0 are API_UNREACHABLE', () => {
    [500, 502, 503, 504].forEach((s) =>
        assert.equal(C.errorKindFor(s, null, ''), Errors.KIND.API_UNREACHABLE, String(s)));
    assert.equal(C.errorKindFor(0, null, ''), Errors.KIND.API_UNREACHABLE);
});

test('errorKindFor: a numeric-string code is understood, a nonsense code is a failure', () => {
    assert.equal(C.errorKindFor(200, '0', ''), Errors.KIND.OK);
    assert.equal(C.errorKindFor(200, '1', ''), Errors.KIND.GENERIC);
    assert.equal(C.errorKindFor(200, 'yes', ''), Errors.KIND.GENERIC);
    assert.equal(C.errorKindFor(200, {}, ''), Errors.KIND.GENERIC);
});

// --------------------------------------------------------------------- unwrap ---

test('unwrap: returns data on success', () => {
    assert.deepEqual(C.unwrap({ status: 200, body: { code: 0, data: { a: 1 } } }, '/x'), { a: 1 });
});

test('unwrap: a payload with no envelope is returned as-is', () => {
    assert.deepEqual(C.unwrap({ status: 200, body: [1, 2] }, '/x'), [1, 2]);
    assert.deepEqual(C.unwrap({ status: 200, body: { a: 1 } }, '/x'), { a: 1 });
});

test('unwrap: an empty body is null, not an error', () => {
    assert.equal(C.unwrap({ status: 204, body: null }, '/x'), null);
});

test('unwrap: code!==0 throws with the server message and the path in detail', () => {
    typed(() => C.unwrap({ status: 200, body: { code: 1, message: 'peer not found' } }, '/admin/peer'),
        Errors.KIND.GENERIC, 'code 1');
    try {
        C.unwrap({ status: 200, body: { code: 7, message: 'nope' } }, '/admin/peer');
    } catch (e) {
        assert.equal(e.detail.code, 7);
        assert.equal(e.detail.status, 200);
        assert.equal(e.detail.path, '/admin/peer');
        assert.match(e.message, /nope/);
    }
});

test('unwrap: an HTML body at 200 is a failure, not silently passed through as data', () => {
    typed(() => C.unwrap({ status: 200, body: '<html>login</html>' }, '/x'),
        Errors.KIND.GENERIC, 'html body');
});

test('unwrap: a 404 names the path and is API_VERSION_MISMATCH', () => {
    try {
        C.unwrap({ status: 404, body: '404 page not found' }, '/admin/audit_conn');
        assert.fail('expected a throw');
    } catch (e) {
        assert.equal(e.kind, Errors.KIND.API_VERSION_MISMATCH);
        assert.match(e.message, /\/admin\/audit_conn/);
    }
});

test('unwrap: a missing or malformed response object is typed, not a TypeError', () => {
    [null, undefined, 'x', 42, []].forEach((res) =>
        typed(() => C.unwrap(res, '/x'), Errors.KIND.GENERIC, 'response ' + JSON.stringify(res)));
});

// ------------------------------------------------------------------- paginate ---

test('paginate: normalizes {list,page,total,page_size}', () => {
    assert.deepEqual(C.paginate({ list: [1, 2], page: 2, total: 40, page_size: 20 }),
        { list: [1, 2], page: 2, total: 40, pageSize: 20 });
});

test('paginate: a bare array is one full page', () => {
    assert.deepEqual(C.paginate([1, 2, 3]), { list: [1, 2, 3], page: 1, total: 3, pageSize: 3 });
});

test('paginate: hostile or absent fields fall back rather than producing NaN', () => {
    [null, undefined, 'x', 42, {}, { list: null }, { list: 'a' }, { list: [], page: 'x' },
        { list: [], total: -5 }, { list: [], page_size: NaN }, { list: [], page: Infinity }
    ].forEach((d) => {
        const p = C.paginate(d);
        assert.ok(Array.isArray(p.list), 'list is not an array for ' + JSON.stringify(d));
        [p.page, p.total, p.pageSize].forEach((n) =>
            assert.ok(Number.isInteger(n) && n >= 0, 'bad number for ' + JSON.stringify(d)));
    });
});

test('paginate: a numeric-string total is accepted', () => {
    assert.equal(C.paginate({ list: [], total: '40' }).total, 40);
});

// -------------------------------------------------------------------- request ---

test('request: rejects when no transport is configured', async () => {
    Api.setTransport(null);
    await assert.rejects(Api.request({ method: 'GET', path: '/api/peers' }), (e) => {
        assert.equal(e.kind, Errors.KIND.API_UNREACHABLE);
        return true;
    });
});

test('setTransport: refuses anything that is not a function or null', () => {
    typed(() => Api.setTransport(42), Errors.KIND.GENERIC, 'number');
    typed(() => Api.setTransport({}), Errors.KIND.GENERIC, 'object');
    Api.setTransport(null);
});

test('request: never throws synchronously, whatever it is handed', async () => {
    recorder({ status: 200, body: { code: 0, data: null } });
    for (const req of [null, undefined, 42, 'x', {}, { path: 'nope' }, { path: '/x', query: 'a' }]) {
        let p;
        assert.doesNotThrow(() => { p = Api.request(req); }, 'sync throw');
        await p.then(() => {}, (e) => assert.equal(e.name, 'PilotError'));
    }
});

test('request: a transport that throws synchronously becomes a typed rejection', async () => {
    recorder({ throwSync: true });
    await assert.rejects(Api.request({ method: 'GET', path: '/api/peers' }), (e) => {
        assert.equal(e.name, 'PilotError');
        return true;
    });
});

test('request: a typed transport rejection keeps its kind', async () => {
    recorder({ reject: Errors.create(Errors.KIND.BRIDGE_NO_ADDRESS_CAP, 'no cap', {}) });
    await assert.rejects(Api.request({ method: 'GET', path: '/api/peers' }), (e) => {
        assert.equal(e.kind, Errors.KIND.BRIDGE_NO_ADDRESS_CAP);
        return true;
    });
});

// ------------------------------------------------------------------- surfaces ---

test('devices.list sends GET to the devices endpoint with admin auth and paginates', async () => {
    const calls = recorder({ status: 200, body: { code: 0, data: { list: [{ id: 'a' }], page: 1, total: 1, page_size: 20 } } });
    const out = await Api.devices.list({ page: 1, pageSize: 20 });
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].path, C.EP['devices.list'].path + '?page=1&page_size=20');
    assert.equal(calls[0].auth, C.AUTH.admin);
    assert.deepEqual(out, { list: [{ id: 'a' }], page: 1, total: 1, pageSize: 20 });
});

test('devices.rename puts the id in the path safely and the name in the body', async () => {
    const calls = recorder({ status: 200, body: { code: 0, data: null } });
    await Api.devices.rename('../../etc', 'lobby-pi');
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].path.indexOf('..%2F..%2Fetc') > 0, true, calls[0].path);
    assert.equal(calls[0].path.indexOf('/../'), -1);
    assert.deepEqual(JSON.parse(calls[0].body), { id: '../../etc', name: 'lobby-pi' });
});

test('devices.remove issues a DELETE and refuses an empty id', async () => {
    const calls = recorder({ status: 200, body: { code: 0, data: null } });
    await Api.devices.remove('abc');
    assert.equal(calls[0].method, 'DELETE');
    await assert.rejects(Api.devices.remove(''), (e) => e.kind === Errors.KIND.GENERIC);
});

test('addressbook writes go to the client API so real clients see them', async () => {
    const calls = recorder({ status: 200, body: { code: 0, data: null } });
    await Api.addressbook.addPeer('personal', { id: 'p1' });
    await Api.addressbook.updatePeer('personal', { id: 'p1', alias: 'a' });
    await Api.addressbook.removePeer('personal', 'p1');
    await Api.addressbook.addTag('personal', 'office');
    await Api.addressbook.renameTag('personal', 'office', 'hq');
    await Api.addressbook.removeTag('personal', 'hq');
    calls.forEach((c) => {
        assert.ok(c.path.indexOf('/api/ab/') === 0, 'not a client-API path: ' + c.path);
        assert.equal(c.auth, C.AUTH.user);
    });
    assert.deepEqual(JSON.parse(calls[4].body), { old: 'office', new: 'hq' });
});

test('users.setEnabled and resetPassword send the documented fields', async () => {
    const calls = recorder({ status: 200, body: { code: 0, data: null } });
    await Api.users.setEnabled('7', false);
    await Api.users.resetPassword('7', 'hunter2');
    assert.deepEqual(JSON.parse(calls[0].body), { id: '7', status: 0 });
    assert.deepEqual(JSON.parse(calls[1].body), { id: '7', password: 'hunter2' });
    calls.forEach((c) => assert.equal(c.auth, C.AUTH.admin));
});

test('users.resetPassword refuses an empty or non-string password', async () => {
    recorder({ status: 200, body: { code: 0, data: null } });
    for (const pw of ['', null, undefined, 42, {}, 'a\x00b']) {
        await assert.rejects(Api.users.resetPassword('7', pw), (e) => e.name === 'PilotError');
    }
});

// The gap Task 24 was warned about (Task 18's PilotApi.addressbook shipped with
// 76 passing tests that never once called it, and a façade that silently
// discarded every payload passed review): nothing above exercised
// users.list/groups/create/update/setGroup's actual method, path, payload or
// unwrapped shape. Verified by execution before js/features/users-ui.js was
// built on top of them (task-24-report.md); these lock the verified behaviour
// in as a permanent regression test rather than leaving the gap open.
test('users.list sends GET /admin/user with admin auth, and paginates the {list,page,total,page_size} shape', async () => {
    const calls = recorder({ status: 200, body:
        { code: 0, message: '', data: { list: [{ id: 'u1', name: 'ada' }], page: 3, total: 91, page_size: 20 } } });
    const out = await Api.users.list({ page: 3, pageSize: 20, keyword: 'ada' });
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].path, '/admin/user?keyword=ada&page=3&page_size=20');
    assert.equal(calls[0].auth, C.AUTH.admin);
    assert.deepEqual(out, { list: [{ id: 'u1', name: 'ada' }], page: 3, total: 91, pageSize: 20 });
});

test('users.groups sends GET /admin/group and resolves to a bare array (not {list,...})', async () => {
    const calls = recorder({ status: 200, body:
        { code: 0, message: '', data: { list: [{ id: 'g1', name: 'Support' }], page: 1, total: 1, page_size: 50 } } });
    const out = await Api.users.groups();
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].path, '/admin/group');
    assert.equal(calls[0].auth, C.AUTH.admin);
    assert.deepEqual(out, [{ id: 'g1', name: 'Support' }], 'groups() must unwrap to a plain array via asList()');
});

test('users.groups tolerates a bare-array data payload with no pagination envelope at all', async () => {
    recorder({ status: 200, body: { code: 0, message: '', data: [{ id: 'g1', name: 'Support' }] } });
    const out = await Api.users.groups();
    assert.deepEqual(out, [{ id: 'g1', name: 'Support' }]);
});

test('users.create POSTs the account object as-is to /admin/user', async () => {
    const calls = recorder({ status: 200, body: { code: 0, data: null } });
    await Api.users.create({ name: 'ada', email: 'ada@example.com', password: 'correct horse' });
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].path, '/admin/user');
    assert.equal(calls[0].auth, C.AUTH.admin);
    assert.deepEqual(JSON.parse(calls[0].body), { name: 'ada', email: 'ada@example.com', password: 'correct horse' });
    await assert.rejects(Api.users.create(null), (e) => e.kind === Errors.KIND.GENERIC);
    await assert.rejects(Api.users.create('nope'), (e) => e.kind === Errors.KIND.GENERIC);
});

test('users.update PUTs to /admin/user/{id} using the object\'s own id', async () => {
    const calls = recorder({ status: 200, body: { code: 0, data: null } });
    await Api.users.update({ id: 'u1', name: 'ada2' });
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].path, '/admin/user/u1');
    assert.deepEqual(JSON.parse(calls[0].body), { id: 'u1', name: 'ada2' });
});

test('users.setGroup PUTs {id,group_id} to /admin/user/{id}', async () => {
    const calls = recorder({ status: 200, body: { code: 0, data: null } });
    await Api.users.setGroup('u1', 'g2');
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].path, '/admin/user/u1');
    assert.deepEqual(JSON.parse(calls[0].body), { id: 'u1', group_id: 'g2' });
    await assert.rejects(Api.users.setGroup('', 'g2'), (e) => e.kind === Errors.KIND.GENERIC);
});

test('users.setEnabled and setGroup refuse an empty id even without an explicit guarded() wrapper', async () => {
    // Unlike create/update/resetPassword, setEnabled/setGroup build their path
    // directly rather than going through guarded() -- confirms call()'s own
    // synchronous try/catch around fill() still turns the seg() throw into a
    // typed rejection instead of an uncaught synchronous exception.
    recorder({ status: 200, body: { code: 0, data: null } });
    await assert.rejects(Api.users.setEnabled('', true), (e) => e.name === 'PilotError' && e.kind === Errors.KIND.GENERIC);
    await assert.rejects(Api.users.setGroup('', 'g1'), (e) => e.name === 'PilotError' && e.kind === Errors.KIND.GENERIC);
});

test('audit.conn, file and login are three distinct admin endpoints', async () => {
    const calls = recorder({ status: 200, body: { code: 0, data: { list: [] } } });
    await Api.audit.conn({});
    await Api.audit.file({});
    await Api.audit.login({});
    const paths = calls.map((c) => c.path);
    assert.equal(new Set(paths).size, 3, 'audit endpoints collide: ' + paths.join(' '));
    calls.forEach((c) => assert.equal(c.auth, C.AUTH.admin));
});

// --------------------------------------------------------- hostile façade input ---

test('devices.rename: a pre-encoded traversal id is also neutralised, never a real path change', async () => {
    const calls = recorder({ status: 200, body: { code: 0, data: null } });
    await Api.devices.rename('%2e%2e', 'name');
    // encodeURIComponent escapes the literal "%" itself, so "%2e%2e" can never
    // decode back into ".." on the wire — it lands as a harmless opaque segment.
    assert.equal(calls[0].path, C.EP['devices.rename'].path.replace('{id}', '%252e%252e'));
    assert.equal(calls[0].path.split('/').indexOf('..'), -1);
});

test('devices.rename: an id containing a bare "/" cannot smuggle in an extra path segment', async () => {
    const calls = recorder({ status: 200, body: { code: 0, data: null } });
    await Api.devices.rename('a/../../etc/passwd', 'name');
    assert.equal(calls[0].path, '/admin/peer/a%2F..%2F..%2Fetc%2Fpasswd');
    assert.equal(calls[0].path.split('/').length, 4, 'the id must not introduce new segments');
});

test('encodeQuery: a value containing "#" cannot truncate the query string', () => {
    assert.equal(C.encodeQuery({ q: 'a#b' }), '?q=a%23b');
});

test('devices.rename and devices.remove refuse a null or undefined id rather than building a bad request', async () => {
    recorder({ status: 200, body: { code: 0, data: null } });
    for (const id of [null, undefined]) {
        await assert.rejects(Api.devices.rename(id, 'name'), (e) => e.name === 'PilotError');
        await assert.rejects(Api.devices.remove(id), (e) => e.name === 'PilotError');
    }
});

test('devices.list and audit.* accept a null or undefined query and still hit the right path', async () => {
    const calls = recorder({ status: 200, body: { code: 0, data: { list: [] } } });
    await Api.devices.list(null);
    await Api.devices.list(undefined);
    calls.forEach((c) => assert.equal(c.path, C.EP['devices.list'].path));
});

test('a surface failure is typed and independent — one endpoint erroring says which', async () => {
    Api.setTransport((req) => Promise.resolve(req.path.indexOf('/admin/audit') === 0
        ? { status: 404, body: '404 page not found' }
        : { status: 200, body: { code: 0, data: { list: [] } } }));
    await assert.rejects(Api.audit.conn({}), (e) => {
        assert.equal(e.kind, Errors.KIND.API_VERSION_MISMATCH);
        assert.match(e.message, /\/admin\/audit/);
        return true;
    });
    assert.deepEqual((await Api.devices.list({})).list, []);
});

// ---------------------------------------------------------- ab='' (Task 23 fixes) ---
//
// Two independent bugs found and fixed while building Task 23 (js/features/
// addressbook-ui.js), both invisible to every test that existed before it because
// this façade had NO addressbook tests of its own and addressbook-ui's own unit
// tests always inject a fully fake api — only a real end-to-end drive through
// PilotApi.addressbook (this file) surfaced either one:
//
// 1. js/core/addressbook.js's AB.PERSONAL.guid is '' by design (the personal
//    address book has no server-assigned id). Every ab.* method must accept ''
//    as a real value meaning "the personal book", not reject it as "missing" the
//    way every OTHER path/string parameter (a device, user or peer id) correctly
//    still does. addressbook-ui.js's default `activeGuid` is '' (the personal
//    book is the default selection), so before this fix every one of these calls
//    rejected before the transport ever ran.
// 2. books()/peers()/tags() used to run their response through asList()/
//    listCall()+paginate(), which only ever look at a `.list` key -- the generic
//    {list, page, total, page_size} shape devices.list/users.list/audit.* use.
//    Rustdesk's real address-book endpoints answer {profiles:[...]},
//    {peers:[...]} and {tags:[...]} instead, so paginate() silently discarded
//    every real payload down to an empty list, with no error at all. Fixed by
//    resolving to the raw unwrapped `data`, which js/core/addressbook.js's
//    booksFrom/peersFrom/tagsFrom are already built to dig through (any of
//    those keys, a bare array, or one more level of {data:...}) -- exactly why
//    the interface documents these as "-> Promise<any>" rather than a pinned
//    paginated shape.

test("addressbook.peers('') reaches the transport instead of rejecting, and resolves to the raw data", async () => {
    const calls = recorder({ status: 200, body: { code: 0, message: '', data: { peers: [{ id: 'a1' }] } } });
    const r = await Api.addressbook.peers('');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/api/ab/peers?ab=');
    assert.deepEqual(r, { peers: [{ id: 'a1' }] }, 'the real {peers:[...]} shape, not paginate()\'s {list:[]}');
});

test("addressbook.tags('') fills the path with an empty segment instead of rejecting, and resolves to the raw data", async () => {
    const calls = recorder({ status: 200, body: { code: 0, message: '', data: { tags: ['office'] } } });
    const r = await Api.addressbook.tags('');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/api/ab/tags/');
    assert.deepEqual(r, { tags: ['office'] });
});

test('addressbook.books() resolves to the real {profiles:[...]} shape, not an empty paginated list', async () => {
    const calls = recorder({ status: 200, body: { code: 0, message: '', data: { profiles: [{ guid: 'g1' }] } } });
    const r = await Api.addressbook.books();
    assert.equal(calls.length, 1);
    assert.deepEqual(r, { profiles: [{ guid: 'g1' }] });
});

test("addressbook.addTag/renameTag/removeTag/addPeer/updatePeer/removePeer all accept ab=''", async () => {
    const calls = recorder({ status: 200, body: { code: 0, message: '', data: {} } });
    await Api.addressbook.addTag('', 'x');
    await Api.addressbook.renameTag('', 'x', 'y');
    await Api.addressbook.removeTag('', 'y');
    await Api.addressbook.addPeer('', { id: 'p1' });
    await Api.addressbook.updatePeer('', { id: 'p1' });
    await Api.addressbook.removePeer('', 'p1');
    assert.equal(calls.length, 6);
    assert.deepEqual(calls.map((c) => c.path), [
        '/api/ab/tag/add/', '/api/ab/tag/rename/', '/api/ab/tag/',
        '/api/ab/peer/add/', '/api/ab/peer/update/', '/api/ab/peer/'
    ]);
});

test("ab='' is still typed and control-character checked, only the non-empty rule is relaxed", async () => {
    await assert.rejects(Api.addressbook.peers(42), (e) => e.kind === 'GENERIC');
    await assert.rejects(Api.addressbook.peers('a\x00b'), (e) => e.kind === 'GENERIC');
    await assert.rejects(Api.addressbook.tags(null), (e) => e.kind === 'GENERIC');
});

test('an empty id is still rejected for every non-ab path parameter (the fix is scoped to ab only)', async () => {
    recorder({ status: 200, body: { code: 0, data: {} } });
    await assert.rejects(Api.devices.rename('', 'x'), (e) => e.kind === 'GENERIC');
    await assert.rejects(Api.devices.remove(''), (e) => e.kind === 'GENERIC');
});

// ------------------------------------------------------------------ endpoints ---

test('ENDPOINTS: every entry is well formed and every id is unique', () => {
    const ids = new Set();
    C.ENDPOINTS.forEach((ep) => {
        assert.ok(!ids.has(ep.id), 'duplicate endpoint id ' + ep.id);
        ids.add(ep.id);
        assert.ok(IO.METHODS.indexOf(ep.method) >= 0, ep.id + ' has a bad method');
        assert.equal(ep.path.charAt(0), '/', ep.id);
        assert.equal(typeof ep.admin, 'boolean', ep.id);
        assert.equal(typeof ep.probe, 'boolean', ep.id);
    });
});

test('probeTargets: every probe target is a side-effect-free GET with no placeholder', () => {
    const targets = C.probeTargets();
    assert.ok(targets.length >= 6 && targets.length <= 12, 'probe set is not small: ' + targets.length);
    targets.forEach((ep) => {
        assert.equal(ep.method, 'GET', ep.id + ' would mutate');
        assert.equal(ep.path.indexOf('{'), -1, ep.id + ' has an unfilled placeholder');
        assert.ok(C.EP[ep.id], ep.id + ' is not a real endpoint');
    });
});

test('probeTargets: covers all four surfaces so a mismatch cannot hide in one of them', () => {
    const ids = C.probeTargets().map((e) => e.id).join(' ');
    ['devices.', 'ab.', 'users.', 'audit.'].forEach((prefix) =>
        assert.ok(ids.indexOf(prefix) >= 0, 'no probe target for ' + prefix));
});

// ---------------------------------------------------------------- module shape ---

test('module shape: pure — no cockpit reference at all', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    assert.equal(/\bcockpit\b/.test(src), false, 'api-client must never mention cockpit');
    assert.equal(/^\s*(import|export)\s/m.test(src), false, 'ES module syntax present');
    assert.ok(src.indexOf('module.exports') > 0);
    assert.equal(typeof globalThis.PilotApi, 'object');
    assert.equal(globalThis.PilotApi, C.PilotApi);
});

test('index.html loads js/core/api-client.js in its C7 position', () => {
    const html = fs.readFileSync(INDEX, 'utf8');
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    const me = srcs.indexOf('js/core/api-client.js');
    assert.ok(me >= 0, 'index.html does not load js/core/api-client.js');
    const at = C7.indexOf('js/core/api-client.js');
    C7.slice(0, at).forEach((m) => {
        const i = srcs.indexOf(m);
        if (i >= 0) assert.ok(i < me, m + ' must load before js/core/api-client.js');
    });
    C7.slice(at + 1).forEach((m) => {
        const i = srcs.indexOf(m);
        if (i >= 0) assert.ok(i > me, m + ' must load after js/core/api-client.js');
    });
});
