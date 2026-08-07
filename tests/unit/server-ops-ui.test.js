// tests/unit/server-ops-ui.test.js — the pure half of Server Ops (day-2
// operations), plus the cockpit-facing half driven with a hand-built fake
// `cockpit` global. No real DOM, no real bridge.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../../js/core/errors.js');
require('../../js/core/console-view.js');
require('../../js/features/setup-ui.js');
// Real, not reimplemented: fakeServers() below delegates decodeSshCredential
// to the actual js/core/servers.js so this test file cannot silently drift
// from what a real Servers object does (GAP C, task 33).
const RealServers = require('../../js/core/servers.js');
const S = require('../../js/features/server-ops-ui.js');

const ROOT = path.resolve(__dirname, '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'js/features/server-ops-ui.js'), 'utf8');

const LOCAL = { id: 'local', host: '127.0.0.1', sshPort: 22, apiPort: 21114, domain: null,
    transport: 'local', hasCredential: true };
const REMOTE_NO_CRED = { id: 'edge1', host: 'edge1.example.com', sshPort: 22, apiPort: 21114,
    domain: null, transport: 'ssh', hasCredential: false };
const REMOTE_WITH_CRED = Object.assign({}, REMOTE_NO_CRED, { hasCredential: true });

// ------------------------------------------------------------ module shape

test('module loads with no DOM and no cockpit global', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof S.blankState, 'function');
    assert.equal(globalThis.PilotServerOpsUi, S);
});

// ------------------------------------------------------------ Task 32 wiring
//
// server-ops-empty (template lines ~717-722) was inline copy standing in for
// PilotEmptyState.forKind('server') before js/core/emptystate.js existed
// (Task 30's report flagged this explicitly). Now that it exists, this proves
// the call site actually sources its copy from the shared module rather than
// two independent hardcoded strings silently drifting apart over time.

test('serverEmptyState() matches PilotEmptyState.forKind(\'server\') exactly', () => {
    const ES = require('../../js/core/emptystate.js');
    assert.deepEqual(S.serverEmptyState(), ES.forKind('server'));
    assert.deepEqual(S.serverEmptyState(),
        { message: 'No RustDesk server configured yet.', ctaLabel: 'Run setup', tab: 'setup' });
});

test('serverEmptyState() falls back to the identical copy if PilotEmptyState is unavailable', () => {
    // Simulates the module not being loaded (an older build, or a stripped-down
    // test harness) — the fallback must read exactly the same as the real thing,
    // so no visible copy ever depends on which path was taken.
    const saved = globalThis.PilotEmptyState;
    delete globalThis.PilotEmptyState;
    try {
        assert.deepEqual(S.serverEmptyState(),
            { message: 'No RustDesk server configured yet.', ctaLabel: 'Run setup', tab: 'setup' });
    } finally {
        globalThis.PilotEmptyState = saved;
    }
});

test('the server-ops-empty template sources its text from emptyState(), not a literal', () => {
    assert.match(SOURCE, /data-testid="server-ops-empty"/);
    const block = SOURCE.split('data-testid="server-ops-empty"')[1].split('</div>')[0];
    assert.match(block, /x-text="emptyState\(\)\.message"/);
    assert.match(block, /x-text="emptyState\(\)\.ctaLabel"/);
    assert.ok(!block.includes('No RustDesk server configured yet.'),
        'the message must come from emptyState(), not a hardcoded literal in the template');
    assert.ok(!/>Run setup</.test(block),
        'the CTA label must come from emptyState(), not a hardcoded literal in the template');
});

test('the pure half never references cockpit', () => {
    const upToDivider = SOURCE.split('cockpit I/O')[0];
    assert.ok(!/\bcockpit\b/.test(upToDivider), 'pure section must not reference cockpit');
});

test('dual export and Pilot* global (house pattern)', () => {
    assert.match(SOURCE, /^\s*'use strict';/m);
    assert.match(SOURCE, /root\.PilotServerOpsUi\s*=/);
    assert.match(SOURCE, /typeof module !== 'undefined' && module\.exports/);
});

// ------------------------------------------------------------ OPS

test('OPS: every entry has all required fields', () => {
    assert.ok(Array.isArray(S.OPS));
    assert.equal(S.OPS.length, 11);
    const ids = S.OPS.map((o) => o.id);
    assert.deepEqual(ids, ['status', 'restart-hbbs', 'restart-hbbr', 'restart-api',
        'relay-log', 'doctor', 'recheck-ports', 'versions', 'update-api', 'update-server',
        'rotate-key']);
    assert.equal(new Set(ids).size, ids.length, 'op ids must be unique');
    for (const op of S.OPS) {
        assert.equal(typeof op.id, 'string');
        assert.equal(typeof op.label, 'string');
        assert.equal(typeof op.danger, 'boolean');
        assert.equal(typeof op.needsCredential, 'boolean');
        assert.equal(typeof op.why, 'string');
        assert.ok(op.why.length > 0, op.id + ' must have a non-empty why');
    }
});

test('every danger:true op is captured in DANGER_OPS', () => {
    const dangerIds = S.OPS.filter((o) => o.danger === true).map((o) => o.id);
    assert.deepEqual(new Set(S.DANGER_OPS), new Set(dangerIds));
    assert.ok(S.DANGER_OPS.includes('restart-hbbs'));
    assert.ok(S.DANGER_OPS.includes('restart-hbbr'));
    assert.ok(S.DANGER_OPS.includes('restart-api'));
    assert.ok(S.DANGER_OPS.includes('rotate-key'));
});

test('rotate-key\'s why states the reconfiguration consequence in its own text', () => {
    const op = S.OPS.find((o) => o.id === 'rotate-key');
    assert.match(op.why, /reconfigur/i);
});

test('OPS is frozen and cannot be mutated by a caller', () => {
    assert.throws(() => { S.OPS.push({ id: 'x' }); });
    assert.throws(() => { S.OPS[0].label = 'hacked'; });
});

// ------------------------------------------------------------ isOpAllowed

test('isOpAllowed is false for every op when the server is null', () => {
    for (const op of S.OPS) assert.equal(S.isOpAllowed(op.id, null), false, op.id);
    assert.equal(S.isOpAllowed('status', undefined), false);
    assert.equal(S.isOpAllowed('status', 'not-an-object'), false);
});

test('isOpAllowed is false for an unknown op id, even with a fully-credentialed server', () => {
    assert.equal(S.isOpAllowed('nope', LOCAL), false);
    assert.equal(S.isOpAllowed('', LOCAL), false);
    assert.equal(S.isOpAllowed(undefined, LOCAL), false);
});

test('isOpAllowed: every op id, missing credential vs present, on a remote server', () => {
    for (const op of S.OPS) {
        assert.equal(S.isOpAllowed(op.id, REMOTE_NO_CRED), false,
            op.id + ' must be blocked without a stored credential');
        assert.equal(S.isOpAllowed(op.id, REMOTE_WITH_CRED), true,
            op.id + ' must be allowed once a credential is stored');
    }
});

test('isOpAllowed: every op is allowed on the local target, which needs no credential', () => {
    for (const op of S.OPS) assert.equal(S.isOpAllowed(op.id, LOCAL), true, op.id);
});

// ------------------------------------------------------------ opArgv

test('opArgv returns the exact argv for every op, and it never carries a credential', () => {
    const SECRET = 'hunter2-super-secret-pem-or-password';
    const serverWithSecretLookingField = Object.assign({}, REMOTE_WITH_CRED, { password: SECRET, pem: SECRET });
    // The update ops cannot build a command without a release to install, so
    // they are given a plan here; without one they correctly return null, which
    // is asserted separately below.
    const PLAN = { url: 'https://github.com/o/n/releases/download/v9/a.tar.gz',
        sha256: 'c'.repeat(64), stamp: '20260807' };
    for (const op of S.OPS) {
        const argv = S.opArgv(op.id, serverWithSecretLookingField, PLAN);
        assert.ok(Array.isArray(argv), op.id + ' must produce an argv array');
        const joined = argv.join(' ');
        assert.equal(joined.indexOf(SECRET), -1, op.id + ' argv must never contain a credential');
    }
});

test('opArgv: status queries all three units via systemctl is-active, in order', () => {
    assert.deepEqual(S.opArgv('status', LOCAL),
        ['systemctl', 'is-active', 'rustdesk-hbbs.service', 'rustdesk-hbbr.service', 'rustdesk-api.service']);
});

test('opArgv: each restart op targets exactly its own unit', () => {
    assert.deepEqual(S.opArgv('restart-hbbs', LOCAL), ['systemctl', 'restart', 'rustdesk-hbbs.service']);
    assert.deepEqual(S.opArgv('restart-hbbr', LOCAL), ['systemctl', 'restart', 'rustdesk-hbbr.service']);
    assert.deepEqual(S.opArgv('restart-api', LOCAL), ['systemctl', 'restart', 'rustdesk-api.service']);
});

