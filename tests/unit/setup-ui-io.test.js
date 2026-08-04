// tests/unit/setup-ui-io.test.js — the cockpit-facing half of the setup wizard.
//
// The component is driven under node with a hand-built fake `cockpit` global, so
// the streaming, the envelope handed to pilot-exec, the transcript persisted to
// /var/lib/pilot/runs and the partial-success handover are all asserted without a
// browser, a bridge or a server.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const UI = require('../../js/features/setup-ui.js');

const DETECTION = {
    os_release: { id: 'debian', id_like: '', version_id: '12', pretty_name: 'Debian 12' },
    arch: 'x86_64', init: 'systemd', firewall: 'firewalld', egress: true,
    disk_free_mb: 4096, hbbs: null, api: null, public_ip: '203.0.113.10'
};

const RUN_LINES = [
    '{"t":"run-start","run_id":"20260803T204500Z","transport":"local","steps":2}',
    '{"t":"step-start","id":"fetch-api","title":"Download API server","cmd":"curl -fsSL https://x"}',
    '{"t":"output","id":"fetch-api","stream":"stdout","line":"downloading"}',
    '{"t":"step-end","id":"fetch-api","status":"ok","exit":0,"ms":8432}',
    '{"t":"step-start","id":"reachability","title":"Probe required ports","cmd":"pilot probe"}',
    '{"t":"output","id":"reachability","stream":"stderr","line":"21116/udp blocked"}',
    '{"t":"step-end","id":"reachability","status":"failed","exit":1,"ms":900}',
    '{"t":"run-end","status":"partial","kind":"PORT_BLOCKED"}'
];

// A fake cockpit that records every call and replays scripted stdout, either as a
// stream (like the real bridge) or only on resolution (like a stub that has no
// stream support) — both paths must produce the same transcript.
function fakeCockpit(opts) {
    const o = opts || {};
    const calls = [];
    const files = {};
    const api = {
        calls: calls,
        files: files,
        spawn(argv, options) {
            const record = { argv: argv.slice(), options: options || {}, stdin: null };
            calls.push(record);
            const key = Object.keys(o.spawn || {}).find((k) => argv.join(' ').indexOf(k) >= 0);
            const scripted = key === undefined ? undefined : o.spawn[key];
            let resolveP, rejectP;
            const p = new Promise((res, rej) => { resolveP = res; rejectP = rej; });
            p.input = function (data) { record.stdin = String(data); return p; };
            p.stream = function (cb) {
                if (!o.noStream && typeof scripted === 'string')
                    setTimeout(() => { cb(scripted); }, 0);
                return p;
            };
            // Real cockpit.spawn() guarantees every stream() chunk is delivered
            // before the promise settles. This fake models that with a resolve
            // delay strictly greater than the stream callback's: Node clamps
            // setTimeout(fn, 0) to the same 1ms floor as setTimeout(fn, 1), and
            // the resolve timer here is armed (in spawn(), above) before the
            // caller even gets `p` back to call p.stream(cb) on — so a resolve
            // delay of 1 (the same as the clamped 0) fires deterministically
            // FIRST, backwards from the real guarantee. 8ms leaves an ample,
            // deterministic margin without slowing the suite down.
            setTimeout(() => {
                if (scripted === undefined) {
                    const e = new Error('no stub for: ' + argv.join(' '));
                    e.exit_status = 1;
                    rejectP(e);
                } else if (scripted && scripted.error) {
                    const e = new Error(scripted.message || 'stub failure');
                    e.exit_status = 1;
                    rejectP(e);
                } else {
                    resolveP(o.noStream ? scripted : '');
                }
            }, 8);
            return p;
        },
        file(path, options) {
            return {
                replace(content) {
                    if (o.fileFails) return Promise.reject(new Error('read-only file system'));
                    files[path] = content;
                    calls.push({ argv: ['file.replace', path], options: options || {} });
                    return Promise.resolve();
                },
                close() {}
            };
        }
    };
    return api;
}

