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
    assert.equal(S.OPS.length, 8);
    const ids = S.OPS.map((o) => o.id);
    assert.deepEqual(ids, ['status', 'restart-hbbs', 'restart-hbbr', 'restart-api',
        'relay-log', 'doctor', 'recheck-ports', 'rotate-key']);
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
    for (const op of S.OPS) {
        const argv = S.opArgv(op.id, serverWithSecretLookingField);
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

test('opArgv: doctor and recheck-ports', () => {
    assert.deepEqual(S.opArgv('doctor', LOCAL), ['rustdesk-utils', 'doctor']);
    assert.deepEqual(S.opArgv('recheck-ports', LOCAL), ['ss', '-H', '-ltnu']);
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
        }
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
            assert.equal(envelope.ssh.host, REMOTE_WITH_CRED.host);
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
