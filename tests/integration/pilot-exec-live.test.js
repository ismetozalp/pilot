// Live integration tests for libexec/pilot-exec against throwaway containers.
//
// The regression this suite exists to catch is DIVERGENCE BETWEEN TRANSPORTS:
// the same envelope is executed over transport 'local' inside one container and
// over transport 'ssh' into a second, and the two JSON-line streams must be
// identical once run_id, transport and timings are removed. Everything else here
// — adopt-not-reinstall, failure injection, idempotency, redaction on a real
// on-disk transcript — is asserted against a real filesystem, not a fake.
//
// Never runs against anything but a container it created and destroys.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', '..', 'libexec', 'pilot-exec');
const TAG = 'localhost/pilot-exec-test:1';
const MASK = '••••••';

function sh(cmd, args, opts) {
    return spawnSync(cmd, args, Object.assign({ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, opts || {}));
}

function onPath(cmd) {
    return sh('sh', ['-c', 'command -v ' + cmd]).status === 0;
}

function sleepMs(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const REQUIRE_LIVE = process.env.PILOT_LIVE_REQUIRE === '1';

const NEEDED = ['podman', 'ssh', 'ssh-keygen', 'ssh-keyscan'];
const MISSING = NEEDED.filter((c) => !onPath(c));
let unavailable = MISSING.length ? 'not on PATH: ' + MISSING.join(', ') : false;

const CONTAINERFILE = [
    'FROM docker.io/library/debian:12-slim',
    'RUN apt-get update && apt-get install -y --no-install-recommends \\',
    '      openssh-server python3 procps coreutils ca-certificates sudo iproute2 \\',
    '    && rm -rf /var/lib/apt/lists/*',
    'RUN mkdir -p /run/sshd && ssh-keygen -A \\',
    "    && sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config",
    'CMD ["/usr/sbin/sshd","-D","-e"]',
    ''
].join('\n');

// The image is built once, at load time, because node:test evaluates `skip`
// when the test is registered rather than when it runs.
if (!unavailable) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-img-'));
    fs.writeFileSync(path.join(dir, 'Containerfile'), CONTAINERFILE);
    const built = sh('podman', ['build', '-q', '-t', TAG, dir], { timeout: 900000 });
    if (built.status !== 0) {
        unavailable = 'podman build failed: ' +
            String(built.stderr || '').trim().split('\n').slice(-2).join(' ');
    }
}

if (unavailable && REQUIRE_LIVE) {
    throw new Error('PILOT_LIVE_REQUIRE=1 but live tests cannot run: ' + unavailable);
}

const SKIP = unavailable;
if (SKIP) {
    console.log('pilot-exec-live: SKIPPING all live tests: ' + SKIP);
}

// --- container lifecycle --------------------------------------------------

const started = [];

function startContainer(name, publishSsh) {
    sh('podman', ['rm', '-f', name]);
    let port = 0;
    let created = null;
    // A random port collides often enough to have failed a real run ("Failed to
    // bind port ... Address already in use"), which reads as a product failure
    // rather than the harness clash it is. Retry on a fresh port instead.
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const args = ['run', '-d', '--name', name];
        if (publishSsh) {
            port = 21000 + Math.floor(Math.random() * 15000);
            args.push('-p', '127.0.0.1:' + port + ':22');
        }
        args.push(TAG);
        created = sh('podman', args);
        if (created.status === 0) break;
        if (!publishSsh || !/address already in use/i.test(String(created.stderr))) break;
        sh('podman', ['rm', '-f', name]);
    }
    assert.equal(created.status, 0, 'podman run failed: ' + created.stderr);
    started.push(name);
    assert.equal(sh('podman', ['cp', HELPER, name + ':/usr/local/bin/pilot-exec']).status, 0);
    assert.equal(sh('podman', ['exec', name, 'chmod', '0755', '/usr/local/bin/pilot-exec']).status, 0);
    return port;
}

function destroyAll() {
    for (const name of started.splice(0)) sh('podman', ['rm', '-f', name]);
}

function authoriseKey(name, publicKey) {
    assert.equal(sh('podman', ['exec', name, 'mkdir', '-p', '-m', '0700', '/root/.ssh']).status, 0);
    const written = sh('podman', ['exec', '-i', name, 'sh', '-c',
        'cat > /root/.ssh/authorized_keys && chmod 0600 /root/.ssh/authorized_keys'],
        { input: publicKey });
    assert.equal(written.status, 0, written.stderr);
}

function waitForSshd(port) {
    for (let i = 0; i < 60; i += 1) {
        const scan = sh('ssh-keyscan', ['-T', '2', '-p', String(port), '127.0.0.1']);
        if (scan.status === 0 && /ssh-/.test(scan.stdout || '')) return true;
        sleepMs(500);
    }
    return false;
}

function makeKeypair() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-key-'));
    const file = path.join(dir, 'id_ed25519');
    const gen = sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'pilot-test', '-f', file]);
    assert.equal(gen.status, 0, gen.stderr);
    return { pem: fs.readFileSync(file, 'utf8'), pub: fs.readFileSync(file + '.pub', 'utf8') };
}

// --- driving pilot-exec ---------------------------------------------------

function parseLines(text) {
    return String(text || '').split('\n').filter((l) => l.trim() !== '').map((l, i) => {
        try {
            return JSON.parse(l);
        } catch (e) {
            throw new Error('protocol line ' + i + ' is not JSON: ' + l);
        }
    });
}

function runInContainer(name, envelope, mode) {
    const r = sh('podman', ['exec', '-i', '-e', 'PILOT_RUNS_DIR=/var/lib/pilot/runs', name,
        'python3', '/usr/local/bin/pilot-exec', mode || '--run'],
        { input: JSON.stringify(envelope), timeout: 60000 });
    return { code: r.status, lines: parseLines(r.stdout), raw: r.stdout || '', err: r.stderr || '' };
}

function runOnHost(envelope, env, mode) {
    const r = sh('python3', [HELPER, mode || '--run'], {
        input: JSON.stringify(envelope),
        env: Object.assign({}, process.env, env),
        timeout: 60000
    });
    return { code: r.status, lines: parseLines(r.stdout), raw: r.stdout || '', err: r.stderr || '' };
}