test('opArgv: relay-log reads hbbr through journalctl in raw (cat) form', () => {
    const argv = S.opArgv('relay-log', LOCAL);
    assert.deepEqual(argv, ['journalctl', '-u', 'rustdesk-hbbr.service', '--no-pager', '-o', 'cat', '-n', '2000']);
});

test('opArgv: doctor takes the server address, recheck-ports takes none', () => {
    // rustdesk-utils' own usage: `doctor [rustdesk-server]`. Run bare it prints
    // "ERROR: You must supply the rustdesk-server address" and exits, so this
    // op could never once have produced a diagnosis. Verified against the real
    // binary on a provisioned server.
    assert.deepEqual(S.opArgv('doctor', LOCAL), ['rustdesk-utils', 'doctor', LOCAL.host]);
    assert.deepEqual(S.opArgv('recheck-ports', LOCAL), ['ss', '-H', '-ltnu']);
});

test('doctor refuses to run rather than invoke itself with no address', () => {
    // Returning null blocks the op. Emitting a bare `rustdesk-utils doctor`
    // would surface the binary's usage text as if it were a diagnosis.
    assert.equal(S.opArgv('doctor', { id: 'x', transport: 'local', host: '' }), null);
    assert.equal(S.opArgv('doctor', { id: 'x', transport: 'local', host: '   ' }), null);
    assert.equal(S.opArgv('doctor', {}), null);
});

test('opArgv: rotate-key removes the keypair and restarts hbbs in one compound command', () => {
    const argv = S.opArgv('rotate-key', LOCAL);
    assert.deepEqual(argv[0], 'sh');
    assert.deepEqual(argv[1], '-c');
    assert.match(argv[2], /rm -f .*id_ed25519/);
    assert.match(argv[2], /systemctl restart rustdesk-hbbs\.service/);
});

// A false "success" here is the worst failure mode this surface has: an
// operator who believes a compromised key was rotated, and it was not,
// stops treating it as compromised. `rm -f` on a missing path exits 0, so
// the script must check the key file exists FIRST and fail loudly (naming
// the path) rather than silently no-op through to a green run.
test('opArgv: rotate-key verifies the key file exists before removing it, and fails loudly (naming the path) if not', () => {
    const argv = S.opArgv('rotate-key', LOCAL);
    const script = argv[2];
    assert.match(script, /if \[ ! -e '\/var\/lib\/rustdesk-server\/id_ed25519' \]/,
        'must guard on the private key file actually existing');
    assert.match(script, /exit 1/, 'a missing key file must abort the step, not proceed to rm/restart');
    assert.match(script, />&2/, 'the failure message must go to stderr');
    assert.match(script, /\/var\/lib\/rustdesk-server\/id_ed25519/,
        'the failure message must name the actual path that was missing');
    // The guard must come BEFORE the rm/restart, not after.
    const guardIdx = script.indexOf('exit 1');
    const rmIdx = script.indexOf('rm -f');
    assert.ok(guardIdx < rmIdx, 'the existence check must run before rm -f, not after');
});

test('opArgv: rotate-key reads server.hbbsDataDir when the registry supplies one, falling back to the default otherwise', () => {
    const customServer = Object.assign({}, LOCAL, { hbbsDataDir: '/srv/custom-rustdesk' });
    const argv = S.opArgv('rotate-key', customServer);
    assert.match(argv[2], /\/srv\/custom-rustdesk\/id_ed25519/);
    assert.ok(argv[2].indexOf('/var/lib/rustdesk-server') === -1,
        'a supplied hbbsDataDir must replace the default, not merely add to it');

    // Hostile/empty values fall back to the documented default rather than
    // producing a broken or empty path.
    for (const bad of [null, undefined, '', '   ', 42, {}]) {
        const withBad = Object.assign({}, LOCAL, { hbbsDataDir: bad });
        assert.equal(S.hbbsDataDirFor(withBad), '/var/lib/rustdesk-server', JSON.stringify(bad));
    }
});

test('opArgv returns null for an unknown op', () => {
    assert.equal(S.opArgv('nope', LOCAL), null);
    assert.equal(S.opArgv('', LOCAL), null);
});

// ------------------------------------------------------------ parseUnitState

test('parseUnitState: active, inactive, failed', () => {
    assert.equal(S.parseUnitState('active\n'), 'active');
    assert.equal(S.parseUnitState('inactive\n'), 'inactive');
    assert.equal(S.parseUnitState('failed\n'), 'failed');
});

test('parseUnitState: unknown for anything else, including empty and garbage', () => {
    assert.equal(S.parseUnitState(''), 'unknown');
    assert.equal(S.parseUnitState('   '), 'unknown');
    assert.equal(S.parseUnitState('activating'), 'unknown');
    assert.equal(S.parseUnitState('reloading'), 'unknown');
    assert.equal(S.parseUnitState('asdkjasd'), 'unknown');
    assert.equal(S.parseUnitState(null), 'unknown');
    assert.equal(S.parseUnitState(undefined), 'unknown');
    assert.equal(S.parseUnitState(42), 'unknown');
    assert.equal(S.parseUnitState('ACTIVE'), 'active', 'case-insensitive on the word itself');
});

test('unitStatesFrom zips systemctl is-active output against the three units in order', () => {
    const rows = S.unitStatesFrom('active\nfailed\ninactive\n');
    assert.deepEqual(rows.map((r) => r.state), ['active', 'failed', 'inactive']);
    assert.deepEqual(rows.map((r) => r.key), ['hbbs', 'hbbr', 'api']);
});

// ------------------------------------------------------------ parseRelayLog

const NEW_LINE = '[2026-08-03 15:47:56.007358 +00:00] INFO [src/relay_server.rs:453] ' +
    'New relay request eed8c682-1234-5678-9abc-def012345678 from [::ffff:198.51.100.23]:44181';
const PAIRED_LINE = '[2026-08-03 15:47:56.067211 +00:00] INFO [src/relay_server.rs:437] ' +
    'Relayrequest eed8c682-1234-5678-9abc-def012345678 from [::ffff:198.51.100.23]:52390 got paired';
const CLOSED_LINE = '[2026-08-03 16:00:36.305113 +00:00] INFO [src/relay_server.rs:449] ' +
    'Relay of [::ffff:198.51.100.23]:52390 closed';

test('parseRelayLog: the three real reference lines produce one complete session', () => {
    const sessions = S.parseRelayLog([NEW_LINE, PAIRED_LINE, CLOSED_LINE].join('\n'));
    assert.equal(sessions.length, 1);
    const s = sessions[0];
    assert.equal(s.id, 'eed8c682-1234-5678-9abc-def012345678');
    assert.equal(typeof s.startedAt, 'number');
    assert.equal(typeof s.pairedAt, 'number');
    assert.equal(typeof s.closedAt, 'number');
    assert.ok(s.pairedAt >= s.startedAt);
    assert.ok(s.closedAt >= s.pairedAt);
    assert.equal(s.durationMs, s.closedAt - s.startedAt);
    assert.ok(s.durationMs > 0);
    assert.ok(s.peers.length >= 1);
    assert.ok(s.peers.every((p) => p.ip === '198.51.100.23'), 'ipv6-mapped ipv4 must normalise to dotted form');
    assert.ok(s.peers.some((p) => p.raw === '[::ffff:198.51.100.23]:52390'), 'the raw address must be preserved');
});

test('parseRelayLog: an empty string produces no sessions', () => {
    assert.deepEqual(S.parseRelayLog(''), []);
});

test('parseRelayLog: non-log noise interleaved between valid lines does not disturb them', () => {
    const text = [
        'this is not a log line at all',
        NEW_LINE,
        '2026-08-03 garbage garbage',
        PAIRED_LINE,
        '<<< binary garbage \x00\x01 >>>',
        CLOSED_LINE,
        'trailing noise'
    ].join('\n');
    const sessions = S.parseRelayLog(text);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].closedAt !== null, true);
});

test('parseRelayLog: an unpaired session still appears, with nulls, never dropped', () => {
    const sessions = S.parseRelayLog(NEW_LINE);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].pairedAt, null);
    assert.equal(sessions[0].closedAt, null);
    assert.equal(sessions[0].durationMs, null);
});

test('parseRelayLog: an unclosed session still appears, with nulls, never dropped', () => {
    const sessions = S.parseRelayLog([NEW_LINE, PAIRED_LINE].join('\n'));
    assert.equal(sessions.length, 1);
    assert.notEqual(sessions[0].pairedAt, null);
    assert.equal(sessions[0].closedAt, null);
    assert.equal(sessions[0].durationMs, null);
});

