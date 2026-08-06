// Unit tests for js/features/devices-ui.js -- the Devices surface.
//
// The parsers are the risk here: the payload comes from a third-party API server
// over a bridge, so every one of them is driven with hostile input as well as with
// the shape the server is documented to return.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const D = require('../../js/features/devices-ui.js');
const Errors = require('../../js/core/errors.js');

const ROOT = path.join(__dirname, '..', '..');
const DASH = '—';
const NOW = Date.UTC(2026, 7, 3, 12, 0, 0);
const PROTO_KEYS = ['__proto__', 'toString', 'constructor', 'valueOf', 'hasOwnProperty'];

// The shape C12 documents: HTTP 200, {code,message,data}, paginated data.
function payload(list, over) {
    return { code: 0, message: '', data: Object.assign(
        { list, page: 1, total: list.length, page_size: 50 }, over || {}) };
}

// row_id is the database primary key every real peer row carries, and the one
// the admin API matches on for update/delete. The fixtures lacked it, so the
// suite could not have caught Rename and Delete addressing the wrong field.
const RAW = [
    { row_id: 1, id: '123456789', alias: 'Kitchen Pi', online: true, last_online: 1754222400,
      ip: '10.0.0.7', platform: 'Linux', version: '1.3.7' },
    { row_id: 2, id: '987654321', hostname: 'reception', online: false, last_online: 1754136000,
      ip: '10.0.0.9', platform: 'Windows', version: '1.3.6' }
];

// --- module shape --------------------------------------------------------

test('module loads with no DOM and no cockpit global', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof D.pilotDevices, 'function');
    assert.equal(typeof globalThis.pilotDevices, 'function');
    assert.equal(D.MOUNT_ID, 'pilot-devices');
    assert.equal(D.SERVER_CHANGED_EVENT, 'pilot:server-changed');
});

test('the module never builds a URL or touches cockpit itself (C12)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'js/features/devices-ui.js'), 'utf8');
    assert.ok(!/cockpit\./.test(src), 'a surface must go through PilotApi, never cockpit');
    assert.ok(!/https?:\/\//.test(src.replace(/^\s*\/\/.*$/gm, '')),
        'a surface must not build URLs -- api-client owns them');
});

test('index.html loads devices-ui.js before js/app.js (C5 rule 4, C7 order)', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.includes('js/features/devices-ui.js'));
    // Subsequence/contains only -- later tasks legitimately add more tags (C11).
    assert.ok(srcs.indexOf('js/features/devices-ui.js') < srcs.indexOf('js/app.js'));
    assert.ok(srcs.indexOf('js/core/api-client.js') < srcs.indexOf('js/features/devices-ui.js'));
});

// --- toMillis ------------------------------------------------------------

test('toMillis: epoch seconds and milliseconds', () => {
    assert.equal(D.toMillis(1754222400), 1754222400000);
    assert.equal(D.toMillis(1754222400000), 1754222400000);
    assert.equal(D.toMillis('1754222400'), 1754222400000);
    assert.equal(D.toMillis('2026-08-03T12:00:00Z'), NOW);
});

test('toMillis: a control character makes it not a timestamp', () => {
    // Trimming first would silently accept these; the check is on the raw string.
    for (const bad of ['1754222400\n', '1754222400\x00', '\x0b2026-08-03T12:00:00Z'])
        assert.equal(D.toMillis(bad), null, JSON.stringify(bad));
});

test('toMillis: rejects everything that is not a usable time', () => {
    for (const bad of [null, undefined, 0, -1, NaN, Infinity, -Infinity, '', '   ',
        'yesterday', {}, [], [1754222400], true, false, () => 1, Symbol('x'),
        '0001-01-01T00:00:00Z'])
        assert.equal(D.toMillis(bad), null, String(bad));
});

// --- relativeTime --------------------------------------------------------

test('relativeTime: phrases and singular/plural', () => {
    assert.equal(D.relativeTime(NOW, NOW), 'just now');
    assert.equal(D.relativeTime(NOW - 30000, NOW), 'just now');
    assert.equal(D.relativeTime(NOW - 60000, NOW), '1 minute ago');
    assert.equal(D.relativeTime(NOW - 600000, NOW), '10 minutes ago');
    assert.equal(D.relativeTime(NOW - 3600000, NOW), '1 hour ago');
    assert.equal(D.relativeTime(NOW - 86400000, NOW), '1 day ago');
    assert.equal(D.relativeTime(NOW - 86400000 * 9, NOW), '9 days ago');
});

test('relativeTime: unknown is "never", and a clock skew is not a negative age', () => {
    for (const bad of [null, undefined, NaN, 'x', {}])
        assert.equal(D.relativeTime(bad, NOW), 'never', String(bad));
    assert.equal(D.relativeTime(NOW + 600000, NOW), 'just now');
});

// --- normalizeList -------------------------------------------------------

test('normalizeList: the documented envelope, the bare page and a bare array', () => {
    const a = D.normalizeList(payload(RAW));
    assert.equal(a.items.length, 2);
    assert.equal(a.total, 2);
    assert.equal(a.page, 1);
    assert.equal(a.pageSize, 50);

    const b = D.normalizeList({ list: RAW, page: 2, total: 9, page_size: 20 });
    assert.equal(b.items.length, 2);
    assert.equal(b.total, 9);
    assert.equal(b.page, 2);
    assert.equal(b.pageSize, 20);

    const c = D.normalizeList(RAW);
    assert.equal(c.items.length, 2);
    assert.equal(c.total, 2, 'with no meta the count of what we got is the total');
    assert.equal(c.page, null);
});

test('normalizeList: camelCase pageSize and string counters are accepted', () => {
    const r = D.normalizeList({ list: [], page: '3', total: '41', pageSize: '20' });
    assert.equal(r.page, 3);
    assert.equal(r.total, 41);
    assert.equal(r.pageSize, 20);
});

