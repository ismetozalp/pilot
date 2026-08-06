// tests/unit/users-ui.test.js — the Users & groups surface. No DOM, no cockpit,
// no bridge: the façade is a fake installed on the global PilotApi singleton.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../../js/core/errors.js');
const V = require('../../js/core/console-view.js');
const U = require('../../js/features/users-ui.js');

const ROOT = path.resolve(__dirname, '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'js/features/users-ui.js'), 'utf8');

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

const GROUPS = [{ id: 'g1', name: 'Support', device_count: 4 }, { id: 'g2', name: 'Field' }];
const USERS = [
    { id: 'u1', name: 'ada', email: 'ada@example.com', group_id: 'g1', status: 1, is_admin: true },
    { id: 'u2', name: 'bob', email: 'bob@example.com', group_id: 'g2', status: 0 },
    { id: 'u3', name: 'cem', email: '', status: 1 }
];

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
    return {
        calls,
        users: {
            list: wrap('list', envelope(USERS)), groups: wrap('groups', envelope(GROUPS)),
            create: wrap('create', { code: 0 }), update: wrap('update', { code: 0 }),
            setEnabled: wrap('setEnabled', { code: 0 }), resetPassword: wrap('resetPassword', { code: 0 }),
            setGroup: wrap('setGroup', { code: 0 })
        }
    };
}

function good(over) {
    return Object.assign({ name: 'ada', email: 'ada@example.com',
        password: 'correct horse', confirm: 'correct horse' }, over || {});
}

test('module loads with no DOM and no cockpit global', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof globalThis.pilotUsersUi, 'function');
    assert.equal(typeof U.mount, 'function');
    assert.equal(typeof U.TEMPLATE, 'string');
});

test('the surface never touches cockpit and never builds a URL', () => {
    assert.ok(!/\bcockpit\b/.test(SOURCE), 'must not reference cockpit');
    assert.ok(!/https?:\/\//.test(SOURCE), 'must not contain a URL');
    assert.ok(!/PilotApiIo|api-io/.test(SOURCE), 'must go through PilotApi only');
});

test('the surface refuses to run if console-view is not loaded first', () => {
    const prev = globalThis.PilotConsoleView;
    delete globalThis.PilotConsoleView;
    try { assert.throws(() => U.normalizeUser({ id: 'u1' }, []), /console-view\.js must load before/); }
    finally { globalThis.PilotConsoleView = prev; }
});

test('index.html loads both new modules, in order, and provides the host element', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(html.includes('<script src="js/core/console-view.js"></script>'));
    assert.ok(html.includes('<script src="js/features/users-ui.js"></script>'));
    assert.ok(html.includes('id="pilot-users"'), 'index.html needs the #pilot-users host element');
    assert.ok(html.indexOf('js/core/console-view.js') < html.indexOf('js/features/users-ui.js'));
});

test('passwordProblem rejects every unusable password', () => {
    assert.equal(U.passwordProblem(''), 'Password is required.');
    for (const v of [null, undefined, 12345678]) assert.match(U.passwordProblem(v), /required/);
    for (const v of ['abcdefg\nhij', 'abcdefgh\x00']) assert.match(U.passwordProblem(v), /control characters/);
    assert.match(U.passwordProblem('        '), /only whitespace/);
    assert.match(U.passwordProblem('short'), /at least 8/);
    assert.match(U.passwordProblem('x'.repeat(129)), /at most 128/);
});

test('passwordProblem accepts a strong password, unicode included', () => {
    for (const v of ['correct horse', 'ışıklıgün', 'x'.repeat(8), 'x'.repeat(128)])
        assert.equal(U.passwordProblem(v), '', JSON.stringify(v));
});

test('validateNewUser accepts a complete form and an absent optional email', () => {
    const v = U.validateNewUser(good());
    assert.equal(v.ok, true);
    assert.deepEqual(v.problems, {});
    assert.equal(U.validateNewUser(good({ email: '' })).ok, true);
});