test('parseRelayLog: interleaved sessions are each tracked independently by id', () => {
    const newB = NEW_LINE.replace('eed8c682-1234-5678-9abc-def012345678', 'bbbbbbbb-1234-5678-9abc-def012345678')
        .replace('44181', '55555').replace('198.51.100.23', '10.0.0.9');
    const pairedB = PAIRED_LINE.replace('eed8c682-1234-5678-9abc-def012345678', 'bbbbbbbb-1234-5678-9abc-def012345678')
        .replace('52390', '55556').replace('198.51.100.23', '10.0.0.9');
    const closedB = CLOSED_LINE.replace('52390', '55556').replace('198.51.100.23', '10.0.0.9');
    const text = [NEW_LINE, newB, PAIRED_LINE, pairedB, CLOSED_LINE, closedB].join('\n');
    const sessions = S.parseRelayLog(text);
    assert.equal(sessions.length, 2);
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
    assert.ok(byId['eed8c682-1234-5678-9abc-def012345678']);
    assert.ok(byId['bbbbbbbb-1234-5678-9abc-def012345678']);
    assert.ok(byId['eed8c682-1234-5678-9abc-def012345678'].peers.every((p) => p.ip === '198.51.100.23'));
    assert.ok(byId['bbbbbbbb-1234-5678-9abc-def012345678'].peers.every((p) => p.ip === '10.0.0.9'));
});

test('parseRelayLog: out-of-order lines (closed appears before its own new/paired) still resolve', () => {
    const text = [CLOSED_LINE, NEW_LINE, PAIRED_LINE].join('\n');
    const sessions = S.parseRelayLog(text);
    assert.equal(sessions.length, 1);
    assert.notEqual(sessions[0].closedAt, null, 'the closed event must still be attributed by address');
});

test('parseRelayLog: a truncated final line is ignored, not crashed on, and does not eat prior lines', () => {
    const text = [NEW_LINE, PAIRED_LINE, CLOSED_LINE.slice(0, 40)].join('\n');
    const sessions = S.parseRelayLog(text);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].closedAt, null, 'the truncated close must not match');
});

test('parseRelayLog: a line with an embedded newline does not crash or corrupt neighbouring sessions', () => {
    const withEmbedded = NEW_LINE + '\nsome garbage\nwith an embedded\nnewline sequence';
    const text = [withEmbedded, PAIRED_LINE, CLOSED_LINE].join('\n');
    const sessions = S.parseRelayLog(text);
    assert.equal(sessions.length, 1);
    assert.notEqual(sessions[0].closedAt, null);
});

test('parseRelayLog: unicode content in surrounding noise does not crash or get mistaken for a session', () => {
    const text = ['héllo wörld 日本語 🚀', NEW_LINE, 'Ω≈ç√∫˜µ≤≥÷', PAIRED_LINE, CLOSED_LINE].join('\n');
    const sessions = S.parseRelayLog(text);
    assert.equal(sessions.length, 1);
});

test('parseRelayLog: a 10k-line log parses without error (performance sanity)', () => {
    const lines = [];
    for (let i = 0; i < 3333; i++) {
        const id = 'aaaaaaaa-0000-0000-0000-' + String(i).padStart(12, '0');
        const nl = NEW_LINE.replace('eed8c682-1234-5678-9abc-def012345678', id);
        const pl = PAIRED_LINE.replace('eed8c682-1234-5678-9abc-def012345678', id);
        lines.push(nl, pl, CLOSED_LINE);
    }
    assert.ok(lines.length >= 9999);
    const start = Date.now();
    const sessions = S.parseRelayLog(lines.join('\n'));
    const elapsed = Date.now() - start;
    assert.equal(sessions.length, 3333);
    assert.ok(elapsed < 5000, 'parsing 10k lines took ' + elapsed + 'ms');
});

test('parseRelayLog: a plain (non-bracketed) ipv4 address is also accepted', () => {
    const nl = NEW_LINE.replace('[::ffff:198.51.100.23]:44181', '203.0.113.9:44181');
    const sessions = S.parseRelayLog(nl);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].peers[0].ip, '203.0.113.9');
    assert.equal(sessions[0].peers[0].raw, '203.0.113.9:44181');
});

// ------------------------------------------------------------ summarise

test('summarise: counts and average/max duration over ordinary sessions', () => {
    const sessions = S.parseRelayLog([NEW_LINE, PAIRED_LINE, CLOSED_LINE].join('\n'))
        .concat(S.parseRelayLog(NEW_LINE));
    const sum = S.summarise(sessions);
    assert.equal(sum.total, 2);
    assert.equal(sum.closed, 1);
    assert.equal(sum.unclosed, 1);
    assert.equal(sum.paired, 1);
    assert.equal(sum.unpaired, 1);
    assert.ok(sum.avgDurationMs > 0);
    assert.equal(sum.maxDurationMs, sum.avgDurationMs);
});

test('summarise: an empty or garbage list summarises to all zeros/nulls, never throws', () => {
    assert.deepEqual(S.summarise([]), {
        total: 0, paired: 0, unpaired: 0, closed: 0, unclosed: 0,
        totalDurationMs: 0, avgDurationMs: null, maxDurationMs: null
    });
    assert.equal(S.summarise(null).total, 0);
    assert.equal(S.summarise(undefined).total, 0);
    assert.equal(S.summarise([null, 'not an object', 42, {}]).total, 1);
});

test('summarise: a session with closedAt < startedAt (clock skew) never yields a negative duration', () => {
    const skewed = { id: 'skew', startedAt: 10000, pairedAt: 10000, closedAt: 9000, durationMs: null, peers: [] };
    const sum = S.summarise([skewed]);
    assert.equal(sum.total, 1);
    assert.ok(sum.totalDurationMs >= 0, 'total duration must never go negative');
    assert.ok(sum.avgDurationMs >= 0, 'average duration must never go negative');
    assert.equal(sum.avgDurationMs, 0, 'a skewed session clamps to a zero duration, not negative');
});

test('summarise: trusts a hand-built durationMs too, and still clamps it if negative', () => {
    const weird = { id: 'w', startedAt: null, pairedAt: null, closedAt: null, durationMs: -500, peers: [] };
    const sum = S.summarise([weird]);
    assert.equal(sum.totalDurationMs, 0);
    assert.equal(sum.avgDurationMs, 0);
});

// ------------------------------------------------------------ blankState

test('blankState is a fresh object every call, not shared mutable state', () => {
    const a = S.blankState();
    const b = S.blankState();
    a.opAlerts.status = 'poked';
    assert.equal(b.opAlerts.status, undefined);
    assert.equal(a.server, null);
    assert.equal(a.loading, false);
    assert.deepEqual(a.unitStates, []);
    assert.deepEqual(a.relaySessions, []);
    assert.equal(a.relaySummary, null);
    assert.equal(a.confirm, null);
});

// ------------------------------------------------------------ component (I/O)

function fakeCockpit(opts) {
    const o = opts || {};
    const calls = [];
    const api = {
        calls: calls,
        spawn(argv, options) {
            const record = { argv: argv.slice(), options: options || {}, stdin: null };
            calls.push(record);
            const key = Object.keys(o.spawn || {}).find((k) => argv.join(' ').indexOf(k) >= 0);
            const scripted = key === undefined ? undefined : o.spawn[key];
            let resolveP, rejectP;
            const p = new Promise((res, rej) => { resolveP = res; rejectP = rej; });
            p.input = function (data) { record.stdin = String(data); return p; };
            p.stream = function (cb) {
                if (o.noStream) return p;
                if (typeof scripted === 'string') setTimeout(() => cb(scripted), 0);
                return p;
            };
            setTimeout(() => {
                if (scripted === undefined) {
                    const e = new Error('no stub for: ' + argv.join(' '));
                    e.exit_status = 1;
                    rejectP(e);
                } else if (scripted && scripted.error) {
                    const e = new Error(scripted.message || 'stub failure');
                    e.exit_status = scripted.exit_status === undefined ? 1 : scripted.exit_status;
                    rejectP(e);
                } else {
                    resolveP(o.noStream ? scripted : '');
                }
            }, 8);
            return p;
        }
    };
    return api;
}

function withCockpit(fake, fn) {
    globalThis.cockpit = fake;
    return Promise.resolve().then(fn).finally(() => { delete globalThis.cockpit; });
}

function fakeServers(recs, secrets) {
    return {
        active() { return Promise.resolve(recs.__active || null); },
        read(id) {
            return Object.prototype.hasOwnProperty.call(recs, id)
                ? Promise.resolve(recs[id]) : Promise.reject(new Error('no such record'));
        },
        readSecret(id, kind) {
            const key = id + '.' + kind;
            return Promise.resolve(Object.prototype.hasOwnProperty.call(secrets, key) ? secrets[key] : null);
        },
        decodeSshCredential(raw) { return RealServers.decodeSshCredential(raw); }
    };
}

function withServers(fake, fn) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'PilotServers');
    const prev = globalThis.PilotServers;
    globalThis.PilotServers = fake;
    return Promise.resolve().then(fn).finally(() => { if (had) globalThis.PilotServers = prev; else delete globalThis.PilotServers; });
}

test('the component constructs with no DOM and no cockpit, and starts empty', () => {
    const c = S.serverOpsUi();
    assert.equal(c.server, null);
    assert.equal(globalThis.pilotServerOpsUi, S.serverOpsUi);
});

