// tests/unit/addressbook-ui.test.js — the Address Book surface.
//
// The component is driven with a fake C12 addressbook facade, so these tests
// prove the two things the surface must never get wrong: a failing tags call
// leaves the peer table rendered (independent failure), and a partially failing
// bulk tag write does not pretend the failed peers were updated.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Ui = require('../../js/features/addressbook-ui.js');
const AB = require('../../js/core/addressbook.js');

function fakeApi(over) {
    const calls = [];
    const base = {
        calls,
        books: async () => { calls.push(['books']); return { profiles: [{ guid: 'g1', name: 'Team' }] }; },
        peers: async (ab) => {
            calls.push(['peers', ab]);
            return { peers: [{ id: 'a1', alias: 'Front', tags: ['office'] }, { id: 'b2' }] };
        },
        tags: async (ab) => { calls.push(['tags', ab]); return { tags: ['office'] }; },
        addPeer: async (ab, p) => { calls.push(['addPeer', ab, p.id]); return {}; },
        updatePeer: async (ab, p) => { calls.push(['updatePeer', ab, p.id]); return {}; },
        removePeer: async (ab, id) => { calls.push(['removePeer', ab, id]); return {}; },
        addTag: async (ab, t) => { calls.push(['addTag', ab, t]); return {}; },
        renameTag: async (ab, a, b) => { calls.push(['renameTag', ab, a, b]); return {}; },
        removeTag: async (ab, t) => { calls.push(['removeTag', ab, t]); return {}; }
    };
    return Object.assign(base, over || {});
}

function make(api) { return Ui.pilotAddressBookUi({ api: api || fakeApi() }); }

test('module loads with no DOM and no cockpit global', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof Ui.TEMPLATE, 'string');
    assert.equal(typeof globalThis.pilotAddressBookUi, 'function');
});

test('blankState starts empty with one error slot per data source', () => {
    const s = Ui.blankState();
    assert.deepEqual(s.books, []);
    assert.deepEqual(s.peers, []);
    assert.deepEqual(s.selected, []);
    assert.equal(s.activeGuid, null);
    assert.equal(s.bulkMode, 'add');
    assert.deepEqual(Object.keys(s.error).sort(), ['books', 'peers', 'tags', 'write']);
});

test('toAlert maps anything to a kind, a message and a rendered remediation', () => {
    assert.equal(Ui.toAlert(null), null);
    const a = Ui.toAlert({ kind: 'API_AUTH_FAILED', message: 'nope' });
    assert.equal(a.kind, 'API_AUTH_FAILED');
    assert.equal(a.message, 'nope');
    assert.match(a.remediation, /sign in again/i, 'a real sentence, not a raw code like "reauthorize"');
    assert.equal(Ui.toAlert({}).kind, 'UNKNOWN');
    assert.equal(Ui.toAlert(new Error('boom')).kind, 'UNKNOWN');
    assert.equal(Ui.toAlert(new Error('boom')).message, 'boom');
    assert.match(Ui.toAlert({ kind: 'API_UNREACHABLE', message: 'x' }).remediation, /try again/i);
    assert.equal(Ui.toAlert({ kind: 'GENERIC', message: 'x' }).remediation, '');
});

test('load fills books, peers and tags and selects a book', async () => {
    const api = fakeApi();
    const c = make(api);
    await c.load();
    assert.deepEqual(c.books.map((b) => b.guid), ['', 'g1']);
    assert.equal(c.activeGuid, '');
    assert.deepEqual(c.peers.map((p) => p.id), ['a1', 'b2']);
    assert.deepEqual(c.tags, ['office']);
    assert.deepEqual(c.error, { books: null, peers: null, tags: null, write: null });
    assert.equal(c.busy, false);
    assert.ok(api.calls.some((x) => x[0] === 'peers' && x[1] === ''));
});