test('validateNewUser rejects hostile usernames', () => {
    const cases = [['', /required/], ['   ', /start or end with a space/], [' ada', /start or end with a space/],
        ['ada ', /start or end with a space/], ['ad\na', /control characters/], ['ad\x00a', /control characters/],
        ['ad\x7fa', /control characters/], ['..', /"\.\."/], ['a\x1f..b', /control characters/],
        ['a/b', /letters, digits/], ['a\\b', /letters, digits/], ['ışıl', /letters, digits/],
        ['<script>', /letters, digits/], ['a'.repeat(65), /letters, digits/]];
    for (const [name, re] of cases) {
        const v = U.validateNewUser(good({ name }));
        assert.equal(v.ok, false, 'accepted ' + JSON.stringify(name));
        assert.match(v.problems.name, re, 'wrong reason for ' + JSON.stringify(name));
    }
    assert.match(U.validateNewUser(good({ name: '../../etc/shadow' })).problems.name, /letters, digits|"\.\."/);
    assert.equal(U.validateNewUser(good({ name: 'a'.repeat(64) })).ok, true);
});

test('validateNewUser rejects hostile emails', () => {
    for (const email of ['ada@', '@example.com', 'ada example.com', 'ada@example', 'ada@ex ample.com'])
        assert.match(U.validateNewUser(good({ email })).problems.email, /not valid/, 'accepted ' + email);
    assert.match(U.validateNewUser(good({ email: 'ada\n@example.com' })).problems.email, /control characters/);
    assert.match(U.validateNewUser(good({ email: 'a'.repeat(250) + '@example.com' })).problems.email, /too long/);
});

test('validateNewUser requires a matching confirmation', () => {
    assert.match(U.validateNewUser(good({ confirm: 'other password' })).problems.confirm, /do not match/);
    assert.match(U.validateNewUser({ name: 'ada', password: 'correct horse' }).problems.confirm, /confirm/);
});

test('validateNewUser never throws on a non-object form', () => {
    for (const bad of [null, undefined, 'nope', 42, [], true]) {
        const v = U.validateNewUser(bad);
        assert.equal(v.ok, false);
        assert.equal(typeof v.problems.name, 'string');
    }
});

test('blankForm is a fresh object every time', () => {
    const a = U.blankForm();
    a.name = 'mutated';
    assert.equal(U.blankForm().name, '');
});

test('normalizeGroups accepts every payload flavour', () => {
    assert.equal(U.normalizeGroups(envelope(GROUPS)).length, 2);
    assert.equal(U.normalizeGroups(GROUPS).length, 2);
    assert.equal(U.normalizeGroups({ list: GROUPS, total: 2 }).length, 2);
    for (const bad of [null, 'nope', { code: 0, data: { list: null } }])
        assert.deepEqual(U.normalizeGroups(bad), []);
});

test('normalizeGroup tolerates alternative key spellings and hostile values', () => {
    assert.equal(U.normalizeGroup({ group_id: 'g9', group_name: 'Ops' }).id, 'g9');
    assert.equal(U.normalizeGroup({ group_id: 'g9', group_name: 'Ops' }).name, 'Ops');
    assert.equal(U.normalizeGroup({ id: 'g1' }).name, '(unnamed)');
    assert.equal(U.normalizeGroup({ id: 'g1', name: 'Ops\ntwo' }).name, 'Ops two');
    assert.equal(U.normalizeGroup({ id: 'g1', device_count: '4' }).deviceCount, 4);
    assert.equal(U.normalizeGroup({ id: 'g1', device_count: -1 }).deviceCount, null);
    assert.equal(U.normalizeGroup({ id: 'g1' }).deviceCount, null);
    assert.equal(U.normalizeGroup(null).id, '');
});

test('groupLabel resolves a name, or says so honestly', () => {
    const gs = U.normalizeGroups(GROUPS);
    assert.equal(U.groupLabel(gs, 'g1'), 'Support');
    assert.equal(U.groupLabel(gs, ''), 'Unassigned');
    assert.equal(U.groupLabel(gs, 'g404'), 'Group g404');
    assert.equal(U.groupLabel(null, 'g1'), 'Group g1');
});

