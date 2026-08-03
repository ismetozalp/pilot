// Unit tests for the e2e harness itself (tests/e2e.mjs) and the fake Cockpit
// bridge (tests/e2e/cockpit-stub.js).
//
// The harness is test infrastructure, so a defect in it does not fail loudly —
// it makes a broken UI look tested. Both files therefore get the same hostile
// treatment as shipped code: the request resolver and the screenshot-name
// sanitiser are validators, and the spawn/http fakes are parsers.
//
// Nothing here needs playwright: tests/e2e.mjs imports the browser lazily.
'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const Stub = require('../../tests/e2e/cockpit-stub.js');
let H = null;
let Scenario = null;

before(async () => {
    H = await import(pathToFileURL(path.join(ROOT, 'tests', 'e2e.mjs')).href);
    Scenario = await import(pathToFileURL(path.join(ROOT, 'tests', 'e2e', 'harness.e2e.mjs')).href);
});

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-e2e-'));
}

// --- resolveRequestPath: the one place a static server leaks the filesystem ---

test('the repo root is the served root', () => {
    assert.equal(H.ROOT, ROOT);
});

test('a bare root request serves index.html', () => {
    for (const url of ['/', '', '/?x=1', '/#frag']) {
        const r = H.resolveRequestPath(ROOT, url);
        assert.equal(r.status, 200, JSON.stringify(url));
        assert.equal(r.file, path.join(ROOT, 'index.html'), JSON.stringify(url));
    }
});

test('the Cockpit bridge URL is mapped onto the stub', () => {
    // index.html loads ../base1/cockpit.js, which the browser resolves to
    // /base1/cockpit.js. If this mapping breaks, every scenario silently runs
    // against a page with no bridge at all.
    const r = H.resolveRequestPath(ROOT, '/base1/cockpit.js');
    assert.equal(r.status, 200);
    assert.equal(r.file, path.join(ROOT, 'tests', 'e2e', 'cockpit-stub.js'));
});

test('query strings and fragments are stripped before resolving', () => {
    const r = H.resolveRequestPath(ROOT, '/index.html?v=2#top');
    assert.equal(r.file, path.join(ROOT, 'index.html'));
});

test('no request escapes the served root', () => {
    // Traversal in every form that has ever worked against a hand-rolled static
    // server: plain, encoded, double-encoded, backslashed, mixed, and doubled
    // slashes (which path.posix.normalize deliberately preserves).
    const hostile = [
        '/../../etc/passwd',
        '/..%2f..%2fetc/passwd',
        '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
        '/tests/../../../../etc/shadow',
        '/..\\..\\etc\\passwd',
        '//etc/passwd',
        '/./././../../root/.ssh/id_rsa',
        '/js/../../../../../../etc/hosts',
        '/%2e%2e/%2e%2e/%2e%2e/etc/group'
    ];
    for (const url of hostile) {
        const r = H.resolveRequestPath(ROOT, url);
        if (r.status !== 200) continue;          // rejected outright is fine too
        assert.ok(r.file === ROOT || r.file.startsWith(ROOT + path.sep),
            `escaped the root: ${url} -> ${r.file}`);
    }
});

test('undecodable, null-byte and oversized URLs are refused with 400', () => {
    const bad = ['/%zz', '/%', '/a%2', '/x%00.html', '/x .html',
        '/' + 'a'.repeat(5000)];
    for (const url of bad) {
        assert.equal(H.resolveRequestPath(ROOT, url).status, 400, JSON.stringify(url));
    }
});

test('a non-string URL is refused rather than crashing the server', () => {
    for (const url of [null, undefined, 42, {}, [], true]) {
        assert.equal(H.resolveRequestPath(ROOT, url).status, 400, JSON.stringify(url));
    }
});

test('unicode paths resolve inside the root', () => {
    const r = H.resolveRequestPath(ROOT, '/css/thème-été.css');
    assert.equal(r.status, 200);
    assert.ok(r.file.startsWith(ROOT + path.sep));
});

// --- contentType ---------------------------------------------------------

