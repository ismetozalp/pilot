// Integration tests for --run: the shared orchestration above the transport.
//
// Everything here uses transport 'local' with python3 as the command, so it
// runs on any host that can run pilot-exec at all. The SSH transport's wiring
// is exercised against real containers in tests/integration/pilot-exec-live.test.js;
// what IS asserted here is that an unreachable SSH endpoint fails closed with
// the documented exit code rather than falling back to local execution.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', '..', 'libexec', 'pilot-exec');
const MASK = '••••••';

function tmpdir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run(envelope, opts) {
    const options = opts || {};
    const runs = options.runsDir || tmpdir('pilot-runs-');
    const env = Object.assign({}, process.env, {
        PILOT_RUNS_DIR: runs,
        PILOT_KNOWN_HOSTS: options.knownHosts || path.join(runs, 'known_hosts')
    }, options.env || {});
    const r = spawnSync('python3', [HELPER, '--run'], {
        input: JSON.stringify(envelope),
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        env: env
    });
    const lines = (r.stdout || '').split('\n').filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l));
    return { code: r.status, lines: lines, raw: r.stdout || '', err: r.stderr || '', runs: runs };
}

function step(over) {
    return Object.assign({
        id: 'noop', title: 'Do nothing', mutating: false, why: 'because',
        argv: ['python3', '-c', 'pass'], write: null, check: null, sha256: null, secret: false
    }, over || {});
}

function envelope(steps, over) {
    return Object.assign({
        version: 1, transport: 'local', run_id: '20260803T204500Z',
        ssh: null, credentials: null, steps: steps
    }, over || {});
}

// Loads pilot-exec as a Python module (main() is guarded by __name__) and
// evaluates `body`, which must print one JSON document. Used to reach
// internals (SshTransport directly, monkeypatched module functions) that are
// not reachable through the --run CLI surface alone.
function pyEval(body) {
    const code = [
        'import importlib.machinery, importlib.util, json, sys',
        'loader = importlib.machinery.SourceFileLoader("pilot_exec", ' + JSON.stringify(HELPER) + ')',
        'spec = importlib.util.spec_from_loader("pilot_exec", loader)',
        'px = importlib.util.module_from_spec(spec)',
        'loader.exec_module(px)'
    ].concat(body).join('\n');
    const r = spawnSync('python3', ['-c', code], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.equal(r.status, 0, 'python helper eval failed: ' + r.stderr);
    return JSON.parse(r.stdout);
}

const ids = (lines, t) => lines.filter((l) => l.t === t).map((l) => l.id);

// --- the C4 protocol ------------------------------------------------------

test('a clean run emits exactly the C4 line sequence and exits 0', () => {
    const r = run(envelope([
        step({ id: 'first', title: 'First step', argv: ['python3', '-c', 'print("alpha")'] }),
        step({ id: 'second', title: 'Second step', argv: ['python3', '-c', 'print("beta")'] })
    ]));
    assert.equal(r.code, 0, r.err);

    assert.equal(r.lines[0].t, 'run-start');
    assert.equal(r.lines[0].run_id, '20260803T204500Z');
    assert.equal(r.lines[0].transport, 'local');
    assert.equal(r.lines[0].steps, 2);

    assert.deepEqual(ids(r.lines, 'step-start'), ['first', 'second']);
    assert.deepEqual(ids(r.lines, 'step-end'), ['first', 'second']);

    const outputs = r.lines.filter((l) => l.t === 'output');
    assert.deepEqual(outputs.map((l) => l.line), ['alpha', 'beta']);
    for (const o of outputs) assert.equal(o.stream, 'stdout');

    const ends = r.lines.filter((l) => l.t === 'step-end');
    for (const e of ends) {
        assert.equal(e.status, 'ok');
        assert.equal(e.exit, 0);
        assert.equal(typeof e.ms, 'number');
        assert.ok(e.ms >= 0);
    }

    const last = r.lines[r.lines.length - 1];
    assert.deepEqual(last, { t: 'run-end', status: 'ok', kind: null });
});

test('step-start carries the literal command, and stderr is labelled', () => {
    const r = run(envelope([
        step({ id: 'talky', argv: ['python3', '-c', 'import sys; sys.stderr.write("warned\\n")'] })
    ]));
    assert.equal(r.code, 0, r.err);
    const start = r.lines.find((l) => l.t === 'step-start');
    assert.equal(start.cmd, "python3 -c 'import sys; sys.stderr.write(\"warned\\n\")'");
    const out = r.lines.find((l) => l.t === 'output');
    assert.equal(out.stream, 'stderr');
    assert.equal(out.line, 'warned');
});

test('every emitted line is mirrored verbatim into the run transcript', () => {
    const r = run(envelope([step({ id: 'only', argv: ['python3', '-c', 'print("recorded")'] })]));
    assert.equal(r.code, 0, r.err);
    const file = path.join(r.runs, '20260803T204500Z.jsonl');
    assert.equal(fs.existsSync(file), true, 'transcript was not written');
    assert.equal(fs.readFileSync(file, 'utf8'), r.raw);
});

// --- idempotency probes (C1 check) ---------------------------------------

test('a satisfied check yields status "skipped" and the argv never runs', () => {
    const sentinel = path.join(tmpdir('pilot-skip-'), 'touched');
    const r = run(envelope([
        step({
            id: 'adopt-hbbs', title: 'Adopt hbbs', mutating: true,
            argv: ['touch', sentinel],
            check: { argv: ['python3', '-c', 'pass'], expect: 'zero' }
        })
    ]));
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.existsSync(sentinel), false, 'a skipped step executed its argv');
    const end = r.lines.find((l) => l.t === 'step-end');
    assert.equal(end.status, 'skipped');
    assert.equal(end.exit, 0);
    assert.deepEqual(ids(r.lines, 'step-start'), ['adopt-hbbs']);
});