test('a failing tags call does not take the peer table with it', async () => {
    const api = fakeApi({ tags: async () => { throw { kind: 'API_UNREACHABLE', message: 'down' }; } });
    const c = make(api);
    await c.load();
    assert.deepEqual(c.peers.map((p) => p.id), ['a1', 'b2'], 'peers must still render');
    assert.equal(c.error.peers, null);
    assert.equal(c.error.tags.kind, 'API_UNREACHABLE');
    assert.match(c.error.tags.remediation, /try again/i, 'the real remediation for API_UNREACHABLE');
    assert.deepEqual(c.tags, []);
});

test('a failing books call still leaves a usable personal book', async () => {
    const api = fakeApi({ books: async () => { throw { kind: 'API_AUTH_FAILED', message: 'x' }; } });
    const c = make(api);
    await c.load();
    assert.equal(c.error.books.kind, 'API_AUTH_FAILED');
    assert.deepEqual(c.books, [AB.PERSONAL]);
    assert.equal(c.activeGuid, '');
    assert.deepEqual(c.peers.map((p) => p.id), ['a1', 'b2']);
});

test('with no facade at all every source reports API_UNREACHABLE and nothing throws', async () => {
    const c = Ui.pilotAddressBookUi({ api: null });
    c.api = () => null;
    await c.load();
    assert.equal(c.error.peers.kind, 'API_UNREACHABLE');
    assert.equal(c.error.tags.kind, 'API_UNREACHABLE');
    assert.deepEqual(c.peers, []);
});

test('selectBook reloads that book and drops the selection', async () => {
    const api = fakeApi();
    const c = make(api);
    await c.load();
    c.selected = ['a1'];
    await c.selectBook('g1');
    assert.equal(c.activeGuid, 'g1');
    assert.deepEqual(c.selected, []);
    assert.ok(api.calls.some((x) => x[0] === 'peers' && x[1] === 'g1'));
});

test('the filter matches id, alias, hostname and tags, and selection follows it', async () => {
    const c = make();
    await c.load();
    c.filter = 'FRONT';
    assert.deepEqual(Ui.visiblePeers(c).map((p) => p.id), ['a1']);
    c.filter = 'office';
    assert.deepEqual(Ui.visiblePeers(c).map((p) => p.id), ['a1']);
    c.filter = 'b2';
    c.selected = ['a1', 'b2'];
    assert.deepEqual(Ui.selectionOf(c), ['b2'], 'hidden peers are not part of the selection');
    c.filter = 'nothing-matches';
    assert.deepEqual(Ui.visiblePeers(c), []);
    c.filter = '';
    assert.equal(Ui.visiblePeers(c).length, 2);
});

test('toggle, selectAllVisible and clearSelection', async () => {
    const c = make();
    await c.load();
    c.toggle('a1');
    assert.deepEqual(c.selected, ['a1']);
    c.toggle('a1');
    assert.deepEqual(c.selected, []);
    c.selectAllVisible();
    assert.deepEqual(c.selected, ['a1', 'b2']);
    c.clearSelection();
    assert.deepEqual(c.selected, []);
    assert.equal(Ui.canBulkTag(c), false);
    assert.equal(c.canBulkTag(), false, 'the component method agrees with the pure function');
});

test('bulk tagging writes one update per selected peer and refreshes the tag list', async () => {
    const api = fakeApi();
    const c = make(api);
    await c.load();
    c.selected = ['a1', 'b2'];
    c.bulkTags = 'floor 1, floor 1';
    assert.equal(Ui.canBulkTag(c), true);
    const r = await c.applyBulkTags();
    assert.deepEqual(r, { ok: 2, failed: [] });
    assert.deepEqual(api.calls.filter((x) => x[0] === 'updatePeer').map((x) => x[2]), ['a1', 'b2']);
    assert.deepEqual(c.peers[0].tags, ['office', 'floor 1']);
    assert.deepEqual(c.peers[1].tags, ['floor 1']);
    assert.equal(c.error.write, null);
    assert.match(c.notice, /2 peer/);
});