function withCockpit(fake, fn) {
    globalThis.cockpit = fake;
    return Promise.resolve().then(fn).finally(() => { delete globalThis.cockpit; });
}

// ------------------------------------------------------------ runIdFor

test('a run id is a compact UTC timestamp usable as a filename', () => {
    const id = UI.runIdFor(new Date(Date.UTC(2026, 7, 3, 20, 45, 0)));
    assert.equal(id, '20260803T204500Z');
    assert.equal(UI.runPath(id), '/var/lib/pilot/runs/20260803T204500Z.jsonl');
});

test('an unusable date still yields a usable run id', () => {
    for (const bad of [null, undefined, 'yesterday', new Date(NaN), 42]) {
        const id = UI.runIdFor(bad);
        assert.match(id, /^[0-9]{8}T[0-9]{6}Z$/, JSON.stringify(String(bad)));
        assert.notEqual(UI.runPath(id), null);
    }
});

// ------------------------------------------------------------ splitStream

test('splitStream yields only complete lines and keeps the remainder', () => {
    assert.deepEqual(UI.splitStream('a\nb\nc'), { lines: ['a', 'b'], rest: 'c' });
    assert.deepEqual(UI.splitStream('a\nb\n'), { lines: ['a', 'b'], rest: '' });
    assert.deepEqual(UI.splitStream(''), { lines: [], rest: '' });
    assert.deepEqual(UI.splitStream('no newline yet'), { lines: [], rest: 'no newline yet' });
    assert.deepEqual(UI.splitStream(null), { lines: [], rest: '' });
});

// A chunk boundary can split a JSON line anywhere, including mid-token. The
// incremental parser must carry the remainder forward and reassemble it exactly.
test('a line split across chunk boundaries reassembles into one complete line', () => {
    let carry = '';
    const chunks = ['{"t":"ou', 'tput","line":"a"}\n{"t":"run-end"', ',"status":"ok","kind":null}\n'];
    const collected = [];
    for (const chunk of chunks) {
        const r = UI.splitStream(carry + chunk);
        carry = r.rest;
        collected.push(...r.lines);
    }
    assert.deepEqual(collected, [
        '{"t":"output","line":"a"}',
        '{"t":"run-end","status":"ok","kind":null}'
    ]);
    assert.equal(carry, '');
});

// A stream can end (helper crash, connection drop) before the last line's
// newline arrives; the truncated fragment must be kept as `rest`, not dropped.
test('a truncated final line with no trailing newline is kept as rest, not lost', () => {
    const r = UI.splitStream('{"t":"run-end"}\n{"t":"trunc');
    assert.deepEqual(r.lines, ['{"t":"run-end"}']);
    assert.equal(r.rest, '{"t":"trunc');
});

// A CRLF-emitting helper leaves a trailing \r on every line; splitStream only
// ever splits on \n, so the \r rides along — and parseLine's trim() (below)
// is what actually makes that harmless.
test('a CRLF stream keeps the carriage return attached to each split line', () => {
    const r = UI.splitStream('a\r\nb\r\n');
    assert.deepEqual(r.lines, ['a\r', 'b\r']);
    assert.equal(r.rest, '');
});

test('parseLine tolerates the trailing CR a CRLF stream leaves behind', () => {
    const line = '{"t":"run-end","status":"ok","kind":null}\r';
    assert.equal(UI.parseLine(line).t, 'run-end');
});

// A single very large line (a big base64 blob, a huge stdout capture) must
// still come back whole from splitStream — any truncation happens later, in
// parseLine's own size cap, never silently inside the line splitter.
test('splitStream does not truncate a very large single line', () => {
    const huge = '{"t":"output","id":"a","stream":"stdout","line":"' + 'x'.repeat(500000) + '"}';
    const r = UI.splitStream(huge + '\n');
    assert.deepEqual(r.lines, [huge]);
    assert.equal(r.lines[0].length, huge.length);
    assert.equal(r.rest, '');
});