test('an unsatisfied check lets the step run', () => {
    const r = run(envelope([
        step({
            id: 'install-hbbs', argv: ['python3', '-c', 'print("installed")'],
            check: { argv: ['python3', '-c', 'raise SystemExit(1)'], expect: 'zero' }
        })
    ]));
    assert.equal(r.code, 0, r.err);
    assert.equal(r.lines.find((l) => l.t === 'step-end').status, 'ok');
    assert.equal(r.lines.find((l) => l.t === 'output').line, 'installed');
});

test('expect "nonzero" inverts the probe', () => {
    const r = run(envelope([
        step({ id: 'a', argv: ['python3', '-c', 'print("ran-a")'], check: { argv: ['python3', '-c', 'raise SystemExit(1)'], expect: 'nonzero' } }),
        step({ id: 'b', argv: ['python3', '-c', 'print("ran-b")'], check: { argv: ['python3', '-c', 'pass'], expect: 'nonzero' } })
    ]));
    assert.equal(r.code, 0, r.err);
    const ends = r.lines.filter((l) => l.t === 'step-end');
    assert.equal(ends[0].status, 'skipped');
    assert.equal(ends[1].status, 'ok');
    assert.deepEqual(r.lines.filter((l) => l.t === 'output').map((l) => l.line), ['ran-b']);
});

// --- failure handling -----------------------------------------------------

test('a failing first step ends the run "failed" and exits 1', () => {
    const r = run(envelope([
        step({ id: 'boom', argv: ['python3', '-c', 'raise SystemExit(3)'] }),
        step({ id: 'never', argv: ['python3', '-c', 'print("unreachable")'] })
    ]));
    assert.equal(r.code, 1);
    const end = r.lines.find((l) => l.t === 'step-end');
    assert.equal(end.id, 'boom');
    assert.equal(end.status, 'failed');
    assert.equal(end.exit, 3);
    assert.deepEqual(ids(r.lines, 'step-start'), ['boom'], 'a later step was started after a failure');
    assert.deepEqual(r.lines[r.lines.length - 1], { t: 'run-end', status: 'failed', kind: 'GENERIC' });
});