function normalise(lines) {
    return lines.map((line) => {
        const copy = Object.assign({}, line);
        delete copy.ms;
        delete copy.run_id;
        delete copy.transport;
        return copy;
    });
}

const outcomes = (lines) => lines.filter((l) => l.t === 'step-end')
    .map((l) => l.id + ':' + l.status);

// --- the shared envelope --------------------------------------------------

const PAYLOAD = 'rustdesk-api-payload\n';
const DIGEST = crypto.createHash('sha256').update(PAYLOAD).digest('hex');
const HBBS = '#!/bin/sh\nwhile :; do sleep 3600; done\n';

function step(over) {
    return Object.assign({
        id: 'noop', title: 'Do nothing', mutating: false, why: 'because',
        argv: ['python3', '-c', 'pass'], write: null, check: null, sha256: null, secret: false
    }, over || {});
}

// Executed identically on both transports. Every command is deterministic and
// needs no network, so the two streams are comparable byte for byte.
function paritySteps() {
    return [
        step({
            id: 'cache-dir', title: 'Create the download cache', mutating: true,
            why: 'downloads land in a known directory',
            argv: ['install', '-d', '-m', '0755', '/var/cache/pilot'],
            check: { argv: ['test', '-d', '/var/cache/pilot'], expect: 'zero' }
        }),
        step({
            id: 'seed-payload', title: 'Stage the payload', mutating: true,
            why: 'stands in for a release asset', argv: [],
            write: { path: '/var/cache/pilot/src.bin', mode: '0644',
                content: PAYLOAD, owner: 'root:root' }
        }),
        step({
            id: 'fetch-api', title: 'Download API server', mutating: true,
            why: 'the API server is not installed',
            // The C14 shape exactly: -o is its own element, followed by the
            // destination. python3 stands in for curl so no network is needed.
            argv: ['python3', '-c', 'import sys, shutil; shutil.copyfile(sys.argv[1], sys.argv[3])',
                '/var/cache/pilot/src.bin', '-o', '/var/cache/pilot/api.tar.gz'],
            sha256: DIGEST
        }),
        step({
            id: 'verify', title: 'Verify the download', mutating: false,
            why: 'prove the file landed',
            argv: ['python3', '-c', 'print("pilot-parity-ok")']
        })
    ];
}

function hbbsSteps() {
    return [
        step({
            id: 'install-hbbs', title: 'Install hbbs', mutating: true,
            why: 'no RustDesk server was detected', argv: [],
            write: { path: '/usr/local/bin/hbbs', mode: '0755', content: HBBS, owner: 'root:root' },
            check: { argv: ['test', '-x', '/usr/local/bin/hbbs'], expect: 'zero' }
        }),
        step({
            id: 'start-hbbs', title: 'Start hbbs', mutating: true,
            why: 'the service must be running',
            argv: ['sh', '-c', 'setsid /usr/local/bin/hbbs >/dev/null 2>&1 & echo $! > /run/hbbs.pid'],
            check: { argv: ['sh', '-c', 'kill -0 "$(cat /run/hbbs.pid 2>/dev/null)" 2>/dev/null'],
                expect: 'zero' }
        }),
        step({
            id: 'adopt-hbbs', title: 'Record the running server', mutating: false,
            why: 'an existing hbbs is adopted, never reinstalled',
            argv: ['test', '-x', '/usr/local/bin/hbbs']
        })
    ];
}

function envelope(steps, over) {
    return Object.assign({
        version: 1, transport: 'local', run_id: '20260803T204500Z',
        ssh: null, credentials: null, steps: steps
    }, over || {});
}

// --- transport parity -----------------------------------------------------

test('both transports run the same envelope to identical JSON lines', { skip: SKIP }, (t) => {
    t.after(destroyAll);
    const localName = 'pilot-parity-local';
    const sshName = 'pilot-parity-ssh';
    startContainer(localName, false);
    const port = startContainer(sshName, true);
    const keys = makeKeypair();
    authoriseKey(sshName, keys.pub);
    assert.equal(waitForSshd(port), true, 'sshd never came up in ' + sshName);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-parity-'));
    const knownHosts = path.join(dir, 'known_hosts');
    const hostEnv = { PILOT_RUNS_DIR: path.join(dir, 'runs'), PILOT_KNOWN_HOSTS: knownHosts };

    const probe = runOnHost({ host: '127.0.0.1', port: port }, hostEnv, '--check-hostkey');
    assert.equal(probe.code, 0, probe.err);
    const key = probe.lines[0];
    assert.deepEqual(Object.keys(key).sort(), ['fingerprint', 'kind', 'known']);
    assert.equal(key.known, false, 'a fresh container must be an unknown host');
    assert.equal(key.kind, 'SSH_HOSTKEY_UNKNOWN');
    assert.match(key.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);

    const localRun = runInContainer(localName, envelope(paritySteps()));
    assert.equal(localRun.code, 0, localRun.err);

    const sshRun = runOnHost(envelope(paritySteps(), {
        transport: 'ssh', run_id: '20260803T210000Z',
        ssh: { host: '127.0.0.1', port: port, user: 'root', auth: 'pem',
            accept_fingerprint: key.fingerprint },
        credentials: { password: null, pem: keys.pem }
    }), hostEnv);
    assert.equal(sshRun.code, 0, sshRun.err);

    assert.deepEqual(normalise(sshRun.lines), normalise(localRun.lines),
        'the transports diverged on the same envelope');
    assert.deepEqual(outcomes(localRun.lines),
        ['cache-dir:ok', 'seed-payload:ok', 'fetch-api:ok', 'verify:ok']);
    assert.equal(localRun.lines[0].transport, 'local');
    assert.equal(sshRun.lines[0].transport, 'ssh');

    // The confirmed key was recorded, so a second run needs no confirmation.
    assert.match(fs.readFileSync(knownHosts, 'utf8'),
        new RegExp('^\\[127\\.0\\.0\\.1\\]:' + port + ' ssh-', 'm'));
    const second = runOnHost(envelope(paritySteps(), {
        transport: 'ssh', run_id: '20260803T210500Z',
        ssh: { host: '127.0.0.1', port: port, user: 'root', auth: 'pem',
            accept_fingerprint: null },
        credentials: { password: null, pem: keys.pem }
    }), hostEnv);
    assert.equal(second.code, 0, second.err);
});