test('with no server configured, loadServer(null) leaves the surface empty, not errored', async () => {
    const c = S.serverOpsUi();
    await c.loadServer(null);
    assert.equal(c.server, null);
    assert.equal(c.alert, null);
});

test('loadServer(id): a missing record (no server ever configured under this id) is the empty state, not an alert', async () => {
    await withServers(fakeServers({}, {}), async () => {
        const c = S.serverOpsUi();
        await c.loadServer('local');
        assert.equal(c.server, null);
        assert.equal(c.alert, null);
    });
});

test('loadServer: the local target always has hasCredential true, needing no secret file', async () => {
    const rec = { id: 'local', host: '127.0.0.1', sshPort: 22, apiPort: 21114, domain: null };
    await withServers(fakeServers({ local: rec }, {}), async () => {
        const c = S.serverOpsUi();
        await c.loadServer('local');
        assert.ok(c.server);
        assert.equal(c.server.transport, 'local');
        assert.equal(c.server.hasCredential, true);
    });
});

test('loadServer: a remote server with no stored secret has hasCredential false', async () => {
    const rec = { id: 'edge1', host: 'edge1.example.com', sshPort: 22, apiPort: 21114, domain: null };
    await withServers(fakeServers({ edge1: rec }, {}), async () => {
        const c = S.serverOpsUi();
        await c.loadServer('edge1');
        assert.ok(c.server);
        assert.equal(c.server.transport, 'ssh');
        assert.equal(c.server.hasCredential, false);
    });
});

test('loadServer: a remote server with a stored secret has hasCredential true', async () => {
    const rec = { id: 'edge1', host: 'edge1.example.com', sshPort: 22, apiPort: 21114, domain: null };
    await withServers(fakeServers({ edge1: rec }, { 'edge1.ssh': 's3cr3t' }), async () => {
        const c = S.serverOpsUi();
        await c.loadServer('edge1');
        assert.equal(c.server.hasCredential, true);
    });
});

test('onServerChanged reads the event detail and reloads the server', async () => {
    const rec = { id: 'local', host: '127.0.0.1', sshPort: 22, apiPort: 21114, domain: null };
    await withServers(fakeServers({ local: rec }, {}), async () => {
        const c = S.serverOpsUi();
        c.onServerChanged({ detail: { id: 'local' } });
        await new Promise((r) => setTimeout(r, 10));
        assert.ok(c.server);
        assert.equal(c.server.id, 'local');
    });
});

test('onServerChanged ignores a malformed event rather than throwing', () => {
    const c = S.serverOpsUi();
    assert.equal(c.onServerChanged(null), false);
    assert.equal(c.onServerChanged(undefined), false);
});

test('a non-danger op needing a credential is disabled with a visible reason when hasCredential is false', () => {
    const c = S.serverOpsUi();
    c.server = REMOTE_NO_CRED;
    assert.equal(c.isOpAllowed('status'), false);
    assert.match(c.reasonBlocked('status'), /credential/i);
});

test('with no server at all, reasonBlocked names that as the reason', () => {
    const c = S.serverOpsUi();
    c.server = null;
    assert.match(c.reasonBlocked('status'), /no server/i);
});

test('request() opens a confirmation for a danger op instead of running it immediately', () => {
    const c = S.serverOpsUi();
    c.server = LOCAL;
    const result = c.request('restart-hbbs');
    assert.equal(result, true);
    assert.ok(c.confirm);
    assert.equal(c.confirm.opId, 'restart-hbbs');
});

test('request() refuses a disallowed op outright (no confirmation ever opens for it)', () => {
    const c = S.serverOpsUi();
    c.server = REMOTE_NO_CRED;
    const result = c.request('restart-hbbs');
    assert.equal(result, false);
    assert.equal(c.confirm, null);
});

test('rotate-key\'s confirmation refuses to proceed until the server id is typed exactly', () => {
    const c = S.serverOpsUi();
    c.server = LOCAL;
    c.request('rotate-key');
    assert.equal(c.confirmDisabled(), true, 'nothing typed yet');
    c.confirm.typed = 'wrong-id';
    assert.equal(c.confirmDisabled(), true, 'wrong id typed');
    c.confirm.typed = LOCAL.id;
    assert.equal(c.confirmDisabled(), false, 'the exact id unlocks it');
});

test('a non-rotate-key danger op\'s confirmation needs no typed id', () => {
    const c = S.serverOpsUi();
    c.server = LOCAL;
    c.request('restart-hbbs');
    assert.equal(c.confirmDisabled(), false);
});

test('cancelConfirm closes the confirmation without running anything', async () => {
    const fake = fakeCockpit({ spawn: {} });
    await withCockpit(fake, async () => {
        const c = S.serverOpsUi();
        c.server = LOCAL;
        c.request('restart-hbbs');
        c.cancelConfirm();
        assert.equal(c.confirm, null);
        assert.equal(fake.calls.length, 0);
    });
});

const RUN_STATUS_OK = [
    '{"t":"run-start","run_id":"20260803T204500Z","transport":"local","steps":1}',
    '{"t":"step-start","id":"status","title":"Service status","cmd":"systemctl is-active"}',
    '{"t":"output","id":"status","stream":"stdout","line":"active"}',
    '{"t":"output","id":"status","stream":"stdout","line":"active"}',
    '{"t":"output","id":"status","stream":"stdout","line":"failed"}',
    '{"t":"step-end","id":"status","status":"ok","exit":0,"ms":10}',
    '{"t":"run-end","status":"ok","kind":null}'
].join('\n') + '\n';

test('execute(\'status\') runs pilot-exec --run and populates parsed unit states', async () => {
    const fake = fakeCockpit({ spawn: { '--run': RUN_STATUS_OK } });
    await withCockpit(fake, async () => {
        const c = S.serverOpsUi();
        c.server = LOCAL;
        const ok = await c.execute('status');
        assert.equal(ok, true);
        assert.equal(c.unitStates.length, 3);
        assert.deepEqual(c.unitStates.map((u) => u.state), ['active', 'active', 'failed']);
        const call = fake.calls.find((x) => x.argv.indexOf('--run') >= 0);
        assert.deepEqual(call.argv, ['/usr/libexec/pilot/pilot-exec', '--run']);
        const envelope = JSON.parse(call.stdin);
        assert.equal(envelope.transport, 'local');
        assert.equal(envelope.ssh, null);
        assert.equal(envelope.credentials, null);
        assert.deepEqual(envelope.steps[0].argv,
            ['systemctl', 'is-active', 'rustdesk-hbbs.service', 'rustdesk-hbbr.service', 'rustdesk-api.service']);
    });
});

test('execute(\'relay-log\') parses the accumulated output into sessions and a summary', async () => {
    const RUN_RELAY = [
        '{"t":"run-start","run_id":"20260803T204500Z","transport":"local","steps":1}',
        '{"t":"step-start","id":"relay-log","title":"Recent relay sessions","cmd":"journalctl"}',
        '{"t":"output","id":"relay-log","stream":"stdout","line":' + JSON.stringify(NEW_LINE) + '}',
        '{"t":"output","id":"relay-log","stream":"stdout","line":' + JSON.stringify(PAIRED_LINE) + '}',
        '{"t":"output","id":"relay-log","stream":"stdout","line":' + JSON.stringify(CLOSED_LINE) + '}',
        '{"t":"step-end","id":"relay-log","status":"ok","exit":0,"ms":10}',
        '{"t":"run-end","status":"ok","kind":null}'
    ].join('\n') + '\n';
    const fake = fakeCockpit({ spawn: { '--run': RUN_RELAY } });
    await withCockpit(fake, async () => {
        const c = S.serverOpsUi();
        c.server = LOCAL;
        const ok = await c.execute('relay-log');
        assert.equal(ok, true);
        assert.equal(c.relaySessions.length, 1);
        assert.equal(c.relaySummary.total, 1);
        assert.equal(c.relaySummary.closed, 1);
    });
});

test('a failing op surfaces its kind under that op\'s own alert, and does not touch other ops', async () => {
    const fake = fakeCockpit({
        spawn: { '--run': { error: true, message: JSON.stringify({ t: 'fatal', kind: 'HBBS_NOT_FOUND', message: 'hbbs is not installed' }) } }
    });
    await withCockpit(fake, async () => {
        const c = S.serverOpsUi();
        c.server = LOCAL;
        const ok = await c.execute('doctor');
        assert.equal(ok, false);
        assert.equal(c.opAlerts.doctor.kind, 'HBBS_NOT_FOUND');
        assert.match(c.opAlerts.doctor.message, /not installed/);
        assert.equal(c.opAlerts.status, undefined, 'a different op\'s alert must be untouched');
        assert.equal(c.opBusy.doctor, false);
    });
});