test('a failure after a completed step ends the run "partial"', () => {
    const r = run(envelope([
        step({ id: 'good', argv: ['python3', '-c', 'pass'] }),
        step({ id: 'boom', argv: ['python3', '-c', 'raise SystemExit(2)'] }),
        step({ id: 'never', argv: ['python3', '-c', 'pass'] })
    ]));
    assert.equal(r.code, 1);
    assert.deepEqual(ids(r.lines, 'step-start'), ['good', 'boom']);
    assert.equal(r.lines[r.lines.length - 1].status, 'partial');
});

test('a command that does not exist fails the step instead of crashing the run', () => {
    const r = run(envelope([step({ id: 'missing', argv: ['pilot-no-such-command-xyz'] })]));
    assert.equal(r.code, 1);
    const end = r.lines.find((l) => l.t === 'step-end');
    assert.equal(end.status, 'failed');
    assert.equal(end.exit, 127);
    assert.match(r.lines.find((l) => l.t === 'output').line, /cannot run pilot-no-such-command-xyz/);
});

// --- write steps ----------------------------------------------------------

test('a write step creates the file with its content, mode and parent directory', () => {
    const dir = tmpdir('pilot-write-');
    const target = path.join(dir, 'nested', 'config.yaml');
    const r = run(envelope([
        step({
            id: 'configure', argv: [], mutating: true,
            write: { path: target, mode: '0640', content: 'gin:\n  api-addr: 0.0.0.0:21114\n', owner: (os.userInfo().username + ':' + os.userInfo().username) }
        })
    ]));
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(target, 'utf8'), 'gin:\n  api-addr: 0.0.0.0:21114\n');
    assert.equal(fs.statSync(target).mode & 0o777, 0o640);
    assert.equal(r.lines.find((l) => l.t === 'step-start').cmd, 'write ' + target);
    assert.equal(r.lines.find((l) => l.t === 'step-end').status, 'ok');
});

test('a write step honours its check and can be skipped', () => {
    const dir = tmpdir('pilot-write2-');
    const target = path.join(dir, 'already.conf');
    fs.writeFileSync(target, 'original\n');
    const r = run(envelope([
        step({
            id: 'configure', argv: [],
            write: { path: target, mode: '0600', content: 'replaced\n', owner: 'root:root' },
            check: { argv: ['test', '-f', target], expect: 'zero' }
        })
    ]));
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(target, 'utf8'), 'original\n');
    assert.equal(r.lines.find((l) => l.t === 'step-end').status, 'skipped');
});

// --- write_file never exposes a wider-than-requested mode -----------------