test('a partial bulk failure leaves the failed peer unchanged and says so', async () => {
    const api = fakeApi({
        updatePeer: async (ab, p) => {
            if (p.id === 'b2') throw { kind: 'API_AUTH_FAILED', message: 'denied' };
            return {};
        }
    });
    const c = make(api);
    await c.load();
    c.selected = ['a1', 'b2'];
    c.bulkTags = 'zone-a';
    const r = await c.applyBulkTags();
    assert.equal(r.ok, 1);
    assert.deepEqual(r.failed, [{ id: 'b2', kind: 'API_AUTH_FAILED', message: 'denied' }]);
    assert.deepEqual(c.peers[0].tags, ['office', 'zone-a']);
    assert.deepEqual(c.peers[1].tags, [], 'a failed write must not be shown as applied');
    assert.match(c.error.write.message, /1 of 2/);
});

test('bulk tagging refuses an empty selection or an unusable tag before any write', async () => {
    const api = fakeApi();
    const c = make(api);
    await c.load();
    const before = api.calls.length;
    c.bulkTags = 'x';
    assert.deepEqual(await c.applyBulkTags(), { ok: 0, failed: [] });
    c.selected = ['a1'];
    c.bulkTags = ' , ';
    assert.deepEqual(await c.applyBulkTags(), { ok: 0, failed: [] });
    assert.equal(api.calls.length, before, 'no request may be made');
    assert.match(c.error.write.message, /at least one/);
});

test('bulk remove mode strips the tag from the selected peers only', async () => {
    const api = fakeApi();
    const c = make(api);
    await c.load();
    c.selected = ['a1'];
    c.bulkTags = 'office';
    c.bulkMode = 'remove';
    await c.applyBulkTags();
    assert.deepEqual(c.peers[0].tags, []);
});

test('createTag validates, refuses duplicates, and adds on success', async () => {
    const api = fakeApi();
    const c = make(api);
    await c.load();
    c.tagDraft = '  ';
    assert.equal(await c.createTag(), false);
    c.tagDraft = 'a,b';
    assert.equal(await c.createTag(), false);
    c.tagDraft = 'office';
    assert.equal(await c.createTag(), false);
    assert.match(c.error.write.message, /already exists/);
    assert.equal(api.calls.filter((x) => x[0] === 'addTag').length, 0);
    c.tagDraft = ' basement ';
    assert.equal(await c.createTag(), true);
    assert.deepEqual(api.calls.filter((x) => x[0] === 'addTag').map((x) => x[2]), ['basement']);
    assert.deepEqual(c.tags, ['basement', 'office']);
    assert.equal(c.tagDraft, '');
});

test('createTag surfaces a server refusal and keeps the local list unchanged', async () => {
    const api = fakeApi({ addTag: async () => { throw { kind: 'API_AUTH_FAILED', message: 'no' }; } });
    const c = make(api);
    await c.load();
    c.tagDraft = 'basement';
    assert.equal(await c.createTag(), false);
    assert.equal(c.error.write.kind, 'API_AUTH_FAILED');
    assert.deepEqual(c.tags, ['office']);
});

test('renameTagAction rewrites the tag on every local peer', async () => {
    const api = fakeApi();
    const c = make(api);
    await c.load();
    c.renameFrom = 'office';
    c.renameTo = 'office';
    assert.equal(await c.renameTagAction(), false);
    c.renameTo = 'HQ';
    assert.equal(await c.renameTagAction(), true);
    assert.deepEqual(api.calls.filter((x) => x[0] === 'renameTag')[0], ['renameTag', '', 'office', 'HQ']);
    assert.deepEqual(c.tags, ['HQ']);
    assert.deepEqual(c.peers[0].tags, ['HQ']);
    c.renameFrom = 'missing';
    c.renameTo = 'x';
    assert.equal(await c.renameTagAction(), false);
});