test('a changed host key is a hard stop even for an already-trusted host', { skip: SKIP }, (t) => {
    t.after(destroyAll);
    const name = 'pilot-hostkey-changed';
    const port = startContainer(name, true);
    const keys = makeKeypair();
    authoriseKey(name, keys.pub);
    assert.equal(waitForSshd(port), true);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-hk-'));
    const knownHosts = path.join(dir, 'known_hosts');
    // Record a key that is real in form but is not this host's.
    const other = makeKeypair();
    const untrustedRecord = '[127.0.0.1]:' + port + ' ' +
        other.pub.trim().split(/\s+/).slice(0, 2).join(' ') + '\n';
    fs.writeFileSync(knownHosts, untrustedRecord);
    const hostEnv = { PILOT_RUNS_DIR: path.join(dir, 'runs'), PILOT_KNOWN_HOSTS: knownHosts };
    // Captured before either hard-stop call, so a bug that persists the
    // ATTACKER's key on the SSH_HOSTKEY_CHANGED path — silently trusting it
    // while still refusing this one connection — shows up as a diff below
    // instead of passing unnoticed.
    const knownHostsBefore = fs.readFileSync(knownHosts, 'utf8');

    const probe = runOnHost({ host: '127.0.0.1', port: port }, hostEnv, '--check-hostkey');
    assert.equal(probe.code, 5);
    assert.equal(probe.lines[0].kind, 'SSH_HOSTKEY_CHANGED');
    assert.equal(probe.lines[0].known, true);
    assert.equal(fs.readFileSync(knownHosts, 'utf8'), knownHostsBefore,
        'a rejected --check-hostkey probe rewrote the stored host key');

    const sentinelStep = step({ id: 'must-not-run', mutating: true,
        argv: ['touch', '/tmp/pilot-must-not-exist'] });
    const run = runOnHost(envelope([sentinelStep], {
        transport: 'ssh', run_id: '20260803T211000Z',
        ssh: { host: '127.0.0.1', port: port, user: 'root', auth: 'pem',
            accept_fingerprint: probe.lines[0].fingerprint },
        credentials: { password: null, pem: keys.pem }
    }), hostEnv);
    assert.equal(run.code, 5, 'a changed key must never be auto-accepted');
    assert.deepEqual(run.lines[run.lines.length - 1],
        { t: 'run-end', status: 'failed', kind: 'SSH_HOSTKEY_CHANGED' });
    assert.equal(sh('podman', ['exec', name, 'test', '-e', '/tmp/pilot-must-not-exist']).status !== 0,
        true, 'a step ran despite the host-key hard stop');
    // The critical property: a hard-stopped run must not have persisted the
    // offered (attacker) key over the previously-trusted one. If it did, the
    // NEXT run against the real host would sail through as "known" with the
    // wrong key on file — the exact MITM-persistence bug this test exists to
    // catch.
    assert.equal(fs.readFileSync(knownHosts, 'utf8'), untrustedRecord,
        'the stored host key was rewritten by a run that hard-stopped on SSH_HOSTKEY_CHANGED');
});

// --- greenfield, then adopt ----------------------------------------------

test('a greenfield install adopts on re-run and never restarts hbbs', { skip: SKIP }, (t) => {
    t.after(destroyAll);
    const name = 'pilot-greenfield';
    startContainer(name, false);

    const first = runInContainer(name, envelope(hbbsSteps()));
    assert.equal(first.code, 0, first.err);
    assert.deepEqual(outcomes(first.lines),
        ['install-hbbs:ok', 'start-hbbs:ok', 'adopt-hbbs:ok']);

    const pidBefore = sh('podman', ['exec', name, 'cat', '/run/hbbs.pid']).stdout.trim();
    assert.match(pidBefore, /^[0-9]+$/);
    assert.equal(sh('podman', ['exec', name, 'kill', '-0', pidBefore]).status, 0,
        'hbbs is not running after the greenfield install');

    const second = runInContainer(name, envelope(hbbsSteps(), { run_id: '20260803T212000Z' }));
    assert.equal(second.code, 0, second.err);
    assert.deepEqual(outcomes(second.lines),
        ['install-hbbs:skipped', 'start-hbbs:skipped', 'adopt-hbbs:ok'],
        'the re-run reinstalled instead of adopting');

    const pidAfter = sh('podman', ['exec', name, 'cat', '/run/hbbs.pid']).stdout.trim();
    assert.equal(pidAfter, pidBefore, 'hbbs was restarted by the adopt run');
    assert.equal(sh('podman', ['exec', name, 'kill', '-0', pidAfter]).status, 0,
        'hbbs is no longer running after the adopt run');
});

test('a full envelope is idempotent across three consecutive runs', { skip: SKIP }, (t) => {
    t.after(destroyAll);
    const name = 'pilot-idempotent';
    startContainer(name, false);
    const all = paritySteps().concat(hbbsSteps());

    const first = runInContainer(name, envelope(all, { run_id: '20260803T220000Z' }));
    assert.equal(first.code, 0, first.err);

    const second = runInContainer(name, envelope(all, { run_id: '20260803T220100Z' }));
    const third = runInContainer(name, envelope(all, { run_id: '20260803T220200Z' }));
    assert.equal(second.code, 0, second.err);
    assert.equal(third.code, 0, third.err);
    assert.deepEqual(outcomes(third.lines), outcomes(second.lines),
        'repeated runs did not converge');
    assert.deepEqual(outcomes(second.lines), [
        'cache-dir:skipped', 'seed-payload:ok', 'fetch-api:ok', 'verify:ok',
        'install-hbbs:skipped', 'start-hbbs:skipped', 'adopt-hbbs:ok'
    ]);
    // Each run keeps its own transcript rather than overwriting the last one.
    const listed = sh('podman', ['exec', name, 'ls', '/var/lib/pilot/runs']).stdout;
    for (const id of ['20260803T220000Z', '20260803T220100Z', '20260803T220200Z']) {
        assert.match(listed, new RegExp(id + '\\.jsonl'));
    }
});

