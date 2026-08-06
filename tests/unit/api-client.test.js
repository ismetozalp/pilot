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
        ['addPeer', 'addTag', 'books', 'peers', 'personal', 'removePeer', 'removeTag',
            'renameTag', 'tags', 'updatePeer']);
    assert.deepEqual(Object.keys(Api.users).sort(),
        ['create', 'groups', 'list', 'login', 'resetPassword', 'setEnabled', 'setGroup', 'update']);
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

// CORRECTED against the server's own admin_swagger.json: the admin API has no
// /{id} routes and no PUT or DELETE at all. The target goes in the BODY, and
// the device's name field is `alias` -- `name` is not a field admin.PeerForm
// has, so the old body would have been silently ignored even if the path had
// existed.
test('devices.rename POSTs {row_id, id, alias} — row_id is what the API matches on', async () => {
    const calls = recorder({ status: 200, body: { code: 0, data: null } });
    await Api.devices.rename(4, '../../etc', 'lobby-pi');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].path, '/api/admin/peer/update');
    // The id is data now, so it cannot smuggle a path segment at all -- a
    // stronger property than escaping it.
    assert.equal(calls[0].path.indexOf('etc'), -1, calls[0].path);
    // row_id is the database primary key. {id, alias} alone answers
    // "Params validation failed." -- measured on a live v2.7 -- so Rename
    // could not work at all.
    assert.deepEqual(JSON.parse(calls[0].body), { row_id: 4, id: '../../etc', alias: 'lobby-pi' });
});

test('devices.remove POSTs {row_id} to /peer/delete and refuses a non-numeric row', async () => {
    const calls = recorder({ status: 200, body: { code: 0, data: null } });
    await Api.devices.remove(4);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].path, '/api/admin/peer/delete');
    // {id} answers " is a required field": the API deletes by row_id.
    assert.deepEqual(JSON.parse(calls[0].body), { row_id: 4 });
    await assert.rejects(Api.devices.remove(''), (e) => e.kind === Errors.KIND.GENERIC);
    await assert.rejects(Api.devices.remove('abc'), (e) => e.kind === Errors.KIND.GENERIC);
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
    // Numeric ids: both admin.UserForm and admin.UserPasswordForm type id as an
    // integer, and the server's binder rejects a string.
    assert.deepEqual(JSON.parse(calls[0].body), { id: 7, status: 0 });
    assert.deepEqual(JSON.parse(calls[1].body), { id: 7, password: 'hunter2' });
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
    assert.equal(calls[0].path, '/api/admin/user/list?keyword=ada&page=3&page_size=20');
    assert.equal(calls[0].auth, C.AUTH.admin);
    assert.deepEqual(out, { list: [{ id: 'u1', name: 'ada' }], page: 3, total: 91, pageSize: 20 });
});

test('users.groups sends GET /admin/group and resolves to a bare array (not {list,...})', async () => {
    const calls = recorder({ status: 200, body:
        { code: 0, message: '', data: { list: [{ id: 'g1', name: 'Support' }], page: 1, total: 1, page_size: 50 } } });
    const out = await Api.users.groups();
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].path, '/api/admin/group/list');
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
    assert.equal(calls[0].path, '/api/admin/user/create');
    assert.equal(calls[0].auth, C.AUTH.admin);
    assert.deepEqual(JSON.parse(calls[0].body), { name: 'ada', email: 'ada@example.com', password: 'correct horse' });
    await assert.rejects(Api.users.create(null), (e) => e.kind === Errors.KIND.GENERIC);
    await assert.rejects(Api.users.create('nope'), (e) => e.kind === Errors.KIND.GENERIC);
});

test('users.update POSTs the account to /user/update, id in the body', async () => {
    const calls = recorder({ status: 200, body: { code: 0, data: null } });
    await Api.users.update({ id: 1, name: 'ada2' });
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].path, '/api/admin/user/update');
    assert.deepEqual(JSON.parse(calls[0].body), { id: 1, name: 'ada2' });
});

test('users.setGroup POSTs {id,group_id} to /user/update, with a NUMERIC id', async () => {
    const calls = recorder({ status: 200, body: { code: 0, data: null } });
    await Api.users.setGroup('7', '2');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].path, '/api/admin/user/update');
    // admin.UserForm types id as an integer; "7" is rejected by the server's
    // binder, so it is converted once in the client rather than at each site.
    // group_id is a uint in admin.UserForm: the server rejects the string a
    // <select> yields -- "cannot unmarshal string into Go struct field
    // UserForm.group_id of type uint" -- which is exactly what the Users tab
    // reported in the field.
    assert.deepEqual(JSON.parse(calls[0].body), { id: 7, group_id: 2 });
    await assert.rejects(Api.users.setGroup('', 'g2'), (e) => e.kind === Errors.KIND.GENERIC);
    await assert.rejects(Api.users.setGroup('not-a-number', 'g2'), (e) => e.kind === Errors.KIND.GENERIC);
});