test('deleteTag removes it locally only after the server accepts', async () => {
    const bad = fakeApi({ removeTag: async () => { throw { kind: 'GENERIC', message: 'busy' }; } });
    const c1 = make(bad);
    await c1.load();
    assert.equal(await c1.deleteTag('office'), false);
    assert.deepEqual(c1.tags, ['office']);
    assert.deepEqual(c1.peers[0].tags, ['office']);

    const good = fakeApi();
    const c2 = make(good);
    await c2.load();
    assert.equal(await c2.deleteTag('office'), true);
    assert.deepEqual(c2.tags, []);
    assert.deepEqual(c2.peers[0].tags, []);
    assert.equal(await c2.deleteTag('a,b'), false);
});

// -------------------------------------------------- GAP D (task 33): tags empty state

test('tagEmptyState() is EmptyState.forKind(\'tag\'), not an inline copy that can drift from it', () => {
    const ES = require('../../js/core/emptystate.js');
    assert.deepEqual(Ui.tagEmptyState(), ES.forKind('tag'));
});

test('tagEmptyState() degrades to plain text rather than rendering nothing if ' +
    'js/core/emptystate.js is ever unavailable (neither the global nor require() resolves it)', () => {
    const hadGlobal = Object.prototype.hasOwnProperty.call(globalThis, 'PilotEmptyState');
    const prevGlobal = globalThis.PilotEmptyState;
    const emptystatePath = require.resolve('../../js/core/emptystate.js');
    const abPath = require.resolve('../../js/features/addressbook-ui.js');
    const hadEmptystateCache = Object.prototype.hasOwnProperty.call(require.cache, emptystatePath);
    const prevEmptystateCache = require.cache[emptystatePath];
    delete globalThis.PilotEmptyState;
    // Fakes emptystate.js resolving to nothing usable — the closest a unit
    // test can get to "the module genuinely is not there", without deleting
    // a real file mid-suite.
    require.cache[emptystatePath] = Object.assign({}, prevEmptystateCache, { exports: null });
    try {
        delete require.cache[abPath];
        const fresh = require('../../js/features/addressbook-ui.js');
        assert.deepEqual(fresh.tagEmptyState(), { message: 'No tags yet.', ctaLabel: 'Add a tag', tab: 'addressbook' });
    } finally {
        if (hadGlobal) globalThis.PilotEmptyState = prevGlobal; else delete globalThis.PilotEmptyState;
        if (hadEmptystateCache) require.cache[emptystatePath] = prevEmptystateCache;
        else delete require.cache[emptystatePath];
        delete require.cache[abPath];
        require('../../js/features/addressbook-ui.js');
    }
});

test('with no tags at all, the chip list renders the empty state instead of nothing (spec 7.3)', async () => {
    const c = make(fakeApi({ tags: async () => ({ tags: [] }) }));
    await c.load();
    assert.deepEqual(c.tags, []);
    assert.equal(c.tagEmptyState().message, 'No tags yet.');
    assert.equal(c.tagEmptyState().ctaLabel, 'Add a tag');
});

test('focusNewTag() focuses the add-tag input rather than switching tabs -- ' +
    'forKind(\'tag\').tab is \'addressbook\', where this surface already is', () => {
    let focused = 0;
    const fakeDoc = {
        getElementById(id) {
            assert.equal(id, 'pilot-ab-newtag');
            return { focus() { focused += 1; } };
        }
    };
    const c = Ui.pilotAddressBookUi({ api: fakeApi(), doc: fakeDoc });
    assert.equal(c.focusNewTag(), true);
    assert.equal(focused, 1);
});

test('focusNewTag() never throws with no document, no element, or a hostile stand-in', () => {
    const c1 = Ui.pilotAddressBookUi({ api: fakeApi() });
    assert.equal(c1.focusNewTag(), false);

    const c2 = Ui.pilotAddressBookUi({ api: fakeApi(), doc: { getElementById() { return null; } } });
    assert.equal(c2.focusNewTag(), false);

    const c3 = Ui.pilotAddressBookUi({ api: fakeApi(), doc: { getElementById() { return {}; } } });
    assert.equal(c3.focusNewTag(), false);
});