test('content types cover everything the plugin serves', () => {
    assert.match(H.contentType('/a/index.html'), /^text\/html/);
    assert.match(H.contentType('/a/app.js'), /^text\/javascript/);
    assert.match(H.contentType('/a/x.mjs'), /^text\/javascript/);
    assert.match(H.contentType('/a/x.css'), /^text\/css/);
    assert.match(H.contentType('/a/x.json'), /^application\/json/);
    assert.equal(H.contentType('/a/x.png'), 'image/png');
    assert.match(H.contentType('/a/INDEX.HTML'), /^text\/html/);
    assert.equal(H.contentType('/a/LICENSE'), 'application/octet-stream');
    assert.equal(H.contentType(''), 'application/octet-stream');
});

// --- cspHeader -----------------------------------------------------------

test('a missing or broken manifest yields no CSP header rather than throwing', () => {
    const d = tmpdir();
    assert.equal(H.cspHeader(d), null);
    fs.writeFileSync(path.join(d, 'manifest.json'), '{not json');
    assert.equal(H.cspHeader(d), null);
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ name: 'pilot' }));
    assert.equal(H.cspHeader(d), null);
    fs.writeFileSync(path.join(d, 'manifest.json'),
        JSON.stringify({ 'content-security-policy': 42 }));
    assert.equal(H.cspHeader(d), null);
});

test('a manifest CSP is served verbatim, so the page runs under the shipped policy', () => {
    const d = tmpdir();
    const policy = "default-src 'self'; connect-src 'self'";
    fs.writeFileSync(path.join(d, 'manifest.json'),
        JSON.stringify({ 'content-security-policy': policy }));
    assert.equal(H.cspHeader(d), policy);
});

// --- shotPath: a screenshot name is attacker-shaped input too --------------

test('a screenshot always lands in tests/ with a safe basename', () => {
    const names = ['setup', '../../etc/passwd', '/abs/path', 'a b/c', 'thème',
        'x y', 'ab', '..', '.', '', '   ', null, undefined, 42, {},
        'name.with.dots', 'a'.repeat(300)];
    for (const n of names) {
        const p = H.shotPath(n);
        assert.equal(path.dirname(p), path.join(ROOT, 'tests'), JSON.stringify(n));
        assert.match(path.basename(p), /^e2e-[A-Za-z0-9_-]+\.png$/, JSON.stringify(n));
        assert.ok(!path.basename(p).includes('..'), JSON.stringify(n));
    }
    assert.equal(H.shotPath('setup'), path.join(ROOT, 'tests', 'e2e-setup.png'));
    assert.equal(H.shotPath(''), path.join(ROOT, 'tests', 'e2e-shot.png'));
});

// --- mergeStub -----------------------------------------------------------

test('mergeStub fills in the defaults and always provides the log arrays', () => {
    const m = H.mergeStub(undefined);
    assert.deepEqual(m.calls, []);
    assert.deepEqual(m.errors, []);
    assert.equal(m.httpAddressCap, true);
    assert.equal(typeof m.spawn, 'object');
    assert.equal(typeof m.files, 'object');
    assert.equal(typeof m.http, 'object');
    assert.equal(typeof m.dbus, 'object');
});

test('mergeStub never mutates DEFAULT_STUB', () => {
    const before = JSON.stringify(H.DEFAULT_STUB);
    H.mergeStub({ spawn: { 'x y': 'z' }, files: { '/tmp/a': 'b' } });
    assert.equal(JSON.stringify(H.DEFAULT_STUB), before);
});

test('a scenario override wins over the default of the same key', () => {
    const key = Object.keys(H.DEFAULT_STUB.files)[0];
    const m = H.mergeStub({ files: { [key]: 'overridden' } });
    assert.equal(m.files[key], 'overridden');
});

test('mergeStub survives hostile input instead of throwing', () => {
    for (const s of [null, 'nope', 42, [], true]) {
        const m = H.mergeStub(s);
        assert.equal(m.httpAddressCap, true, JSON.stringify(s));
        assert.deepEqual(m.calls, []);
    }
    const m = H.mergeStub({ spawn: null, files: 'x', http: 7, dbus: [], httpAddressCap: false });
    assert.deepEqual(m.spawn, H.DEFAULT_STUB.spawn);
    assert.equal(m.httpAddressCap, false);
});