test('normalizeList: non-object entries are dropped rather than rendered', () => {
    const r = D.normalizeList({ list: [null, 'x', 7, [], RAW[0], undefined, true] });
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].id, '123456789');
});

test('normalizeList: hostile payloads produce an empty page, never a throw', () => {
    for (const bad of [null, undefined, '', 'not json', 0, 42, true, [],
        {}, { code: 1, message: 'nope', data: null }, { data: 'truncated' },
        { list: 'not-an-array' }, { data: { data: { data: {} } } }, Object.create(null)]) {
        const r = D.normalizeList(bad);
        assert.ok(Array.isArray(r.items), JSON.stringify(bad));
        assert.equal(r.items.length, 0, JSON.stringify(bad));
        assert.equal(r.total, 0, JSON.stringify(bad));
    }
});

// --- deviceRow / deviceRows ---------------------------------------------

test('deviceRow: the fields the inventory renders', () => {
    const r = D.deviceRow(RAW[0], NOW);
    assert.equal(r.id, '123456789');
    assert.equal(r.name, 'Kitchen Pi');
    assert.equal(r.online, true);
    assert.equal(r.lastSeenMs, 1754222400000);
    assert.equal(r.lastSeenText, D.relativeTime(1754222400000, NOW));
    assert.equal(r.ip, '10.0.0.7');
    assert.equal(r.platform, 'Linux');
    assert.equal(r.version, '1.3.7');
});

test('deviceRow: alternative field names every API build has used', () => {
    const r = D.deviceRow({ device_id: 'abc', device_name: 'lab', is_online: 1,
        last_seen: '2026-08-03T11:00:00Z', last_ip: '192.0.2.4', os: 'macOS',
        client_version: '1.2.0' }, NOW);
    assert.equal(r.id, 'abc');
    assert.equal(r.name, 'lab');
    assert.equal(r.online, true);
    assert.equal(r.lastSeenMs, Date.UTC(2026, 7, 3, 11, 0, 0));
    assert.equal(r.ip, '192.0.2.4');
    assert.equal(r.platform, 'macOS');
    assert.equal(r.version, '1.2.0');
});

test('deviceRow: the server is believed when it speaks, and the heartbeat when it does not', () => {
    // CORRECTED. This used to assert that a fresh heartbeat must NOT make a
    // device online -- "the whole point of the surface is genuine heartbeat
    // state (spec 7.2)". The intent was right and the implementation inverted
    // it: rustdesk-api v2.7 peer rows carry no online field of any kind, so
    // "only what the server said" meant "always offline", and the Overview
    // reported 4 devices, 0 online while the user had machines connected.
    // Deriving from the heartbeat IS reporting genuine heartbeat state; it is
    // the only place that state exists.
    const fresh = D.deviceRow({ id: 'x', last_online: Math.floor(NOW / 1000) }, NOW);
    assert.equal(fresh.online, true, 'a device heard from seconds ago is online');
    assert.equal(fresh.onlineFrom, 'heartbeat');
    const stale = D.deviceRow({ id: 'x', last_online: Math.floor(NOW / 1000) - 3600 }, NOW);
    assert.equal(stale.online, false, 'an hour of silence is not online');

    // An explicit field still wins, and the coercion is unchanged.
    assert.equal(D.deviceRow({ id: 'x', online: 'true' }, NOW).online, true);
    assert.equal(D.deviceRow({ id: 'x', online: 'ONLINE' }, NOW).online, true);
    assert.equal(D.deviceRow({ id: 'x', online: 'true' }, NOW).onlineFrom, 'server');
    for (const v of [0, '0', 'false', 'maybe', {}, [], 2])
        assert.equal(D.deviceRow({ id: 'x', online: v }, NOW).online, false, String(v));
    // '', null and undefined are "the server said nothing", not "offline" --
    // with no timestamp either, the answer is still false.
    for (const v of ['', null, undefined])
        assert.equal(D.deviceRow({ id: 'x', online: v }, NOW).online, false, String(v));
    // ...but they must not suppress a good heartbeat.
    for (const v of ['', null, undefined])
        assert.equal(D.deviceRow({ id: 'x', online: v, last_online: Math.floor(NOW / 1000) }, NOW).online,
            true, String(v));
});

test('deviceRow: unknown values are a dash, not an empty cell or "undefined"', () => {
    const r = D.deviceRow({ id: 'only-an-id' }, NOW);
    assert.equal(r.name, 'only-an-id', 'a nameless device is identified by its id');
    assert.equal(r.ip, DASH);
    assert.equal(r.platform, DASH);
    assert.equal(r.version, DASH);
    assert.equal(r.lastSeenText, 'never');
    assert.equal(r.lastSeenMs, null);
});

test('deviceRow: control characters and oversized fields cannot break the table', () => {
    const r = D.deviceRow({ id: 'a\x00b', alias: 'line\nbreak\ttab',
        ip: '10.0.0.1\r\n10.0.0.2', platform: 'x'.repeat(5000) }, NOW);
    assert.ok(!/[\x00-\x1f\x7f]/.test(r.id + r.name + r.ip + r.platform));
    assert.equal(r.name, 'line break tab');
    assert.ok(r.platform.length <= 200, 'an oversized field is truncated, not rendered whole');
});

test('deviceRow: unicode and a traversal-shaped name survive verbatim', () => {
    const r = D.deviceRow({ id: 'u1', alias: '厂房 🔥 café' }, NOW);
    assert.equal(r.name, '厂房 🔥 café');
    assert.equal(D.deviceRow({ id: 'u2', alias: '../../etc/passwd' }, NOW).name,
        '../../etc/passwd', 'a device name is a label, never a path -- it is shown as typed');
});

test('deviceRow: prototype-shaped input yields strings, not functions', () => {
    for (const k of PROTO_KEYS) {
        const r = D.deviceRow({ id: 'p', alias: k, platform: k }, NOW);
        assert.equal(typeof r.name, 'string', k);
        assert.equal(r.name, k, k);
    }
    const r = D.deviceRow(Object.create(null), NOW);
    assert.equal(r.id, '');
});