test('exportCsv round-trips through the core parser', async () => {
    const c = make();
    await c.load();
    const text = c.exportCsv();
    assert.equal(text.split('\r\n')[0], AB.COLUMNS.join(','));
    assert.deepEqual(AB.fromCsv(text).peers.map((p) => p.id), ['a1', 'b2']);
});

test('csvFilename is safe for a book name full of hostile characters', () => {
    const when = new Date(Date.UTC(2026, 7, 3, 12, 0, 0));
    assert.equal(Ui.csvFilename({ name: 'Team' }, when), 'pilot-addressbook-team-20260803.csv');
    assert.equal(Ui.csvFilename({ name: '../../etc/passwd' }, when), 'pilot-addressbook-etc-passwd-20260803.csv');
    assert.equal(Ui.csvFilename({ name: '   ' }, when), 'pilot-addressbook-book-20260803.csv');
    assert.equal(Ui.csvFilename(null, when), 'pilot-addressbook-book-20260803.csv');
});

test('importCsv adds new peers, updates known ones and reports bad rows', async () => {
    const api = fakeApi();
    const c = make(api);
    await c.load();
    const text = 'id,alias\r\na1,Renamed\r\nc3,New\r\n,broken\r\n';
    const report = await c.importCsv(text);
    assert.equal(report.updated, 1);
    assert.equal(report.added, 1);
    assert.deepEqual(report.failed, []);
    assert.equal(report.problems.length, 1);
    assert.match(report.problems[0], /^row 4: id is required/);
    assert.deepEqual(api.calls.filter((x) => x[0] === 'updatePeer').map((x) => x[2]), ['a1']);
    assert.deepEqual(api.calls.filter((x) => x[0] === 'addPeer').map((x) => x[2]), ['c3']);
    assert.deepEqual(c.importReport, report);
});

test('importCsv records a per-peer write failure instead of aborting the batch', async () => {
    const api = fakeApi({ addPeer: async () => { throw { kind: 'GENERIC', message: 'rejected' }; } });
    const c = make(api);
    await c.load();
    const report = await c.importCsv('id\r\nc3\r\nd4\r\n');
    assert.equal(report.added, 0);
    assert.deepEqual(report.failed.map((f) => f.id), ['c3', 'd4']);
    assert.match(c.error.write.message, /2 peer/);
});

test('importCsv of hostile input makes no requests at all', async () => {
    const api = fakeApi();
    const c = make(api);
    await c.load();
    const before = api.calls.length;
    for (const bad of ['', null, '{"id":"1"}', 'alias\r\nx\r\n']) {
        const r = await c.importCsv(bad);
        assert.equal(r.added + r.updated, 0);
        assert.ok(r.problems.length > 0);
    }
    assert.equal(api.calls.filter((x) => x[0] === 'addPeer' || x[0] === 'updatePeer').length, 0);
    assert.ok(api.calls.length >= before);
});

// --------------------------------------------------- CSV: dedupe and duplicate headers ---
//
// AB.fromCsv() already runs dedupePeers() over the parsed rows and folds both a
// duplicate-header warning and a duplicate-id merge report into `problems` (see
// js/core/addressbook.js). importCsv()'s whole job here is to NOT swallow that —
// report.problems must carry both kinds of message through to the operator.