test('LocalTransport.write_file creates its temp file at the target mode via os.open, never open()+chmod', () => {
    // The race this guards against: builtin open(tmp, "w") creates a new file
    // at 0666 & ~umask (0644 under a typical umask 022), and a subsequent
    // os.chmod() only narrows it AFTER the fact — leaving a window, however
    // short, where a secret write step's content sits at a wider mode than
    // requested. That window is a handful of machine instructions inside a
    // single function call and is not reliably observable by polling from a
    // separate process, so this is asserted by source shape instead: the
    // creating os.open() call must receive the target mode directly, and
    // there must be no bare open(tmp, "w") anywhere in LocalTransport.
    const src = fs.readFileSync(HELPER, 'utf8');
    const classStart = src.indexOf('class LocalTransport(Transport):');
    const classEnd = src.indexOf('\nclass SshTransport(Transport):');
    assert.ok(classStart >= 0 && classEnd > classStart,
        'could not locate LocalTransport in the helper source');
    const body = src.slice(classStart, classEnd);
    assert.match(body,
        /os\.open\(\s*tmp,\s*os\.O_WRONLY\s*\|\s*os\.O_CREAT\s*\|\s*os\.O_TRUNC,\s*int\(mode,\s*8\)\s*\)/,
        'write_file must pass the target mode straight into the os.open() call that creates the file');
    assert.doesNotMatch(body, /open\(tmp,\s*["']w["']/,
        'write_file must not create the temp file with a bare open() call');
});

test('a write step still lands at exactly its requested mode end to end (regression)', () => {
    const dir = tmpdir('pilot-write3-');
    const target = path.join(dir, 'secret.env');
    const r = run(envelope([
        step({
            id: 'stash', argv: [], secret: true, mutating: true,
            write: {
                path: target, mode: '0600', content: 'TOKEN=abc\n',
                owner: os.userInfo().username + ':' + os.userInfo().username
            }
        })
    ]));
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

// --- a local OSError during transport setup fails clean, not with a traceback

test('SshTransport.start() converts a bare OSError from temp-file setup into Fail(SSH_UNREACHABLE), not an uncaught traceback', () => {
    const doc = pyEval([
        // Bypass the real network host-key scan: only the tempfile/os.fdopen/
        // os.chmod path this fix touches is under test here.
        'px.hostkey_gate = lambda ssh: {"fingerprint": "SHA256:' + 'A'.repeat(43) + '", "known": True, "kind": "OK", "keytype": "ssh-ed25519", "key": "AAAA"}',
        'import tempfile',
        'def broken_mkstemp(*a, **kw):',
        '    raise OSError(28, "No space left on device")',
        'tempfile.mkstemp = broken_mkstemp',
        'ssh = {"host": "h", "port": 22, "user": "root", "auth": "agent", "accept_fingerprint": None}',
        'transport = px.SshTransport(ssh, None)',
        'try:',
        '    transport.start()',
        '    result = {"raised": False}',
        'except px.Fail as exc:',
        '    result = {"raised": True, "type": "Fail", "code": exc.code, "kind": exc.kind}',
        'except Exception as exc:',
        '    result = {"raised": True, "type": type(exc).__name__}',
        'print(json.dumps(result))'
    ]);
    assert.deepEqual(doc, { raised: true, type: 'Fail', code: 7, kind: 'SSH_UNREACHABLE' });
});

// --- redaction at the emitter (C4) ---------------------------------------

test('a credential from the envelope never survives into stdout or the transcript', () => {
    const secret = 'hunter2horse-battery';
    const r = run(envelope([
        step({ id: 'leak', argv: ['python3', '-c', 'print("psk=' + secret + '")'] })
    ], { credentials: { password: secret, pem: null } }));
    assert.equal(r.code, 0, r.err);
    assert.equal(r.raw.includes(secret), false, 'the password reached stdout');
    assert.ok(r.raw.includes(MASK), 'nothing was masked at all');
    assert.equal(r.lines.find((l) => l.t === 'output').line, 'psk=' + MASK);
    const file = fs.readFileSync(path.join(r.runs, '20260803T204500Z.jsonl'), 'utf8');
    assert.equal(file.includes(secret), false, 'the password reached the on-disk transcript');
});

test('the content of a secret write step is redacted from later output', () => {
    const dir = tmpdir('pilot-secret-');
    const target = path.join(dir, 'token');
    const secret = 'sk-live-9f2a4c7e1b';
    const owner = os.userInfo().username + ':' + os.userInfo().username;
    const r = run(envelope([
        step({ id: 'stash', argv: [], secret: true, mutating: true,
            write: { path: target, mode: '0600', content: secret + '\n', owner: owner } }),
        step({ id: 'show', argv: ['cat', target] })
    ]));
    assert.equal(r.code, 0, r.err);
    assert.equal(r.raw.includes(secret), false);
    assert.equal(r.lines.find((l) => l.t === 'step-start').cmd, MASK);
});

test('a secret step masks its command but still reports its real exit code', () => {
    const r = run(envelope([
        step({ id: 'hidden', secret: true, argv: ['python3', '-c', 'raise SystemExit(4)'] })
    ]));
    assert.equal(r.code, 1);
    assert.equal(r.lines.find((l) => l.t === 'step-start').cmd, MASK);
    assert.equal(r.lines.find((l) => l.t === 'step-end').exit, 4);
});

// --- SHA256 enforcement (C14) --------------------------------------------

function copyStep(src, dest, digest, id) {
    // A stand-in for `curl -fsSL <url> -o <dest>` that needs no network but keeps
    // the C14 argv shape exactly: -o is its own element, followed by the target.
    return step({
        id: id || 'fetch-api', title: 'Download API server', mutating: true,
        argv: ['python3', '-c', 'import sys, shutil; shutil.copyfile(sys.argv[1], sys.argv[3])',
            src, '-o', dest],
        sha256: digest
    });
}

test('a matching sha256 lets the run continue and is recorded in the transcript', () => {
    const dir = tmpdir('pilot-sha-ok-');
    const src = path.join(dir, 'payload.bin');
    const dest = path.join(dir, 'api.tar.gz');
    fs.writeFileSync(src, 'rustdesk-api-payload\n');
    const digest = crypto.createHash('sha256').update('rustdesk-api-payload\n').digest('hex');

    const r = run(envelope([
        copyStep(src, dest, digest),
        step({ id: 'install', argv: ['python3', '-c', 'print("unpacked")'] })
    ]));
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'rustdesk-api-payload\n');
    assert.deepEqual(ids(r.lines, 'step-end'), ['fetch-api', 'install']);
    assert.match(r.lines.filter((l) => l.t === 'output').map((l) => l.line).join('\n'),
        /sha256 verified for /);
});

test('a sha256 mismatch is a HARD STOP: exit 6, CHECKSUM_MISMATCH, nothing after it runs', () => {
    const dir = tmpdir('pilot-sha-bad-');
    const src = path.join(dir, 'payload.bin');
    const dest = path.join(dir, 'api.tar.gz');
    fs.writeFileSync(src, 'tampered-payload\n');
    const wrong = 'd0689a353fd756815cfe560ce7cb98f764602de60d0403b51db4e5a9bd84d22a';

    const r = run(envelope([
        copyStep(src, dest, wrong),
        step({ id: 'install', argv: ['touch', path.join(dir, 'must-not-exist')] })
    ]));
    assert.equal(r.code, 6);
    assert.equal(fs.existsSync(path.join(dir, 'must-not-exist')), false,
        'the run continued past a checksum mismatch');
    assert.deepEqual(ids(r.lines, 'step-start'), ['fetch-api']);
    const end = r.lines.find((l) => l.t === 'step-end');
    assert.equal(end.status, 'failed');
    assert.deepEqual(r.lines[r.lines.length - 1],
        { t: 'run-end', status: 'failed', kind: 'CHECKSUM_MISMATCH' });
    assert.match(r.lines.filter((l) => l.t === 'output').map((l) => l.line).join('\n'),
        /sha256 mismatch for /);
    assert.match(r.err, /CHECKSUM_MISMATCH/);
});

test('a download that produced no file is a checksum failure, not a success', () => {
    const dir = tmpdir('pilot-sha-none-');
    const dest = path.join(dir, 'never-written.tar.gz');
    const r = run(envelope([
        step({
            id: 'fetch-api', mutating: true,
            argv: ['python3', '-c', 'pass', '-o', dest],
            sha256: 'a'.repeat(63) + 'b'
        })
    ]));
    assert.equal(r.code, 6);
    assert.equal(r.lines[r.lines.length - 1].kind, 'CHECKSUM_MISMATCH');
});

// --- the transport boundary fails closed ---------------------------------

test('an ssh envelope never silently falls back to local execution', () => {
    const dir = tmpdir('pilot-ssh-');
    const sentinel = path.join(dir, 'ran-locally');
    // Port 1 is reserved and never carries sshd, so the host key scan cannot
    // succeed on any machine.
    const r = run(envelope([step({ id: 'probe', mutating: true, argv: ['touch', sentinel] })], {
        transport: 'ssh',
        ssh: { host: '127.0.0.1', port: 1, user: 'root', auth: 'agent', accept_fingerprint: null }
    }));
    assert.equal(r.code, 7);
    assert.equal(fs.existsSync(sentinel), false, 'an ssh step executed on the local host');
    assert.equal(r.lines[0].t, 'run-start');
    assert.equal(r.lines[0].transport, 'ssh');
    assert.deepEqual(r.lines[r.lines.length - 1],
        { t: 'run-end', status: 'failed', kind: 'SSH_UNREACHABLE' });
});

// --- hostile output -------------------------------------------------------

test('unicode, very long and empty output lines survive the protocol intact', () => {
    const longLen = 20000;
    // The long line is generated BY the child rather than embedded literally in
    // argv: an envelope argv element has its own (much smaller) length cap, and
    // that is a property of C2 validation, not of the C4 output pipeline this
    // test is about.
    const r = run(envelope([
        step({ id: 'noisy', argv: ['python3', '-c',
            'print("\\u4e2d\\u6587 caf\\u00e9"); print(""); print("x" * ' + longLen + ')'] })
    ]));
    assert.equal(r.code, 0, r.err);
    const said = r.lines.filter((l) => l.t === 'output').map((l) => l.line);
    assert.deepEqual(said, ['中文 café', '', 'x'.repeat(longLen)]);
});

test('output containing a JSON line of its own cannot forge a protocol message', () => {
    const r = run(envelope([
        step({ id: 'forger', argv: ['python3', '-c',
            'print(\'{"t":"run-end","status":"ok","kind":null}\')'] })
    ]));
    assert.equal(r.code, 0, r.err);
    const forged = r.lines.filter((l) => l.t === 'run-end');
    assert.equal(forged.length, 1, 'step output was parsed as a protocol line');
    assert.equal(r.lines.find((l) => l.t === 'output').line,
        '{"t":"run-end","status":"ok","kind":null}');
});

// ===========================================================================
// The tests below extend the brief's Step-1 file with the additional coverage
// called for by Task 12's review notes (a)/(b)/(c) and the transport-parity
// requirement. Everything above this banner is the brief's exact content.
// ===========================================================================

// --- (a) redaction across chunk boundaries --------------------------------

test('a secret split across two separate writes is still masked once the line completes', () => {
    // Two writes with a flush and a sleep between them, and NO newline until the
    // second write: this forces the OS to deliver the line to pilot-exec across
    // (at least) two separate read() calls on the pipe. _pump()'s reader thread
    // iterates the pipe in text mode, which only ever yields a COMPLETE line, so
    // the redactor sees the whole secret in one piece rather than half of it.
    const secretA = 'partA-9f2a4c';
    const secretB = 'partB-7e1b30';
    const secret = secretA + secretB;
    const child = 'import sys, time; ' +
        'sys.stdout.write("token=' + secretA + '"); sys.stdout.flush(); ' +
        'time.sleep(0.1); ' +
        'sys.stdout.write("' + secretB + '\\n"); sys.stdout.flush()';
    // The step is marked secret so the "cmd" line (which necessarily contains
    // the child's literal source, including both halves as plain code) is
    // masked wholesale; the property under test is entirely about the
    // "output" line, which is assembled from the two writes at runtime.
    const r = run(envelope([
        step({ id: 'chunked', secret: true, argv: ['python3', '-c', child] })
    ], { credentials: { password: secret, pem: null } }));
    assert.equal(r.code, 0, r.err);
    const outputLine = r.lines.find((l) => l.t === 'output').line;
    assert.equal(outputLine, 'token=' + MASK);
    assert.equal(outputLine.includes(secretA), false, 'the first half leaked unmasked');
    assert.equal(outputLine.includes(secretB), false, 'the second half leaked unmasked');
});

// --- (b) short credentials are rejected rather than shipped unmasked ------

test('a credential shorter than the redaction floor is refused at validation, not shipped unmasked', () => {
    // '' is already rejected by the pre-existing "must not be empty" rule; 1-3
    // characters are exactly the new floor this task adds.
    for (const short of ['a', 'ab', 'abc']) {
        const r = run(envelope([step({ id: 'noop' })], { credentials: { password: short, pem: null } }));
        assert.equal(r.code, 3, JSON.stringify(short));
        assert.match(r.err, /password must be at least 4 characters/, JSON.stringify(short));
    }
    const empty = run(envelope([step({ id: 'noop' })], { credentials: { password: '', pem: null } }));
    assert.equal(empty.code, 3);
    assert.match(empty.err, /must not be empty/);
});

test('a 4-character credential is accepted and is masked like any other secret', () => {
    const r = run(envelope([
        step({ id: 'leak4', argv: ['python3', '-c', 'print("pin=abcd")'] })
    ], { credentials: { password: 'abcd', pem: null } }));
    assert.equal(r.code, 0, r.err);
    assert.equal(r.lines.find((l) => l.t === 'output').line, 'pin=' + MASK);
});

// --- interleaved / multi-stream output -------------------------------------

test('a step writing to both stdout and stderr reports both, each correctly labelled', () => {
    const r = run(envelope([
        step({
            id: 'both', argv: ['python3', '-c',
                'import sys; print("out-line"); sys.stderr.write("err-line\\n")']
        })
    ]));
    assert.equal(r.code, 0, r.err);
    const outputs = r.lines.filter((l) => l.t === 'output' && l.id === 'both');
    assert.equal(outputs.length, 2);
    assert.ok(outputs.some((o) => o.stream === 'stdout' && o.line === 'out-line'));
    assert.ok(outputs.some((o) => o.stream === 'stderr' && o.line === 'err-line'));
});

test('a very large step output is delivered in full, line by line', () => {
    const n = 4000;
    const child = 'for i in range(' + n + '): print("line-%05d" % i)';
    const r = run(envelope([step({ id: 'firehose', argv: ['python3', '-c', child] })]));
    assert.equal(r.code, 0, r.err);
    const said = r.lines.filter((l) => l.t === 'output' && l.id === 'firehose').map((l) => l.line);
    assert.equal(said.length, n);
    assert.equal(said[0], 'line-00000');
    assert.equal(said[n - 1], 'line-' + String(n - 1).padStart(5, '0'));
});

// --- (c) SSH password auth: the secret never touches argv or the environment

function withStubBin(files) {
    const dir = tmpdir('pilot-stubbin-');
    for (const [name, content] of Object.entries(files)) {
        const file = path.join(dir, name);
        fs.writeFileSync(file, content);
        fs.chmodSync(file, 0o755);
    }
    return dir;
}

// A fixed, validly-base64 "host key" both ssh-keyscan and known_hosts agree on,
// so hostkey_gate() reports the host as already-known without needing
// accept_fingerprint at all.
const STUB_KEYTYPE = 'ssh-ed25519';
const STUB_KEY = Buffer.from('pilot-stub-hostkey-material-000').toString('base64');

const STUB_SSH_KEYSCAN = '#!/usr/bin/env python3\n' +
    'print("stub-host ' + STUB_KEYTYPE + ' ' + STUB_KEY + '")\n';

// Forwards the remote command (the SSH invocation's last argv element) to a
// local shell, so a "remote" step actually runs locally under a stand-in
// process — enough to prove the shared run_steps()/Emitter code path produces
// an identical step sequence over both transports.
const STUB_SSH = '#!/usr/bin/env python3\n' +
    'import sys, subprocess\n' +
    'sys.exit(subprocess.call(["/bin/sh", "-c", sys.argv[-1]]))\n';

// sshpass -d <fd> reads the password from an inherited file descriptor and
// never sees it in argv or the environment. This stub records exactly that —
// its own argv and environment, and what it actually read from the fd — before
// handing off to the stub ssh above, so the test can assert the secret only
// ever arrived through the pipe.
function stubSshpass(markerFile) {
    return '#!/usr/bin/env python3\n' +
        'import sys, os, json\n' +
        'assert sys.argv[1] == "-d", sys.argv\n' +
        'fd = int(sys.argv[2])\n' +
        'data = os.read(fd, 65536).decode("utf-8", "replace")\n' +
        'os.close(fd)\n' +
        'record = {\n' +
        '    "argv": sys.argv,\n' +
        '    "has_sshpass_env": "SSHPASS" in os.environ,\n' +
        '    "read_from_fd": data.strip(),\n' +
        '}\n' +
        'with open(' + JSON.stringify(markerFile) + ', "w") as fh:\n' +
        '    json.dump(record, fh)\n' +
        'os.execvp(sys.argv[3], sys.argv[3:])\n';
}

test('SSH password auth: the secret reaches the child only via a file descriptor, never argv or env', () => {
    const runs = tmpdir('pilot-runs-');
    const knownHosts = path.join(runs, 'known_hosts');
    fs.writeFileSync(knownHosts, '[stub-host]:2222 ' + STUB_KEYTYPE + ' ' + STUB_KEY + '\n');

    const marker = path.join(runs, 'sshpass-marker.json');
    const bin = withStubBin({
        'ssh-keyscan': STUB_SSH_KEYSCAN,
        ssh: STUB_SSH,
        sshpass: stubSshpass(marker)
    });

    const secret = 'correct-horse-battery-staple';
    const r = run(envelope([
        step({ id: 'probe', argv: ['python3', '-c', 'print("via-ssh")'] })
    ], {
        transport: 'ssh',
        ssh: { host: 'stub-host', port: 2222, user: 'root', auth: 'password', accept_fingerprint: null },
        credentials: { password: secret, pem: null }
    }), {
        runsDir: runs, knownHosts: knownHosts,
        env: { PATH: bin + path.delimiter + process.env.PATH }
    });

    assert.equal(r.code, 0, r.err);
    assert.equal(r.lines.find((l) => l.t === 'output' && l.id === 'probe').line, 'via-ssh');

    assert.ok(fs.existsSync(marker), 'the stub sshpass never ran');
    const record = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(record.read_from_fd, secret, 'sshpass did not read the correct password from the fd');
    assert.equal(record.has_sshpass_env, false, 'SSHPASS was set in the environment');
    assert.ok(!record.argv.some((a) => a.includes(secret)), 'the password appeared in argv');
    assert.equal(r.raw.includes(secret), false, 'the password reached pilot-exec stdout');
});

// --- transport parity: the headline property ------------------------------

test('the same envelope over local and (stubbed) ssh produces the same step sequence and JSON lines', () => {
    const steps = [
        step({ id: 'one', title: 'First', argv: ['python3', '-c', 'print("hello")'] }),
        step({ id: 'two', title: 'Second', check: { argv: ['python3', '-c', 'pass'], expect: 'zero' }, argv: ['python3', '-c', 'print("skipped-body")'] }),
        step({ id: 'three', title: 'Third', argv: ['python3', '-c', 'import sys; sys.stderr.write("oops\\n")'] })
    ];

    const localRun = run(envelope(steps, { transport: 'local' }));
    assert.equal(localRun.code, 0, localRun.err);

    const runs = tmpdir('pilot-runs-');
    const knownHosts = path.join(runs, 'known_hosts');
    fs.writeFileSync(knownHosts, '[stub-host]:2222 ' + STUB_KEYTYPE + ' ' + STUB_KEY + '\n');
    const bin = withStubBin({ 'ssh-keyscan': STUB_SSH_KEYSCAN, ssh: STUB_SSH });

    const sshRun = run(envelope(steps, {
        transport: 'ssh',
        ssh: { host: 'stub-host', port: 2222, user: 'root', auth: 'agent', accept_fingerprint: null }
    }), {
        runsDir: runs, knownHosts: knownHosts,
        env: { PATH: bin + path.delimiter + process.env.PATH }
    });
    assert.equal(sshRun.code, 0, sshRun.err);

    // Strip the fields that are legitimately different (the transport label
    // itself, and step-end timings) before comparing line-for-line.
    const normalize = (lines) => lines.map((l) => {
        const copy = Object.assign({}, l);
        delete copy.transport;
        if (copy.t === 'step-end') delete copy.ms;
        return copy;
    });

    assert.deepEqual(normalize(localRun.lines), normalize(sshRun.lines));
    assert.equal(localRun.lines[0].transport, 'local');
    assert.equal(sshRun.lines[0].transport, 'ssh');
});