test('deviceRows: rows with no id are dropped -- they cannot be acted on', () => {
    const rows = D.deviceRows(payload([{ alias: 'ghost' }, RAW[0], { id: '   ' }]), NOW);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, '123456789');
});

test('deviceRows: hostile payloads give an empty inventory, never a throw', () => {
    for (const bad of [null, undefined, 'x', 7, {}, [], { data: null }])
        assert.deepEqual(D.deviceRows(bad, NOW), [], String(bad));
});

// --- filter and sort -----------------------------------------------------

test('filterRows: matches name, id, address and platform, case-insensitively', () => {
    const rows = D.deviceRows(payload(RAW), NOW);
    assert.equal(D.filterRows(rows, 'kitchen').length, 1);
    assert.equal(D.filterRows(rows, 'KITCHEN').length, 1);
    assert.equal(D.filterRows(rows, '10.0.0.9').length, 1);
    assert.equal(D.filterRows(rows, 'windows').length, 1);
    assert.equal(D.filterRows(rows, '9876').length, 1);
    assert.equal(D.filterRows(rows, '').length, 2);
    assert.equal(D.filterRows(rows, 'nothing-matches').length, 0);
});

test('filterRows: hostile queries and rows do not throw', () => {
    const rows = D.deviceRows(payload(RAW), NOW);
    for (const q of [null, undefined, 7, {}, [], '\x00', '   '])
        assert.equal(D.filterRows(rows, q).length, 2, String(q));
    for (const bad of [null, undefined, 'x', 7, {}])
        assert.deepEqual(D.filterRows(bad, 'a'), [], String(bad));
});

test('sortRows: every supported key, both directions, with a total order', () => {
    const rows = D.deviceRows(payload(RAW), NOW);
    assert.deepEqual(D.sortRows(rows, 'name', 'asc').map((r) => r.name),
        ['Kitchen Pi', 'reception']);
    assert.deepEqual(D.sortRows(rows, 'name', 'desc').map((r) => r.name),
        ['reception', 'Kitchen Pi']);
    assert.deepEqual(D.sortRows(rows, 'online', 'desc').map((r) => r.id),
        ['123456789', '987654321']);
    assert.deepEqual(D.sortRows(rows, 'lastSeenMs', 'asc').map((r) => r.id),
        ['987654321', '123456789']);
    // Devices with no last-seen sort together, before the ones we know about.
    const withNull = D.deviceRows(payload([{ id: 'zz' }].concat(RAW)), NOW);
    assert.equal(D.sortRows(withNull, 'lastSeenMs', 'asc')[0].id, 'zz');
});

test('sortRows: an unknown or prototype-shaped key leaves the order alone', () => {
    const rows = D.deviceRows(payload(RAW), NOW);
    for (const k of PROTO_KEYS.concat([null, undefined, '', 'nope', 7]))
        assert.deepEqual(D.sortRows(rows, k, 'asc').map((r) => r.id),
            rows.map((r) => r.id), String(k));
    assert.notEqual(D.sortRows(rows, 'name', 'asc'), rows, 'sorting must not mutate the input');
});

// --- validName -----------------------------------------------------------

test('validName: accepts ordinary and unicode names, trimming them', () => {
    assert.deepEqual(D.validName('  Kitchen Pi  '),
        { ok: true, reason: '', value: 'Kitchen Pi' });
    assert.equal(D.validName('厂房 🔥').ok, true);
    assert.equal(D.validName('a'.repeat(64)).ok, true);
});

test('validName: rejects empty, control characters and oversized names', () => {
    for (const bad of ['', '   ', '\t', 'a\nb', 'a\x00b', 'a\x1fb', 'a\x7fb',
        'a'.repeat(65), null, undefined, 7, {}, [], true]) {
        const v = D.validName(bad);
        assert.equal(v.ok, false, JSON.stringify(bad));
        assert.ok(v.reason.length > 0, JSON.stringify(bad));
    }
});

// --- per-server state ----------------------------------------------------

test('stateFor: a fresh slice per server, isolated from the others', () => {
    const store = D.newStore();
    const a = D.stateFor(store, 'alpha');
    const b = D.stateFor(store, 'beta');
    a.query = 'kitchen';
    assert.equal(b.query, '');
    assert.equal(D.stateFor(store, 'alpha').query, 'kitchen', 'the slice is remembered');
    assert.deepEqual(Object.keys(D.newSurfaceState()).sort(),
        ['error', 'loadedAt', 'page', 'pageSize', 'query', 'rows', 'sortDir', 'sortKey', 'total']);
});

test('stateFor: a prototype-shaped server id is an ordinary key', () => {
    const store = D.newStore();
    for (const k of PROTO_KEYS) {
        const s = D.stateFor(store, k);
        assert.equal(typeof s, 'object', k);
        assert.equal(s.query, '', k);
        s.query = k;
        assert.equal(D.stateFor(store, k).query, k, k);
    }
    assert.equal(D.stateFor(store, 'alpha').query, '', 'no key leaked across servers');
});

test('stateFor: a missing or hostile store still returns a usable slice', () => {
    for (const bad of [null, undefined, 'x', 7, true])
        assert.equal(D.stateFor(bad, 'a').query, '', String(bad));
    assert.equal(D.stateFor(D.newStore(), '').query, '', 'a blank id falls back to "local"');
});

test('rememberState: writes only known keys and returns the store', () => {
    const store = D.newStore();
    const out = D.rememberState(store, 'alpha',
        { query: 'pi', page: 3, nonsense: 1, __proto__: { polluted: true } });
    assert.equal(out, store);
    assert.equal(D.stateFor(store, 'alpha').query, 'pi');
    assert.equal(D.stateFor(store, 'alpha').page, 3);
    assert.equal(D.stateFor(store, 'alpha').nonsense, undefined);
    assert.equal({}.polluted, undefined, 'no prototype pollution');
    D.rememberState(store, 'alpha', null);
    assert.equal(D.stateFor(store, 'alpha').query, 'pi', 'a null patch changes nothing');
});