test('the merged stub survives the JSON round-trip addInitScript performs', () => {
    // The config is serialised into the page. Anything that does not survive
    // JSON is silently dropped there and impossible to debug from a scenario.
    const m = H.mergeStub({ spawn: { 'pilot-exec --run': { lines: [{ t: 'run-end' }] } } });
    assert.deepEqual(JSON.parse(JSON.stringify(m)), m);
});

// --- scenario discovery ---------------------------------------------------

test('scenario discovery takes *.e2e.mjs files only, sorted, absolute', () => {
    const d = tmpdir();
    fs.writeFileSync(path.join(d, 'b.e2e.mjs'), '');
    fs.writeFileSync(path.join(d, 'a.e2e.mjs'), '');
    fs.writeFileSync(path.join(d, 'cockpit-stub.js'), '');
    fs.writeFileSync(path.join(d, 'notes.mjs'), '');
    fs.writeFileSync(path.join(d, 'x.e2e.mjs.txt'), '');
    fs.mkdirSync(path.join(d, 'nested.e2e.mjs'));
    assert.deepEqual(H.scenarioFiles(d),
        [path.join(d, 'a.e2e.mjs'), path.join(d, 'b.e2e.mjs')]);
});

test('scenario discovery on a missing directory returns nothing', () => {
    assert.deepEqual(H.scenarioFiles(path.join(tmpdir(), 'nope')), []);
    assert.deepEqual(H.scenarioFiles(tmpdir()), []);
});

test('the harness scenario is discovered and honours the scenario contract', () => {
    // Superset, never an exact list: later tasks add their own scenarios (C11).
    const found = H.scenarioFiles(path.join(ROOT, 'tests', 'e2e'));
    assert.ok(found.includes(path.join(ROOT, 'tests', 'e2e', 'harness.e2e.mjs')),
        `harness.e2e.mjs not discovered: ${found.join(', ')}`);
    assert.equal(Scenario.name, 'harness');
    assert.equal(typeof Scenario.default, 'function');
    assert.equal(Scenario.default.length, 1, 'a scenario takes exactly one ctx argument');
});

// --- assertions and the result ledger -------------------------------------

test('assertEqual and assertOk report the values they rejected', () => {
    H.assertEqual(1, 1);
    H.assertOk('yes');
    assert.throws(() => H.assertEqual(1, 2, 'nope'), /nope.*1.*2/s);
    assert.throws(() => H.assertOk(false, 'missing'), /missing/);
    assert.throws(() => H.assertOk(null), /assertion failed/);
    assert.throws(() => H.assertEqual(NaN, NaN), /not equal/);
    H.assertEqual('a', 'a');
});

test('assertMatch tests the string it names', () => {
    H.assertMatch('pilot-exec --run', /--run/);
    assert.throws(() => H.assertMatch('nothing', /--run/, 'no flag'), /no flag/);
    assert.throws(() => H.assertMatch(null, /x/), /null/);
});

test('check records both outcomes and never throws out of a scenario', async () => {
    H.resetResults();
    await H.check('passes', () => {});
    await H.check('fails', () => { throw new Error('boom'); });
    await H.check('async fails', async () => { throw new Error('later'); });
    const r = H.results();
    assert.equal(r.length, 3);
    assert.deepEqual(r.map((x) => x.ok), [true, false, false]);
    assert.equal(H.failed().length, 2);
    assert.equal(H.report('unit-test'), 2);
    H.resetResults();
    assert.deepEqual(H.results(), []);
});

test('open() without serve() explains itself instead of failing on a bad URL', async () => {
    await assert.rejects(() => H.open({}, {}), /serve\(\)/);
});

// --- the static server, end to end ---------------------------------------