test('execute refuses to run (and never spawns) when the op is not allowed', async () => {
    const fake = fakeCockpit({ spawn: {} });
    await withCockpit(fake, async () => {
        const c = S.serverOpsUi();
        c.server = REMOTE_NO_CRED;
        const ok = await c.execute('status');
        assert.equal(ok, false);
        assert.equal(fake.calls.length, 0);
    });
});

test('a remote op sends the stored credential on stdin only, never in argv', async () => {
    await withServers(fakeServers({}, { 'edge1.ssh': 's3cr3tpassword' }), async () => {
        const fake = fakeCockpit({ spawn: { '--run': RUN_STATUS_OK } });
        await withCockpit(fake, async () => {
            const c = S.serverOpsUi();
            c.server = REMOTE_WITH_CRED;
            await c.execute('status');
            const call = fake.calls.find((x) => x.argv.indexOf('--run') >= 0);
            assert.equal(call.argv.join(' ').indexOf('s3cr3tpassword'), -1);
            assert.ok(call.stdin.indexOf('s3cr3tpassword') >= 0);
            const envelope = JSON.parse(call.stdin);
            assert.equal(envelope.transport, 'ssh');
            assert.equal(envelope.credentials.password, 's3cr3tpassword');
            assert.equal(envelope.ssh.auth, 'password');
            assert.equal(envelope.credentials.pem, null, 'a password credential must never also carry a pem field');
            assert.equal(envelope.ssh.host, REMOTE_WITH_CRED.host);
        });
    });
});

// GAP C (task 33): before this fix, envelopeFor() unconditionally hardcoded
// `auth: 'password'` and put the raw stored secret into credentials.password
// no matter what it actually was — a stored PEM would be sent to pilot-exec
// AS AN SSH PASSWORD (a clean SSH_AUTH_FAILED, but with no way to explain the
// real cause). It must now route on the credential's own auth-type tag.
test('a remote op with a stored PEM credential sends it as pem, never as a password', async () => {
    const pemBody = '-----BEGIN OPENSSH PRIVATE KEY-----\nZZZZ\n-----END OPENSSH PRIVATE KEY-----';
    await withServers(fakeServers({}, { 'edge1.ssh': RealServers.encodeSshCredential('pem', pemBody) }), async () => {
        const fake = fakeCockpit({ spawn: { '--run': RUN_STATUS_OK } });
        await withCockpit(fake, async () => {
            const c = S.serverOpsUi();
            c.server = REMOTE_WITH_CRED;
            await c.execute('status');
            const call = fake.calls.find((x) => x.argv.indexOf('--run') >= 0);
            assert.equal(call.argv.join(' ').indexOf('BEGIN OPENSSH'), -1, 'the pem must never reach argv');
            const envelope = JSON.parse(call.stdin);
            assert.equal(envelope.ssh.auth, 'pem');
            assert.equal(envelope.credentials.pem, pemBody);
            assert.equal(envelope.credentials.password, null, 'a pem credential must never also carry a password field');
        });
    });
});

test('a remote op with a legacy bare-string secret (pre-dating GAP C) still sends it as a password, ' +
    'the only thing it could ever have been before an auth-type tag existed', async () => {
    await withServers(fakeServers({}, { 'edge1.ssh': 's3cr3tpassword' }), async () => {
        const fake = fakeCockpit({ spawn: { '--run': RUN_STATUS_OK } });
        await withCockpit(fake, async () => {
            const c = S.serverOpsUi();
            c.server = REMOTE_WITH_CRED;
            await c.execute('status');
            const call = fake.calls.find((x) => x.argv.indexOf('--run') >= 0);
            const envelope = JSON.parse(call.stdin);
            assert.equal(envelope.ssh.auth, 'password');
            assert.equal(envelope.credentials.password, 's3cr3tpassword');
        });
    });
});

test('confirmRun executes the op once confirmed and clears the confirmation', async () => {
    const fake = fakeCockpit({ spawn: { '--run': RUN_STATUS_OK.replace('"id":"status"', '"id":"restart-hbbs"') } });
    await withCockpit(fake, async () => {
        const c = S.serverOpsUi();
        c.server = LOCAL;
        c.request('restart-hbbs');
        const ok = await c.confirmRun();
        assert.equal(c.confirm, null);
        assert.ok(fake.calls.some((x) => x.argv.indexOf('--run') >= 0));
    });
});

test('confirmRun does nothing while disabled (rotate-key without the typed id)', async () => {
    const fake = fakeCockpit({ spawn: {} });
    await withCockpit(fake, async () => {
        const c = S.serverOpsUi();
        c.server = LOCAL;
        c.request('rotate-key');
        const result = await c.confirmRun();
        assert.equal(result, false);
        assert.ok(c.confirm, 'the confirmation must still be open');
        assert.equal(fake.calls.length, 0);
    });
});

// ------------------------------------------------------------ rotate-key: existence guard end-to-end
//
// The confirmation gate (typed server id) and the on-target existence guard
// (opArgv's `if [ ! -e ... ]`) are two independent defences against two
// different mistakes: the confirm gate stops a MISCLICK; the existence
// guard stops a false "success" when the key simply is not where Pilot
// expects it. These three tests exercise the real component method
// (confirmRun -> execute), not opArgv in isolation, so a regression that
// wired the guard into the wrong place (or dropped it before it reaches
// pilot-exec) would be caught here too.

const RUN_ROTATE_OK = [
    '{"t":"run-start","run_id":"20260803T204700Z","transport":"local","steps":1}',
    '{"t":"step-start","id":"rotate-key","title":"Rotate server keypair","cmd":"sh -c ..."}',
    '{"t":"step-end","id":"rotate-key","status":"ok","exit":0,"ms":40}',
    '{"t":"run-end","status":"ok","kind":null}'
].join('\n') + '\n';

// Models the real on-target guard tripping: the shell script's own `exit 1`
// after printing to stderr, surfaced by pilot-exec as a normal failed step
// (never a manufactured green run).
const RUN_ROTATE_MISSING_KEY = [
    '{"t":"run-start","run_id":"20260803T204800Z","transport":"local","steps":1}',
    '{"t":"step-start","id":"rotate-key","title":"Rotate server keypair","cmd":"sh -c ..."}',
    '{"t":"output","id":"rotate-key","stream":"stderr",' +
        '"line":"rotate-key: no keypair found at /var/lib/rustdesk-server/id_ed25519 -- nothing was rotated"}',
    '{"t":"step-end","id":"rotate-key","status":"failed","exit":1,"ms":5}',
    '{"t":"run-end","status":"failed","kind":null}'
].join('\n') + '\n';