test('users.resetPassword uses the DEDICATED endpoint, not /user/update', async () => {
    // admin.UserForm has no password field at all, so the old call sent a
    // password to a route that ignores it -- and reported success.
    //
    // The endpoint is changePwd, NOT updatePassword: admin_swagger.json declares
    // updatePassword, but v2.7 does not route it (measured 404 with a valid
    // admin token, while changePwd answered and named its required fields). The
    // shipped swagger over-declares, so the running server is the contract --
    // which is what tests/e2e/live-api-contract.live.mjs enforces.
    const calls = recorder({ status: 200, body: { code: 0, data: null } });
    await Api.users.resetPassword('1', 'a-brand-new-password');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].path, '/api/admin/user/changePwd');
    assert.deepEqual(JSON.parse(calls[0].body), { id: 1, password: 'a-brand-new-password' });
});

test('users.login exchanges a username and password for an admin token', async () => {
    const calls = recorder({ status: 200, body:
        { code: 0, message: 'success', data: { token: 'deadbeef', username: 'admin' } } });
    const out = await Api.users.login('admin', 'generated-one');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].path, '/api/admin/login');
    assert.deepEqual(JSON.parse(calls[0].body), { username: 'admin', password: 'generated-one' });
    assert.equal(out.token, 'deadbeef');
    await assert.rejects(Api.users.login('', 'x'), (e) => e.kind === Errors.KIND.GENERIC);
    await assert.rejects(Api.users.login('admin', ''), (e) => e.kind === Errors.KIND.GENERIC);
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

// The test above only ever fed an empty list through audit.conn/file/login —
// exactly the shape that would look identical whether paginate() unwrapped
// the real payload or silently discarded it (the axis Task 18's address-book
// façade actually broke on: 76 green tests that never called those methods).
// A realistic envelope — several rows, a total clearly larger than list.length,
// a non-default page/page_size — is the only fixture that can tell "unwrapped
// correctly" from "returned a plausible-looking empty stub" apart. Mutation-
// verified: breaking paginate() (js/core/api-client.js) turns these three red
// (task-25-report.md carries the transcript).
test('audit.conn unwraps a realistic paginated envelope, not just an empty list', async () => {
    const calls = recorder({ status: 200, body: { code: 0, message: '', data:
        { list: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }], page: 4, total: 137, page_size: 25 } } });
    const out = await Api.audit.conn({ page: 4, pageSize: 25 });
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].path, C.EP['audit.conn'].path + '?page=4&page_size=25');
    assert.equal(calls[0].auth, C.AUTH.admin);
    assert.deepEqual(out, { list: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }], page: 4, total: 137, pageSize: 25 });
});

test('audit.file unwraps a realistic paginated envelope, not just an empty list', async () => {
    const calls = recorder({ status: 200, body: { code: 0, message: '', data:
        { list: [{ id: 'f1' }, { id: 'f2' }], page: 2, total: 53, page_size: 10 } } });
    const out = await Api.audit.file({ page: 2, pageSize: 10 });
    assert.equal(calls[0].path, C.EP['audit.file'].path + '?page=2&page_size=10');
    assert.deepEqual(out, { list: [{ id: 'f1' }, { id: 'f2' }], page: 2, total: 53, pageSize: 10 });
});

test('audit.login unwraps a realistic paginated envelope, not just an empty list', async () => {
    const calls = recorder({ status: 200, body: { code: 0, message: '', data:
        { list: [{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }, { id: 'l4' }], page: 1, total: 204, page_size: 4 } } });
    const out = await Api.audit.login({ page: 1, pageSize: 4 });
    assert.equal(calls[0].path, C.EP['audit.login'].path + '?page=1&page_size=4');
    assert.deepEqual(out, { list: [{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }, { id: 'l4' }], page: 1, total: 204, pageSize: 4 });
});

// --------------------------------------------------------- hostile façade input ---

test('devices.rename: a pre-encoded traversal id is also neutralised, never a real path change', async () => {
    const calls = recorder({ status: 200, body: { code: 0, data: null } });
    await Api.devices.rename(4, '%2e%2e', 'name');
    // encodeURIComponent escapes the literal "%" itself, so "%2e%2e" can never
    // decode back into ".." on the wire — it lands as a harmless opaque segment.
    assert.equal(calls[0].path, C.EP['devices.rename'].path,
        'the id is data now, so the path is fixed and cannot be steered at all');
    assert.equal(JSON.parse(calls[0].body).id, '%2e%2e', 'and it survives verbatim in the body');
    assert.equal(calls[0].path.split('/').indexOf('..'), -1);
});

