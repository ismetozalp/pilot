// tests/unit/audit-ui.test.js — the Audit surface: connection, file-transfer and
// login logs filtered by user, device and date. No DOM, no cockpit, no bridge.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../../js/core/errors.js');
require('../../js/core/console-view.js');
const A = require('../../js/features/audit-ui.js');

const ROOT = path.resolve(__dirname, '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'js/features/audit-ui.js'), 'utf8');

async function withApi(fake, fn) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'PilotApi');
    const prev = globalThis.PilotApi;
    globalThis.PilotApi = fake;
    try { return await fn(); }
    finally { if (had) globalThis.PilotApi = prev; else delete globalThis.PilotApi; }
}

function envelope(list, total) {
    return { code: 0, message: '', data: { list, total: total === undefined ? list.length : total, page: 1, page_size: 50 } };
}

const CONN = [
    { id: 'c1', created_at: 1754246400, user: 'ada', from_peer: '111111111', to_peer: '222222222', type: 'remote', ip: '10.0.0.5' },
    { id: 'c2', created_at: '2026-08-03T11:00:00Z', username: 'bob', peer_id: '333333333', conn_type: 'file' }
];
const LOGIN = [{ id: 'l1', created_at: 1754250000, user: 'ada', device_id: 'dev-1', type: 'login', ip: '10.0.0.5' }];

function apiFake(over) {
    const calls = [];
    const o = over || {};
    const wrap = (name, fallback) => (...args) => {
        calls.push({ name, args });
        const impl = o[name];
        if (typeof impl === 'function') return Promise.resolve().then(() => impl(...args));
        if (impl && (impl instanceof Error || impl.kind)) return Promise.reject(impl);
        return Promise.resolve(impl === undefined ? fallback : impl);
    };
    return { calls, audit: { conn: wrap('conn', envelope(CONN)), file: wrap('file', envelope([])), login: wrap('login', envelope(LOGIN)) } };
}

test('module loads with no DOM and no cockpit global', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof globalThis.pilotAuditUi, 'function');
    assert.deepEqual(A.KINDS, ['conn', 'file', 'login']);
    assert.deepEqual(A.TABS.map((t) => t.id), ['conn', 'file', 'login']);
});

test('the surface never touches cockpit and never builds a URL', () => {
    assert.ok(!/\bcockpit\b/.test(SOURCE), 'must not reference cockpit');
    assert.ok(!/https?:\/\//.test(SOURCE), 'must not contain a URL');
    assert.ok(!/PilotApiIo|api-io/.test(SOURCE), 'must go through PilotApi only');
});

test('the surface refuses to run if console-view is not loaded first', () => {
    const prev = globalThis.PilotConsoleView;
    delete globalThis.PilotConsoleView;
    try { assert.throws(() => A.normalizeRow('conn', { id: 'c1' }), /console-view\.js must load before/); }
    finally { globalThis.PilotConsoleView = prev; }
});

test('index.html loads audit-ui after console-view and provides the host element', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(html.includes('<script src="js/features/audit-ui.js"></script>'));
    assert.ok(html.includes('id="pilot-audit"'), 'index.html needs the #pilot-audit host element');
    assert.ok(html.indexOf('js/core/console-view.js') < html.indexOf('js/features/audit-ui.js'));
});

test('parseWhen accepts unix seconds, unix milliseconds and ISO-8601', () => {
    assert.equal(A.parseWhen(1754246400), 1754246400000);
    assert.equal(A.parseWhen('1754246400'), 1754246400000);
    assert.equal(A.parseWhen(1754246400000), 1754246400000);
    assert.equal(A.parseWhen('2026-08-03T18:40:00Z'), Date.UTC(2026, 7, 3, 18, 40, 0));
    assert.equal(A.parseWhen('2026-08-03T18:40:00.000Z'), Date.UTC(2026, 7, 3, 18, 40, 0));
});