// --- failure injection ----------------------------------------------------

test('failure at a middle step reports partial, stops, and retains the transcript', { skip: SKIP }, (t) => {
    t.after(destroyAll);
    const name = 'pilot-failure';
    startContainer(name, false);

    const steps = paritySteps();
    steps.splice(3, 0, step({
        id: 'unit', title: 'Install the unit file', mutating: true,
        why: 'inject a failure', argv: ['python3', '-c', 'raise SystemExit(5)']
    }));
    const r = runInContainer(name, envelope(steps, { run_id: '20260803T230000Z' }));
    assert.equal(r.code, 1);
    assert.deepEqual(outcomes(r.lines),
        ['cache-dir:ok', 'seed-payload:ok', 'fetch-api:ok', 'unit:failed']);
    assert.equal(r.lines.filter((l) => l.t === 'step-end').pop().exit, 5);
    assert.deepEqual(r.lines[r.lines.length - 1],
        { t: 'run-end', status: 'partial', kind: 'GENERIC' });
    assert.equal(r.lines.some((l) => l.t === 'step-start' && l.id === 'verify'), false,
        'a step after the failure was started');

    const transcript = sh('podman', ['exec', name, 'cat',
        '/var/lib/pilot/runs/20260803T230000Z.jsonl']);
    assert.equal(transcript.status, 0, 'the transcript was not retained after a failure');
    assert.equal(transcript.stdout, r.raw);

    // Re-running after fixing the failure completes, without hand-cleaning.
    const fixed = runInContainer(name, envelope(paritySteps(), { run_id: '20260803T230500Z' }));
    assert.equal(fixed.code, 0, fixed.err);
    assert.deepEqual(outcomes(fixed.lines),
        ['cache-dir:skipped', 'seed-payload:ok', 'fetch-api:ok', 'verify:ok']);
});

test('a checksum mismatch on a real download is a hard stop with exit 6', { skip: SKIP }, (t) => {
    t.after(destroyAll);
    const name = 'pilot-checksum';
    startContainer(name, false);

    const steps = paritySteps();
    steps[2] = Object.assign({}, steps[2], { sha256: 'b'.repeat(64) });
    steps[3] = step({ id: 'verify', mutating: true, why: 'must not run',
        argv: ['touch', '/tmp/pilot-past-checksum'] });

    const r = runInContainer(name, envelope(steps, { run_id: '20260803T231000Z' }));
    assert.equal(r.code, 6);
    assert.deepEqual(r.lines[r.lines.length - 1],
        { t: 'run-end', status: 'failed', kind: 'CHECKSUM_MISMATCH' });
    assert.equal(sh('podman', ['exec', name, 'test', '-e', '/tmp/pilot-past-checksum']).status !== 0,
        true, 'the run continued past a checksum mismatch');
    assert.match(r.raw, /sha256 mismatch for \/var\/cache\/pilot\/api\.tar\.gz/);
});

// --- redaction on a transcript produced by a real run --------------------

test('no credential survives a real run, on stdout or on disk, on either transport', { skip: SKIP }, (t) => {
    t.after(destroyAll);
    const name = 'pilot-redact-ssh';
    const port = startContainer(name, true);
    const keys = makeKeypair();
    authoriseKey(name, keys.pub);
    assert.equal(waitForSshd(port), true);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-redact-'));
    const runs = path.join(dir, 'runs');
    const hostEnv = { PILOT_RUNS_DIR: runs, PILOT_KNOWN_HOSTS: path.join(dir, 'known_hosts') };
    const probe = runOnHost({ host: '127.0.0.1', port: port }, hostEnv, '--check-hostkey');
    assert.equal(probe.code, 0, probe.err);

    const password = 'hunter2horse-live-secret';
    const token = 'sk-live-3f9a2c8e14b7';
    const steps = [
        step({
            id: 'stash-token', title: 'Write the API token', mutating: true, secret: true,
            why: 'the token is written to a 0600 file', argv: [],
            write: { path: '/root/api.token', mode: '0600', content: token + '\n',
                owner: 'root:root' }
        }),
        step({ id: 'show-token', title: 'Read it back', why: 'prove output is scrubbed',
            argv: ['cat', '/root/api.token'] }),
        step({ id: 'echo-password', title: 'Print the password', why: 'prove cmd is scrubbed',
            argv: ['python3', '-c', 'print("psk=' + password + '")'] })
    ];

    const r = runOnHost(envelope(steps, {
        transport: 'ssh', run_id: '20260803T230000Z',
        ssh: { host: '127.0.0.1', port: port, user: 'root', auth: 'pem',
            accept_fingerprint: probe.lines[0].fingerprint },
        credentials: { password: password, pem: keys.pem }
    }), hostEnv);
    assert.equal(r.code, 0, r.err);

    for (const secret of [password, token, keys.pem.trim()]) {
        assert.equal(r.raw.includes(secret), false, 'a secret reached stdout');
        assert.equal(r.err.includes(secret), false, 'a secret reached stderr');
    }
    assert.ok(r.raw.includes(MASK), 'nothing was masked at all');
    assert.equal(r.lines.find((l) => l.t === 'step-start' && l.id === 'stash-token').cmd, MASK);

    const file = path.join(runs, '20260803T230000Z.jsonl');
    assert.equal(fs.existsSync(file), true, 'no transcript was written');
    const onDisk = fs.readFileSync(file, 'utf8');
    for (const secret of [password, token, keys.pem.trim()]) {
        assert.equal(onDisk.includes(secret), false, 'a secret reached the on-disk transcript');
    }
    assert.equal(onDisk, r.raw);
    // And the PEM never lingers in a temp file after the run.
    assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('pilot-pem-')), []);
});