test('the server serves the plugin, the stub, and refuses everything else', async (t) => {
    const s = await H.serve(ROOT);
    t.after(() => s.close());
    assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const index = await fetch(`${s.url}/index.html`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /^text\/html/);
    const csp = H.cspHeader(ROOT);
    if (csp !== null) {
        assert.equal(index.headers.get('content-security-policy'), csp,
            'index.html is not served under the shipped CSP');
    }

    const bridge = await fetch(`${s.url}/base1/cockpit.js`);
    assert.equal(bridge.status, 200);
    assert.match(await bridge.text(), /PilotCockpitStub/);

    assert.equal((await fetch(`${s.url}/no-such-file.txt`)).status, 404);
    assert.equal((await fetch(`${s.url}/tests`)).status, 404, 'a directory was served');
    assert.equal((await fetch(`${s.url}/%zz`)).status, 400);
});

// --- the fake bridge: install --------------------------------------------

function bridge(cfg) {
    const win = {};
    const cockpit = Stub.install(win, cfg || {});
    return { win, cockpit, cfg: win.__pilotStub };
}

test('install works with no DOM and returns the object it installed', () => {
    const b = bridge();
    assert.equal(b.win.cockpit, b.cockpit);
    for (const m of ['spawn', 'file', 'http', 'dbus', 'gettext', 'format']) {
        assert.equal(typeof b.cockpit[m], 'function', m);
    }
    assert.deepEqual(b.cfg.calls, []);
    assert.equal(b.cfg.httpAddressCap, true);
});

// --- matchKey ------------------------------------------------------------

test('an exact key beats a substring, and the longest substring wins', () => {
    const map = { 'pilot-exec': 'short', 'pilot-exec --run': 'long', 'x': 'x' };
    assert.equal(Stub.matchKey(map, 'pilot-exec --run'), 'long');
    assert.equal(Stub.matchKey(map, 'sudo pilot-exec --run --v'), 'long');
    assert.equal(Stub.matchKey(map, 'pilot-exec --detect'), 'short');
});

test('matchKey refuses to invent a match', () => {
    assert.equal(Stub.matchKey({}, 'anything'), undefined);
    assert.equal(Stub.matchKey({ a: 1 }, ''), undefined);
    assert.equal(Stub.matchKey({ '': 1 }, 'abc'), undefined, 'an empty key matches everything');
    assert.equal(Stub.matchKey(null, 'abc'), undefined);
    assert.equal(Stub.matchKey({ 'longer than the line': 1 }, 'short'), undefined);
    assert.equal(Stub.matchKey({ 'échec': 'u' }, 'test échec ici'), 'u');
    assert.equal(Stub.matchKey({ 'a\nb': 'nl' }, 'x a\nb y'), 'nl');
    assert.equal(Stub.matchKey({ x: 1 }, null), undefined);
    assert.equal(Stub.matchKey({ toString: 'inherited?' }, 'toString'), 'inherited?');
    assert.equal(Stub.matchKey({ a: 1 }, 'constructor'), undefined,
        'an inherited property was treated as a scripted response');
});

// --- jsonLines / chunksOf ------------------------------------------------

test('jsonLines emits one newline-terminated JSON document per entry', () => {
    const out = Stub.jsonLines([{ t: 'run-start' }, 'raw line', 'already\n', 42]);
    assert.deepEqual(out, ['{"t":"run-start"}\n', 'raw line\n', 'already\n', '42\n']);
    assert.deepEqual(Stub.jsonLines([]), []);
    assert.deepEqual(Stub.jsonLines(null), []);
});

test('chunksOf splits a stream the way a real bridge does', () => {
    assert.deepEqual(Stub.chunksOf('a\nb\n', 'line'), ['a\n', 'b\n']);
    assert.deepEqual(Stub.chunksOf('a\nb', 'line'), ['a\n', 'b']);
    assert.deepEqual(Stub.chunksOf('a\nb\n', 'blob'), ['a\nb\n']);
    assert.deepEqual(Stub.chunksOf('ab\n', 'split'), ['a', 'b\n']);
    assert.deepEqual(Stub.chunksOf('', 'line'), []);
    assert.deepEqual(Stub.chunksOf(null, 'line'), []);
    assert.deepEqual(Stub.chunksOf('x', 'split'), ['x']);
    // Whatever the mode, no byte is invented or lost.
    for (const mode of ['line', 'split', 'blob']) {
        assert.equal(Stub.chunksOf('one\ntwo\nthr', mode).join(''), 'one\ntwo\nthr', mode);
    }
});