test('normalizeUser reads the documented shape', () => {
    const u = U.normalizeUser(USERS[0], U.normalizeGroups(GROUPS));
    assert.deepEqual(u, { id: 'u1', name: 'ada', email: 'ada@example.com', groupId: 'g1',
        groupName: 'Support', isAdmin: true, enabled: true, statusLabel: 'Enabled', busy: '' });
});

test('normalizeUser decides enabled from every spelling the server might use', () => {
    for (const r of [{ status: 1 }, { status: '1' }, { status: 'enabled' }, { status: 'Active' },
        { enabled: true }, { is_enabled: true }, {}, { status: 'maybe' }])
        assert.equal(U.normalizeUser(Object.assign({ id: 'x' }, r), []).enabled, true, JSON.stringify(r));
    for (const r of [{ status: 0 }, { status: '0' }, { status: 'disabled' }, { status: 'INACTIVE' },
        { enabled: false }, { is_enabled: false }])
        assert.equal(U.normalizeUser(Object.assign({ id: 'x' }, r), []).enabled, false, JSON.stringify(r));
});

test('normalizeUser recognises an admin however the server spells it', () => {
    for (const r of [{ is_admin: true }, { is_admin: 1 }, { role: 'admin' }, { role: 'ADMIN' }])
        assert.equal(U.normalizeUser(Object.assign({ id: 'x' }, r), []).isAdmin, true, JSON.stringify(r));
    for (const r of [{ is_admin: 0 }, {}, { role: 'viewer' }])
        assert.equal(U.normalizeUser(Object.assign({ id: 'x' }, r), []).isAdmin, false, JSON.stringify(r));
});

test('normalizeUser scrubs hostile field values and never throws', () => {
    const u = U.normalizeUser({ id: 'u\n1', username: 'a\x00b', email: 'e'.repeat(4000) }, []);
    assert.equal(u.id, 'u 1');
    assert.equal(u.name, 'a b');
    assert.equal(u.email.length, V.MAX_TEXT);
    assert.ok(!/[\x00-\x1f\x7f]/.test(u.id + u.name + u.email + u.groupName));
    for (const bad of [null, undefined, 'nope', 42, [], true]) {
        const x = U.normalizeUser(bad, []);
        assert.equal(x.id, '');
        assert.equal(x.name, '');
    }
});

test('rowsFrom drops rows with neither id nor name and keeps the reported total', () => {
    const parsed = U.rowsFrom(envelope([USERS[0], null, {}, { id: '', name: '' }, 'garbage', USERS[1]], 91),
        U.normalizeGroups(GROUPS));
    assert.deepEqual(parsed.rows.map((r) => r.id), ['u1', 'u2']);
    assert.equal(parsed.total, 91);
});

test('rowsFrom survives a truncated payload', () => {
    for (const bad of [null, {}, { code: 0, data: null }, { list: null }, 'nope']) {
        const parsed = U.rowsFrom(bad, []);
        assert.deepEqual(parsed.rows, []);
        assert.equal(typeof parsed.total, 'number');
    }
});

test('listQuery clamps paging and sanitises the keyword', () => {
    assert.deepEqual(U.listQuery({}), { page: 1, page_size: 50 });
    assert.deepEqual(U.listQuery(null), { page: 1, page_size: 50 });
    assert.deepEqual(U.listQuery({ page: 4, pageSize: 20 }), { page: 4, page_size: 20 });
    assert.equal(U.listQuery({ page: 0 }).page, 1);
    assert.equal(U.listQuery({ page: -9 }).page, 1);
    assert.equal(U.listQuery({ pageSize: 9999 }).page_size, 200);
    assert.equal(U.listQuery({ pageSize: 'abc' }).page_size, 50);
    assert.equal(U.listQuery({ keyword: 'ada' }).keyword, 'ada');
    assert.equal(U.listQuery({ keyword: '  ' }).keyword, undefined);
    assert.equal(U.listQuery({ keyword: 'a\nb' }).keyword, 'a b');
    assert.equal(U.listQuery({ keyword: 'k'.repeat(500) }).keyword.length, 64);
    assert.equal(U.listQuery({ keyword: { evil: true } }).keyword, undefined);
});