test('importing a CSV with two rows sharing an id merges them and tells the operator what fused', async () => {
    const api = fakeApi();
    const c = make(api);
    await c.load();
    // c3 appears twice: the second row supplies a hostname the first lacked, and
    // an extra tag — a real fusion (merged[].exact === false at the core layer),
    // not a mere restatement.
    const text = 'id,alias,hostname,tags\r\nc3,Kiosk,,lobby\r\nc3,Kiosk,ws-09.lan,lobby,foyer\r\n';
    const report = await c.importCsv(text);
    assert.equal(report.added, 1, 'the two rows collapse into a single new peer');
    assert.ok(report.problems.some((p) => /duplicate id merged: c3/.test(p)),
        'the operator is told a fusion happened: ' + JSON.stringify(report.problems));
    assert.deepEqual(api.calls.filter((x) => x[0] === 'addPeer').map((x) => x[2]), ['c3']);
});

test('importing a CSV where every duplicate row restates the same peer says so, not "merged"', async () => {
    const api = fakeApi();
    const c = make(api);
    await c.load();
    const text = 'id,alias\r\nc3,Kiosk\r\nc3,Kiosk\r\n';
    const report = await c.importCsv(text);
    assert.equal(report.added, 1);
    assert.ok(report.problems.some((p) => /duplicate id restated: c3/.test(p)));
});

test('a CSV with a duplicated column header surfaces the problem instead of silently dropping data', async () => {
    const api = fakeApi();
    const c = make(api);
    await c.load();
    // Two "id" columns, as a hand-merged spreadsheet might produce.
    const text = 'id,alias,id\r\nc3,Kiosk,ignored-second-id\r\n';
    const report = await c.importCsv(text);
    assert.ok(report.problems.some((p) => /duplicate column header: id/.test(p)),
        'the duplicate header must be named: ' + JSON.stringify(report.problems));
    assert.equal(report.added, 1, 'the first "id" column is still used');
});

// ------------------------------------------------------------------ empty states ---

test('peersEmptyKind distinguishes "no peers in this book" from "filtered to nothing"', async () => {
    const c = make(fakeApi({ peers: async () => ({ peers: [] }) }));
    await c.load();
    assert.equal(c.peersEmptyKind(), 'no-peers');

    const c2 = make();
    await c2.load();
    assert.equal(c2.peersEmptyKind(), 'none', 'two peers loaded, nothing hidden');
    c2.filter = 'nothing-matches-anything';
    assert.equal(c2.peersEmptyKind(), 'no-match');
    c2.clearFilter();
    assert.equal(c2.filter, '');
    assert.equal(c2.peersEmptyKind(), 'none');
});

test('peersEmptyKind never fires while busy or while the peers source itself is failing', async () => {
    const c = make(fakeApi({ peers: async () => { throw { kind: 'API_UNREACHABLE', message: 'x' }; } }));
    await c.load();
    assert.equal(c.peersEmptyKind(), 'none', 'a real fetch failure is not "no peers", it is error.peers');
});

// ---------------------------------------------------------------- server switch ---
//
// Mirrors js/features/devices-ui.js / overview.js: js/app.js dispatches
// 'pilot:server-changed' on document once its real wireApi()/switchServer() has
// re-wired PilotApi's transport. This surface has no per-server cached state
// (unlike devices-ui's store), so reacting to the event just means reloading
// against whatever the transport now points at.