// --- errorMessage --------------------------------------------------------

test('errorMessage: survives every error shape a bridge can produce', () => {
    assert.equal(D.errorMessage(Errors.create('API_UNREACHABLE', 'no route to host')),
        'no route to host');
    assert.equal(D.errorMessage('plain string'), 'plain string');
    assert.equal(D.errorMessage(null), '');
    assert.equal(D.errorMessage(undefined), '');
    assert.equal(typeof D.errorMessage(Object.create(null)), 'string');
    assert.equal(typeof D.errorMessage({ get message() { throw new Error('boom'); } }), 'string');
    assert.equal(typeof D.errorMessage({ kind: 'API_AUTH_FAILED' }), 'string');
});

// --- the component -------------------------------------------------------

function fakeApi(over) {
    const calls = [];
    const api = {
        calls,
        devices: {
            list: async (q) => { calls.push(['list', q]); return payload(RAW); },
            rename: async (rowId, id, name) => { calls.push(['rename', rowId, id, name]); return { code: 0 }; },
            remove: async (rowId) => { calls.push(['remove', rowId]); return { code: 0 }; },
            addToAddressBook: async (id, ab) => { calls.push(['addToAddressBook', id, ab]); return { code: 0 }; }
        }
    };
    Object.assign(api.devices, (over && over.devices) || {});
    // The address-book half of the façade. `books` answers rustdesk's own
    // {data:{profiles:[...]}} shape, which js/core/addressbook.js's booksFrom()
    // is what normalises -- this surface must not re-derive it.
    api.addressbook = Object.assign({
        books: async () => { calls.push(['books']); return { data: { profiles: [
            { guid: '', name: 'Personal', personal: true },
            { guid: 'shared-1', name: 'Support team' }
        ] } }; }
    }, (over && over.addressbook) || {});
    return api;
}

// Calls that are not the address-book list: refresh(true) now also re-fetches
// the books (they are per server and a new one must show up without a reload),
// which is deliberate and not what these device-table assertions are about.
function deviceCalls(api) { return api.calls.filter((x) => x[0] !== 'books'); }

function component(over) {
    const o = over || {};
    return D.pilotDevices(Object.assign({
        api: o.api || fakeApi(), store: D.newStore(), serverId: 'alpha',
        doc: null, now: () => NOW
    }, o.deps || {}));
}

test('the component constructs with no api, no DOM and no store', () => {
    const c = D.pilotDevices();
    assert.equal(c.loading, false);
    assert.deepEqual(c.rows, []);
    assert.equal(c.serverId, 'local');
    assert.equal(c.hasApi(), false);
});

test('refresh renders the inventory and records the total', async () => {
    const api = fakeApi();
    const c = component({ api });
    await c.refresh(true);
    assert.equal(c.loading, false);
    assert.equal(c.error, null);
    assert.equal(c.rows.length, 2);
    assert.equal(c.total, 2);
    assert.equal(c.visible()[0].name, 'Kitchen Pi');
    assert.deepEqual(deviceCalls(api)[0], ['list', { page: 1, page_size: 50, q: '' }]);
});

test('a devices failure is reported with its kind and does not blank the surface', async () => {
    const c = component({ api: fakeApi({ devices: {
        list: async () => { throw Errors.create('API_UNREACHABLE', 'connection refused'); }
    } }) });
    await c.refresh(true);
    assert.equal(c.loading, false);
    assert.deepEqual(c.rows, []);
    assert.equal(c.errorText(c.error), 'connection refused');
    assert.equal(c.errorRemediation(c.error), Errors.remediation('API_UNREACHABLE'));
});

test('no API client is a stated reason, not an empty table', async () => {
    const c = D.pilotDevices({ api: null, store: D.newStore() });
    await c.refresh(true);
    assert.ok(c.error);
    assert.match(c.errorText(c.error), /API client/);
});

test('refresh without force serves the remembered rows instead of refetching', async () => {
    const api = fakeApi();
    const c = component({ api });
    await c.refresh(true);
    await c.refresh(false);
    assert.equal(deviceCalls(api).length, 1, 'the second call came from the per-server cache');
    assert.equal(c.rows.length, 2);
});

test('switching servers preserves the query and the rows of the one we left', async () => {
    const api = fakeApi();
    const c = component({ api });
    await c.refresh(true);
    c.setQuery('kitchen');
    assert.equal(c.visible().length, 1);

    // Counts device LIST calls specifically: switching server also re-fetches
    // the address books (they are per server too), which is a different call.
    const lists = () => api.calls.filter((x) => x[0] === 'list').length;
    await c.useServer('beta');
    assert.equal(c.serverId, 'beta');
    assert.equal(c.state.query, '', 'a new server starts with a clean filter');
    assert.equal(lists(), 2, 'an unseen server is fetched');

    await c.useServer('alpha');
    assert.equal(c.state.query, 'kitchen', 'the filter came back');
    assert.equal(c.rows.length, 2);
    assert.equal(c.visible().length, 1);
    assert.equal(lists(), 2, 'a server we already loaded is not refetched');
});

test('switching to the server we are already on does nothing', async () => {
    const api = fakeApi();
    const c = component({ api });
    await c.refresh(true);
    await c.useServer('alpha');
    assert.equal(deviceCalls(api).length, 1);
});

test('a server-changed event switches the surface; a malformed one is ignored', async () => {
    const c = component();
    await c.refresh(true);
    assert.equal(c.onServerChanged({ detail: { id: 'beta' } }), true);
    assert.equal(c.serverId, 'beta');
    // A safe describer: one case here is a `detail` getter that itself throws, and
    // JSON.stringify(ev) would throw trying to read it before assert.equal even runs.
    const describe = (v) => { try { return JSON.stringify(v); } catch (e) { return '<throws: ' + e.message + '>'; } };
    for (const ev of [null, undefined, {}, { detail: null }, { detail: { id: '' } },
        { detail: { id: 7 } }, { get detail() { throw new Error('boom'); } }])
        assert.equal(c.onServerChanged(ev), false, describe(ev));
    assert.equal(c.serverId, 'beta');
});

