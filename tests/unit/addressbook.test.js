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
    assert.deepEqual(out.merged, [{ id: '1', exact: false }]);
    assert.equal(out.peers.length, 2);
    assert.equal(out.peers[0].alias, 'first');
    assert.equal(out.peers[0].hostname, 'h1');
    assert.deepEqual(out.peers[0].tags, ['a', 'b']);
    assert.deepEqual(AB.dedupePeers(null), { peers: [], merged: [], conflicts: [] });
});

test('dedupePeers names exactly which conflicting field values were discarded', () => {
    // Without book scoping, two records that happen to share an id fuse into one
    // regardless of whether they came from the same address book or two unrelated
    // ones. `conflicts` is the finer-grained record of which non-empty field
    // values disagreed and were discarded; `merged` (checked in the next test)
    // is what tells a caller a fusion happened at all, even when nothing here
    // technically "conflicted".
    const out = AB.dedupePeers([
        { id: '1', alias: 'front desk', hostname: 'ws-01', tags: ['siteA'] },
        { id: '1', alias: 'back office', hostname: 'ws-02', tags: ['siteB'] }
    ]);
    assert.deepEqual(out.merged, [{ id: '1', exact: false }]);
    assert.deepEqual(out.conflicts, [
        { id: '1', field: 'alias', kept: 'front desk', discarded: 'back office' },
        { id: '1', field: 'hostname', kept: 'ws-01', discarded: 'ws-02' }
    ]);
    assert.equal(out.peers.length, 1);
    assert.equal(out.peers[0].alias, 'front desk');
    assert.deepEqual(out.peers[0].tags, ['siteA', 'siteB'], 'tags still union, not a conflict');

    // filling an EMPTY field from a duplicate is not a CONFLICT -- only two
    // non-empty, differing values are -- but it still counts as fusion in `merged`
    // (the duplicate contributed real information the kept record didn't have).
    const filled = AB.dedupePeers([{ id: '2' }, { id: '2', alias: 'only one has a name' }]);
    assert.deepEqual(filled.conflicts, []);
    assert.deepEqual(filled.merged, [{ id: '2', exact: false }]);
    assert.equal(filled.peers[0].alias, 'only one has a name');
});

test('dedupePeers.merged is meaningful on its own: a caller need not consult conflicts', () => {
    // The reviewer's exact reproduction: two records whose ONLY difference is
    // their tags. No text field disagrees, so `conflicts` is empty -- but two
    // genuinely different tag sets were still fused into one peer, and a caller
    // who reads "conflicts: []" as "nothing was fused" would be wrong. `merged`
    // must say so on its own.
    const fused = AB.dedupePeers([{ id: '99', tags: ['siteA'] }, { id: '99', tags: ['siteB'] }]);
    assert.equal(fused.peers.length, 1);
    assert.deepEqual(fused.peers[0].tags, ['siteA', 'siteB']);
    assert.deepEqual(fused.conflicts, [], 'no non-empty field disagreed');
    assert.deepEqual(fused.merged, [{ id: '99', exact: false }],
        'merged must flag real fusion even with zero conflicts');

    // Contrast: literally the same record stated twice (e.g. the same CSV row
    // appearing twice) contributes nothing new, so it is exact -- a caller can
    // tell the two cases apart using merged alone.
    const restated = AB.dedupePeers([
        { id: '5', alias: 'x', tags: ['a'] },
        { id: '5', alias: 'x', tags: ['a'] }
    ]);
    assert.deepEqual(restated.merged, [{ id: '5', exact: true }]);
    assert.equal(restated.merged.some((m) => !m.exact), false);
    assert.equal(fused.merged.some((m) => !m.exact), true);
});

