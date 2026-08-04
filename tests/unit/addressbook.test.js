// tests/unit/addressbook.test.js — peer/tag models, dedupe and CSV round-trips.
//
// The CSV path is the one place a user hands Pilot a file from a spreadsheet, so
// the hostile cases here are the point of the module: embedded commas, quotes and
// newlines, a formula-injection prefix, unicode, oversized fields and truncated
// quoting. Every one of them has to survive export -> import unchanged.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AB = require('../../js/core/addressbook.js');

const isGeneric = (e) => e && e.kind === 'GENERIC';

function peer(over) {
    return Object.assign({ id: '123456789', alias: '', username: '', hostname: '',
        platform: '', tags: [], note: '' }, over || {});
}

test('module loads with no DOM and no cockpit global', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.deepEqual(AB.COLUMNS, ['id', 'alias', 'username', 'hostname', 'platform', 'tags', 'note']);
    assert.deepEqual(AB.MODES, ['add', 'remove', 'set']);
});

test('str coerces only scalars, never objects', () => {
    assert.equal(AB.str('x'), 'x');
    assert.equal(AB.str(7), '7');
    assert.equal(AB.str(false), 'false');
    assert.equal(AB.str(null), '');
    assert.equal(AB.str(undefined), '');
    assert.equal(AB.str({}), '');
    assert.equal(AB.str([1, 2]), '');
});

test('normalizeTag rejects every shape that is not a usable tag', () => {
    assert.equal(AB.normalizeTag('  office  '), 'office');
    assert.equal(AB.normalizeTag('bürö \u{1f30d}'), 'bürö \u{1f30d}');
    for (const bad of ['', '   ', null, undefined, {}, [], 'a,b', 'a\nb', 'a\tb',
        'a\x00b', 'a\x1fb', 'a\x7fb', 'x'.repeat(AB.LIMITS.tag + 1)])
        assert.equal(AB.normalizeTag(bad), null, 'accepted ' + JSON.stringify(bad));
    assert.equal(AB.normalizeTag('x'.repeat(AB.LIMITS.tag)).length, AB.LIMITS.tag);
});

test('normalizeTags dedupes, preserves order, splits strings and caps the count', () => {
    assert.deepEqual(AB.normalizeTags([' b ', 'a', 'b', '', null, 'a']), ['b', 'a']);
    assert.deepEqual(AB.normalizeTags('b,a,,b'), ['b', 'a']);
    assert.deepEqual(AB.normalizeTags(null), []);
    assert.deepEqual(AB.normalizeTags({ 0: 'a' }), []);
    const many = [];
    for (let i = 0; i < AB.LIMITS.tagsPerPeer + 10; i++) many.push('t' + i);
    assert.equal(AB.normalizeTags(many).length, AB.LIMITS.tagsPerPeer);
});

test('normalizePeer always returns every key, never throws', () => {
    const empty = AB.normalizePeer(undefined);
    assert.deepEqual(Object.keys(empty).sort(),
        ['alias', 'hostname', 'id', 'note', 'platform', 'tags', 'username']);
    assert.deepEqual(empty, { id: '', alias: '', username: '', hostname: '',
        platform: '', tags: [], note: '' });
    assert.deepEqual(AB.normalizePeer('nonsense'), empty);
    const p = AB.normalizePeer({ id: ' 42 ', alias: ' Büro ', tags: 'a,b', note: 'l1\r\nl2\rl3' });
    assert.equal(p.id, '42');
    assert.equal(p.alias, 'Büro');
    assert.deepEqual(p.tags, ['a', 'b']);
    assert.equal(p.note, 'l1\nl2\nl3');
});