test('rename validates before it calls the API, and patches the row in place', async () => {
    const api = fakeApi();
    const c = component({ api });
    await c.refresh(true);
    c.startRename(c.rows[0]);
    assert.equal(c.editName, 'Kitchen Pi');

    c.editName = 'a\nb';
    assert.equal(await c.commitRename(), false);
    assert.ok(c.actionError);
    assert.equal(deviceCalls(api).length, 1, 'an invalid name never reaches the server');

    c.editName = '  Kitchen  ';
    assert.equal(await c.commitRename(), true);
    assert.deepEqual(deviceCalls(api)[1], ['rename', 1, '123456789', 'Kitchen'],
        'row_id first: the admin API matches on the database primary key');
    assert.equal(c.rows[0].name, 'Kitchen');
    assert.equal(c.editingId, null);
    assert.equal(c.isBusy('123456789'), false);
});

test('a rename the server rejects keeps the old name and reports the reason', async () => {
    const c = component({ api: fakeApi({ devices: {
        rename: async () => { throw Errors.create('API_AUTH_FAILED', 'token expired'); }
    } }) });
    await c.refresh(true);
    c.startRename(c.rows[0]);
    c.editName = 'New name';
    assert.equal(await c.commitRename(), false);
    assert.equal(c.rows[0].name, 'Kitchen Pi');
    assert.equal(c.errorText(c.actionError), 'token expired');
    assert.equal(c.isBusy('123456789'), false);
});

test('a traversal-shaped rename is sent verbatim as a name, never as a path', async () => {
    const api = fakeApi();
    const c = component({ api });
    await c.refresh(true);
    c.startRename(c.rows[0]);
    c.editName = '../../etc/shadow';
    assert.equal(await c.commitRename(), true);
    // rowId first: the admin API matches on the database primary key, and the
    // RustDesk id alone answers "Params validation failed."
    assert.deepEqual(deviceCalls(api)[1], ['rename', 1, '123456789', '../../etc/shadow']);
});

test('delete takes two clicks and removes exactly one row', async () => {
    const api = fakeApi();
    const c = component({ api });
    await c.refresh(true);
    assert.equal(await c.confirmDelete(), false, 'nothing is deleted without a confirmation');
    c.askDelete(c.rows[1]);
    assert.equal(c.confirmingId, '987654321');
    c.cancelDelete();
    assert.equal(c.confirmingId, null);
    assert.equal(deviceCalls(api).length, 1);

    c.askDelete(c.rows[1]);
    assert.equal(await c.confirmDelete(), true);
    assert.deepEqual(deviceCalls(api)[1], ['remove', 2], 'deleted by row_id, not by device id');
    assert.deepEqual(c.rows.map((r) => r.id), ['123456789']);
    assert.equal(c.total, 1);
});

test('a delete the server refuses leaves the row in place', async () => {
    const c = component({ api: fakeApi({ devices: {
        remove: async () => { throw Errors.create('GENERIC', 'device is in use'); }
    } }) });
    await c.refresh(true);
    c.askDelete(c.rows[0]);
    assert.equal(await c.confirmDelete(), false);
    assert.equal(c.rows.length, 2);
    assert.equal(c.errorText(c.actionError), 'device is in use');
});

test('add to address book passes the id and the chosen book', async () => {
    const api = fakeApi();
    const c = component({ api });
    await c.refresh(true);
    c.book = 'shared';
    assert.equal(await c.addToBook(c.rows[0]), true);
    assert.deepEqual(deviceCalls(api)[1], ['addToAddressBook', '123456789', 'shared']);
    assert.match(c.notice, /address book/);
    assert.equal(await c.addToBook({ id: '' }), false);
});

test('an address-book failure is an action error, not a surface error', async () => {
    const c = component({ api: fakeApi({ devices: {
        addToAddressBook: async () => { throw Errors.create('BRIDGE_NO_ADDRESS_CAP', 'no address capability'); }
    } }) });
    await c.refresh(true);
    c.book = 'shared';   // a book must be chosen, or the client-side guard below fires first
    assert.equal(await c.addToBook(c.rows[0]), false);
    assert.equal(c.error, null, 'the inventory stays on screen');
    assert.equal(c.rows.length, 2);
    assert.equal(c.errorRemediation(c.actionError), Errors.remediation('BRIDGE_NO_ADDRESS_CAP'));
});

test('add to address book without a book chosen is a client-side action error, never a raw path-parameter string', async () => {
    // The button is disabled in this state; this is the defence for anything
    // that can still call the method directly -- caught before api-client.js's
    // internal guard string ("a path parameter must not be empty") could ever
    // reach the operator as if it were a real answer from the server.
    const api = fakeApi({ addressbook: { books: async () => { throw new Error('down'); } } });
    const c = component({ api });
    await c.refresh(true);
    await c.loadBooks();
    assert.equal(c.hasBook(), false);
    assert.equal(await c.addToBook(c.rows[0]), false);
    assert.equal(c.errorText(c.actionError), 'No address book is available yet to add this device to.');
    assert.ok(!api.calls.some((call) => call[0] === 'addToAddressBook'), 'the API was never called');
});

test('setSort toggles direction on the same column and resets on a new one', () => {
    const c = component();
    assert.equal(c.state.sortKey, 'name');
    c.setSort('name');
    assert.equal(c.state.sortDir, 'desc');
    c.setSort('online');
    assert.deepEqual([c.state.sortKey, c.state.sortDir], ['online', 'asc']);
    c.setSort('__proto__');
    assert.equal(c.state.sortKey, 'online', 'an unknown column is ignored');
});

// --- hasBook / errorRemediationLabel / emptyKind / pagination -----------