test('every mode refuses to run without exactly one mode flag, live', { skip: SKIP }, (t) => {
    t.after(destroyAll);
    const name = 'pilot-usage';
    startContainer(name, false);
    const r = sh('podman', ['exec', '-i', name, 'python3', '/usr/local/bin/pilot-exec'],
        { input: '' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /exactly one mode flag/);
});

// --- coverage gaps carried over from Task 12's review ---------------------
//
// These three close specific holes flagged in that review that the suite
// above does not happen to exercise: write_file's chown-failure branch (needs
// a real `chown` binary refusing a nonexistent owner), a chown to root:root
// that actually succeeds (needs real root, which only a container gives us
// here), and the ssh PEM temp file's lifecycle — mode 0600 while a run is in
// flight, and removed whether the run finishes cleanly or fails.

test('write_file surfaces a real chown failure as a failed step, not a crash', { skip: SKIP }, (t) => {
    t.after(destroyAll);
    const name = 'pilot-chown-fail';
    startContainer(name, false);

    const bad = step({
        id: 'bad-owner', title: 'Write with a nonexistent owner', mutating: true,
        why: 'exercise the chown-failure branch of write_file', argv: [],
        write: { path: '/var/cache/pilot/owned.txt', mode: '0644',
            content: 'x\n', owner: 'nosuchuser9:nosuchgroup9' }
    });
    const r = runInContainer(name, envelope([bad], { run_id: '20260803T232000Z' }));
    assert.equal(r.code, 1, 'a real chown failure must be a normal step failure, not a crash');
    assert.deepEqual(outcomes(r.lines), ['bad-owner:failed']);
    assert.deepEqual(r.lines[r.lines.length - 1],
        { t: 'run-end', status: 'failed', kind: 'GENERIC' });
    assert.match(r.raw, /chown/);
    assert.equal(sh('podman', ['exec', name, 'test', '-e', '/var/cache/pilot/owned.txt']).status,
        1, 'the target file must not exist after a failed chown');
    assert.equal(sh('podman', ['exec', name, 'test', '-e', '/var/cache/pilot/owned.txt.pilot-tmp']).status,
        1, 'the temp file must be cleaned up after a failed chown');
});

test('a write step chowned to root:root actually succeeds under real root', { skip: SKIP }, (t) => {
    t.after(destroyAll);
    const name = 'pilot-chown-ok';
    startContainer(name, false);

    const good = step({
        id: 'good-owner', title: 'Write owned by root:root', mutating: true,
        why: 'exercise a chown that really succeeds', argv: [],
        write: { path: '/var/cache/pilot/rootowned.txt', mode: '0640',
            content: 'y\n', owner: 'root:root' }
    });
    const r = runInContainer(name, envelope([good], { run_id: '20260803T232500Z' }));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(outcomes(r.lines), ['good-owner:ok']);

    const stat = sh('podman', ['exec', name, 'stat', '-c', '%U:%G %a', '/var/cache/pilot/rootowned.txt']);
    assert.equal(stat.status, 0);
    assert.equal(stat.stdout.trim(), 'root:root 640');
});

// The two tests above drive `runInContainer`, i.e. `--transport local`, so they
// only ever exercise `LocalTransport.write_file`. `SshTransport.write_file` is a
// structurally different implementation — a remote `/bin/sh -c` script doing
// `chmod; chown; mv -f` under `set -e`, not a direct chown subprocess — and was
// entirely untested by the pair above. These two are their ssh-transport
// siblings, standing up the same real root-over-ssh container this suite
// already uses for transport parity.

function setupSshHost(name) {
    const port = startContainer(name, true);
    const keys = makeKeypair();
    authoriseKey(name, keys.pub);
    assert.equal(waitForSshd(port), true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-ssh-'));
    const hostEnv = { PILOT_RUNS_DIR: path.join(dir, 'runs'),
        PILOT_KNOWN_HOSTS: path.join(dir, 'known_hosts') };
    const probe = runOnHost({ host: '127.0.0.1', port: port }, hostEnv, '--check-hostkey');
    assert.equal(probe.code, 0, probe.err);
    const fp = probe.lines[0].fingerprint;
    const sshOf = (over) => Object.assign({ host: '127.0.0.1', port: port, user: 'root',
        auth: 'pem', accept_fingerprint: fp }, over || {});
    return { hostEnv, sshOf, pem: keys.pem };
}

test('SshTransport.write_file surfaces a real remote chown failure as a failed step, not a crash',
    { skip: SKIP }, (t) => {
        t.after(destroyAll);
        const name = 'pilot-chown-fail-ssh';
        const { hostEnv, sshOf, pem } = setupSshHost(name);

        const bad = step({
            id: 'bad-owner', title: 'Write with a nonexistent owner', mutating: true,
            why: 'exercise the chown-failure branch of SshTransport.write_file', argv: [],
            write: { path: '/var/cache/pilot/owned.txt', mode: '0644',
                content: 'x\n', owner: 'nosuchuser9:nosuchgroup9' }
        });
        const r = runOnHost(envelope([bad], {
            transport: 'ssh', run_id: '20260804T000000Z',
            ssh: sshOf(), credentials: { password: null, pem: pem }
        }), hostEnv);
        assert.equal(r.code, 1,
            'a real chown failure over ssh must be a normal step failure, not a crash');
        assert.deepEqual(outcomes(r.lines), ['bad-owner:failed']);
        assert.deepEqual(r.lines[r.lines.length - 1],
            { t: 'run-end', status: 'failed', kind: 'GENERIC' });
        assert.match(r.raw, /chown/);
        assert.equal(sh('podman', ['exec', name, 'test', '-e', '/var/cache/pilot/owned.txt']).status,
            1, 'the target file must not exist after a failed remote chown');
        // Transport parity, asserted rather than assumed: LocalTransport.write_file
        // explicitly unlinks its temp file when chown fails (see the sibling
        // assertion in the local chown-failure test above). SshTransport.write_file's
        // remote script now carries an EXIT trap for exactly this reason — without
        // it, `set -e` would abort the script the instant `chown` failed, before
        // ever reaching `mv -f`, leaving `.pilot-tmp` (potentially secret content,
        // per a `secret: true` write step) behind on the remote host at a
        // predictable path. This was a real, confirmed gap; it is fixed in
        // libexec/pilot-exec and asserted here so a regression is caught live.
        assert.equal(
            sh('podman', ['exec', name, 'test', '-e', '/var/cache/pilot/owned.txt.pilot-tmp']).status,
            1, 'the remote temp file must be cleaned up after a failed chown, ' +
                'the same as LocalTransport');
    });

test('SshTransport.write_file chowns to root:root and succeeds over a real ssh connection',
    { skip: SKIP }, (t) => {
        t.after(destroyAll);
        const name = 'pilot-chown-ok-ssh';
        const { hostEnv, sshOf, pem } = setupSshHost(name);

        const good = step({
            id: 'good-owner', title: 'Write owned by root:root', mutating: true,
            why: 'exercise a chown that really succeeds over ssh', argv: [],
            write: { path: '/var/cache/pilot/rootowned.txt', mode: '0640',
                content: 'y\n', owner: 'root:root' }
        });
        const r = runOnHost(envelope([good], {
            transport: 'ssh', run_id: '20260804T000100Z',
            ssh: sshOf(), credentials: { password: null, pem: pem }
        }), hostEnv);
        assert.equal(r.code, 0, r.err);
        assert.deepEqual(outcomes(r.lines), ['good-owner:ok']);

        const stat = sh('podman', ['exec', name, 'stat', '-c', '%U:%G %a',
            '/var/cache/pilot/rootowned.txt']);
        assert.equal(stat.status, 0);
        assert.equal(stat.stdout.trim(), 'root:root 640');
        assert.equal(
            sh('podman', ['exec', name, 'test', '-e', '/var/cache/pilot/rootowned.txt.pilot-tmp']).status,
            1, 'the remote temp file must be gone after a successful write');
    });

function spawnWatched(env, extraEnv) {
    return new Promise((resolve, reject) => {
        const child = spawn('python3', [HELPER, '--run'], {
            env: Object.assign({}, process.env, extraEnv)
        });
        let out = '';
        let err = '';
        let sawPemFile = false;
        let pemMode600 = false;
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('pilot-exec did not exit within the watchdog timeout'));
        }, 30000);
        const poll = setInterval(() => {
            let files;
            try {
                files = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('pilot-pem-'));
            } catch (e) {
                files = [];
            }
            if (files.length) {
                sawPemFile = true;
                try {
                    const st = fs.statSync(path.join(os.tmpdir(), files[0]));
                    if ((st.mode & 0o777) === 0o600) pemMode600 = true;
                } catch (e) {
                    // file vanished between readdir and stat; the next poll tries again
                }
            }
        }, 15);
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => {
            clearTimeout(timer);
            clearInterval(poll);
            const remaining = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('pilot-pem-'));
            resolve({ code, raw: out, err, sawPemFile, pemMode600, remaining });
        });
        child.on('error', (e) => {
            clearTimeout(timer);
            clearInterval(poll);
            reject(e);
        });
        child.stdin.write(JSON.stringify(env));
        child.stdin.end();
    });
}