// --- spawn ---------------------------------------------------------------

test('a scripted spawn resolves its text and logs a copy of the argv', async () => {
    const b = bridge({ spawn: { 'echo hi': 'hi\n' } });
    const argv = ['echo', 'hi'];
    const out = await b.cockpit.spawn(argv, { superuser: 'require' });
    assert.equal(out, 'hi\n');
    argv.push('mutated');
    assert.deepEqual(b.cfg.calls[0].argv, ['echo', 'hi'], 'the log aliased the caller array');
    assert.deepEqual(b.cfg.calls[0].opts, { superuser: 'require' });
    assert.equal(b.cfg.calls[0].kind, 'spawn');
});

test('an unstubbed spawn rejects instead of resolving empty', async () => {
    // A UI that renders "nothing configured" because a call was never scripted
    // makes a broken screen look healthy. This is the single most valuable
    // behaviour in the whole stub.
    const b = bridge();
    await assert.rejects(() => b.cockpit.spawn(['pilot-exec', '--run']),
        (e) => /no stub for: pilot-exec --run/.test(e.message) &&
            e.problem === 'no-stub' && e.exit_status === 1);
});

test('a scripted failure carries message, exit status and problem', async () => {
    const b = bridge({ spawn: { 'pilot-exec': { error: true, message: 'boom',
        exit_status: 3, problem: 'access-denied' } } });
    await assert.rejects(() => b.cockpit.spawn(['pilot-exec', '--run']),
        (e) => e.message === 'boom' && e.exit_status === 3 && e.problem === 'access-denied');
});

test('streamed JSON lines arrive in fragments and reassemble exactly', async () => {
    const lines = [
        { t: 'run-start', run_id: '20260803T204500Z', transport: 'local', steps: 1 },
        { t: 'step-start', id: 'fetch-api', title: 'Fetch', cmd: 'curl -fsSL' },
        { t: 'step-end', id: 'fetch-api', status: 'ok', exit: 0, ms: 12 },
        { t: 'run-end', status: 'ok', kind: null }
    ];
    const b = bridge({ spawn: { 'pilot-exec --run': { lines, chunk: 'split' } } });
    const seen = [];
    const p = b.cockpit.spawn(['pilot-exec', '--run']);
    const settled = await p.stream((c) => seen.push(c));
    assert.equal(seen.length, 8, 'every line should arrive in two fragments');
    assert.equal(settled, '', 'cockpit resolves empty once a stream handler is attached');
    const parsed = seen.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(parsed.map((o) => o.t),
        ['run-start', 'step-start', 'step-end', 'run-end']);
    assert.deepEqual(parsed, lines);
});

test('without a stream handler the whole transcript resolves at once', async () => {
    const b = bridge({ spawn: { 'pilot-exec --run': { lines: [{ t: 'run-end', status: 'ok' }] } } });
    assert.equal(await b.cockpit.spawn(['pilot-exec', '--run']), '{"t":"run-end","status":"ok"}\n');
});

test('a truncated trailing document is delivered verbatim', async () => {
    // A consumer that assumes every chunk ends on a line boundary must fail
    // here, not in production against a killed helper.
    const b = bridge({ spawn: { 'pilot-exec --run': {
        lines: [{ t: 'run-start', steps: 2 }], trailer: '{"t":"step-en' } } });
    const text = await b.cockpit.spawn(['pilot-exec', '--run']);
    assert.equal(text, '{"t":"run-start","steps":2}\n{"t":"step-en');
    assert.throws(() => JSON.parse(text.split('\n')[1]));
});