test('refresh loads accounts and groups through the PilotApi façade only', async () => {
    const api = apiFake();
    await withApi(api, async () => {
        const c = globalThis.pilotUsersUi();
        assert.equal(await c.refresh(), true);
        assert.equal(c.loading, false);
        assert.equal(c.alert, null);
        assert.equal(c.rows.length, 3);
        assert.equal(c.total, 3);
        assert.equal(c.rows[0].groupName, 'Support');
        assert.equal(c.rows[1].statusLabel, 'Disabled');
        assert.deepEqual(api.calls.map((k) => k.name).sort(), ['groups', 'list']);
        assert.deepEqual(api.calls.find((k) => k.name === 'list').args[0], { page: 1, page_size: 50 });
    });
});

test('a groups failure is a warning; the accounts still render', async () => {
    const api = apiFake({ groups: { kind: 'API_AUTH_FAILED', message: 'token rejected' } });
    await withApi(api, async () => {
        const c = globalThis.pilotUsersUi();
        assert.equal(await c.refresh(), true);
        assert.equal(c.rows.length, 3);
        assert.equal(c.groups.length, 0);
        assert.equal(c.alert.kind, 'API_AUTH_FAILED');
        assert.equal(c.alert.context, 'Groups');
        assert.equal(c.rows[0].groupName, 'Group g1');
    });
});

test('an accounts failure names the reason and clears the table', async () => {
    const api = apiFake({ list: { kind: 'API_UNREACHABLE', message: 'no route to host' } });
    await withApi(api, async () => {
        const c = globalThis.pilotUsersUi();
        assert.equal(await c.refresh(), false);
        assert.deepEqual(c.rows, []);
        assert.equal(c.total, 0);
        assert.equal(c.alert.kind, 'API_UNREACHABLE');
        assert.equal(c.alert.context, 'Users');
        assert.equal(c.alert.message, 'no route to host');
        assert.equal(c.loading, false);
    });
});

test('with no PilotApi at all the surface says so instead of throwing', async () => {
    await withApi(undefined, async () => {
        const c = globalThis.pilotUsersUi();
        assert.equal(await c.refresh(), false);
        assert.equal(c.alert.kind, 'API_UNREACHABLE');
        assert.deepEqual(c.rows, []);
    });
});

test('a stale in-flight load never overwrites a newer result', async () => {
    let release = null;
    const slow = new Promise((res) => { release = res; });
    let n = 0;
    const api = apiFake({ list: () => { n += 1; return n === 1 ? slow.then(() => envelope([USERS[0]])) : envelope([USERS[1], USERS[2]]); } });
    await withApi(api, async () => {
        const c = globalThis.pilotUsersUi();
        const first = c.refresh();
        const second = c.refresh();
        await second;
        assert.deepEqual(c.rows.map((r) => r.id), ['u2', 'u3']);
        release();
        assert.equal(await first, false);
        assert.deepEqual(c.rows.map((r) => r.id), ['u2', 'u3'], 'the stale load must not win');
        assert.equal(c.loading, false);
    });
});

test('toggle flips the account and re-reads the list', async () => {
    const api = apiFake();
    await withApi(api, async () => {
        const c = globalThis.pilotUsersUi();
        await c.refresh();
        api.calls.length = 0;
        assert.equal(await c.toggle(c.rows[0]), true);
        assert.deepEqual(api.calls.find((k) => k.name === 'setEnabled').args, ['u1', false]);
        assert.ok(api.calls.some((k) => k.name === 'list'), 'the list must be re-read');
        await c.toggle(c.rows.find((r) => r.id === 'u2'));
        assert.deepEqual(api.calls.filter((k) => k.name === 'setEnabled').pop().args, ['u2', true]);
    });
});

test('a failing write leaves an alert and clears the row spinner', async () => {
    const api = apiFake({ setEnabled: { kind: 'API_AUTH_FAILED', message: 'token rejected' } });
    await withApi(api, async () => {
        const c = globalThis.pilotUsersUi();
        await c.refresh();
        const row = c.rows[0];
        assert.equal(await c.toggle(row), false);
        assert.equal(row.busy, '');
        assert.equal(c.alert.kind, 'API_AUTH_FAILED');
    });
});