// ------------------------------------------------------------ detectRequest

test('a localhost detect request carries no ssh block and no credentials', () => {
    const s = UI.blankState();
    s.choices.target = 'local';
    assert.deepEqual(UI.detectRequest(s),
        { version: 1, transport: 'local', ssh: null, credentials: null });
});

test('a remote detect request carries the ssh block and the password on stdin only', () => {
    const s = UI.blankState();
    s.choices = Object.assign(s.choices, {
        target: 'ssh', host: 'rd.example.com', port: 2222, user: 'ubuntu',
        auth: 'password', password: 'hunter2'
    });
    s.hostkey = { fingerprint: 'SHA256:abc', known: false, confirmed: true };
    const req = UI.detectRequest(s);
    assert.deepEqual(req.ssh, {
        host: 'rd.example.com', port: 2222, user: 'ubuntu',
        auth: 'password', accept_fingerprint: 'SHA256:abc'
    });
    assert.deepEqual(req.credentials, { password: 'hunter2', pem: null });
    assert.equal(req.version, 1);
    assert.equal(req.transport, 'ssh');
});

test('an unconfirmed host key is never sent as an accepted fingerprint', () => {
    const s = UI.blankState();
    s.choices = Object.assign(s.choices, { target: 'ssh', host: 'h', port: 22, user: 'root', auth: 'agent' });
    s.hostkey = { fingerprint: 'SHA256:abc', known: false, confirmed: false };
    assert.equal(UI.detectRequest(s).ssh.accept_fingerprint, null);
    assert.equal(UI.detectRequest(s).credentials, null);
});

test('the envelope context reuses the detect request transport and ssh block', () => {
    const s = UI.blankState();
    s.choices = Object.assign(s.choices, {
        target: 'ssh', host: 'h', port: 22, user: 'root', auth: 'pem', pem: 'KEY'
    });
    s.hostkey = { fingerprint: 'SHA256:z', known: true, confirmed: true };
    const ctx = UI.envelopeCtx(s, '20260803T204500Z');
    assert.equal(ctx.run_id, '20260803T204500Z');
    assert.equal(ctx.transport, 'ssh');
    assert.equal(ctx.ssh.host, 'h');
    assert.deepEqual(ctx.credentials, { password: null, pem: 'KEY' });
});

// ------------------------------------------------------------ reachFrom

test('blocked ports are read back out of the reachability step transcript', () => {
    let exec = UI.blankExec();
    for (const line of RUN_LINES) exec = UI.reduce(exec, UI.parseLine(line));
    assert.deepEqual(UI.reachFrom(exec),
        [{ port: 21116, proto: 'udp', reachable: false, scope: 'cloud' }]);
});

test('a reachability step that passed reports nothing blocked', () => {
    let exec = UI.blankExec();
    exec = UI.reduce(exec, { t: 'run-start', run_id: 'r', transport: 'local', steps: 1 });
    exec = UI.reduce(exec, { t: 'step-start', id: 'reachability', title: 'Probe', cmd: 'x' });
    exec = UI.reduce(exec, { t: 'output', id: 'reachability', stream: 'stdout', line: '21115/tcp reachable' });
    exec = UI.reduce(exec, { t: 'step-end', id: 'reachability', status: 'ok', exit: 0, ms: 5 });
    assert.deepEqual(UI.reachFrom(exec), []);
});

test('a run with no reachability step at all reports nothing rather than guessing', () => {
    assert.deepEqual(UI.reachFrom(UI.blankExec()), []);
    assert.deepEqual(UI.reachFrom(null), []);
});

// ------------------------------------------------------------ component

test('the component constructs with no DOM and no cockpit', () => {
    const c = UI.pilotSetupUi();
    assert.equal(c.step, 'target');
    assert.equal(c.busy, false);
    assert.equal(c.finished, false);
    assert.equal(c.passwordWriter, null);
    assert.equal(globalThis.pilotSetupUi, UI.pilotSetupUi);
});