test('a non-zero exit rejects after the output has been streamed', async () => {
    const b = bridge({ spawn: { 'pilot-exec --run': {
        lines: [{ t: 'run-end', status: 'failed', kind: 'CHECKSUM_MISMATCH' }],
        exit_status: 1 } } });
    const seen = [];
    const p = b.cockpit.spawn(['pilot-exec', '--run']).stream((c) => seen.push(c));
    await assert.rejects(() => p, (e) => e.exit_status === 1);
    assert.match(seen.join(''), /CHECKSUM_MISMATCH/);
});

test('closing a running process rejects it', async () => {
    const b = bridge({ spawn: { 'pilot-exec --run': { lines: [{ t: 'run-start' }] } } });
    const p = b.cockpit.spawn(['pilot-exec', '--run']);
    p.close('cancelled');
    await assert.rejects(() => p, /cancelled/);
});

test('input written to a process is recorded, so envelopes can be asserted', async () => {
    const b = bridge({ spawn: { 'pilot-exec --run': 'ok\n' } });
    const p = b.cockpit.spawn(['pilot-exec', '--run']);
    p.input(JSON.stringify({ version: 1, transport: 'local' }));
    await p;
    assert.equal(b.cfg.calls[0].input, '{"version":1,"transport":"local"}');
});

test('a non-array argv is coerced rather than crashing', async () => {
    const b = bridge({ spawn: { 'whoami': 'root\n' } });
    assert.equal(await b.cockpit.spawn('whoami'), 'root\n');
    assert.deepEqual(b.cfg.calls[0].argv, ['whoami']);
});

// --- file ----------------------------------------------------------------

test('file read, replace and modify round-trip through the log', async () => {
    const b = bridge({ files: { '/etc/pilot/config.json': '{"a":1}' } });
    const f = b.cockpit.file('/etc/pilot/config.json');
    assert.equal(await f.read(), '{"a":1}');
    await f.replace('{"a":2}');
    assert.equal(await f.read(), '{"a":2}');
    await f.modify((cur) => cur.replace('2', '3'));
    assert.equal(await f.read(), '{"a":3}');
    f.close();
    const kinds = b.cfg.calls.map((c) => c.kind);
    assert.deepEqual(kinds, ['read', 'replace', 'read', 'read', 'replace', 'read']);
    assert.equal(b.cfg.calls[1].content, '{"a":2}');
});

test('a missing file reads as null and replace(null) deletes it', async () => {
    const b = bridge();
    const f = b.cockpit.file('/etc/pilot/servers/prod.json');
    assert.equal(await f.read(), null);
    await f.replace('{"id":"prod"}');
    assert.equal(await f.read(), '{"id":"prod"}');
    await f.replace(null);
    assert.equal(await f.read(), null);
    assert.equal(b.cfg.calls.filter((c) => c.kind === 'replace')[1].content, null);
});

test('a scripted file error rejects both reads and writes', async () => {
    const b = bridge({ files: { '/etc/pilot/config.json': {
        error: true, message: 'access-denied', problem: 'access-denied' } } });
    const f = b.cockpit.file('/etc/pilot/config.json');
    await assert.rejects(() => f.read(), (e) => e.problem === 'access-denied');
    await assert.rejects(() => f.replace('x'), (e) => e.problem === 'access-denied');
});

test('hostile paths are treated as opaque keys, never as prototype access', async () => {
    const b = bridge({ files: { '/etc/pilot/a\nb': 'newline', 'é/é': 'unicode' } });
    assert.equal(await b.cockpit.file('__proto__').read(), null);
    assert.equal(await b.cockpit.file('constructor').read(), null);
    assert.equal(await b.cockpit.file('/etc/pilot/a\nb').read(), 'newline');
    assert.equal(await b.cockpit.file('é/é').read(), 'unicode');
    assert.equal(await b.cockpit.file('../../etc/shadow').read(), null);
    assert.equal(await b.cockpit.file(null).read(), null);
});

// --- http ----------------------------------------------------------------