test('the ssh PEM temp file is 0600 in flight and gone after, on success and on failure',
    { skip: SKIP }, async (t) => {
        t.after(destroyAll);
        const name = 'pilot-pem-lifecycle';
        const port = startContainer(name, true);
        const keys = makeKeypair();
        authoriseKey(name, keys.pub);
        assert.equal(waitForSshd(port), true);

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-pemlife-'));
        const hostEnv = { PILOT_RUNS_DIR: path.join(dir, 'runs'),
            PILOT_KNOWN_HOSTS: path.join(dir, 'known_hosts') };

        const probe = runOnHost({ host: '127.0.0.1', port: port }, hostEnv, '--check-hostkey');
        assert.equal(probe.code, 0, probe.err);
        const fp = probe.lines[0].fingerprint;

        const sshOf = (over) => Object.assign({ host: '127.0.0.1', port: port, user: 'root',
            auth: 'pem', accept_fingerprint: fp }, over || {});

        // Success: several steps, each a fresh ssh invocation, so the pem file
        // sits on disk in /tmp for the whole multi-step run.
        const okSteps = [
            step({ id: 's1', mutating: true, argv: ['sh', '-c', 'sleep 0.2'] }),
            step({ id: 's2', mutating: true, argv: ['sh', '-c', 'sleep 0.2'] }),
            step({ id: 's3', argv: ['sh', '-c', 'sleep 0.2'] })
        ];
        const ok = await spawnWatched(envelope(okSteps, {
            transport: 'ssh', run_id: '20260803T233000Z',
            ssh: sshOf(), credentials: { password: null, pem: keys.pem }
        }), hostEnv);
        assert.equal(ok.code, 0, ok.err);
        assert.equal(ok.sawPemFile, true, 'the pem temp file was never observed on disk');
        assert.equal(ok.pemMode600, true, 'the pem temp file was not mode 0600 while in use');
        assert.deepEqual(ok.remaining, [], 'the pem temp file was not removed after a clean run');

        // Failure: a step fails mid-plan; the pem file must still be cleaned up
        // by the finally-block close(), not just on the happy path.
        const failSteps = [
            step({ id: 'f1', mutating: true, argv: ['sh', '-c', 'sleep 0.2'] }),
            step({ id: 'f2', mutating: true, argv: ['sh', '-c', 'sleep 0.2; exit 9'] }),
            step({ id: 'f3', argv: ['sh', '-c', 'sleep 0.2'] })
        ];
        const failed = await spawnWatched(envelope(failSteps, {
            transport: 'ssh', run_id: '20260803T233500Z',
            ssh: sshOf(), credentials: { password: null, pem: keys.pem }
        }), hostEnv);
        assert.equal(failed.code, 1, 'the injected failure must surface as a failed run');
        assert.equal(failed.sawPemFile, true,
            'the pem temp file was never observed on disk during the failing run');
        assert.equal(failed.pemMode600, true,
            'the pem temp file was not mode 0600 during the failing run');
        assert.deepEqual(failed.remaining, [],
            'the pem temp file was not removed after a failed run');
    });