test('next refuses to leave the target step while the form is invalid', () => {
    const c = UI.pilotSetupUi();
    c.choices.target = 'ssh';
    c.choices.host = '';
    assert.equal(c.next(), false);
    assert.equal(c.step, 'target');
    assert.equal(typeof c.errors.host, 'string');
    c.choices.host = 'rd.example.com';
    assert.equal(c.next(), true);
    assert.equal(c.step, 'hostkey');
});

test('a localhost wizard never lands on the host-key step', () => {
    const c = UI.pilotSetupUi();
    c.choices.target = 'local';
    assert.equal(c.next(), true);
    assert.equal(c.step, 'detect');
    assert.deepEqual(c.steps(), ['target', 'detect', 'ports', 'execute', 'handover']);
});

test('the wizard will not leave the host-key step until the fingerprint is confirmed', () => {
    const c = UI.pilotSetupUi();
    c.choices = Object.assign(c.choices, { target: 'ssh', host: 'h', port: 22, user: 'root', auth: 'agent' });
    c.step = 'hostkey';
    c.hostkey = { fingerprint: 'SHA256:abc', known: false, confirmed: false };
    assert.equal(c.next(), false);
    assert.equal(c.step, 'hostkey');
    assert.match(c.errors.hostkey, /fingerprint/i);
    c.acceptHostKey();
    assert.equal(c.next(), true);
    assert.equal(c.step, 'detect');
});

test('detect sends a DetectRequest on stdin and builds the plan from the answer', async () => {
    const fake = fakeCockpit({ spawn: { '--detect': JSON.stringify(DETECTION) }, noStream: true });
    await withCockpit(fake, async () => {
        const c = UI.pilotSetupUi();
        c.choices.target = 'local';
        assert.equal(await c.detect(), true);
        const call = fake.calls[0];
        assert.equal(call.argv[0], '/usr/libexec/pilot/pilot-exec');
        assert.equal(call.argv[1], '--detect');
        assert.equal(call.options.superuser, 'require');
        assert.deepEqual(JSON.parse(call.stdin),
            { version: 1, transport: 'local', ssh: null, credentials: null });
        assert.equal(c.detection.firewall, 'firewalld');
        assert.equal(c.firewall, 'firewalld');
        assert.ok(c.plan && Array.isArray(c.plan.steps));
        assert.equal(c.error, null);
    });
});

test('a helper that answers with garbage does not leave a half-built plan', async () => {
    const fake = fakeCockpit({ spawn: { '--detect': '{"os_release":' }, noStream: true });
    await withCockpit(fake, async () => {
        const c = UI.pilotSetupUi();
        assert.equal(await c.detect(), false);
        assert.equal(c.plan, null);
        assert.equal(typeof c.error.message, 'string');
        assert.equal(c.busy, false);
    });
});

test('detection failure surfaces a kind and a remediation rather than a bare toast', async () => {
    const fake = fakeCockpit({ spawn: { '--detect': { error: true, message: 'ssh: connect: refused' } } });
    await withCockpit(fake, async () => {
        const c = UI.pilotSetupUi();
        assert.equal(await c.detect(), false);
        assert.equal(typeof c.error.kind, 'string');
        assert.ok(c.error.message.includes('refused'));
    });
});