test('devices.rename: a hostile id cannot reach the path at all', async () => {
    // Stronger than the escaping this used to assert: the real admin API takes
    // the id in the body, so there is no path for it to smuggle a segment into.
    const calls = recorder({ status: 200, body: { code: 0, data: null } });
    await Api.devices.rename(4, 'a/../../etc/passwd', 'name');
    assert.equal(calls[0].path, '/api/admin/peer/update');
    assert.equal(calls[0].path.indexOf('passwd'), -1, 'the id must not appear in the path');
    assert.deepEqual(JSON.parse(calls[0].body),
        { row_id: 4, id: 'a/../../etc/passwd', alias: 'name' });
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
    Api.setTransport((req) => Promise.resolve(req.path.indexOf('/api/admin/audit') === 0
        ? { status: 404, body: '404 page not found' }
        : { status: 200, body: { code: 0, data: { list: [] } } }));
    await assert.rejects(Api.audit.conn({}), (e) => {
        assert.equal(e.kind, Errors.KIND.API_VERSION_MISMATCH);
        assert.match(e.message, /\/api\/admin\/audit/);
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

test('addressbook.books() is the UNION of the personal book and the shared ones', async () => {
    // The personal book is not in shared/profiles -- it is its own call, and it
    // is the only place its real guid ("1-1-0" on the reference server) can be
    // learned. AB.PERSONAL hardcoded '', so every personal-book request went to
    // /api/ab/peers?ab= and /api/ab/tags/, which answer 400 and 404.
    const calls = [];
    Api.setTransport((req) => {
        calls.push(req);
        if (req.path === '/api/ab/personal')
            return Promise.resolve({ status: 200, body: { guid: '1-1-0', name: 'admin', rule: 3 } });
        return Promise.resolve({ status: 200, body: { data: [{ guid: 'g1', name: 'Support' }], total: 1 } });
    });
    const r = await Api.addressbook.books();
    assert.deepEqual(calls.map((c) => c.path).sort(),
        ['/api/ab/personal', '/api/ab/shared/profiles']);
    assert.deepEqual(r, { profiles: [
        { guid: '1-1-0', name: 'admin', personal: true },
        { guid: 'g1', name: 'Support' }
    ] }, 'the personal book comes first, carrying the guid the server gave it');
});

test('addressbook.books(): one half failing must not lose the other', async () => {
    // A server with no shared books still has a personal one, and vice versa.
    Api.setTransport((req) => req.path === '/api/ab/personal'
        ? Promise.resolve({ status: 200, body: { guid: '1-1-0', name: 'admin' } })
        : Promise.resolve({ status: 500, body: 'boom' }));
    assert.deepEqual((await Api.addressbook.books()).profiles,
        [{ guid: '1-1-0', name: 'admin', personal: true }]);

    Api.setTransport((req) => req.path === '/api/ab/personal'
        ? Promise.resolve({ status: 500, body: 'boom' })
        : Promise.resolve({ status: 200, body: { data: [{ guid: 'g1' }] } }));
    assert.deepEqual((await Api.addressbook.books()).profiles, [{ guid: 'g1' }]);

    // Both failing is an empty list, never a throw that blanks the surface.
    Api.setTransport(() => Promise.resolve({ status: 500, body: 'boom' }));
    assert.deepEqual((await Api.addressbook.books()).profiles, []);
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
    // addPeer POSTs to .../peer/add/{guid}; removePeer DELETEs .../peer/{guid}.
    // The swagger declares the delete at .../peer/add/{guid} and the running
    // server 404s that -- measured both ways, like updatePassword before it.
    assert.deepEqual(calls.map((c) => c.path), [
        '/api/ab/tag/add/', '/api/ab/tag/rename/', '/api/ab/tag/',
        '/api/ab/peer/add/', '/api/ab/peer/update/', '/api/ab/peer/'
    ]);
    // And the BODY shapes the server actually accepts: a single peer object,
    // never an array ("cannot unmarshal array into Go value of type
    // api.PeerForm"), and a tag as {name}, never an array or a bare string.
    assert.deepEqual(JSON.parse(calls[0].body), { name: 'x' }, 'addTag sends {name}');
    assert.deepEqual(JSON.parse(calls[3].body), { id: 'p1' }, 'addPeer sends ONE peer, not [peer]');
    assert.deepEqual(JSON.parse(calls[4].body), { id: 'p1' }, 'updatePeer sends ONE peer');
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

test('probeTargets: covers both auth surfaces, and never anything that mutates', () => {
    const targets = C.probeTargets();
    const ids = targets.map((e) => e.id).join(' ');
    // The three admin surfaces, each a parameterless GET.
    ['devices.', 'users.', 'audit.'].forEach((prefix) =>
        assert.ok(ids.indexOf(prefix) >= 0, 'no probe target for ' + prefix));
    // And the client surface, which is what validates the Bearer half of the
    // auth seam -- previously "covered" by ab.books/ab.peers, which the server
    // does not serve as GET at all. They are POST-shaped reads, and the probe's
    // rule is that it issues nothing but parameterless GETs, so the address
    // book is deliberately not probed; session.current stands in for it.
    assert.ok(targets.some((e) => e.id === 'session.current' && e.admin === false),
        'the client API must be probed too, or a Bearer mismatch hides');
    targets.forEach((e) => {
        assert.equal(e.method, 'GET', e.id + ' is probed but is not a GET');
        assert.equal(e.path.indexOf('{'), -1, e.id + ' is probed but takes a path parameter');
    });
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

test('ENDPOINTS: the exact routes, pinned — every one measured against a real v2.7 server', () => {
    // Mutation showed a route could be changed to anything without a single
    // test failing, because the assertions referenced EP[...].path rather than
    // the literal. That is how a whole table of 404s survived: the tests agreed
    // with whatever it said. These are the paths tests/e2e/live-api-contract
    // confirmed the server actually serves.
    const actual = {};
    C.ENDPOINTS.forEach((e) => { actual[e.id] = e.method + ' ' + e.path; });
    assert.deepEqual(actual, {
        'session.current': 'GET /api/peers',
        'devices.list': 'GET /api/admin/peer/list',
        'devices.rename': 'POST /api/admin/peer/update',
        'devices.remove': 'POST /api/admin/peer/delete',
        'ab.personal': 'POST /api/ab/personal',
        'ab.books': 'POST /api/ab/shared/profiles',
        'ab.peers': 'POST /api/ab/peers',
        'ab.addPeer': 'POST /api/ab/peer/add/{ab}',
        'ab.updatePeer': 'PUT /api/ab/peer/update/{ab}',
        'ab.removePeer': 'DELETE /api/ab/peer/{ab}',
        'ab.tags': 'POST /api/ab/tags/{ab}',
        'ab.addTag': 'POST /api/ab/tag/add/{ab}',
        'ab.renameTag': 'PUT /api/ab/tag/rename/{ab}',
        'ab.removeTag': 'DELETE /api/ab/tag/{ab}',
        'users.list': 'GET /api/admin/user/list',
        'users.create': 'POST /api/admin/user/create',
        'users.update': 'POST /api/admin/user/update',
        'users.password': 'POST /api/admin/user/changePwd',
        'users.groups': 'GET /api/admin/group/list',
        'audit.conn': 'GET /api/admin/audit_conn/list',
        'audit.file': 'GET /api/admin/audit_file/list',
        'audit.login': 'GET /api/admin/login_log/list',
        'admin.login': 'POST /api/admin/login'
    });
    // The two shapes that were wrong everywhere, as standing rules.
    C.ENDPOINTS.forEach((e) => {
        assert.ok(e.path.indexOf('/api/') === 0, e.id + ' is missing the /api base path: ' + e.path);
        if (e.admin) assert.ok(e.method === 'GET' || e.method === 'POST',
            e.id + ' uses ' + e.method + ', but the admin surface has no PUT or DELETE');
    });
});

test('devices.addToAddressBook sends ONE peer, exactly like addressbook.addPeer', async () => {
    // THE BUG, reported twice: "Add to address book" failed with
    // "the API request failed (/api/ab/peer/add/1-1-0)" -- and kept failing
    // after addressbook.addPeer was fixed, because this method built its OWN
    // ab.addPeer request with body [peer]. The server answers an array with
    // 400 "cannot unmarshal array into Go value of type api.PeerForm". Nothing
    // covered this body, so the suite stayed green through both rounds.
    const calls = recorder({ status: 200, body: { code: 0, data: null } });
    await Api.devices.addToAddressBook('100000002', '1-1-0');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].path, '/api/ab/peer/add/1-1-0');
    const body = JSON.parse(calls[0].body);
    assert.ok(!Array.isArray(body), 'an array is rejected outright by the server');
    assert.deepEqual(body, { id: '100000002' });
    // Same wire shape as the address-book surface's own call -- they are one
    // operation and must not drift apart again.
    const direct = recorder({ status: 200, body: { code: 0, data: null } });
    await Api.addressbook.addPeer('1-1-0', { id: '100000002' });
    assert.deepEqual(JSON.parse(direct[0].body), body);
    assert.equal(direct[0].path, calls[0].path);
});

test('only ONE place builds an ab.addPeer request', () => {
    // Two copies of one request is how the fix missed the second caller. The
    // devices method delegates now, and this is what keeps it that way.
    const src = fs.readFileSync(SRC, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const hits = (src.match(/call\('ab\.addPeer'/g) || []).length;
    assert.equal(hits, 1, "ab.addPeer must be built in exactly one place; " +
        'call PilotApi.addressbook.addPeer() instead of re-issuing it');
});