test('parseWhen rejects every shape that is not a usable time', () => {
    const bad = ['', '   ', 'not a date', '0', 0, -1, -1754246400, NaN, Infinity, -Infinity,
        null, undefined, true, false, {}, [], [1754246400],
        '1754246400\n', '\t1754246400', '1754246400\x00', '17542464\x1f00',
        '99999999999999999', 1e20, 1, 1000,
        '١٧٥٤٢٤٦٤٠٠', '2026-13-45T99:99:99Z', '../1754246400'];
    for (const v of bad)
        assert.equal(A.parseWhen(v), null, 'accepted ' + JSON.stringify(v));
});

test('parseWhen rejects times outside the plausible window', () => {
    assert.equal(A.parseWhen('1999-12-31T23:59:59Z'), null);
    assert.equal(A.parseWhen('2100-01-01T00:00:00Z'), null);
    assert.equal(A.parseWhen('2000-01-01T00:00:00Z'), Date.UTC(2000, 0, 1));
});

test('formatWhen renders UTC, and says nothing rather than lying', () => {
    assert.equal(A.formatWhen(Date.UTC(2026, 7, 3, 18, 40, 5)), '2026-08-03 18:40:05Z');
    assert.equal(A.formatWhen(Date.UTC(2026, 0, 1, 0, 0, 0)), '2026-01-01 00:00:00Z');
    for (const v of [null, undefined, NaN, Infinity, 'nope', {}, []])
        assert.equal(A.formatWhen(v), A.DASH, JSON.stringify(v));
});

test('parseDay accepts only a real YYYY-MM-DD day', () => {
    assert.equal(A.parseDay('2026-08-03', false), Date.UTC(2026, 7, 3, 0, 0, 0));
    assert.equal(A.parseDay('2026-08-03', true), Date.UTC(2026, 7, 3, 23, 59, 59));
    assert.equal(A.parseDay('2024-02-29', false), Date.UTC(2024, 1, 29));
    const bad = ['', '   ', '2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026-08-00',
        '2026-08-32', '26-08-03', '2026-8-3', '2026/08/03', '2026-08-03T00:00:00Z',
        '2026-08-03\n', '\x002026-08-03', '2026-08-0\x1f', '٢٠٢٦-٠٨-٠٣', '../2026-08-03',
        '1999-12-31', '2100-01-01', null, undefined, 20260803, {}, []];
    for (const v of bad) assert.equal(A.parseDay(v, false), null, 'accepted ' + JSON.stringify(v));
});

test('rangeProblem names the field that is wrong', () => {
    assert.equal(A.rangeProblem('', ''), '');
    assert.equal(A.rangeProblem(null, undefined), '');
    assert.equal(A.rangeProblem('2026-08-01', '2026-08-03'), '');
    assert.equal(A.rangeProblem('2026-08-03', '2026-08-03'), '');
    assert.match(A.rangeProblem('2026-13-01', ''), /From date/);
    assert.match(A.rangeProblem('', '2026-02-30'), /To date/);
    assert.match(A.rangeProblem('2026-08-03\n', ''), /From date/);
    assert.match(A.rangeProblem('2026-08-04', '2026-08-03'), /after/);
});

test('auditQuery clamps paging, sanitises filters and converts days to seconds', () => {
    assert.deepEqual(A.auditQuery('conn', {}), { page: 1, page_size: 50 });
    assert.deepEqual(A.auditQuery('login', null), { page: 1, page_size: 50 });
    assert.deepEqual(A.auditQuery('file', { page: 3, pageSize: 25 }), { page: 3, page_size: 25 });
    assert.equal(A.auditQuery('conn', { page: 0 }).page, 1);
    assert.equal(A.auditQuery('conn', { pageSize: 9999 }).page_size, 200);
    assert.equal(A.auditQuery('conn', { user: ' ada ' }).user, 'ada');
    assert.equal(A.auditQuery('conn', { user: 'a\nb' }).user, 'a b');
    assert.equal(A.auditQuery('conn', { user: 'u'.repeat(500) }).user.length, 64);
    assert.equal(A.auditQuery('conn', { user: '  ' }).user, undefined);
    assert.equal(A.auditQuery('conn', { device: { evil: true } }).device, undefined);
    const q = A.auditQuery('conn', { from: '2026-08-01', to: '2026-08-03' });
    assert.equal(q.from, Date.UTC(2026, 7, 1) / 1000);
    assert.equal(q.to, Date.UTC(2026, 7, 3, 23, 59, 59) / 1000);
    assert.equal(A.auditQuery('conn', { from: '2026-02-30' }).from, undefined);
});