test('a scripted response resolves as a body string with its status', async () => {
    const b = bridge({ http: { 'GET /api/peers': {
        status: 200, body: { code: 0, message: '', data: { list: [], total: 0 } } } } });
    const seen = [];
    const req = b.cockpit.http({ address: '127.0.0.1', port: 21114 })
        .request({ method: 'GET', path: '/api/peers' })
        .response((status, headers) => seen.push([status, headers]));
    const body = await req;
    assert.equal(JSON.parse(body).code, 0);
    assert.equal(seen[0][0], 200);
    const call = b.cfg.calls[0];
    assert.equal(call.kind, 'http');
    assert.equal(call.method, 'GET');
    assert.equal(call.path, '/api/peers');
    assert.equal(call.address, '127.0.0.1');
});

test('get and post record the method they used', async () => {
    const b = bridge({ http: { 'GET /api/ab': 'ok', 'POST /api/login': { body: { code: 0 } } } });
    await b.cockpit.http({}).get('/api/ab');
    await b.cockpit.http({}).post('/api/login', JSON.stringify({ username: 'admin' }));
    assert.deepEqual(b.cfg.calls.map((c) => c.method + ' ' + c.path),
        ['GET /api/ab', 'POST /api/login']);
    assert.equal(b.cfg.calls[1].body, '{"username":"admin"}');
});

test('an HTTP failure status rejects with status, reason and body', async () => {
    const b = bridge({ http: { 'GET /api/users': {
        status: 401, reason: 'Unauthorized', body: 'no token' } } });
    await assert.rejects(() => b.cockpit.http({}).get('/api/users'),
        (e) => e.status === 401 && e.reason === 'Unauthorized' && e.message === 'no token');
});

test('an unstubbed request rejects rather than answering an empty list', async () => {
    const b = bridge();
    await assert.rejects(() => b.cockpit.http({}).get('/api/audit'),
        (e) => /no http stub for: GET \/api\/audit/.test(e.message) && e.problem === 'no-stub');
});

test('a bridge without the address capability fails every proxied request', async () => {
    // Spec 2.8: the http-stream2 channel asks for an `address` capability, and a
    // bridge that lacks it must degrade visibly (BRIDGE_NO_ADDRESS_CAP), not
    // hang. Requests to localhost still work.
    const b = bridge({ httpAddressCap: false, http: { 'GET /api/peers': { body: { code: 0 } } } });
    await assert.rejects(
        () => b.cockpit.http({ address: '10.0.0.5', port: 21114 }).get('/api/peers'),
        (e) => e.problem === 'not-supported');
    assert.equal(JSON.parse(await b.cockpit.http({}).get('/api/peers')).code, 0);
});

// --- dbus ----------------------------------------------------------------

test('dbus answers scripted replies and rejects unscripted ones', async () => {
    const b = bridge({ dbus: {
        'org.freedesktop.systemd1:GetAll': [{ ActiveState: { v: 'active' } }],
        'org.freedesktop.systemd1:StartUnit': { error: 'org.freedesktop.DBus.Error.AccessDenied' } } });
    const d = b.cockpit.dbus('org.freedesktop.systemd1');
    const r = await d.call('/unit', 'org.freedesktop.DBus.Properties', 'GetAll', ['x']);
    assert.equal(r[0].ActiveState.v, 'active');
    await assert.rejects(() => d.call('/', 'i', 'StartUnit', []), /AccessDenied/);
    await assert.rejects(() => d.call('/', 'i', 'Nope', []), /no dbus stub/);
    assert.equal(b.cfg.calls[0].service, 'org.freedesktop.systemd1');
    assert.deepEqual(b.cfg.calls[0].args, ['x']);
    await d.wait();
    d.close();
});

// --- format --------------------------------------------------------------

test('format substitutes positionally and by name, and leaves the rest alone', () => {
    assert.equal(Stub.format('port $0 on $1', 21114, 'host'), 'port 21114 on host');
    assert.equal(Stub.format('${0} steps', 3), '3 steps');
    assert.equal(Stub.format('$host:$port', { host: 'h', port: 1 }), 'h:1');
    assert.equal(Stub.format('$$'), '$$');
    assert.equal(Stub.format('$9'), '');
    assert.equal(Stub.format('$missing', { other: 1 }), '$missing');
    assert.equal(Stub.format(null), '');
    assert.equal(Stub.format('plain'), 'plain');
});