test('rotate-key happy path: confirming with the exact server id actually rotates the key and restarts hbbs', async () => {
    const fake = fakeCockpit({ spawn: { '--run': RUN_ROTATE_OK } });
    await withCockpit(fake, async () => {
        const c = S.serverOpsUi();
        c.server = LOCAL;
        c.request('rotate-key');
        c.confirm.typed = LOCAL.id;
        const ok = await c.confirmRun();
        assert.equal(ok, true);
        assert.equal(c.confirm, null);
        assert.equal(c.opAlerts['rotate-key'], null, 'a genuine success must not leave a stale alert');
        const call = fake.calls.find((x) => x.argv.indexOf('--run') >= 0);
        const envelope = JSON.parse(call.stdin);
        assert.match(envelope.steps[0].argv[2], /if \[ ! -e /,
            'the real run must actually carry the existence guard, not a stale/simplified argv');
    });
});

test('rotate-key wrong/missing path: a missing keypair is a clear, visible failure — never a false success', async () => {
    const fake = fakeCockpit({ spawn: { '--run': RUN_ROTATE_MISSING_KEY } });
    await withCockpit(fake, async () => {
        const c = S.serverOpsUi();
        c.server = LOCAL;
        c.request('rotate-key');
        c.confirm.typed = LOCAL.id;
        const ok = await c.confirmRun();
        assert.equal(ok, false, 'a missing keypair must never be reported as success');
        assert.ok(c.opAlerts['rotate-key'], 'the failure must be visible under this op\'s own alert');
        assert.match(c.opAlerts['rotate-key'].message, /no keypair found at .*id_ed25519.*nothing was rotated/i,
            'the operator-visible alert must name the actual missing path, not a generic message');
    });
});

test('rotate-key\'s confirmation gate still applies after the existence-guard change', async () => {
    const fake = fakeCockpit({ spawn: { '--run': RUN_ROTATE_OK } });
    await withCockpit(fake, async () => {
        const c = S.serverOpsUi();
        c.server = LOCAL;
        c.request('rotate-key');
        assert.ok(c.confirm, 'rotate-key must still open a confirmation, not run immediately');
        assert.equal(c.confirmDisabled(), true, 'must still be locked with nothing typed');
        c.confirm.typed = 'not-the-right-id';
        assert.equal(c.confirmDisabled(), true, 'must still be locked with the wrong id typed');
        assert.equal(fake.calls.length, 0, 'nothing may run until the gate is passed');
        c.confirm.typed = LOCAL.id;
        assert.equal(c.confirmDisabled(), false, 'the exact id must still unlock it');
        await c.confirmRun();
        assert.ok(fake.calls.some((x) => x.argv.indexOf('--run') >= 0));
    });
});

// ------------------------------------------------------------ init() wiring
//
// This is the one that MUST go RED if js/features/server-ops-ui.js's init()
// stops registering the pilot:server-changed listener (Task 24's lesson,
// restated for this surface): every other test in this file calls
// onServerChanged() or loadServer() directly, which would stay green even if
// init() never wired anything up at all. Only this test drives init() with a
// real EventTarget-shaped object and proves the LISTENER ITSELF was
// registered and reacts to a dispatched event — see the task report for the
// mutation transcript (listener removed -> this test red; restored -> green).

function fakeTarget() {
    const listeners = {};
    return {
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        dispatchEvent(ev) { (listeners[ev && ev.type] || []).slice().forEach((fn) => fn(ev)); },
        _listeners: listeners
    };
}

test('init wires a pilot:server-changed listener that reloads the server, live', async () => {
    const rec = { id: 'edge9', host: 'edge9.example.com', sshPort: 22, apiPort: 21114, domain: null };
    await withServers(fakeServers({ edge9: rec }, {}), async () => {
        const c = S.serverOpsUi();
        const target = fakeTarget();
        await c.init(target);
        assert.ok(Array.isArray(target._listeners['pilot:server-changed']),
            'init must register a pilot:server-changed listener on the given target');
        assert.equal(c.server, null, 'nothing is active yet in this fake environment');
        target.dispatchEvent({ type: 'pilot:server-changed', detail: { id: 'edge9' } });
        // onServerChanged calls loadServer() but does not await it, and
        // loadServer's own chain is a few promises deep (read -> readSecret),
        // so give the microtask queue a real turn rather than counting ticks.
        await new Promise((r) => setTimeout(r, 10));
        assert.ok(c.server, 'the dispatched event must actually reload the server, not be ignored');
        assert.equal(c.server.id, 'edge9');
    });
});


// ======================= FIELD REPORT: every Server Ops action was dead on arrival
//
// "when i click service status nothing happens and there is a error on console":
//
//   Uncaught PilotError: envelope.steps[0] is missing key(s): check, secret,
//                        sha256, write
//
// envelopeFor() built a step out of the five keys that carry data for an
// operation. libexec/pilot-exec validates the WHOLE key set -- it rejects a
// missing key exactly as hard as an unknown one -- so the envelope was refused
// before a single command ran. Not just Service status: all eight operations,
// every one of them, since the screen was written.
//
// It survived because every test above stubs the transport and asserts on argv.
// Nothing compared the envelope against the thing that actually validates it,
// so client and tests agreed about a shape the helper has never accepted.
// That is why this reads STEP_KEYS out of libexec/pilot-exec instead of
// restating it: a copy of the contract would have passed while broken too.

function pilotExecStepKeys() {
    const src = fs.readFileSync(path.join(__dirname, '../../libexec/pilot-exec'), 'utf8');
    const m = /^STEP_KEYS\s*=\s*\(([^)]*)\)/m.exec(src);
    assert.ok(m, 'STEP_KEYS not found in libexec/pilot-exec -- the contract moved');
    return m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean).sort();
}

const OPS_SERVER = { id: 'srv', transport: 'local', host: 'h.example', sshPort: 22, hasCredential: true };

test('the envelope step carries exactly the keys pilot-exec demands, read from pilot-exec', () => {
    const want = pilotExecStepKeys();
    for (const op of S.OPS) {
        const env = S.envelopeFor(op.id, OPS_SERVER, null);
        const got = Object.keys(env.steps[0]).sort();
        assert.deepEqual(got, want,
            op.id + ' step keys do not match pilot-exec STEP_KEYS');
    }
});

test('the four non-command keys carry the value that means "not applicable"', () => {
    // They are not padding to satisfy a validator: an operation runs a command
    // and nothing else -- no file written, no idempotency guard, no download to
    // verify, no secret argument.
    const env = S.envelopeFor('status', OPS_SERVER, null);
    const step = env.steps[0];
    assert.equal(step.write, null);
    assert.equal(step.check, null);
    assert.equal(step.sha256, null);
    assert.equal(step.secret, false);
    // ...and the keys that DO carry data still do.
    assert.equal(step.id, 'status');
    assert.ok(Array.isArray(step.argv) && step.argv.length > 0, 'the command survives');
});

test('a danger op is marked mutating, a read-only one is not', () => {
    assert.equal(S.envelopeFor('restart-hbbs', OPS_SERVER, null).steps[0].mutating, true);
    assert.equal(S.envelopeFor('status', OPS_SERVER, null).steps[0].mutating, false);
});


// ============== "add are you sure dialog explaining what going to happen"
//
// A confirmation already existed, but it showed one sentence and two buttons:
// no heading naming the action, no statement of what breaks, and no word on
// whether it can be undone. "Are you sure?" is not a question anyone can answer
// from that -- least of all for rotate-key, which irreversibly breaks every
// deployed device at once.

test('every destructive op carries an impact statement and a reversibility verdict', () => {
    for (const op of S.OPS) {
        if (!op.danger) continue;
        assert.ok(Array.isArray(op.impact) && op.impact.length >= 3,
            op.id + ' must spell out what happens, not just that something will');
        assert.equal(typeof op.reversible, 'boolean', op.id + ' must state whether it can be undone');
        for (const line of op.impact)
            assert.ok(typeof line === 'string' && line.trim().length > 20,
                op.id + ' has a filler impact line: ' + JSON.stringify(line));
    }
});

test('a read-only op is never marked destructive, so the dialog never fires for one', () => {
    for (const op of S.OPS) {
        if (op.danger) continue;
        assert.ok(!op.impact, op.id + ' is not destructive and needs no impact statement');
    }
});

test('rotate-key is the only irreversible op, and says so', () => {
    const irreversible = S.OPS.filter((o) => o.reversible === false).map((o) => o.id);
    assert.deepEqual(irreversible, ['rotate-key'],
        'if another op becomes irreversible its dialog must say so too');
    const rot = S.OPS.find((o) => o.id === 'rotate-key');
    // The specific thing an operator must understand before clicking: it is not
    // "some devices might need attention", it is all of them, at once, by hand.
    assert.ok(rot.impact.some((l) => /EVERY device/.test(l)), 'the blast radius must be explicit');
    assert.ok(rot.impact.some((l) => /by hand|on the device itself/i.test(l)),
        'the recovery cost must be explicit');
});