test('auditQuery and normalizeRow refuse an unknown log', () => {
    for (const k of ['', 'connections', 'CONN', null, undefined, 42, {}]) {
        assert.throws(() => A.auditQuery(k, {}), /Unknown audit log/, 'accepted ' + JSON.stringify(k));
        assert.throws(() => A.normalizeRow(k, {}), /Unknown audit log/, 'accepted ' + JSON.stringify(k));
    }
});

test('normalizeRow reads a connection record', () => {
    const r = A.normalizeRow('conn', CONN[0]);
    assert.equal(r.id, 'c1');
    assert.equal(r.kind, 'conn');
    assert.equal(r.whenMs, 1754246400000);
    assert.equal(r.when, A.formatWhen(1754246400000));
    assert.equal(r.user, 'ada');
    assert.equal(r.device, '111111111');
    assert.equal(r.peer, '222222222');
    assert.equal(r.action, 'remote');
    assert.equal(r.ip, '10.0.0.5');
});

test('normalizeRow tolerates the alternative key spellings of each log', () => {
    assert.equal(A.normalizeRow('conn', CONN[1]).user, 'bob');
    assert.equal(A.normalizeRow('conn', CONN[1]).action, 'file');
    assert.equal(A.normalizeRow('file', { id: 'f1', time: 1754246400, operation: 'send', filename: '/tmp/x' }).action, 'send');
    assert.equal(A.normalizeRow('file', { id: 'f1', time: 1754246400, operation: 'send', filename: '/tmp/x' }).note, '/tmp/x');
    assert.equal(A.normalizeRow('login', LOGIN[0]).device, 'dev-1');
    assert.equal(A.normalizeRow('login', { id: 'l2', timestamp: 1754246400, status: 'failed' }).action, 'failed');
});

test('normalizeRow renders an em dash rather than a blank for a missing field', () => {
    const r = A.normalizeRow('conn', { id: 'c9' });
    for (const k of ['when', 'user', 'device', 'peer', 'action', 'ip']) assert.equal(r[k], A.DASH, k);
    assert.equal(r.whenMs, null);
    assert.equal(r.note, '');
});

test('normalizeRow scrubs hostile values and never throws on a hostile row', () => {
    const r = A.normalizeRow('conn', { id: 'c\n1', user: 'a\x00b', to_peer: 'p'.repeat(4000), note: '../../etc/shadow' });
    assert.equal(r.id, 'c 1');
    assert.equal(r.user, 'a b');
    assert.equal(r.peer.length, 512);
    assert.equal(r.note, '../../etc/shadow');
    assert.ok(!/[\x00-\x1f\x7f]/.test(JSON.stringify(r)));
    for (const bad of [null, undefined, 'nope', 42, [], true]) {
        const x = A.normalizeRow('conn', bad);
        assert.equal(typeof x.id, 'string');
        assert.equal(x.whenMs, null);
    }
});

test('rowsFrom keeps the reported total and gives every row a unique key', () => {
    const parsed = A.rowsFrom('conn', envelope(CONN, 412));
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.total, 412);
    const dup = A.rowsFrom('conn', envelope([{ user: 'ada' }, { user: 'ada' }, { user: 'ada' }]));
    assert.equal(new Set(dup.rows.map((r) => r.id)).size, 3, 'row keys must be unique');
});

test('rowsFrom survives a truncated or hostile payload', () => {
    for (const bad of [null, {}, { code: 0, data: null }, { list: null }, 'nope', [null, 'x', 7]]) {
        const parsed = A.rowsFrom('conn', bad);
        assert.ok(Array.isArray(parsed.rows));
        assert.equal(typeof parsed.total, 'number');
    }
    assert.equal(A.rowsFrom('conn', [null, 'x', 7]).rows.length, 3);
});