test('hasBook: false until a book from THIS server\'s list is chosen', () => {
    const c = component();
    assert.equal(c.hasBook(), false, 'nothing is selected before the books have loaded');
    c.books = [{ guid: '', name: 'Personal', personal: true }, { guid: 'shared', name: 'Shared' }];
    for (const bad of ['   ', '\x00', null, undefined, 'gone'])
        { c.book = bad; assert.equal(c.hasBook(), false, String(bad)); }
    c.book = 'shared';
    assert.equal(c.hasBook(), true);
    // '' is the personal book's real guid (js/core/addressbook.js's
    // PERSONAL.guid), not "nothing selected" -- treating it as empty made the
    // one book every server has permanently unusable.
    c.book = '';
    assert.equal(c.hasBook(), true, "the personal book's own id is the empty string");
    // A selection that does not exist on the server we just switched to must
    // not keep the button enabled.
    c.books = [{ guid: 'other', name: 'Other' }];
    assert.equal(c.hasBook(), false);
});

test('errorRemediationLabel: a specific sentence per remediation kind, empty for "none"', () => {
    const c = component();
    assert.match(c.errorRemediationLabel(Errors.create('API_AUTH_FAILED', 'x')), /sign in again/);
    assert.match(c.errorRemediationLabel(Errors.create('API_UNREACHABLE', 'x')), /try again/);
    assert.equal(c.errorRemediationLabel(Errors.create('GENERIC', 'x')), '', 'GENERIC has no one-click fix');
    assert.equal(c.errorRemediationLabel(null), '');
});

test('emptyKind: tells "no devices at all" apart from "the filter matched nothing"', async () => {
    const api = fakeApi();
    const c = component({ api });
    assert.equal(c.emptyKind(), 'no-devices', 'nothing loaded yet renders the same honest empty state, not a blank table');

    await c.refresh(true);
    assert.equal(c.emptyKind(), 'none', 'two rows, no filter -- nothing to say');

    c.setQuery('nothing-matches-anything');
    assert.equal(c.emptyKind(), 'no-match', 'a filter that matched nothing is not "no devices ever"');
    c.setQuery('');
    assert.equal(c.emptyKind(), 'none');

    const empty = component({ api: fakeApi({ devices: { list: async () => ({ code: 0, message: '', data: { list: [] } }) } }) });
    await empty.refresh(true);
    assert.equal(empty.emptyKind(), 'no-devices');

    const failed = component({ api: fakeApi({ devices: {
        list: async () => { throw Errors.create('API_UNREACHABLE', 'x'); }
    } }) });
    await failed.refresh(true);
    assert.equal(failed.emptyKind(), 'none', 'a load failure is reported as an error, not as "no devices"');
});

test('refresh: total can exceed the fetched page, so truncation is representable', async () => {
    const c = component({ api: fakeApi({ devices: {
        list: async () => payload(RAW, { total: 9 })
    } }) });
    await c.refresh(true);
    assert.equal(c.rows.length, 2);
    assert.equal(c.total, 9, 'more devices exist on the server than this page shows');
    assert.ok(c.total > c.rows.length);
});

// --- the template --------------------------------------------------------

test('the template renders text only and offers real buttons', () => {
    assert.ok(!/x-html/.test(D.TEMPLATE), 'x-html would make a device name executable markup');
    assert.ok(!/<iframe/i.test(D.TEMPLATE));
    assert.ok(!/<a [^>]*@click/.test(D.TEMPLATE), 'clickable anchors are not buttons');
    assert.ok(D.TEMPLATE.includes('type="button"'));
    assert.ok(D.TEMPLATE.includes('x-data="pilotDevices()"'));
    for (const hook of ['refresh', 'filter', 'row', 'rename', 'rename-input', 'rename-save',
        'delete', 'delete-confirm', 'add-book', 'error', 'empty'])
        assert.ok(D.TEMPLATE.includes('data-test="' + hook + '"'), hook);
});

test('the address book control is a real selector, and an empty one is the §7.3 empty state', () => {
    // This was task 20's "disable until task 21" placeholder, never lifted:
    // `book` was never assigned anywhere, so the button was permanently
    // disabled with the (by then false) title "No address book yet" and
    // addToBook() was unreachable.
    assert.ok(D.TEMPLATE.includes('data-test="book"'), 'a real book selector is rendered');
    assert.match(D.TEMPLATE, /data-test="book-picker"[\s\S]{0,120}books\.length > 0/,
        'the selector is rendered ONLY when there is something to choose from');
    assert.match(D.TEMPLATE, /data-test="add-book"[\s\S]{0,120}!hasBook\(\)/,
        'the button is still disabled while nothing is selected');
    for (const hook of ['book-empty', 'book-empty-message', 'book-empty-action'])
        assert.ok(D.TEMPLATE.includes('data-test="' + hook + '"'), hook);
    assert.ok(D.TEMPLATE.includes('bookEmptyState().ctaLabel'),
        'the empty state\'s copy and CTA come from PilotEmptyState, not from a second hardcoded string');
    assert.equal(D.TEMPLATE.indexOf('No address book yet'), -1,
        'the copy lives in js/core/emptystate.js now, not inline here');
});

test('an empty inventory and a filter with no matches each offer a real next action (spec 7.3)', () => {
    for (const hook of ['empty-action', 'empty-filtered', 'empty-filtered-action'])
        assert.ok(D.TEMPLATE.includes('data-test="' + hook + '"'), hook);
    assert.ok(D.TEMPLATE.includes('type="button" class="btn btn-sm btn-primary" data-test="empty-action"'),
        'the empty-state action is a real button, not decoration');
});

test('the error banner renders the real remediation, not a hardcoded "try again" for everything', () => {
    assert.ok(D.TEMPLATE.includes('data-test="error-remediation"'));
    assert.ok(D.TEMPLATE.includes('errorRemediationLabel(error)'));
});

test('pagination is shown, and truncation beyond the fetched page is stated', () => {
    assert.ok(D.TEMPLATE.includes('data-test="pagination"'));
    assert.ok(D.TEMPLATE.includes('data-test="pagination-truncated"'));
    assert.ok(D.TEMPLATE.includes('total > rows.length'));
});