// --- remote privilege escalation ------------------------------------------
//
// Found by hand against a real EC2 host. SshTransport escalated NOTHING: every
// remote command ran as the login user. A plan against the ordinary account of
// any cloud image -- ubuntu@, ec2-user@, admin@, debian@ -- therefore failed on
// its first step with "Permission denied" and kept going through the remaining
// 27. Connecting as root is not a workaround: most cloud images disable root
// SSH outright, and the user's own server is ubuntu@.
//
// Every other tier authorised root, which is precisely why nothing caught it.
// These tests create a genuinely unprivileged remote account and prove the
// three outcomes against a real sshd.

function makeUser(name, user, sudoers) {
    assert.equal(sh('podman', ['exec', name, 'useradd', '-m', '-s', '/bin/sh', user]).status, 0);
    assert.equal(sh('podman', ['exec', name, 'mkdir', '-p', '-m', '0700',
        '/home/' + user + '/.ssh']).status, 0);
    if (sudoers !== null) {
        const w = sh('podman', ['exec', '-i', name, 'sh', '-c',
            'cat > /etc/sudoers.d/pilot-test && chmod 0440 /etc/sudoers.d/pilot-test'],
            { input: sudoers + '\n' });
        assert.equal(w.status, 0, w.stderr);
    }
}

function authoriseKeyFor(name, user, publicKey) {
    const home = user === 'root' ? '/root' : '/home/' + user;
    const w = sh('podman', ['exec', '-i', name, 'sh', '-c',
        'cat > ' + home + '/.ssh/authorized_keys && chmod 0600 ' + home + '/.ssh/authorized_keys' +
        ' && chown -R ' + user + ':' + user + ' ' + home + '/.ssh'], { input: publicKey });
    assert.equal(w.status, 0, w.stderr);
}

// The exact step that failed for the user, plus proof of WHO ran it.
function rootOnlySteps() {
    return [
        step({ id: 'whoami', title: 'Who is running this', mutating: false,
            why: 'proves the escalation', argv: ['id', '-un'] }),
        step({ id: 'cache-dir', title: 'Create the Pilot download cache', mutating: true,
            why: 'the step that failed in the field',
            argv: ['install', '-d', '-m', '0755', '/var/cache/pilot'],
            check: { argv: ['test', '-d', '/var/cache/pilot'], expect: 'zero' } })
    ];
}

function sshEnvelope(port, user, keys, steps, fingerprint) {
    return envelope(steps, {
        transport: 'ssh', run_id: '20260804T120000Z',
        ssh: { host: '127.0.0.1', port: port, user: user, auth: 'pem',
            accept_fingerprint: fingerprint },
        credentials: { password: null, pem: keys.pem }
    });
}

function hostEnvFor(dir) {
    return { PILOT_RUNS_DIR: path.join(dir, 'runs'), PILOT_KNOWN_HOSTS: path.join(dir, 'known_hosts') };
}

// Same shape as the parity test above: probe once, then hand the fingerprint
// to the run envelope as an explicit confirmation.
function hostFingerprint(port, env) {
    const probe = runOnHost({ host: '127.0.0.1', port: port }, env, '--check-hostkey');
    assert.equal(probe.code, 0, probe.err);
    return probe.lines[0].fingerprint;
}

test('ssh: a non-root account with passwordless sudo really reaches root',
    { skip: SKIP }, (t) => {
    t.after(destroyAll);
    const name = 'pilot-sudo-nopasswd';
    const port = startContainer(name, true);
    makeUser(name, 'pilot', 'pilot ALL=(ALL) NOPASSWD:ALL');
    const keys = makeKeypair();
    authoriseKeyFor(name, 'pilot', keys.pub);
    assert.equal(waitForSshd(port), true, 'sshd never came up');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-sudo-'));
    const env = hostEnvFor(dir);
    const fp = hostFingerprint(port, env);

    const run = runOnHost(sshEnvelope(port, 'pilot', keys, rootOnlySteps(), fp), env);
    assert.equal(run.code, 0, 'the plan must succeed as an unprivileged user: ' + run.err);
    assert.deepEqual(outcomes(run.lines), ['whoami:ok', 'cache-dir:ok'],
        'this is the exact step that failed in the field');

    // Not merely "exit 0" -- the command genuinely ran as root.
    const who = run.lines.filter((l) => l.t === 'output' && l.id === 'whoami').map((l) => l.line);
    assert.deepEqual(who, ['root'],
        'the remote command must run as root, not as the login user');

    // And the directory really exists, owned by root, on the remote host.
    const stat = sh('podman', ['exec', name, 'stat', '-c', '%U:%G %a', '/var/cache/pilot']);
    assert.equal(stat.status, 0, 'the directory was never created');
    assert.match(String(stat.stdout).trim(), /^root:root 755$/);
});

test('ssh: a non-root account with NO sudo refuses before running a single step',
    { skip: SKIP }, (t) => {
    t.after(destroyAll);
    const name = 'pilot-sudo-none';
    const port = startContainer(name, true);
    makeUser(name, 'pilot', null);   // no sudoers entry at all
    const keys = makeKeypair();
    authoriseKeyFor(name, 'pilot', keys.pub);
    assert.equal(waitForSshd(port), true, 'sshd never came up');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-nosudo-'));
    const env = hostEnvFor(dir);
    const fp = hostFingerprint(port, env);

    const run = runOnHost(sshEnvelope(port, 'pilot', keys, rootOnlySteps(), fp), env);
    assert.notEqual(run.code, 0, 'it must not report success');
    assert.deepEqual(outcomes(run.lines), [],
        'NOT ONE step may run: a plan that cannot reach root cannot do any of its work, ' +
        'and 28 identical permission failures is worse than one honest refusal');

    const fatal = JSON.parse(String(run.err).trim().split('\n').pop());
    assert.equal(fatal.t, 'fatal');
    assert.equal(fatal.kind, 'SSH_AUTH_FAILED');
    assert.match(fatal.message, /not root and cannot use sudo/i);
    assert.match(fatal.message, /NOPASSWD/, 'the refusal must name the command that fixes it');
    assert.match(fatal.message, /pilot ALL=/, 'and name the actual account');

    // Nothing was touched on the remote host.
    assert.notEqual(sh('podman', ['exec', name, 'test', '-d', '/var/cache/pilot']).status, 0);
});