test('refresh reads the selected log through the façade only', async () => {
    const api = apiFake();
    await withApi(api, async () => {
        const c = globalThis.pilotAuditUi();
        assert.equal(await c.refresh(), true);
        assert.equal(c.tab, 'conn');
        assert.equal(c.rows.length, 2);
        assert.equal(c.total, 2);
        assert.equal(c.alert, null);
        assert.equal(c.loading, false);
        assert.deepEqual(api.calls.map((k) => k.name), ['conn']);
        assert.deepEqual(api.calls[0].args[0], { page: 1, page_size: 50 });
    });
});

test('select switches log and re-queries that log only', async () => {
    const api = apiFake();
    await withApi(api, async () => {
        const c = globalThis.pilotAuditUi();
        await c.refresh();
        assert.equal(await c.select('login'), true);
        assert.equal(c.tab, 'login');
        assert.equal(c.rows.length, 1);
        assert.equal(c.rows[0].action, 'login');
        assert.deepEqual(api.calls.map((k) => k.name), ['conn', 'login']);
    });
});

test('select refuses an unknown log without calling anything', async () => {
    const api = apiFake();
    await withApi(api, async () => {
        const c = globalThis.pilotAuditUi();
        assert.equal(await c.select('nope'), false);
        assert.equal(c.tab, 'conn');
        assert.equal(api.calls.length, 0);
        assert.equal(c.alert.kind, 'GENERIC');
    });
});

test('an invalid date range is refused before any request is made', async () => {
    const api = apiFake();
    await withApi(api, async () => {
        const c = globalThis.pilotAuditUi();
        c.filters.from = '2026-02-30';
        assert.equal(await c.refresh(), false);
        assert.equal(api.calls.length, 0);
        assert.match(c.problem, /From date/);
        c.filters.from = '2026-08-01';
        c.filters.to = '2026-08-03';
        assert.equal(await c.refresh(), true);
        assert.equal(c.problem, '');
        assert.equal(api.calls[0].args[0].from, Date.UTC(2026, 7, 1) / 1000);
    });
});

test('an empty log renders as empty, not as an error', async () => {
    const api = apiFake();
    await withApi(api, async () => {
        const c = globalThis.pilotAuditUi();
        assert.equal(await c.select('file'), true);
        assert.deepEqual(c.rows, []);
        assert.equal(c.alert, null);
    });
});

test('a failing log names the reason and clears the table', async () => {
    const api = apiFake({ conn: { kind: 'API_AUTH_FAILED', message: 'token rejected' } });
    await withApi(api, async () => {
        const c = globalThis.pilotAuditUi();
        assert.equal(await c.refresh(), false);
        assert.deepEqual(c.rows, []);
        assert.equal(c.total, 0);
        assert.equal(c.alert.kind, 'API_AUTH_FAILED');
        assert.equal(c.alert.context, 'Audit');
        assert.equal(c.loading, false);
    });
});

test('with no PilotApi at all the surface says so instead of throwing', async () => {
    await withApi(undefined, async () => {
        const c = globalThis.pilotAuditUi();
        assert.equal(await c.refresh(), false);
        assert.equal(c.alert.kind, 'API_UNREACHABLE');
        assert.deepEqual(c.rows, []);
    });
});

test('a stale in-flight load never overwrites a newer result', async () => {
    let release = null;
    const slow = new Promise((res) => { release = res; });
    const api = apiFake({ conn: () => slow.then(() => envelope(CONN)) });
    await withApi(api, async () => {
        const c = globalThis.pilotAuditUi();
        const first = c.refresh();
        const second = c.select('login');
        await second;
        assert.equal(c.tab, 'login');
        assert.equal(c.rows.length, 1);
        release();
        assert.equal(await first, false);
        assert.equal(c.rows.length, 1, 'the stale connection load must not win');
        assert.equal(c.tab, 'login');
        assert.equal(c.loading, false);
    });
});

test('the template exposes the controls the e2e scenario drives', () => {
    for (const id of ['audit-root', 'audit-refresh', 'audit-row', 'audit-alert', 'audit-empty',
        'audit-total', 'audit-problem', 'audit-user', 'audit-device', 'audit-from', 'audit-to', 'audit-when'])
        assert.ok(A.TEMPLATE.includes('"' + id + '"'), 'template has no ' + id);
    assert.ok(A.TEMPLATE.includes("'audit-tab-' + t.id"), 'template has no per-tab test id');
    assert.ok(A.TEMPLATE.includes('x-data="pilotAuditUi()"'));
});