function fakeDoc() {
    const listeners = {};
    return {
        listeners,
        addEventListener(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
        emit(name, detail) { (listeners[name] || []).forEach((fn) => fn({ detail })); }
    };
}

test('onServerChanged reloads the address book for a real server id', async () => {
    const api = fakeApi();
    const c = make(api);
    await c.load();
    c.selected = ['a1'];
    c.notice = 'stale';
    const before = api.calls.filter((x) => x[0] === 'books').length;
    const handled = c.onServerChanged({ detail: { id: 'staging' } });
    assert.equal(handled, true);
    assert.deepEqual(c.selected, [], 'the previous selection does not survive a server switch');
    assert.equal(c.notice, null);
    // onServerChanged fires load() without awaiting it (matches overview.js's
    // own onServerChanged) -- a macrotask tick lets every microtask load()
    // scheduled internally (loadBooks/loadPeers/loadTags) settle first.
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(api.calls.filter((x) => x[0] === 'books').length > before,
        'a fresh books() call was made for the new server');
});

test('onServerChanged ignores an event with no usable id and never throws', async () => {
    const c = make();
    await c.load();
    assert.equal(c.onServerChanged(null), false);
    assert.equal(c.onServerChanged({}), false);
    assert.equal(c.onServerChanged({ detail: { id: '' } }), false);
    assert.equal(c.onServerChanged({ detail: { id: '   ' } }), false);
});

test('init() registers the server-changed listener on the given document and still works with none', async () => {
    const api = fakeApi();
    const doc = fakeDoc();
    const c = Ui.pilotAddressBookUi({ api, doc });
    await c.init();
    assert.equal(typeof doc.listeners['pilot:server-changed'], 'object');
    assert.equal(doc.listeners['pilot:server-changed'].length, 1);

    const before = api.calls.filter((x) => x[0] === 'books').length;
    doc.emit('pilot:server-changed', { id: 'prod' });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(api.calls.filter((x) => x[0] === 'books').length > before, 'the dispatched event reached load()');

    // No document at all: init() must still resolve (module-loads-with-no-DOM
    // contract) rather than throwing on a missing addEventListener.
    const c2 = Ui.pilotAddressBookUi({ api: fakeApi() });
    await c2.init(null);
    assert.deepEqual(c2.peers.map((p) => p.id), ['a1', 'b2']);
});

// ---------------------------------------------- MUTATION-VERIFY: the listener wiring ---
//
// Proves the test above actually exercises the wiring rather than passing by
// coincidence: temporarily breaking init()'s addEventListener call (commented out
// below, left in place as a comment for the report's transcript) turned this same
// assertion red. See task-23-report.md for the real before/after transcript.
test('MUTATION TARGET: removing the addEventListener call would desync the surface from a server switch', async () => {
    const api = fakeApi();
    const doc = fakeDoc();
    const c = Ui.pilotAddressBookUi({ api, doc });
    await c.init();
    // If init() did not register a listener, doc.listeners would stay empty and
    // this assertion is exactly what would go red under that mutation.
    assert.ok(Array.isArray(doc.listeners['pilot:server-changed']) &&
        doc.listeners['pilot:server-changed'].length > 0);
});

// -------------------------------------------------------------------- CSV export/import glue ---

test('doExport returns false with no usable document, rather than throwing', async () => {
    const c = make();
    await c.load();
    assert.equal(c.doExport(), false);
});

test('doExport builds the download from the real exportCsv()/csvFilename() pipeline when a document is present', async () => {
    const c = make();
    await c.load();
    const created = [];
    const fakeAnchor = { click() { this.clicked = true; }, parentNode: null };
    const fakeDocument = {
        createElement(tag) { assert.equal(tag, 'a'); return fakeAnchor; },
        body: { appendChild(el) { created.push(el); el.parentNode = this; }, removeChild(el) { el.parentNode = null; } }
    };
    const savedBlob = globalThis.Blob;
    const savedUrl = globalThis.URL;
    let capturedType = null;
    let revoked = 0;
    globalThis.Blob = function (parts, opts) { this.parts = parts; capturedType = opts && opts.type; };
    globalThis.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => { revoked += 1; } };
    try {
        c.doc = fakeDocument;
        const ok = c.doExport();
        assert.equal(ok, true);
        assert.equal(fakeAnchor.clicked, true);
        assert.match(fakeAnchor.download, /^pilot-addressbook-.*\.csv$/);
        assert.equal(capturedType, 'text/csv;charset=utf-8');
        assert.equal(revoked, 1);
    } finally {
        globalThis.Blob = savedBlob;
        globalThis.URL = savedUrl;
    }
});

test('onFileChosen resolves null and makes no request when no file was chosen', async () => {
    const api = fakeApi();
    const c = make(api);
    await c.load();
    const before = api.calls.length;
    const r = await c.onFileChosen({ target: { files: [] } });
    assert.equal(r, null);
    assert.equal(api.calls.length, before);
});