test('the dialog renders the name, the impact and the reversibility verdict', () => {
    const t = S.TEMPLATE;
    assert.match(t, /are you sure\?/, 'the dialog must actually ask');
    assert.match(t, /data-testid="server-ops-confirm-title"/);
    assert.match(t, /data-testid="server-ops-confirm-impact"/);
    assert.match(t, /data-testid="server-ops-confirm-reversible"/);
    assert.match(t, /x-for="line in confirmOp\(\)\.impact/, 'the impact lines are rendered, not summarised');
    assert.match(t, /This cannot be undone\./);
});

test('confirmOp survives the confirmation being cleared mid-render', () => {
    // x-if and the bindings inside it are separate Alpine effects; a null here
    // would throw in the frame between them.
    const c = S.serverOpsUi({});
    c.confirm = null;
    const op = c.confirmOp();
    assert.equal(op.label, '');
    assert.deepEqual(op.impact, []);
    assert.equal(op.reversible, true, 'an unknown op must not be described as irreversible');
});


// ================ FIELD REPORT: the ssh user, and "show loading animation"
//
// "service status still not working":
//   Uncaught PilotError: cannot determine the remote user: id -u exited 142
//
// 142 is 128+14, SIGALRM -- the probe timed out. envelopeFor() hardcoded
// user: 'root', the server record never carried the account the wizard actually
// connected as, and most cloud images disable root SSH outright. So every op on
// a remote target hung until the alarm fired. pilot-exec escalates with sudo
// once connected, so a non-root account is the normal case, not the exception.

test('the envelope connects as the account the wizard recorded', () => {
    const srv = { id: 's', transport: 'ssh', host: 'h', sshPort: 22, hasCredential: true, sshUser: 'ubuntu' };
    assert.equal(S.envelopeFor('status', srv, { authType: 'pem', secret: 'k' }).ssh.user, 'ubuntu');
});

test('a record predating sshUser still connects as root, which is what it was provisioned with', () => {
    for (const u of [null, undefined, '', '   ']) {
        const srv = { id: 's', transport: 'ssh', host: 'h', sshPort: 22, hasCredential: true, sshUser: u };
        assert.equal(S.envelopeFor('status', srv, { authType: 'pem', secret: 'k' }).ssh.user, 'root',
            'legacy record with sshUser=' + JSON.stringify(u));
    }
});

test('the ssh user is never hardcoded -- changing the record changes the envelope', () => {
    // The defect was a literal 'root' that no record could influence.
    const mk = (u) => S.envelopeFor('restart-hbbs',
        { id: 's', transport: 'ssh', host: 'h', sshPort: 22, hasCredential: true, sshUser: u },
        { authType: 'password', secret: 'p' }).ssh.user;
    assert.equal(mk('ec2-user'), 'ec2-user');
    assert.equal(mk('debian'), 'debian');
    assert.notEqual(mk('ec2-user'), mk('debian'));
});

test('a running op shows a spinner and says what is running', () => {
    const c = S.serverOpsUi({});
    assert.equal(c.isBusy('status'), false);
    assert.equal(c.opLabel({ id: 'status', label: 'Service status' }), 'Service status');
    c.opBusy = { status: true };
    assert.equal(c.isBusy('status'), true);
    assert.equal(c.opLabel({ id: 'status', label: 'Service status' }), 'Service status…',
        'the label must say it is running, for anyone who cannot see a spinner');
    assert.equal(c.opLabel({ id: 'doctor', label: 'Run diagnostics' }), 'Run diagnostics',
        'only the running op changes');
    assert.equal(c.opLabel(null), '', 'never throws mid-render');
});

test('the spinner is x-if, not x-show -- a display utility would override it', () => {
    const t = S.TEMPLATE;
    assert.match(t, /spinner-border/, 'a busy button must show a spinner');
    assert.match(t, /x-if="isBusy\(op\.id\)"/, 'the spinner is conditionally RENDERED');
    // The bug this repo already shipped once: x-show sets an inline display,
    // which a Bootstrap utility class marked !important beats.
    const spinnerTag = /<span class="spinner-border[^>]*>/.exec(t);
    assert.ok(spinnerTag, 'spinner span not found');
    assert.ok(!/x-show/.test(spinnerTag[0]), 'x-show cannot hide a display-utility element');
    assert.match(t, /:aria-busy="isBusy\(op\.id\)"/, 'the busy state must reach assistive tech');
});


// ================== FIELD REPORT: updating the API and the RustDesk server
//
// "add an update mechanism for updating api server from git", and then, on
// discovering the release tarball ships its own conf/config.yaml:
// "user may want to reset config.yaml thats why i said it" and
// "if user says update it but dont touch config.yaml exclude it".
//
// So keeping the configured file is the DEFAULT and is achieved by never
// writing it -- the archive member is excluded from the unpack rather than
// restored afterwards, because "never happened" cannot half-fail. Replacing it
// is opt-in and states what it costs.
//
// Verified against the real v2.7 archive: with the exclude, a configured
// config.yaml is byte-identical afterwards, data/rustdeskapi.db is untouched
// (the archive's data/ is an empty directory carrying no .db at all), and
// apimain plus resources/version are updated.

const UPD_SRV = { id: 's', transport: 'ssh', host: 'h', sshPort: 22, hasCredential: true };
const UPD_PLAN = { url: 'https://github.com/o/n/releases/download/v2.8/linux-arm64.tar.gz',
    sha256: 'd'.repeat(64), version: '2.8', stamp: '20260807T120000Z' };

test('an update refuses to run without a release and a checksum', () => {
    // A command built from an empty URL would curl nothing over a live server.
    for (const bad of [null, undefined, {}, { url: 'https://x/y' }, { sha256: 'd'.repeat(64) },
        { url: 'https://x/y', sha256: 'not-a-digest' }]) {
        assert.equal(S.opArgv('update-api', UPD_SRV, bad), null, JSON.stringify(bad));
        assert.equal(S.opArgv('update-server', UPD_SRV, bad), null, JSON.stringify(bad));
    }
});

test('by default the configured config.yaml is never written', () => {
    const cmd = S.opArgv('update-api', UPD_SRV, UPD_PLAN)[2];
    assert.match(cmd, /--exclude='\.\/release\/conf\/config\.yaml'/,
        'the upstream file must be excluded, not restored afterwards');
});

test('replacing config.yaml is opt-in, and only then is the exclude dropped', () => {
    const reset = S.opArgv('update-api', UPD_SRV, Object.assign({}, UPD_PLAN, { resetConfig: true }))[2];
    assert.ok(reset.indexOf('--exclude') === -1, 'the operator asked for the upstream file');
    // ...and a copy is still taken, so "reset" is recoverable.
    assert.match(reset, /cp -a '\/opt\/rustdesk-api\/conf\/config\.yaml'/);
});

test('the checksum is verified BEFORE the service is stopped or anything unpacked', () => {
    const cmd = S.opArgv('update-api', UPD_SRV, UPD_PLAN)[2];
    const verify = cmd.indexOf('sha256sum -c -');
    const stop = cmd.indexOf('systemctl stop');
    const unpack = cmd.indexOf('tar xzf');
    assert.ok(verify > 0 && stop > 0 && unpack > 0, 'all three steps must be present');
    assert.ok(verify < stop, 'a corrupt download must not reach a running server');
    assert.ok(verify < unpack, 'and must never be unpacked');
});

test('the update backs up the config and the database before touching anything', () => {
    const cmd = S.opArgv('update-api', UPD_SRV, UPD_PLAN)[2];
    assert.match(cmd, /cp -a '\/opt\/rustdesk-api\/conf\/config\.yaml' '\/opt\/rustdesk-api\/conf\/config\.yaml\.20260807T120000Z'/);
    assert.match(cmd, /rustdeskapi\.db\.20260807T120000Z/);
    // The db copy must not abort the update if the file is not there yet.
    assert.match(cmd, /rustdeskapi\.db[^;]*\|\| true/);
});

test('the update fails loudly rather than leaving a half-installed server', () => {
    for (const id of ['update-api', 'update-server']) {
        const cmd = S.opArgv(id, UPD_SRV, UPD_PLAN)[2];
        assert.ok(cmd.indexOf('set -e') === 0, id + ' must stop at the first failing command');
        assert.match(cmd, /systemctl is-active/, id + ' must prove the service came back');
    }
});

test('the server update keeps the keypair and the old binaries', () => {
    const cmd = S.opArgv('update-server', UPD_SRV, UPD_PLAN)[2];
    // The keypair lives in the data directory, not beside the binaries.
    assert.ok(cmd.indexOf('id_ed25519') === -1, 'nothing may touch the keypair');
    assert.match(cmd, /cp -a '\/usr\/local\/bin'\/\$b/, 'the old binaries are kept');
    assert.match(cmd, /test -x '\/usr\/local\/bin\/hbbs'/, 'and the new one is proven executable');
});

test('both updates are destructive ops, so they inherit the confirmation', () => {
    for (const id of ['update-api', 'update-server']) {
        const op = S.OPS.find((o) => o.id === id);
        assert.equal(op.danger, true, id + ' restarts a live service');
        assert.ok(S.DANGER_OPS.indexOf(id) !== -1);
        assert.ok(Array.isArray(op.impact) && op.impact.length >= 3);
        assert.equal(typeof op.reversible, 'boolean');
    }
});

test('the config choice is declared, defaults off, and states its cost', () => {
    const op = S.OPS.find((o) => o.id === 'update-api');
    assert.equal(op.options.length, 1);
    assert.equal(op.options[0].key, 'resetConfig');
    assert.match(op.options[0].warn, /id-server|key/i,
        'the warning must name what is lost, not merely say "settings"');
    const c = S.serverOpsUi({});
    c.server = UPD_SRV;
    c.request('update-api');
    assert.equal(c.confirm.opts.resetConfig, false, 'every option starts off');
    assert.deepEqual(c.confirmOptions().map((o) => o.key), ['resetConfig']);
});

test('an op with no options renders none', () => {
    const c = S.serverOpsUi({});
    c.server = UPD_SRV;
    c.request('restart-hbbs');
    assert.deepEqual(c.confirmOptions(), []);
    assert.deepEqual(c.confirm.opts, {});
});

test('the plan comes from the check, and is null until one has run', () => {
    const c = S.serverOpsUi({});
    assert.equal(c.updatePlanFor('update-api'), null, 'no check, no release, no command');
    c.updates = { 'update-api': { latest: '2.8', url: 'https://x/y', sha256: 'e'.repeat(64), stamp: 'z' } };
    assert.deepEqual(c.updatePlanFor('update-api'),
        { url: 'https://x/y', sha256: 'e'.repeat(64), version: '2.8', stamp: 'z' });
});

test('the dialog renders each option with its warning', () => {
    const t = S.TEMPLATE;
    assert.match(t, /x-for="o in confirmOptions\(\)"/);
    assert.match(t, /x-model="confirm\.opts\[o\.key\]"/);
    assert.match(t, /x-text="o\.warn"/, 'the cost is shown beside the choice');
});


// ============================ the update CHECK: what is installed vs what exists

test('parseVersions reads the report, and a missing component is empty not "none"', () => {
    assert.deepEqual(S.parseVersions('arch=aarch64\napi=2.7\nhbbs=1.4.3'),
        { arch: 'aarch64', api: '2.7', hbbs: '1.4.3' });
    // 'none' is the op's own word for not-installed and must not leak out as a
    // version string that then gets compared against a release tag.
    assert.deepEqual(S.parseVersions('arch=x86_64\napi=none\nhbbs=none'),
        { arch: 'x86_64', api: '', hbbs: '' });
    // A report tolerates noise rather than throwing.
    assert.deepEqual(S.parseVersions('junk\n\napi=2.7\n= \nhbbs=1.4.3'),
        { arch: '', api: '2.7', hbbs: '1.4.3' });
    for (const bad of [null, undefined, 42, {}])
        assert.deepEqual(S.parseVersions(bad), { arch: '', api: '', hbbs: '' });
});

test('a release tag and an installed marker compare on the numbers, not the text', () => {
    // The two traps: the leading v, and string ordering.
    assert.equal(S.isNewer('v2.7', '2.7'), false, 'v2.7 IS 2.7 -- offering it would reinstall');
    assert.equal(S.isNewer('v2.8', '2.7'), true);
    assert.equal(S.isNewer('2.10', '2.9'), true, "'2.10' < '2.9' as text");
    assert.equal(S.isNewer('2.6', '2.7'), false, 'never offer a downgrade');
    assert.equal(S.isNewer('1.4.3', '1.4.3'), false);
    // Nothing installed, or nothing published: not an update.
    for (const [a, b] of [['', '2.7'], ['v2.8', ''], ['', '']])
        assert.equal(S.isNewer(a, b), false, JSON.stringify([a, b]));
});

test('the asset filename comes from ostarget, which names ARM differently per project', () => {
    // rustdesk-server publishes arm64v8, rustdesk-api publishes arm64, for the
    // same machine. One shared guess 404s on half of all ARM installs.
    const OT = require('../../js/core/ostarget.js');
    assert.notEqual(OT.apiAsset('aarch64').name, OT.serverAsset('aarch64').name);
    const apiRel = { assets: [{ name: OT.apiAsset('aarch64').name,
        browser_download_url: 'https://x/a', digest: 'sha256:' + 'a'.repeat(64) }] };
    const srvRel = { assets: [{ name: OT.serverAsset('aarch64').name,
        browser_download_url: 'https://x/s', digest: 'sha256:' + 'b'.repeat(64) }] };
    assert.equal(S.pickReleaseAsset(apiRel, 'aarch64', 'api').url, 'https://x/a');
    assert.equal(S.pickReleaseAsset(srvRel, 'aarch64', 'server').url, 'https://x/s');
    // ...and each refuses the other's archive.
    assert.equal(S.pickReleaseAsset(apiRel, 'aarch64', 'server'), null);
    assert.equal(S.pickReleaseAsset(srvRel, 'aarch64', 'api'), null);
});

test('an asset with no publisher checksum is refused, never installed unverified', () => {
    // There is no pinned digest for a release that did not exist when Pilot was
    // built, so the release document is the only trustworthy source.
    const name = require('../../js/core/ostarget.js').apiAsset('aarch64').name;
    for (const digest of [undefined, '', 'md5:abc', 'sha256:zz', 'sha256:' + 'a'.repeat(63)]) {
        const rel = { assets: [{ name: name, browser_download_url: 'https://x/y', digest: digest }] };
        assert.equal(S.pickReleaseAsset(rel, 'aarch64', 'api'), null, JSON.stringify(digest));
    }
});

test('an unknown architecture yields no asset rather than a wrong one', () => {
    const name = require('../../js/core/ostarget.js').apiAsset('aarch64').name;
    const rel = { assets: [{ name: name, browser_download_url: 'https://x/y',
        digest: 'sha256:' + 'a'.repeat(64) }] };
    for (const arch of ['', 'sparc', null, undefined])
        assert.equal(S.pickReleaseAsset(rel, arch, 'api'), null, String(arch));
});

test('the versions op reads hbbs from PATH or from Pilot\'s bin dir', () => {
    // hbbs arrives two ways: Pilot unpacks the release zip into /usr/local/bin,
    // a distribution package puts it in /usr/bin. Reading only one reported
    // "no hbbs installed" on a server that plainly had one -- found by running
    // this against the real deployment.
    const cmd = S.opArgv('versions', REMOTE_WITH_CRED)[2];
    assert.match(cmd, /command -v hbbs/, 'PATH first');
    assert.match(cmd, /\/usr\/local\/bin\/hbbs/, 'then where Pilot installs it');
    assert.match(cmd, /resources\/version/, 'the API version marker');
    assert.match(cmd, /uname -m/, 'the arch that chooses the asset');
});

test('checking is a read-only op, so it needs no confirmation', () => {
    const op = S.OPS.find((o) => o.id === 'versions');
    assert.equal(op.danger, false);
    assert.ok(!op.impact, 'a read needs no impact statement');
    assert.equal(S.DANGER_OPS.indexOf('versions'), -1);
});


test('an update button is disabled until a check has found a release, and says why', () => {
    const c = S.serverOpsUi({});
    c.server = { id: 's', transport: 'ssh', host: 'h', hasCredential: true };
    for (const id of ['update-api', 'update-server']) {
        assert.equal(c.opDisabled(id), true, id + ' must not be clickable with no release chosen');
        assert.match(c.reasonBlocked(id), /Check for updates/,
            'the reason must name the action that unblocks it');
    }
    // The other ops are unaffected by the update state.
    assert.equal(c.opDisabled('restart-hbbs'), false);
    assert.equal(c.opDisabled('status'), false);
    c.updates = { 'update-api': { latest: '2.8', installed: '2.7', repo: 'a/b',
        url: 'https://x', sha256: 'f'.repeat(64) } };
    assert.equal(c.opDisabled('update-api'), false, 'a found release unlocks it');
    assert.equal(c.opDisabled('update-server'), true, 'and only the one that was found');
});

test('the report renders only after a check, and never claims "up to date" before one', () => {
    const t = S.TEMPLATE;
    assert.match(t, /x-if="installed\.arch"/,
        'nothing may be reported until the target has actually been read');
    assert.match(t, /data-testid="update-report"/);
    assert.match(t, /data-testid="update-none"/);
    // The version transition is shown, so the operator sees what would install.
    assert.match(t, /updates\[op\.id\]\.installed/);
    assert.match(t, /updates\[op\.id\]\.latest/);
    assert.match(t, /updates\[op\.id\]\.repo/, 'and which repository it came from');
});


// ========== FIELD REPORT: "they are disabled right now is it because they are on the latest?"
//
// Exactly the question a disabled button with no explanation provokes. Two very
// different facts produced the identical greyed-out control: "no check has run"
// (a thing to do) and "you are already current" (a result). And the reason line
// was gated on !isOpAllowed(), which is FALSE for these ops -- they are allowed,
// they hold a credential -- so nothing was rendered at all.

test('the blocked reason distinguishes "not checked yet" from "already current"', () => {
    const c = S.serverOpsUi({});
    c.server = { id: 's', transport: 'ssh', host: 'h', hasCredential: true };

    assert.match(c.reasonBlocked('update-api'), /Check for updates/,
        'before a check, name the action that resolves it');

    c.checked = true;
    c.installed = { arch: 'aarch64', api: '2.7', hbbs: '1.4.3' };
    c.checkedRepos = { 'update-api': 'lejianwen/rustdesk-api', 'update-server': 'wy414012/rustdesk-server' };
    const api = c.reasonBlocked('update-api');
    assert.match(api, /Already at the latest release/, 'after a check, report the result');
    assert.match(api, /2\.7/, 'and say which version that is');
    assert.match(api, /lejianwen\/rustdesk-api/, 'and which repository was consulted');
    assert.match(c.reasonBlocked('update-server'), /1\.4\.3/);
});

test('a component that is absent or unconfigured says so, not "already current"', () => {
    const c = S.serverOpsUi({});
    c.server = { id: 's', transport: 'ssh', host: 'h', hasCredential: true };
    c.checked = true;
    c.installed = { arch: 'aarch64', api: '', hbbs: '1.4.3' };
    c.checkedRepos = { 'update-api': 'a/b', 'update-server': 'c/d' };
    assert.match(c.reasonBlocked('update-api'), /not installed/,
        'claiming an absent component is up to date would be a lie');
    c.installed.api = '2.7';
    c.checkedRepos['update-api'] = '';
    assert.match(c.reasonBlocked('update-api'), /No repository is configured/);
    assert.match(c.reasonBlocked('update-api'), /Settings/, 'and where to fix it');
});

test('the reason renders whenever the button is disabled, not only when disallowed', () => {
    const t = S.TEMPLATE;
    // The bug: these ops ARE allowed (they hold a credential) and are disabled
    // for a different reason, so a condition on isOpAllowed rendered nothing.
    assert.match(t, /x-show="opDisabled\(op\.id\) && !isBusy\(op\.id\)"/);
    assert.ok(!/x-show="!isOpAllowed\(op\.id\)"/.test(t),
        'gating on isOpAllowed alone leaves the update ops unexplained');
});