// ---------------------------------------------------------------------------
// Task 25 additions beyond the base brief: the two distinct empty states (spec
// §7.3 -- "nothing logged yet" vs. "this filter matched nothing" are NOT the
// same message or the same recovery), and pilot:server-changed wiring, mirrored
// from tests/unit/users-ui.test.js because the wiring is identical: switching
// the active server must refresh Audit with no manual click, both at cold
// boot (app.js's wireApi() fires refresh() before the transport exists) and
// on a later switchServer().
// ---------------------------------------------------------------------------

test('the template distinguishes an unconfigured system from a filtered-to-nothing result', () => {
    assert.ok(A.TEMPLATE.includes('"audit-empty-action"'), 'the unconfigured empty state needs a next action');
    assert.ok(A.TEMPLATE.includes('"audit-empty-filtered"'), 'template has no audit-empty-filtered');
    assert.ok(A.TEMPLATE.includes('"audit-empty-filtered-action"'), 'the filtered empty state needs a clear-filter action');
    assert.ok(A.TEMPLATE.includes('clearFilters()'), 'the clear-filter action must call clearFilters()');
});

test('clearFilters resets every filter field and reloads', async () => {
    const api = apiFake();
    await withApi(api, async () => {
        const c = globalThis.pilotAuditUi();
        c.filters.user = 'ada';
        c.filters.device = '111';
        c.filters.from = '2026-08-01';
        c.filters.to = '2026-08-03';
        api.calls.length = 0;
        assert.equal(await c.clearFilters(), true);
        assert.deepEqual(c.filters, { user: '', device: '', from: '', to: '' });
        assert.deepEqual(api.calls[0].args[0], { page: 1, page_size: 50 });
    });
});

function fakeTarget() {
    const listeners = {};
    return {
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        dispatchEvent(ev) { (listeners[type(ev)] || []).slice().forEach((fn) => fn(ev)); },
        _listeners: listeners
    };
    function type(ev) { return ev && ev.type; }
}

test('init wires a pilot:server-changed listener that re-triggers refresh()', async () => {
    const api = apiFake();
    await withApi(api, async () => {
        const c = globalThis.pilotAuditUi();
        const target = fakeTarget();
        await c.init(target);
        assert.ok(Array.isArray(target._listeners['pilot:server-changed']),
            'init must register a pilot:server-changed listener on the given target');
        api.calls.length = 0;
        target.dispatchEvent({ type: 'pilot:server-changed', detail: { id: 'staging' } });
        // onServerChanged calls refresh() but does not await it; give the
        // microtask queue a turn so the async audit call lands.
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        assert.deepEqual(api.calls.map((k) => k.name), ['conn'],
            'the event must cause a fresh refresh(), not be silently ignored');
    });
});

test('onServerChanged refuses a malformed event without throwing', async () => {
    const api = apiFake();
    await withApi(api, async () => {
        const c = globalThis.pilotAuditUi();
        for (const bad of [null, undefined, 'nope', 42]) assert.equal(c.onServerChanged(bad), false);
    });
});

test('init tolerates a target with no addEventListener (no DOM) and still refreshes once', async () => {
    const api = apiFake();
    await withApi(api, async () => {
        const c = globalThis.pilotAuditUi();
        assert.equal(await c.init({}), true);
        assert.equal(c.rows.length, 2);
    });
});

// This is the mutation the task brief calls out by name: js/app.js's wireApi()
// dispatches 'pilot:server-changed' BEFORE the compatibility probe resolves,
// and Task 24 proved removing the listener leaves the surface with zero rows
// and a permanent API_UNREACHABLE at cold boot (refresh() would need to be
// re-triggered by something, and nothing else calls it once mounted). The
// test above ('init wires a pilot:server-changed listener...') is the one
// that must go RED if js/features/audit-ui.js's init() stops registering the
// listener -- see the mutation transcript pasted into the task report.