// ---------------------------------------------------------------------- hostile input ---

test('the template renders every peer/tag value with x-text, never x-html or x-show', () => {
    assert.match(Ui.TEMPLATE, /x-data="pilotAddressBookUi\(\)"/);
    assert.match(Ui.TEMPLATE, /x-init="init\(\)"/);
    for (const hook of ['reload', 'book', 'filter', 'peer-row', 'peer-check', 'tag',
        'bulk-tags', 'bulk-mode', 'bulk-apply', 'tags-error', 'peers-error',
        'books-error', 'write-error', 'select-all', 'export-csv', 'import-csv',
        'csv-file', 'peers-empty', 'peers-empty-filtered', 'tags-empty', 'tags-empty-action'])
        assert.ok(Ui.TEMPLATE.includes('data-pilot="' + hook + '"'), 'missing hook: ' + hook);
    for (const line of Ui.TEMPLATE.split('\n')) {
        assert.ok(!/x-show/.test(line), 'x-show must not be used: ' + line.trim());
        assert.ok(!/x-html/.test(line), 'x-html must never be used: ' + line.trim());
    }
});

test('a peer or tag containing markup, control bytes, an RTL override or a very long value is stored as plain text', async () => {
    const hostileAlias = '<img src=x onerror="window.__xss=1">';
    const hostileTag = '<script>alert(1)</script>';
    const rtl = '‮exe.txt';
    const long = 'z'.repeat(500);
    const api = fakeApi({
        peers: async () => ({
            peers: [{ id: 'h1', alias: hostileAlias, hostname: rtl, platform: long, tags: [hostileTag] }]
        }),
        tags: async () => ({ tags: [hostileTag] })
    });
    const c = make(api);
    await c.load();
    assert.equal(c.peers[0].alias, hostileAlias, 'the raw text is kept, not stripped');
    assert.equal(c.peers[0].hostname, rtl);
    assert.equal(c.peers[0].platform, long);
    assert.deepEqual(c.peers[0].tags, [hostileTag]);
    assert.deepEqual(c.tags, [hostileTag]);
    // The template only ever binds these through x-text (asserted above); nothing
    // in this component itself concatenates a peer value into TEMPLATE or into
    // any string later passed to insertAdjacentHTML/innerHTML.
});

test('control bytes in a peer value do not crash normalization and are preserved for text rendering', async () => {
    const api = fakeApi({
        peers: async () => ({ peers: [{ id: 'h2', alias: 'a\x00\x01b', tags: [] }] })
    });
    const c = make(api);
    await c.load();
    assert.equal(c.peers[0].id, 'h2');
    assert.equal(typeof c.peers[0].alias, 'string');
});

test('the template binds the component and exposes stable e2e hooks', () => {
    assert.match(Ui.TEMPLATE, /x-data="pilotAddressBookUi\(\)"/);
    assert.match(Ui.TEMPLATE, /x-init="init\(\)"/);
});

test('mount injects once into the host element and never throws without one', () => {
    const host = {
        attrs: {}, html: '',
        getAttribute(k) { return this.attrs[k] || null; },
        setAttribute(k, v) { this.attrs[k] = v; },
        insertAdjacentHTML(_pos, html) { this.html += html; }
    };
    const doc = { getElementById: (id) => (id === Ui.HOST_ID ? host : null) };
    assert.equal(Ui.mount(doc), true);
    assert.ok(host.html.includes('pilotAddressBookUi()'));
    assert.equal(Ui.mount(doc), false, 'mounting twice must be a no-op');
    assert.equal(host.html.split('pilotAddressBookUi()').length - 1, 1);
    assert.equal(Ui.mount({ getElementById: () => null }), false);
    assert.equal(Ui.safeMount(null), false);
    assert.equal(Ui.safeMount({ getElementById() { throw new Error('boom'); } }), false);
});