test('an action on a row with no id is refused before any call is made', async () => {
    const api = apiFake();
    await withApi(api, async () => {
        const c = globalThis.pilotUsersUi();
        await c.refresh();
        api.calls.length = 0;
        assert.equal(await c.toggle({ id: '', enabled: true }), false);
        assert.equal(await c.toggle(null), false);
        assert.equal(api.calls.length, 0);
        assert.equal(c.alert.kind, 'GENERIC');
    });
});

test('resetPassword refuses a weak password without calling the API', async () => {
    const api = apiFake();
    await withApi(api, async () => {
        const c = globalThis.pilotUsersUi();
        await c.refresh();
        api.calls.length = 0;
        c.pw['u1'] = 'short';
        assert.equal(await c.resetPassword(c.rows[0]), false);
        assert.equal(api.calls.length, 0);
        assert.match(c.alert.message, /at least 8/);
    });
});

test('resetPassword sends a good password and then forgets it', async () => {
    const api = apiFake();
    await withApi(api, async () => {
        const c = globalThis.pilotUsersUi();
        await c.refresh();
        c.pw['u1'] = 'correct horse';
        assert.equal(await c.resetPassword(c.rows[0]), true);
        assert.deepEqual(api.calls.find((k) => k.name === 'resetPassword').args, ['u1', 'correct horse']);
        assert.equal(c.pw['u1'], '');
    });
});

test('assignGroup calls setGroup only when the group actually changed', async () => {
    const api = apiFake();
    await withApi(api, async () => {
        const c = globalThis.pilotUsersUi();
        await c.refresh();
        api.calls.length = 0;
        assert.equal(await c.assignGroup(c.rows[0], 'g1'), false);
        assert.equal(api.calls.length, 0);
        assert.equal(await c.assignGroup(c.rows[0], 'g2'), true);
        assert.deepEqual(api.calls.find((k) => k.name === 'setGroup').args, ['u1', 'g2']);
    });
});

test('create validates before it calls, and resets the form on success', async () => {
    const api = apiFake();
    await withApi(api, async () => {
        const c = globalThis.pilotUsersUi();
        c.form = Object.assign(U.blankForm(), { name: 'a/b', password: 'x', confirm: 'y' });
        assert.equal(await c.create(), false);
        assert.equal(api.calls.length, 0);
        assert.ok(Object.keys(c.formProblems).length >= 2);
        c.form = Object.assign(U.blankForm(), good({ groupId: 'g2' }));
        assert.equal(await c.create(), true);
        assert.deepEqual(api.calls.find((k) => k.name === 'create').args[0],
            { name: 'ada', email: 'ada@example.com', password: 'correct horse', group_id: 'g2' });
        assert.equal(c.form.name, '');
        assert.equal(c.form.password, '');
        assert.deepEqual(c.formProblems, {});
    });
});

test('a failing create keeps the form and reports the reason', async () => {
    const api = apiFake({ create: { kind: 'GENERIC', message: 'username already exists' } });
    await withApi(api, async () => {
        const c = globalThis.pilotUsersUi();
        c.form = Object.assign(U.blankForm(), good());
        assert.equal(await c.create(), false);
        assert.equal(c.form.name, 'ada');
        assert.equal(c.creating, false);
        assert.equal(c.alert.message, 'username already exists');
        assert.equal(c.alert.context, 'Create account');
    });
});

test('the template exposes the controls the e2e scenario drives', () => {
    for (const id of ['users-root', 'users-refresh', 'users-row', 'users-toggle', 'users-reset',
        'users-alert', 'users-empty', 'users-total', 'users-group', 'users-create-submit',
        'users-new-name', 'users-new-password', 'users-new-confirm', 'users-form-problems',
        'users-empty-action', 'users-empty-filtered', 'users-empty-filtered-action',
        'users-alert-action'])
        assert.ok(U.TEMPLATE.includes('"' + id + '"'), 'template has no ' + id);
    assert.ok(U.TEMPLATE.includes('x-data="pilotUsersUi()"'));
    assert.ok(/type="password"/.test(U.TEMPLATE), 'password inputs must be masked');
    assert.ok(!/ value="[^"]/.test(U.TEMPLATE), 'no literal value attribute may carry a secret');
});