test('Alpine auto-invokes init() on any x-data object -- no redundant x-init here', () => {
    // The identical double-fire bug was already found and fixed for
    // js/app.js's pilotApp() (see tests/e2e/servers.e2e.mjs); this asserts it
    // was never reintroduced here.
    assert.ok(!/x-init/.test(D.TEMPLATE));
});

test('no x-show shares an element with a Bootstrap display utility', () => {
    // Display utilities are !important and defeat the inline style x-show sets.
    for (const line of D.TEMPLATE.split('\n')) {
        if (!line.includes('x-show')) continue;
        assert.ok(!/\bd-(flex|block|inline|inline-flex|inline-block|grid|table)\b/.test(line), line);
    }
});

test('mount injects the template once and creates its host if the page has none', () => {
    const attrs = {};
    const host = { id: '', innerHTML: '',
        getAttribute: (k) => attrs[k] || null,
        setAttribute: (k, v) => { attrs[k] = v; } };
    const created = [];
    const doc = {
        getElementById: (id) => (id === 'pilot-devices' && created.length ? host : null),
        createElement: () => host,
        body: { appendChild: (el) => { created.push(el); } }
    };
    assert.equal(D.mount(doc), true);
    assert.equal(created.length, 1);
    assert.equal(host.id, 'pilot-devices');
    assert.ok(host.innerHTML.includes('x-data="pilotDevices()"'));

    host.innerHTML = 'untouched';
    assert.equal(D.mount(doc), false, 'a second mount must not clobber the live DOM');
    assert.equal(host.innerHTML, 'untouched');
});

test('mount does nothing without a usable document', () => {
    for (const bad of [null, undefined, {}, 'x', 7])
        assert.equal(D.mount(bad), false, String(bad));
});

test('emitServerChanged dispatches the documented detail, and is safe without a DOM', () => {
    assert.deepEqual(D.serverChangedDetail('  beta '), { id: 'beta' });
    assert.deepEqual(D.serverChangedDetail(null), { id: 'local' });
    const fired = [];
    const target = { dispatchEvent: (ev) => { fired.push(ev); return true; } };
    const had = typeof globalThis.CustomEvent === 'function';
    if (!had) globalThis.CustomEvent = function (n, o) { this.type = n; this.detail = o && o.detail; };
    try {
        assert.equal(D.emitServerChanged('beta', target), true);
        assert.equal(fired.length, 1);
        assert.equal(fired[0].type, 'pilot:server-changed');
        assert.deepEqual(fired[0].detail, { id: 'beta' });
        assert.equal(D.emitServerChanged('beta', {}), false);
        assert.equal(D.emitServerChanged('beta', null), false);
    } finally { if (!had) delete globalThis.CustomEvent; }
});


// =================================================== FINAL REVIEW, FINDING 3
//
// `book` was initialised to '' and never assigned anywhere: hasBook() was
// permanently false, the button permanently disabled with the (since task 23,
// factually wrong) title "No address book yet", and the 25-line addToBook()
// unreachable. These drive the load/select/add path that now exists.

test('loadBooks fetches this server\'s books through the façade and selects one', async () => {
    const api = fakeApi();
    const c = component({ api });
    await c.loadBooks();
    assert.deepEqual(api.calls.filter((x) => x[0] === 'books').length, 1);
    assert.deepEqual(c.books.map((b) => b.guid), ['', 'shared-1']);
    assert.equal(c.book, '', 'the personal book is selected by default, so the action is usable at once');
    assert.equal(c.hasBook(), true);
    assert.equal(c.bookEmpty(), false);
});

test('addToBook really calls the API with the SELECTED book, including the personal one', async () => {
    const api = fakeApi();
    const c = component({ api });
    await c.loadBooks();
    assert.equal(await c.addToBook({ id: 'dev-1' }), true);
    assert.deepEqual(api.calls.filter((x) => x[0] === 'addToAddressBook').pop(),
        ['addToAddressBook', 'dev-1', ''], 'the personal book id is the empty string, and it is legal');
    c.selectBook('shared-1');
    assert.equal(await c.addToBook({ id: 'dev-2' }), true);
    assert.deepEqual(api.calls.filter((x) => x[0] === 'addToAddressBook').pop(),
        ['addToAddressBook', 'dev-2', 'shared-1']);
    assert.match(c.notice, /added to the address book/);
});

test('no books at all is the §7.3 empty state, never an empty <select>', async () => {
    const c = component({ api: fakeApi({ addressbook: { books: async () => { throw new Error('down'); } } }) });
    await c.loadBooks();
    assert.deepEqual(c.books, []);
    assert.equal(c.book, null);
    assert.equal(c.hasBook(), false);
    assert.equal(c.bookEmpty(), true);
    const e = c.bookEmptyState();
    assert.equal(e.message, require('../../js/core/emptystate.js').forKind('addressbook').message);
    assert.equal(e.tab, 'addressbook', 'the CTA goes where an address book is actually created');
    // And the action still refuses honestly rather than calling the API with nothing.
    assert.equal(await c.addToBook({ id: 'dev-1' }), false);
    assert.match(c.actionError.message, /No address book/);
});

test('an API façade with no addressbook half degrades to the empty state, never throws', async () => {
    const api = fakeApi();
    delete api.addressbook;
    const c = component({ api });
    await c.loadBooks();
    assert.equal(c.bookEmpty(), true);
});

test('switching server re-loads the books and drops the previous selection', async () => {
    const api = fakeApi();
    const c = component({ api });
    await c.loadBooks();
    c.selectBook('shared-1');
    await c.useServer('beta');
    assert.equal(c.serverId, 'beta');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(api.calls.filter((x) => x[0] === 'books').length, 2,
        'address books are per server, so they must be re-fetched');
});