test('validatePeer names each problem instead of throwing', () => {
    assert.equal(AB.validatePeer(peer()).ok, true);
    assert.deepEqual(AB.validatePeer(peer({ id: '' })).problems, ['id is required']);
    assert.deepEqual(AB.validatePeer(peer({ id: {} })).problems, ['id is required']);
    assert.match(AB.validatePeer(peer({ id: 'a b' })).problems[0], /letters, digits/);
    assert.match(AB.validatePeer(peer({ id: 'küürbis' })).problems[0], /letters, digits/);
    assert.match(AB.validatePeer(peer({ id: '../../etc/passwd' })).problems[0], /letters, digits/);
    assert.match(AB.validatePeer(peer({ id: 'x'.repeat(AB.LIMITS.id + 1) })).problems[0], /longer than/);
    assert.match(AB.validatePeer(peer({ alias: 'a\nb' })).problems[0], /control character/);
    assert.match(AB.validatePeer(peer({ hostname: 'h\x00st' })).problems[0], /control character/);
    assert.match(AB.validatePeer(peer({ note: 'a\x0bb' })).problems[0], /control character/);
    assert.equal(AB.validatePeer(peer({ note: 'line1\nline2' })).ok, true);
    assert.match(AB.validatePeer(peer({ note: 'x'.repeat(AB.LIMITS.note + 1) })).problems[0], /longer than/);
    assert.match(AB.validatePeer(peer({ tags: ['ok', 'a,b'] })).problems[0], /1 tag/);
});

test('dedupePeers merges by id, unions tags and drops peers with no id', () => {
    const out = AB.dedupePeers([
        { id: '1', alias: 'first', tags: ['a'] },
        { id: '1', alias: 'second', hostname: 'h1', tags: ['b', 'a'] },
        { id: '2', tags: ['c'] },
        { id: '', alias: 'orphan' },
        null
    ]);
    assert.deepEqual(out.merged, ['1']);
    assert.equal(out.peers.length, 2);
    assert.equal(out.peers[0].alias, 'first');
    assert.equal(out.peers[0].hostname, 'h1');
    assert.deepEqual(out.peers[0].tags, ['a', 'b']);
    assert.deepEqual(AB.dedupePeers(null), { peers: [], merged: [] });
});

test('withTags and bulkTag honour add/remove/set and reject any other mode', () => {
    const base = peer({ id: '1', tags: ['a', 'b'] });
    assert.deepEqual(AB.withTags(base, ['b', 'c'], 'add').tags, ['a', 'b', 'c']);
    assert.deepEqual(AB.withTags(base, ['b'], 'remove').tags, ['a']);
    assert.deepEqual(AB.withTags(base, ['z', 'z'], 'set').tags, ['z']);
    assert.deepEqual(base.tags, ['a', 'b'], 'withTags mutated its input');
    assert.throws(() => AB.withTags(base, ['x'], 'toggle'), isGeneric);
    assert.throws(() => AB.bulkTag([base], ['1'], ['x'], ''), isGeneric);

    const peers = [peer({ id: '1', tags: ['a'] }), peer({ id: '2' })];
    const next = AB.bulkTag(peers, [' 1 ', '', null], ['new'], 'add');
    assert.deepEqual(next[0].tags, ['a', 'new']);
    assert.deepEqual(next[1].tags, []);
    assert.deepEqual(AB.bulkTag(null, ['1'], ['x'], 'add'), []);
});

test('tagCounts, renameTagIn and removeTagFrom', () => {
    const peers = [peer({ id: '1', tags: ['a', 'b'] }), peer({ id: '2', tags: ['b'] })];
    assert.deepEqual(AB.tagCounts(peers), [{ tag: 'b', count: 2 }, { tag: 'a', count: 1 }]);
    assert.deepEqual(AB.renameTagIn(peers, 'a', 'b')[0].tags, ['b'], 'rename must not duplicate');
    assert.deepEqual(AB.removeTagFrom(peers, 'b')[1].tags, []);
    assert.throws(() => AB.renameTagIn(peers, 'a', ''), isGeneric);
    assert.throws(() => AB.removeTagFrom(peers, 'a,b'), isGeneric);
    assert.deepEqual(AB.tagCounts(null), []);
});

test('listFrom digs at most three levels and never recurses forever', () => {
    const loop = {};
    loop.data = loop;
    assert.deepEqual(AB.listFrom(loop, ['list']), []);
    assert.deepEqual(AB.listFrom([1], ['list']), [1]);
    assert.deepEqual(AB.listFrom({ data: { list: [2] } }, ['list']), [2]);
    assert.deepEqual(AB.listFrom({ data: { data: [3] } }, ['list']), [3]);
    assert.deepEqual(AB.listFrom(null, ['list']), []);
    assert.deepEqual(AB.listFrom('nope', ['list']), []);
});