test('start streams the transcript, persists it, and reports PARTIAL for a blocked port', async () => {
    const fake = fakeCockpit({ spawn: { '--run': RUN_LINES.join('\n') + '\n' } });
    await withCockpit(fake, async () => {
        const c = UI.pilotSetupUi();
        c.choices.target = 'local';
        c.plan = { target: 'local', host: null, arch: 'amd64', warnings: [], steps: [] };
        assert.equal(await c.start(), false);
        assert.equal(c.exec.status, 'partial');
        assert.equal(c.exec.steps.length, 2);
        assert.equal(c.exec.steps[0].exit, 0);
        assert.equal(c.exec.steps[1].open, true);
        assert.equal(c.progress().percent, 100);
        assert.equal(c.handoverResult.status, 'partial');
        assert.equal(c.handoverResult.kind, 'PORT_BLOCKED');
        assert.ok(c.handoverResult.message.includes('21116/udp'));
        const path = '/var/lib/pilot/runs/' + c.runId + '.jsonl';
        assert.equal(fake.files[path], RUN_LINES.join('\n') + '\n');
        assert.equal(c.transcriptSaved, true);
    });
});

test('the same run produces the same transcript when the bridge never streams', async () => {
    const fake = fakeCockpit({ spawn: { '--run': RUN_LINES.join('\n') + '\n' }, noStream: true });
    await withCockpit(fake, async () => {
        const c = UI.pilotSetupUi();
        c.plan = { target: 'local', host: null, arch: 'amd64', warnings: [], steps: [] };
        await c.start();
        assert.equal(c.exec.steps.length, 2);
        assert.equal(c.exec.status, 'partial');
    });
});

test('the envelope reaches pilot-exec on stdin and never in argv', async () => {
    const fake = fakeCockpit({ spawn: { '--run': RUN_LINES.join('\n') + '\n' } });
    await withCockpit(fake, async () => {
        const c = UI.pilotSetupUi();
        c.choices = Object.assign(c.choices, {
            target: 'ssh', host: 'h', port: 22, user: 'root', auth: 'password', password: 's3cr3t'
        });
        // provision-plan.js's own toEnvelope() enforces an ssh-keygen-shaped
        // SHA256 fingerprint (43 base64 chars) — 'SHA256:abc' would be rejected
        // as SSH_HOSTKEY_UNKNOWN by that (unmodified, already-shipped) validator
        // before pilot-exec was ever spawned, which is exactly the bug this test
        // is meant to catch, not exercise.
        c.hostkey = { fingerprint: 'SHA256:' + 'a'.repeat(43), known: false, confirmed: true };
        c.plan = { target: 'ssh', host: 'h', arch: 'amd64', warnings: [], steps: [] };
        await c.start();
        const call = fake.calls.find((x) => x.argv.indexOf('--run') >= 0);
        assert.deepEqual(call.argv, ['/usr/libexec/pilot/pilot-exec', '--run']);
        assert.equal(call.argv.join(' ').indexOf('s3cr3t'), -1);
        assert.ok(call.stdin.indexOf('s3cr3t') >= 0);
        assert.equal(JSON.parse(call.stdin).version, 1);
    });
});

test('non-JSON helper chatter is kept as noise instead of breaking the run', async () => {
    // run-start deliberately wipes exec.noise ("clears any previous attempt" —
    // see tests/unit/setup-ui.test.js) so the stray line has to arrive AFTER
    // run-start to survive to the assertion below, exactly like a real sudo
    // prompt would (it fires once a mutating step needs elevation, never
    // before pilot-exec has even announced the run).
    const fake = fakeCockpit({
        spawn: {
            '--run': [RUN_LINES[0], 'sudo: a password is required']
                .concat(RUN_LINES.slice(1)).join('\n') + '\n'
        }
    });
    await withCockpit(fake, async () => {
        const c = UI.pilotSetupUi();
        c.plan = { target: 'local', host: null, arch: 'amd64', warnings: [], steps: [] };
        await c.start();
        assert.deepEqual(c.exec.noise, ['sudo: a password is required']);
        assert.equal(c.exec.steps.length, 2);
    });
});

test('a helper that dies mid-run is recorded as failed, and the transcript is still kept', async () => {
    const fake = fakeCockpit({ spawn: { '--run': { error: true, message: 'helper crashed' } } });
    await withCockpit(fake, async () => {
        const c = UI.pilotSetupUi();
        c.plan = { target: 'local', host: null, arch: 'amd64', warnings: [], steps: [] };
        assert.equal(await c.start(), false);
        assert.equal(c.exec.status, 'failed');
        assert.equal(c.handoverResult.status, 'failed');
        assert.equal(typeof fake.files['/var/lib/pilot/runs/' + c.runId + '.jsonl'], 'string');
    });
});