test('Refresh keeps the book the operator chose, and only re-defaults when it is gone', async () => {
    const api = fakeApi();
    const c = component({ api });
    await c.loadBooks();
    c.selectBook('shared-1');
    // Refresh is exactly what an operator clicks after creating a book on the
    // Address Book tab. It re-runs loadBooks(), which used to reset the
    // selection to the personal book unconditionally -- so the next
    // "Add to address book" silently went somewhere the operator never chose.
    await c.loadBooks();
    assert.equal(c.book, 'shared-1', 'an explicit selection survives a reload that still offers it');
    assert.deepEqual((await c.addToBook({ id: 'dev-9' }), api.calls.filter((x) => x[0] === 'addToAddressBook').pop()),
        ['addToAddressBook', 'dev-9', 'shared-1']);
});

test('Refresh re-defaults when the chosen book no longer exists on the server', async () => {
    const api = fakeApi();
    const c = component({ api });
    await c.loadBooks();
    c.selectBook('shared-1');
    // The book was deleted elsewhere: keeping a dangling guid would send every
    // later add to a book that is not there.
    c.api = fakeApi({ addressbook: { books: async () => ({ data: { profiles: [
        { guid: '', name: 'Personal', personal: true }
    ] } }) } });
    await c.loadBooks();
    assert.deepEqual(c.books.map((b) => b.guid), ['']);
    assert.equal(c.book, '', 'a selection the server no longer offers falls back to the first book');
});

test('a null selection (fresh load) still takes the default -- "" is a real guid, not "unset"', async () => {
    const api = fakeApi();
    const c = component({ api });
    assert.equal(c.book, null, 'null means nothing chosen yet; "" means the personal book');
    await c.loadBooks();
    assert.equal(c.book, '');
});

// ------------------- online/offline: the server sends no such field at all

test('online is derived from last_online_time, because v2.7 sends no online field', () => {
    // FROM THE FIELD: the Overview read "Devices 4, Online 0, Offline 4" while
    // the user had machines connected and visible in the RustDesk client. The
    // mapper looked for online/is_online/isOnline/status -- a real v2.7 peer row
    // carries NONE of them:
    //   row_id, id, cpu, hostname, memory, os, username, uuid, version,
    //   user_id, last_online_time, last_online_ip, group_id, alias,
    //   created_at, updated_at
    // so every device came back false. That is not declining to guess; it is
    // stating the fact wrongly, with confidence, on every row.
    const now = 1786007000000;
    const at = (secondsAgo) => ({ id: 'p' + secondsAgo, hostname: 'h' + secondsAgo,
        last_online_time: (now / 1000) - secondsAgo });
    const rows = D.deviceRows({ code: 0, data: { list: [at(5), at(30), at(115), at(348)],
        page: 1, total: 4, page_size: 50 } }, now);
    assert.deepEqual(rows.map((r) => r.online), [true, true, true, false],
        'measured on a real server: heartbeats land every 30-36s, and the offline ' +
        'machine sat at 348s');
    rows.forEach((r) => assert.equal(r.onlineFrom, 'heartbeat'));
});

test('an explicit online field from the server always beats the heartbeat', () => {
    // A future server that answers the question directly must be believed --
    // including when it says a recently-heard-from device is offline.
    const now = 1786007000000;
    const fresh = (now / 1000) - 5;
    const rows = D.deviceRows({ code: 0, data: { list: [
        { id: 'a', online: false, last_online_time: fresh },
        { id: 'b', online: true, last_online_time: (now / 1000) - 9999 },
        { id: 'c', is_online: 1, last_online_time: (now / 1000) - 9999 }
    ], page: 1, total: 3, page_size: 50 } }, now);
    assert.deepEqual(rows.map((r) => r.online), [false, true, true]);
    rows.forEach((r) => assert.equal(r.onlineFrom, 'server'));
});

test('with no timestamp at all a device is offline, not optimistically online', () => {
    const now = 1786007000000;
    const rows = D.deviceRows({ code: 0, data: { list: [
        { id: 'a' }, { id: 'b', last_online_time: 0 }, { id: 'c', last_online_time: 'nonsense' }
    ], page: 1, total: 3, page_size: 50 } }, now);
    assert.deepEqual(rows.map((r) => r.online), [false, false, false]);
});

test('lastSeen comes from last_online_time, not from updated_at', () => {
    // last_online_time was missing from the pick list, so lastSeen fell through
    // to updated_at -- when the DB row changed, not when the device was heard
    // from. The two differ by minutes on a real server.
    const now = 1786007000000;
    const rows = D.deviceRows({ code: 0, data: { list: [{
        id: 'a', last_online_time: (now / 1000) - 60, updated_at: '2020-01-01 00:00:00'
    }], page: 1, total: 1, page_size: 50 } }, now);
    assert.equal(rows[0].lastSeenMs, now - 60000, 'the heartbeat, not the row mtime');
    assert.equal(rows[0].online, true);
});

test('the window is a stated constant, not a magic number buried in a comparison', () => {
    assert.equal(typeof D.ONLINE_WINDOW_MS, 'number');
    assert.ok(D.ONLINE_WINDOW_MS >= 90000 && D.ONLINE_WINDOW_MS <= 300000,
        'must absorb several missed 30-36s heartbeats without calling a dead peer online');
});

test('the Address column reads last_online_ip, which is the field v2.7 sends', () => {
    // Every row showed a dash under Address even though the server had the
    // address: the pick list named ip/last_ip/lastIp/remote_ip and the real row
    // carries last_online_ip. Same shape as the online-field bug beside it --
    // reading four names the server never sends and reporting "nothing".
    const now = 1786007000000;
    const rows = D.deviceRows({ code: 0, data: { list: [
        { id: 'a', last_online_ip: '10.0.0.7' },
        { id: 'b', ip: '10.0.0.8' },
        { id: 'c' }
    ], page: 1, total: 3, page_size: 50 } }, now);
    assert.equal(rows[0].ip, '10.0.0.7');
    assert.equal(rows[1].ip, '10.0.0.8', 'the older names still work');
    assert.equal(rows[2].ip, DASH, 'and a device with no address is a dash, not "undefined"');
});