test('booksFrom always yields exactly one personal book', () => {
    const only = AB.booksFrom(null);
    assert.equal(only.length, 1);
    assert.equal(only[0].personal, true);
    assert.equal(only[0].guid, '');
    const mixed = AB.booksFrom({ data: { profiles: [
        { guid: 'g1', name: ' Team ' },
        { guid: 'g1', name: 'dup' },
        { id: 'g2', personal: 1 }
    ] } });
    assert.deepEqual(mixed.map((b) => b.guid), ['g1', 'g2']);
    assert.equal(mixed[0].name, 'Team');
    assert.equal(mixed[1].personal, true);
    assert.equal(mixed.filter((b) => b.personal).length, 1);
});

test('peersFrom and tagsFrom accept every payload envelope the server uses', () => {
    assert.deepEqual(AB.peersFrom({ data: { peers: [{ id: '1' }, { id: '' }] } }).map((p) => p.id), ['1']);
    assert.deepEqual(AB.peersFrom({ list: [{ id: '2' }], page: 1, total: 1, page_size: 10 })
        .map((p) => p.id), ['2']);
    assert.deepEqual(AB.peersFrom(undefined), []);
    assert.deepEqual(AB.tagsFrom({ tags: ['a', { name: 'b' }, 'a', 'a,b', null] }), ['a', 'b']);
    assert.deepEqual(AB.tagsFrom({ data: { list: ['x'] } }), ['x']);
    assert.deepEqual(AB.tagsFrom(null), []);
});

test('csvEscape quotes exactly the fields RFC 4180 requires', () => {
    assert.equal(AB.csvEscape(''), '');
    assert.equal(AB.csvEscape('plain'), 'plain');
    assert.equal(AB.csvEscape('a,b'), '"a,b"');
    assert.equal(AB.csvEscape('say "hi"'), '"say ""hi"""');
    assert.equal(AB.csvEscape('a\nb'), '"a\nb"');
    assert.equal(AB.csvEscape('a\r\nb'), '"a\r\nb"');
    assert.equal(AB.csvEscape(' pad '), '" pad "');
    assert.equal(AB.csvEscape(null), '');
});

test('the formula guard is reversible for every string, including empty', () => {
    for (const v of ['', 'plain', '=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx',
        "'plain", "'=1+1", "'", "''", 'ünïcode', '=cmd|\'/c calc\'!A1'])
        assert.equal(AB.unguardFormula(AB.guardFormula(v)), v, 'not reversible: ' + JSON.stringify(v));
    assert.equal(AB.guardFormula(''), '');
    assert.equal(AB.guardFormula('=1+1'), "'=1+1");
    assert.equal(AB.guardFormula('plain'), 'plain');
});

test('parseCsv survives quotes, embedded separators, CRLF and a truncated quote', () => {
    assert.deepEqual(AB.parseCsv('').rows, []);
    assert.deepEqual(AB.parseCsv('\r\n\n').rows, []);
    assert.deepEqual(AB.parseCsv('""').rows, [['']], 'a quoted empty field is a real row');
    assert.deepEqual(AB.parseCsv('﻿a,b').rows, [['a', 'b']], 'BOM not stripped');
    assert.deepEqual(AB.parseCsv('a,"b,c",d').rows, [['a', 'b,c', 'd']]);
    assert.deepEqual(AB.parseCsv('"say ""hi"""').rows, [['say "hi"']]);
    assert.deepEqual(AB.parseCsv('a\r\nb\nc').rows, [['a'], ['b'], ['c']]);
    assert.deepEqual(AB.parseCsv('"l1\r\nl2"').rows, [['l1\nl2']], 'CRLF inside quotes must fold');
    assert.deepEqual(AB.parseCsv('a,,b').rows, [['a', '', 'b']]);
    assert.deepEqual(AB.parseCsv('a,b,').rows, [['a', 'b', '']]);
    const cut = AB.parseCsv('a,"unterminated');
    assert.deepEqual(cut.rows, [['a', 'unterminated']]);
    assert.match(cut.problems[0], /unterminated/);
    const stray = AB.parseCsv('a"b');
    assert.deepEqual(stray.rows, [['a"b']]);
    assert.match(stray.problems[0], /quote inside/);
});