test('ssh: sudo that demands a password uses it, and it never reaches argv',
    { skip: SKIP }, (t) => {
    t.after(destroyAll);
    const name = 'pilot-sudo-password';
    const port = startContainer(name, true);
    const SECRET = 'sudo-Passw0rd-canary';
    makeUser(name, 'pilot', 'pilot ALL=(ALL) ALL');   // password REQUIRED
    assert.equal(sh('podman', ['exec', '-i', name, 'chpasswd'],
        { input: 'pilot:' + SECRET + '\n' }).status, 0);
    const keys = makeKeypair();
    authoriseKeyFor(name, 'pilot', keys.pub);
    assert.equal(waitForSshd(port), true, 'sshd never came up');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-sudopw-'));
    const env = hostEnvFor(dir);
    const fp = hostFingerprint(port, env);

    // SSH auth is by KEY here, deliberately: it isolates the thing under test
    // (sudo -k -S consuming exactly one stdin line) from sshpass, which this
    // machine may not have and which is already covered elsewhere. The password
    // in credentials is what sudo needs, not what ssh needs -- and that is the
    // realistic shape anyway for a PEM login whose account has ordinary sudo.
    const run = runOnHost(envelope(rootOnlySteps(), {
        transport: 'ssh', run_id: '20260804T130000Z',
        ssh: { host: '127.0.0.1', port: port, user: 'pilot', auth: 'pem',
            accept_fingerprint: fp },
        credentials: { password: SECRET, pem: keys.pem }
    }), env);

    assert.equal(run.code, 0, 'password sudo must work: ' + run.err);
    const who = run.lines.filter((l) => l.t === 'output' && l.id === 'whoami').map((l) => l.line);
    assert.deepEqual(who, ['root']);

    // The password travels down the ssh stdin stream. It must appear in no
    // emitted line at all -- /proc/<pid>/cmdline is world-readable, and a
    // transcript is something users paste into bug reports.
    assert.ok(!run.raw.includes(SECRET), 'the sudo password leaked into the transcript');
    assert.ok(!run.err.includes(SECRET), 'the sudo password leaked into stderr');
});

// --- --probe-ports: reachable is not the same as listening -----------------
//
// The provisioning plan's `reachability` step runs `ss -ltun` ON THE TARGET,
// which proves only that something is bound there. The wizard nonetheless
// reported "Every required port is reachable" -- a claim nothing tested. On the
// reference host every port was listening while the cloud security group
// dropped the API port outright, and that was called a clean finish.
//
// A container gives both facts in one place: a published port really is
// reachable from here, an unpublished one really is not, and both are the
// SAME container listening on the SAME interface.

test('--probe-ports tells a reachable port from a merely listening one',
    { skip: SKIP }, (t) => {
    t.after(destroyAll);
    const name = 'pilot-probe-ports';
    const port = startContainer(name, true);      // 22 published, nothing else
    assert.equal(waitForSshd(port), true, 'sshd never came up');

    // Something is listening on 9. Nothing forwards it, so it is unreachable
    // from here -- exactly the shape of a cloud firewall.
    assert.equal(sh('podman', ['exec', '-d', name,
        'python3', '-m', 'http.server', '9', '--bind', '0.0.0.0']).status, 0);
    for (let i = 0; i < 20; i += 1) {
        if (/^[1-9]/.test(String(sh('podman', ['exec', name, 'sh', '-c',
            'ss -ltn | grep -c ":9 " || true']).stdout).trim())) break;
        sleepMs(250);
    }

    // The container really is listening on 9 -- so `ss` would have said yes.
    const ss = sh('podman', ['exec', name, 'sh', '-c', 'ss -ltn | grep -c ":9 " || true']);
    assert.match(String(ss.stdout).trim(), /^[1-9]/, 'the container is not listening on 9 after all');

    const r = runOnHost({ host: '127.0.0.1', ports: [
        { port: port, proto: 'tcp' },     // published -> reachable
        { port: 9, proto: 'tcp' },        // listening, not published -> NOT reachable
        { port: 21116, proto: 'udp' }     // never probeable
    ] }, { PILOT_RUNS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-probe-')) }, '--probe-ports');

    assert.equal(r.code, 0, r.err);
    const byPort = {};
    r.lines[0].results.forEach((x) => { byPort[x.proto + ':' + x.port] = x; });

    assert.equal(byPort['tcp:' + port].reachable, true, 'a published port must be reachable');
    assert.equal(byPort['tcp:9'].reachable, false,
        'a port that is LISTENING but not routable must not be called reachable — ' +
        'that is the exact false positive this mode exists to remove');
    assert.ok(byPort['tcp:9'].detail.length > 0, 'and it must say why');
    assert.equal(byPort['udp:21116'].reachable, null,
        'udp cannot be probed by connecting, and guessing would restore the false confidence');
});

test('--probe-ports refuses a malformed request rather than reporting a blocked port',
    { skip: SKIP }, () => {
    const env = { PILOT_RUNS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-probe-bad-')) };
    for (const bad of [
        { host: '127.0.0.1', ports: [] },
        { host: '127.0.0.1', ports: 'nope' },
        { host: 'not a host', ports: [{ port: 22, proto: 'tcp' }] },
        { host: '127.0.0.1', ports: [{ port: 0, proto: 'tcp' }] },
        { host: '127.0.0.1', ports: [{ port: 22, proto: 'sctp' }] },
        { host: '127.0.0.1', ports: [{ port: 22 }] }
    ]) {
        const r = runOnHost(bad, env, '--probe-ports');
        assert.notEqual(r.code, 0, 'accepted a malformed request: ' + JSON.stringify(bad));
        assert.match(String(r.err), /"t": "fatal"/);
    }
});