test('a transcript that cannot be written is reported rather than assumed', async () => {
    const fake = fakeCockpit({ spawn: { '--run': RUN_LINES.join('\n') + '\n' }, fileFails: true });
    await withCockpit(fake, async () => {
        const c = UI.pilotSetupUi();
        c.plan = { target: 'local', host: null, arch: 'amd64', warnings: [], steps: [] };
        await c.start();
        assert.equal(c.transcriptSaved, false);
        assert.equal(c.exec.steps.length, 2);
    });
});

test('start refuses to run without a plan rather than sending an empty envelope', async () => {
    const fake = fakeCockpit({ spawn: { '--run': '' } });
    await withCockpit(fake, async () => {
        const c = UI.pilotSetupUi();
        c.plan = null;
        assert.equal(await c.start(), false);
        assert.equal(fake.calls.length, 0);
        assert.match(c.error.message, /plan/i);
    });
});

test('manual mode renders the same plan through provision-plan', () => {
    const Plan = require('../../js/core/provision-plan.js');
    const c = UI.pilotSetupUi();
    c.plan = {
        target: 'local', host: null, arch: 'amd64', warnings: [],
        steps: [{
            id: 'unit', title: 'Install unit', mutating: true, why: 'systemd needs the unit.',
            argv: [], write: { path: '/etc/systemd/system/rustdesk-api.service', mode: '0644', content: '[Unit]\n', owner: 'root:root' },
            check: null, sha256: null, secret: false
        }]
    };
    assert.equal(c.manualScript(), Plan.manualScript(c.plan));
});

test('finish is blocked until the generated admin password is actually replaced', async () => {
    const c = UI.pilotSetupUi();
    c.generatedPassword = 'GeneratedPw12';
    c.pw = { password: 'GeneratedPw12', confirm: 'GeneratedPw12' };
    assert.equal(await c.finish(), false);
    assert.match(c.pwErrors.password, /generated/i);
    assert.equal(c.finished, false);
});

test('finish fails closed when nothing is wired to write the new password', async () => {
    const c = UI.pilotSetupUi();
    c.generatedPassword = 'GeneratedPw12';
    c.pw = { password: 'a new long password', confirm: 'a new long password' };
    assert.equal(await c.finish(), false);
    assert.equal(c.finished, false);
    assert.match(c.error.message, /password/i);
});

test('finish completes once the password is written, and keeps a partial verdict partial', async () => {
    const written = [];
    const c = UI.pilotSetupUi();
    c.generatedPassword = 'GeneratedPw12';
    c.pw = { password: 'a new long password', confirm: 'a new long password' };
    c.passwordWriter = (pw) => { written.push(pw); return Promise.resolve(); };
    c.handoverResult = { status: 'partial', blocked: [{ port: 21116, proto: 'udp', scope: 'cloud' }], kind: 'PORT_BLOCKED', message: 'Partial success' };
    assert.equal(await c.finish(), true);
    assert.deepEqual(written, ['a new long password']);
    assert.equal(c.finished, true);
    assert.equal(c.handoverResult.status, 'partial');
});

test('the ports step degrades honestly when no port matrix is available', () => {
    const c = UI.pilotSetupUi();
    c.required = UI.requiredPorts(c.choices);
    assert.ok(Array.isArray(c.required));
    assert.equal(c.portsUnavailable(), c.required.length === 0);
});

test('copyTranscript returns false rather than claiming a copy with no clipboard', async () => {
    const c = UI.pilotSetupUi();
    assert.equal(await c.copyTranscript(), false);
    assert.equal(c.copied, false);
    assert.equal(typeof c.transcript(), 'string');
});