test('dedupePeers refuses to merge across books when book info is supplied', () => {
    // A caller that accidentally combines peer lists from two different address
    // books must not have two unrelated machines silently fused just because they
    // share an id. Passing { byBook: true } plus a `book` key on each raw item
    // makes that refusal automatic instead of a "partition your list first"
    // convention nothing enforces.
    const crossBook = AB.dedupePeers([
        { id: '99', book: 'A', alias: 'machine A' },
        { id: '99', book: 'B', alias: 'machine B' }
    ], { byBook: true });
    assert.equal(crossBook.peers.length, 2, 'different books must stay separate records');
    assert.deepEqual(crossBook.merged, []);
    assert.deepEqual(crossBook.conflicts, []);
    assert.deepEqual(crossBook.peers.map((p) => p.alias).sort(), ['machine A', 'machine B']);

    // Same id, same book: still merges exactly like the unscoped case.
    const sameBook = AB.dedupePeers([
        { id: '99', book: 'A', alias: 'first' },
        { id: '99', book: 'A', hostname: 'h1' }
    ], { byBook: true });
    assert.equal(sameBook.peers.length, 1);
    assert.equal(sameBook.peers[0].alias, 'first');
    assert.equal(sameBook.peers[0].hostname, 'h1');
    assert.deepEqual(sameBook.merged, [{ id: '99', exact: false }]);

    // The realistic hazard in one call: a combined, mixed-book list where one
    // id repeats within a book (must merge) and the same id also appears in a
    // different book (must not merge into the first).
    const mixed = AB.dedupePeers([
        { id: '1', book: 'A', alias: 'a1' },
        { id: '1', book: 'A', hostname: 'hA' },
        { id: '1', book: 'B', alias: 'b1' }
    ], { byBook: true });
    assert.equal(mixed.peers.length, 2, 'book A fuses to one, book B stays its own');
    const byAlias = mixed.peers.slice().sort((a, b) => a.alias < b.alias ? -1 : 1);
    assert.equal(byAlias[0].alias, 'a1');
    assert.equal(byAlias[0].hostname, 'hA');
    assert.equal(byAlias[1].alias, 'b1');
    assert.deepEqual(mixed.merged, [{ id: '1', exact: false }]);
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

test('booksFrom reports the books it was GIVEN, and never invents one', () => {
    // CORRECTED. It used to prepend a synthetic personal book with guid '' when
    // the payload named none -- and '' is not a guid this server accepts:
    // /api/ab/peers?ab= answers 400 and /api/ab/tags/ answers 404, which is
    // exactly what the Address Book tab showed. An entry that cannot be used is
    // worse than none, because §7.3's empty state at least says what to do.
    // The real personal guid ("1-1-0" here) comes from /api/ab/personal, which
    // PilotApi.addressbook.books() now folds in.
    const only = AB.booksFrom(null);
    assert.deepEqual(only, [], 'nothing given, nothing invented');
    const real = AB.booksFrom({ profiles: [{ guid: '1-1-0', name: 'admin', personal: true }] });
    assert.equal(real.length, 1);
    assert.equal(real[0].personal, true);
    assert.equal(real[0].guid, '1-1-0', 'the guid the server actually issued');
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

test('the formula guard looks past a leading zero-width/invisible character', () => {
    const hidden = '\u200B=1+1';
    assert.equal(AB.guardFormula(hidden), "'" + hidden, 'a trigger hidden behind U+200B must still be guarded');
    assert.equal(AB.unguardFormula(AB.guardFormula(hidden)), hidden);

    const benign = '\u200Bhello';
    assert.equal(AB.guardFormula(benign), benign, 'invisible char + plain text is not a formula');

    for (const v of [hidden, benign, '\uFEFF+1', '\u2060@x', '\u200C\u200D-9'])
        assert.equal(AB.unguardFormula(AB.guardFormula(v)), v, 'not reversible: ' + JSON.stringify(v));
});

test('parseCsv survives quotes, embedded separators, CRLF and a truncated quote', () => {
    assert.deepEqual(AB.parseCsv('').rows, []);
    assert.deepEqual(AB.parseCsv('\r\n\n').rows, []);
    assert.deepEqual(AB.parseCsv('""').rows, [['']], 'a quoted empty field is a real row');
    assert.deepEqual(AB.parseCsv('\uFEFFa,b').rows, [['a', 'b']], 'BOM not stripped');
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

test('fromCsv names a duplicate column header instead of silently dropping the data', () => {
    const dupId = AB.fromCsv('id,id,note\r\nKEEP,DISCARDED,hello\r\n');
    assert.equal(dupId.peers.length, 1);
    assert.equal(dupId.peers[0].id, 'KEEP', 'first occurrence still wins');
    assert.equal(dupId.peers[0].note, 'hello');
    assert.match(dupId.problems[0], /duplicate column header: id/);

    const dupAlias = AB.fromCsv('id,alias,alias\r\nok-1,KEEP,DISCARDED\r\n');
    assert.equal(dupAlias.peers[0].alias, 'KEEP');
    assert.match(dupAlias.problems[0], /duplicate column header: alias/);

    const triple = AB.fromCsv('id,id,id\r\nKEEP,SECOND,THIRD\r\n');
    assert.equal(triple.peers[0].id, 'KEEP');
    assert.match(triple.problems[0], /duplicate column header: id \(columns 1, 2, 3\)/);
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

test('peers/books/tags unwrap the {data:[...]} envelope v2.7 actually sends', () => {
    // Measured against a real server:
    //   /api/ab/peers            -> {data:[...], licensed_devices, total}
    //   /api/ab/shared/profiles  -> {data:[...]|null, total}
    //   /api/ab/tags/{guid}      -> a bare array
    // listFrom() already descends through .data at every level, so these shapes
    // work without a key for them -- pinned here because nothing else in the
    // suite used the shape the server actually sends.
    assert.deepEqual(AB.peersFrom({ data: [{ id: 'p1' }, { id: 'p2' }], total: 2 }).map((p) => p.id),
        ['p1', 'p2']);
    assert.deepEqual(AB.booksFrom({ data: [{ guid: 'g1', name: 'Support' }], total: 1 })
        .map((b) => b.guid), ['g1']);
    assert.deepEqual(AB.tagsFrom({ data: ['office', 'lab'] }), ['office', 'lab']);
    // The older shapes must keep working.
    assert.deepEqual(AB.peersFrom({ peers: [{ id: 'p9' }] }).map((p) => p.id), ['p9']);
    assert.deepEqual(AB.tagsFrom(['bare', 'array']), ['bare', 'array']);
    // And an empty or null payload is an empty list, never a throw.
    for (const empty of [{ data: null, total: 0 }, {}, null, undefined])
        assert.deepEqual(AB.peersFrom(empty), []);
});