test('toCsv writes the pinned header and CRLF records', () => {
    const text = AB.toCsv([peer({ id: '1', alias: 'a' })]);
    assert.equal(text.split('\r\n')[0], AB.COLUMNS.join(','));
    assert.equal(text.slice(-2), '\r\n');
    assert.equal(AB.toCsv([]), AB.COLUMNS.join(',') + '\r\n');
    assert.equal(AB.toCsv(null), AB.COLUMNS.join(',') + '\r\n');
});

test('export -> import round-trips hostile peers byte for byte', () => {
    const peers = [
        peer({ id: 'A-1_b', alias: 'Reception, front', note: 'line1\nline2',
            tags: ['office', 'ground floor'] }),
        peer({ id: '987654321', alias: 'say "hello"', username: 'ünïcode',
            hostname: 'ws-01.example.lan', platform: 'Windows',
            note: ' padded ', tags: ['=formula', 'a b'] }),
        peer({ id: 'plain' })
    ];
    const back = AB.fromCsv(AB.toCsv(peers));
    assert.deepEqual(back.problems, []);
    assert.deepEqual(back.peers, peers.map(AB.normalizePeer));
});

test('fromCsv maps columns by header name, in any order, ignoring extras', () => {
    const text = 'note,id,extra,tags\r\nhello,42,ignored,"a,b"\r\n';
    const out = AB.fromCsv(text);
    assert.deepEqual(out.problems, []);
    assert.equal(out.peers.length, 1);
    assert.equal(out.peers[0].id, '42');
    assert.equal(out.peers[0].note, 'hello');
    assert.deepEqual(out.peers[0].tags, ['a', 'b']);
    assert.equal(out.peers[0].alias, '');
});

test('fromCsv reports bad rows by number and keeps the good ones', () => {
    const text = 'id,alias\r\n,nameless\r\nok-1,fine\r\na b,spaced\r\nok-1,again\r\n';
    const out = AB.fromCsv(text);
    assert.deepEqual(out.peers.map((p) => p.id), ['ok-1']);
    assert.match(out.problems[0], /^row 2: id is required/);
    assert.match(out.problems[1], /^row 4: /);
    assert.ok(out.problems.some((p) => /duplicate id merged: ok-1/.test(p)));
});

test('fromCsv refuses input that is not a peer CSV at all', () => {
    assert.deepEqual(AB.fromCsv('').problems, ['CSV has no header row']);
    assert.deepEqual(AB.fromCsv(null).problems, ['CSV has no header row']);
    assert.match(AB.fromCsv('alias,note\r\nx,y\r\n').problems[0], /no "id" column/);
    assert.deepEqual(AB.fromCsv('{"id":"1"}').peers, []);
    assert.deepEqual(AB.fromCsv('id,alias\r\n').peers, []);
});

test('fromCsv enforces the size and row ceilings before doing any work', () => {
    const big = 'id,alias\r\n' + 'x'.repeat(AB.LIMITS.csvBytes);
    const out = AB.fromCsv(big);
    assert.deepEqual(out.peers, []);
    assert.match(out.problems[0], /larger than 1048576 bytes/);

    const rows = ['id'];
    for (let i = 0; i <= AB.LIMITS.csvRows; i++) rows.push('id' + i);
    const many = AB.fromCsv(rows.join('\r\n'));
    assert.deepEqual(many.peers, []);
    assert.match(many.problems[0], /more than 10000 data rows/);
});

test('an oversized field is rejected at import, not silently truncated', () => {
    const text = 'id,note\r\nok-1,"' + 'x'.repeat(AB.LIMITS.note + 1) + '"\r\n';
    const out = AB.fromCsv(text);
    assert.deepEqual(out.peers, []);
    assert.match(out.problems[0], /^row 2: note is longer than 1024/);
});