test('the two empty states gate on opposite senses of the search keyword', () => {
    // "no accounts at all" and "search matched nothing" must never both show,
    // and neither is the generic table -- both branch on !keyword.trim().
    assert.ok(U.TEMPLATE.includes('!keyword.trim()'), 'the plain empty state must require an empty keyword');
    assert.ok(U.TEMPLATE.includes('!!keyword.trim()'), 'the filtered empty state must require a non-empty keyword');
});

// ---------------------------------------------------------------------------
// pilot:server-changed wiring — Task 24 addition beyond the base brief.
// js/app.js's notifyServerChanged() dispatches this event on `document` (or a
// given target) after switchServer() re-wires PilotApi.setTransport. The
// Users surface has no per-server client-side cache to re-key (unlike
// Devices), so the only obligation is: hearing the event triggers a fresh
// refresh() instead of quietly leaving the previous server's accounts on
// screen. Verified with a fake EventTarget so this runs with no real DOM.
// ---------------------------------------------------------------------------

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
        const c = globalThis.pilotUsersUi();
        const target = fakeTarget();
        await c.init(target);
        assert.ok(Array.isArray(target._listeners['pilot:server-changed']),
            'init must register a pilot:server-changed listener on the given target');
        api.calls.length = 0;
        target.dispatchEvent({ type: 'pilot:server-changed', detail: { id: 'staging' } });
        // onServerChanged calls refresh() but does not await it; give the
        // microtask queue a turn so the async list/groups calls land.
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        assert.deepEqual(api.calls.map((k) => k.name).sort(), ['groups', 'list'],
            'the event must cause a fresh refresh(), not be silently ignored');
    });
});

test('onServerChanged refuses a malformed event without throwing', async () => {
    const api = apiFake();
    await withApi(api, async () => {
        const c = globalThis.pilotUsersUi();
        for (const bad of [null, undefined, 'nope', 42]) assert.equal(c.onServerChanged(bad), false);
    });
});

test('init tolerates a target with no addEventListener (no DOM) and still refreshes once', async () => {
    const api = apiFake();
    await withApi(api, async () => {
        const c = globalThis.pilotUsersUi();
        assert.equal(await c.init({}), true);
        assert.equal(c.rows.length, 3);
    });
});

// ------------------------------- the two seeded groups are named in Chinese

test('the seeded groups get a readable label; anything renamed is left alone', () => {
    // rustdesk-api seeds two groups at first migration -- 默认组 and 共享组 --
    // regardless of the `lang` setting, so an English-speaking operator saw two
    // unreadable options and could not tell which was which. `type` is what
    // identifies them (1 default, 2 shared, verified on a real v2.7 install).
    const g = U.normalizeGroups({ code: 0, data: { list: [
        { id: 1, name: '默认组', type: 1 },
        { id: 2, name: '共享组', type: 2 },
        { id: 3, name: 'Support team', type: 2 },
        { id: 4, name: 'Renamed default', type: 1 }
    ] } });
    const rows = Array.isArray(g) ? g : (g.list || []);
    assert.deepEqual(rows.map((r) => r.name),
        ['Default group', 'Shared group', 'Support team', 'Renamed default'],
        'only the untouched seed is relabelled — a group someone named is theirs');
    // The server's own name is kept, never overwritten.
    assert.equal(rows[0].serverName, '默认组');
    assert.equal(rows[2].serverName, 'Support team');
});

test('a group with no name at all is still identified', () => {
    const g = U.normalizeGroups({ code: 0, data: { list: [{ id: 9, type: 7 }] } });
    const rows = Array.isArray(g) ? g : (g.list || []);
    assert.equal(rows[0].name, '(unnamed)');
});
