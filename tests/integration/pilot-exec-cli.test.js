// Integration tests for libexec/pilot-exec: argument parsing, Envelope v1
// validation and the two modes that touch nothing (--print-plan, --selftest-redact).
//
// Every assertion here is deliberately restricted to behaviour that later tasks
// EXTEND rather than change: parse_args, the validators, the redactor, and the
// plan printer. Nothing here asserts what --run / --detect / --check-hostkey do,
// because Tasks 12 and 13 implement them — the only thing asserted about those
// flags is that the parser recognises them as modes, which is permanent.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', '..', 'libexec', 'pilot-exec');

function run(args, stdin) {
    const r = spawnSync('python3', [HELPER].concat(args), {
        input: stdin === undefined ? '' : stdin,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024
    });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function lines(text) {
    return text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

// Loads pilot-exec as a Python module (main() is guarded by __name__) and
// evaluates `body`, which must print one JSON document.
function pyEval(body) {
    const code = [
        'import importlib.machinery, importlib.util, inspect, json, sys',
        'loader = importlib.machinery.SourceFileLoader("pilot_exec", ' + JSON.stringify(HELPER) + ')',
        'spec = importlib.util.spec_from_loader("pilot_exec", loader)',
        'px = importlib.util.module_from_spec(spec)',
        'loader.exec_module(px)'
    ].concat(body).join('\n');
    const r = spawnSync('python3', ['-c', code], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.equal(r.status, 0, 'python helper eval failed: ' + r.stderr);
    return JSON.parse(r.stdout);
}

function step(over) {
    return Object.assign({
        id: 'noop', title: 'Do nothing', mutating: false, why: 'because',
        argv: ['python3', '-c', 'pass'], write: null, check: null, sha256: null, secret: false
    }, over || {});
}

function envelope(over) {
    return Object.assign({
        version: 1, transport: 'local', run_id: '20260803T204500Z',
        ssh: null, credentials: null, steps: [step()]
    }, over || {});
}

// --- the helper is shipped executable (C5 rule 8) -------------------------

test('libexec/pilot-exec exists, is mode 0755 and has a python3 shebang', () => {
    const st = fs.statSync(HELPER);
    assert.equal(st.mode & 0o777, 0o755, 'pilot-exec must be mode 0755');
    assert.ok(fs.readFileSync(HELPER, 'utf8').startsWith('#!/usr/bin/python3'),
        'pilot-exec must start with the python3 shebang');
});

// --- argument parsing (C3) -----------------------------------------------

test('no mode flag is a usage error', () => {
    const r = run([]);
    assert.equal(r.code, 2);
    assert.match(r.err, /exactly one mode flag/);
});

test('two mode flags are a usage error', () => {
    const r = run(['--run', '--detect']);
    assert.equal(r.code, 2);
    assert.match(r.err, /exactly one mode flag/);
});

test('a repeated mode flag is a usage error', () => {
    const r = run(['--print-plan', '--print-plan']);
    assert.equal(r.code, 2);
    assert.match(r.err, /repeated mode flag: --print-plan/);
});

test('--transport is not a flag: transport comes from the envelope (C3)', () => {
    const r = run(['--run', '--transport', 'ssh']);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown argument: --transport/);
});

test('every one of the five C3 mode flags is recognised by the parser', () => {
    // Proven without depending on what each mode DOES: a recognised mode plus an
    // unknown argument must fail on the unknown argument, never on the mode.
    for (const mode of ['--run', '--detect', '--check-hostkey', '--print-plan', '--selftest-redact']) {
        const r = run([mode, '--bogus']);
        assert.equal(r.code, 2, mode);
        assert.match(r.err, /unknown argument: --bogus/, mode);
    }
});

test('the mode list is exactly the six modes the CLI pins', () => {
    // C3 pinned five. --probe-ports is the sixth, added deliberately: the
    // wizard's handover claimed "Every required port is reachable" on the
    // strength of `ss -ltun` run ON THE TARGET, which proves only that
    // something is bound there. A listening socket and a reachable one are
    // different facts, and the reference host proved it -- every port
    // listening, the API port dropped by a cloud security group, and the
    // wizard calling that a clean finish. Measuring it requires connecting
    // FROM the Cockpit host, which is where this helper runs, so this is the
    // right home for it even though a TCP connect needs no privilege.
    const modes = pyEval(['print(json.dumps(list(px.MODES)))']);
    assert.deepEqual(modes.slice().sort(),
        ['--check-hostkey', '--detect', '--print-plan', '--probe-ports', '--run', '--selftest-redact']);
    // Still exactly one handler per mode, registered once -- the property the
    // original five-mode pin was really protecting.
    const handlers = pyEval(['print(json.dumps(sorted(px.MODE_HANDLERS.keys())))']);
    assert.deepEqual(handlers, modes.slice().sort(),
        'every mode must have a handler, and no handler may exist without a mode');
});

// --- the redactor self-test (C3) -----------------------------------------

test('--selftest-redact passes with no network and no SSH', () => {
    const r = run(['--selftest-redact']);
    assert.equal(r.code, 0, r.err);
    const doc = lines(r.out)[0];
    assert.equal(doc.t, 'selftest');
    assert.equal(doc.ok, true);
    assert.equal(doc.mask, '••••••');
    assert.ok(doc.cases.length >= 8, 'expected at least 8 redaction cases');
    for (const c of doc.cases) assert.equal(c.ok, true, 'redaction case failed: ' + c.name);
});

test('the redactor removes every registered form of a secret', () => {
    const got = pyEval([
        'r = px.Redactor()',
        'r.add("hunter2horse")',
        'r.add("-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\\n-----END OPENSSH PRIVATE KEY-----")',
        'out = {',
        '  "plain": r.scrub("hunter2horse"),',
        '  "embedded": r.scrub("psk=hunter2horse;"),',
        '  "twice": r.scrub("hunter2horse hunter2horse"),',
        '  "pem_line": r.scrub("saw b3BlbnNzaC1rZXktdjEAAAAABG5vbmU here"),',
        '  "obj": r.scrub_obj({"cmd": "echo hunter2horse", "n": 7, "l": ["hunter2horse"]}),',
        '  "clean": r.scrub("nothing secret here"),',
        '}',
        'print(json.dumps(out))'
    ]);
    const MASK = '••••••';
    assert.equal(got.plain, MASK);
    assert.equal(got.embedded, 'psk=' + MASK + ';');
    assert.equal(got.twice, MASK + ' ' + MASK);
    assert.equal(got.pem_line, 'saw ' + MASK + ' here');
    assert.equal(got.obj.cmd, 'echo ' + MASK);
    assert.equal(got.obj.n, 7);
    assert.deepEqual(got.obj.l, [MASK]);
    assert.equal(got.clean, 'nothing secret here');
});

test('the redactor ignores non-strings and secrets too short to be distinctive', () => {
    const got = pyEval([
        'r = px.Redactor()',
        'r.add(None); r.add(7); r.add(""); r.add("ab")',
        'print(json.dumps({"kept": r.scrub("ab cd 7"), "n": len(r._needles)}))'
    ]);
    assert.equal(got.kept, 'ab cd 7');
    assert.equal(got.n, 0);
});

// --- the ONE text validator, guarded against later shadowing -------------

test('_text keeps its single five-parameter signature', () => {
    // Round 2 shipped a second, incompatible _text() further down the same file,
    // which silently broke every envelope validation. This is the regression.
    const sig = pyEval(['print(json.dumps(list(inspect.signature(px._text).parameters)))']);
    assert.deepEqual(sig, ['value', 'path', 'maxlen', 'allow_empty', 'allow_ctrl']);
});

test('no module-scope name is defined twice in pilot-exec', () => {
    const dupes = pyEval([
        'import ast',
        'tree = ast.parse(open(' + JSON.stringify(HELPER) + ', "r", encoding="utf-8").read())',
        'seen = {}',
        'for node in tree.body:',
        '    names = []',
        '    if isinstance(node, (ast.FunctionDef, ast.ClassDef)): names = [node.name]',
        '    elif isinstance(node, ast.Assign):',
        '        names = [t.id for t in node.targets if isinstance(t, ast.Name)]',
        '    for n in names: seen[n] = seen.get(n, 0) + 1',
        'print(json.dumps(sorted(k for k, v in seen.items() if v > 1)))'
    ]);
    assert.deepEqual(dupes, [], 'these module-scope names are defined more than once');
});

// --- stdin hostility (C2 strict validation) ------------------------------

test('every malformed stdin document is rejected with exit 3', () => {
    const bad = [
        ['empty', ''],
        ['whitespace', '   \n\t  '],
        ['not JSON', 'this is not json'],
        ['truncated', '{"version":1,"transport":"local"'],
        ['JSON null', 'null'],
        ['JSON array', '[]'],
        ['JSON string', '"envelope"'],
        ['JSON number', '42'],
        ['interleaved noise', 'noise\n' + JSON.stringify(envelope())],
        ['two documents', JSON.stringify(envelope()) + JSON.stringify(envelope())]
    ];
    for (const [name, doc] of bad) {
        const r = run(['--print-plan'], doc);
        assert.equal(r.code, 3, name + ' should exit 3, got ' + r.code + ' ' + r.err);
        assert.match(r.err, /"t": *"fatal"|"t":"fatal"/, name);
    }
});

test('an oversized stdin document is rejected rather than buffered', () => {
    const huge = '{"pad":"' + 'a'.repeat(5 * 1024 * 1024) + '"}';
    const r = run(['--print-plan'], huge);
    assert.equal(r.code, 3);
    assert.match(r.err, /larger than/);
});

test('unknown keys are rejected at every level of the envelope', () => {
    const cases = [
        ['envelope', envelope({ extra: 1 })],
        ['ssh', envelope({ transport: 'ssh', ssh: { host: 'h', port: 22, user: 'root', auth: 'agent', accept_fingerprint: null, extra: 1 } })],
        ['credentials', envelope({ credentials: { password: null, pem: null, extra: 1 } })],
        ['step', envelope({ steps: [step({ extra: 1 })] })],
        ['write', envelope({ steps: [step({ argv: [], write: { path: '/tmp/a', mode: '0644', content: 'x', owner: 'root:root', extra: 1 } })] })],
        ['check', envelope({ steps: [step({ check: { argv: ['true'], expect: 'zero', extra: 1 } })] })]
    ];
    for (const [name, env] of cases) {
        const r = run(['--print-plan'], JSON.stringify(env));
        assert.equal(r.code, 3, name);
        assert.match(r.err, /unknown key/, name);
    }
});

test('a missing key is rejected — every C1 key is always present', () => {
    for (const key of ['id', 'title', 'mutating', 'why', 'argv', 'write', 'check', 'sha256', 'secret']) {
        const s = step();
        delete s[key];
        const r = run(['--print-plan'], JSON.stringify(envelope({ steps: [s] })));
        assert.equal(r.code, 3, key);
        assert.match(r.err, new RegExp('missing key\\(s\\): ' + key), key);
    }
    for (const key of ['version', 'transport', 'run_id', 'ssh', 'credentials', 'steps']) {
        const env = envelope();
        delete env[key];
        const r = run(['--print-plan'], JSON.stringify(env));
        assert.equal(r.code, 3, key);
        assert.match(r.err, new RegExp('missing key\\(s\\): ' + key), key);
    }
});

test('envelope.version must be exactly 1', () => {
    for (const v of [0, 2, '1', 1.5, true, null]) {
        const r = run(['--print-plan'], JSON.stringify(envelope({ version: v })));
        assert.equal(r.code, 3, JSON.stringify(v));
    }
});

test('run_id must be a UTC compact timestamp', () => {
    const bad = ['', 'x', '20260803T204500', '20260803t204500Z', '20260803T204500Z\n',
        '٢٠٢٦٠٨٠٣T٢٠٤٥٠٠Z',
        '../../etc/shadow', '20260803T204500Z/../x', 'a'.repeat(64)];
    for (const v of bad) {
        const r = run(['--print-plan'], JSON.stringify(envelope({ run_id: v })));
        assert.equal(r.code, 3, JSON.stringify(v));
    }
    assert.equal(run(['--print-plan'], JSON.stringify(envelope({ run_id: '20260803T204500Z' }))).code, 0);
});

test('transport and ssh must agree', () => {
    const sshBlock = { host: 'h.example', port: 22, user: 'root', auth: 'agent', accept_fingerprint: null };
    assert.equal(run(['--print-plan'], JSON.stringify(envelope({ transport: 'local', ssh: sshBlock }))).code, 3);
    assert.equal(run(['--print-plan'], JSON.stringify(envelope({ transport: 'ssh', ssh: null }))).code, 3);
    assert.equal(run(['--print-plan'], JSON.stringify(envelope({ transport: 'remote', ssh: sshBlock }))).code, 3);
    assert.equal(run(['--print-plan'], JSON.stringify(envelope({ transport: 'ssh', ssh: sshBlock }))).code, 0);
});

test('ssh.host, user, port, auth and accept_fingerprint are validated', () => {
    const base = { host: 'h.example', port: 22, user: 'root', auth: 'agent', accept_fingerprint: null };
    const bad = [
        ['empty host', { host: '' }],
        ['host with newline', { host: 'a.example\nb.example' }],
        ['host with NUL', { host: 'a\x00b.example' }],
        ['host with space', { host: 'a b.example' }],
        ['host with slash', { host: '../etc/hosts' }],
        ['unicode host', { host: 'høst.example' }],
        ['oversized host', { host: 'a'.repeat(300) }],
        ['port 0', { port: 0 }],
        ['port 65536', { port: 65536 }],
        ['port as string', { port: '22' }],
        ['port as bool', { port: true }],
        ['empty user', { user: '' }],
        ['user with space', { user: 'ro ot' }],
        ['unknown auth', { auth: 'kerberos' }],
        ['md5 fingerprint', { accept_fingerprint: 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99' }],
        ['short fingerprint', { accept_fingerprint: 'SHA256:tooshort' }],
        ['fingerprint with padding', { accept_fingerprint: 'SHA256:' + 'a'.repeat(42) + '=' }]
    ];
    for (const [name, over] of bad) {
        const env = envelope({ transport: 'ssh', ssh: Object.assign({}, base, over) });
        assert.equal(run(['--print-plan'], JSON.stringify(env)).code, 3, name);
    }
    const good = envelope({ transport: 'ssh', ssh: Object.assign({}, base, { accept_fingerprint: 'SHA256:' + 'A'.repeat(43) }) });
    assert.equal(run(['--print-plan'], JSON.stringify(good)).code, 0);
});

test('step ids are slugs, unique, and cannot be used as a path', () => {
    const bad = ['', 'A', 'Fetch-Api', 'fetch api', 'fetch/api', '../fetch', 'fetch\x00api',
        'fetch\napi', '-fetch', 'fétch', 'a'.repeat(64)];
    for (const id of bad) {
        const r = run(['--print-plan'], JSON.stringify(envelope({ steps: [step({ id: id })] })));
        assert.equal(r.code, 3, JSON.stringify(id));
    }
    const dupe = envelope({ steps: [step({ id: 'a' }), step({ id: 'a' })] });
    const r = run(['--print-plan'], JSON.stringify(dupe));
    assert.equal(r.code, 3);
    assert.match(r.err, /duplicate step id: a/);
});

test('argv elements may not carry control characters, and argv may not be empty', () => {
    assert.equal(run(['--print-plan'], JSON.stringify(envelope({ steps: [step({ argv: [] })] }))).code, 3);
    assert.equal(run(['--print-plan'], JSON.stringify(envelope({ steps: [step({ argv: ['echo', 'a\nb'] })] }))).code, 3);
    assert.equal(run(['--print-plan'], JSON.stringify(envelope({ steps: [step({ argv: ['echo', 'a\x00b'] })] }))).code, 3);
    assert.equal(run(['--print-plan'], JSON.stringify(envelope({ steps: [step({ argv: 'echo hi' })] }))).code, 3);
    assert.equal(run(['--print-plan'], JSON.stringify(envelope({ steps: [step({ argv: ['echo', 7] })] }))).code, 3);
    assert.equal(run(['--print-plan'], JSON.stringify(envelope({ steps: [step({ argv: ['echo', ''] })] }))).code, 0);
});

test('a write step has argv [], an absolute traversal-free path, 0NNN mode and u:g owner', () => {
    const w = { path: '/etc/pilot/x.conf', mode: '0644', content: 'a\nb\n', owner: 'root:root' };
    const okEnv = envelope({ steps: [step({ argv: [], write: w })] });
    assert.equal(run(['--print-plan'], JSON.stringify(okEnv)).code, 0);

    const bad = [
        ['argv not empty', step({ argv: ['echo'], write: w })],
        ['relative path', step({ argv: [], write: Object.assign({}, w, { path: 'etc/x' }) })],
        ['traversal', step({ argv: [], write: Object.assign({}, w, { path: '/etc/pilot/../../root/.ssh/authorized_keys' }) })],
        ['dot segment', step({ argv: [], write: Object.assign({}, w, { path: '/etc/./x' }) })],
        ['NUL in path', step({ argv: [], write: Object.assign({}, w, { path: '/etc/x\x00y' }) })],
        ['mode 644', step({ argv: [], write: Object.assign({}, w, { mode: '644' }) })],
        ['mode 0o644', step({ argv: [], write: Object.assign({}, w, { mode: '0o644' }) })],
        ['mode 0999', step({ argv: [], write: Object.assign({}, w, { mode: '0999' }) })],
        ['owner root', step({ argv: [], write: Object.assign({}, w, { owner: 'root' }) })],
        ['owner with space', step({ argv: [], write: Object.assign({}, w, { owner: 'root: root' }) })],
        ['content not a string', step({ argv: [], write: Object.assign({}, w, { content: 7 }) })]
    ];
    for (const [name, s] of bad) {
        assert.equal(run(['--print-plan'], JSON.stringify(envelope({ steps: [s] }))).code, 3, name);
    }
});

test('check.expect is zero or nonzero and check.argv is non-empty', () => {
    assert.equal(run(['--print-plan'], JSON.stringify(envelope({ steps: [step({ check: { argv: ['test', '-d', '/tmp'], expect: 'zero' } })] }))).code, 0);
    assert.equal(run(['--print-plan'], JSON.stringify(envelope({ steps: [step({ check: { argv: ['false'], expect: 'nonzero' } })] }))).code, 0);
    assert.equal(run(['--print-plan'], JSON.stringify(envelope({ steps: [step({ check: { argv: ['true'], expect: 'ZERO' } })] }))).code, 3);
    assert.equal(run(['--print-plan'], JSON.stringify(envelope({ steps: [step({ check: { argv: [], expect: 'zero' } })] }))).code, 3);
});

// --- C14: sha256 is verified against the -o path of the download argv ----

test('download_target reads the -o destination as its own argv element (C14)', () => {
    const got = pyEval([
        'cases = {',
        '  "curl": px.download_target(["curl", "-fsSL", "https://x/y.tgz", "-o", "/var/cache/pilot/y.tgz"]),',
        '  "long": px.download_target(["curl", "--output", "/var/cache/pilot/y.tgz", "https://x/y.tgz"]),',
        '  "none": px.download_target(["curl", "-fsSL", "https://x/y.tgz"]),',
        '  "dangling": px.download_target(["curl", "https://x/y.tgz", "-o"]),',
        '  "inside_sh": px.download_target(["/bin/sh", "-c", "curl -fsSL https://x/y.tgz -o /tmp/y"]),',
        '  "empty": px.download_target([]),',
        '  "first_wins": px.download_target(["curl", "-o", "/a", "-o", "/b"]),',
        '}',
        'print(json.dumps(cases))'
    ]);
    assert.equal(got.curl, '/var/cache/pilot/y.tgz');
    assert.equal(got.long, '/var/cache/pilot/y.tgz');
    assert.equal(got.none, null);
    assert.equal(got.dangling, null);
    // The round-2 defect: an -o buried in a shell string is NOT a download target.
    assert.equal(got.inside_sh, null);
    assert.equal(got.empty, null);
    assert.equal(got.first_wins, '/a');
});

test('a step carrying sha256 must expose an absolute -o destination', () => {
    const digest = 'd0689a353fd756815cfe560ce7cb98f764602de60d0403b51db4e5a9bd84d22a';
    const good = step({
        id: 'fetch-api', sha256: digest,
        argv: ['curl', '-fsSL', 'https://example/linux-amd64.tar.gz', '-o', '/var/cache/pilot/api.tar.gz']
    });
    assert.equal(run(['--print-plan'], JSON.stringify(envelope({ steps: [good] }))).code, 0);

    const bad = [
        ['no -o', step({ sha256: digest, argv: ['curl', '-fsSL', 'https://example/a'] })],
        ['-o inside sh -c', step({ sha256: digest, argv: ['/bin/sh', '-c', 'curl https://x -o /tmp/y'] })],
        ['relative dest', step({ sha256: digest, argv: ['curl', 'https://x', '-o', 'api.tar.gz'] })],
        ['traversal dest', step({ sha256: digest, argv: ['curl', 'https://x', '-o', '/var/cache/../etc/passwd'] })],
        ['uppercase digest', step({ sha256: digest.toUpperCase(), argv: ['curl', 'https://x', '-o', '/tmp/a'] })],
        ['short digest', step({ sha256: 'abc', argv: ['curl', 'https://x', '-o', '/tmp/a'] })],
        ['digest not a string', step({ sha256: 12345, argv: ['curl', 'https://x', '-o', '/tmp/a'] })]
    ];
    for (const [name, s] of bad) {
        assert.equal(run(['--print-plan'], JSON.stringify(envelope({ steps: [s] }))).code, 3, name);
    }
});

// --- --print-plan executes NOTHING (C3) ----------------------------------

test('--print-plan prints the steps in order and executes nothing', () => {
    const sentinel = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-pp-')), 'touched');
    const env = envelope({
        steps: [
            step({ id: 'one', title: 'First', why: 'first reason', mutating: true, argv: ['touch', sentinel] }),
            step({ id: 'two', title: 'Second', why: 'second reason', argv: ['python3', '-c', 'pass'] })
        ]
    });
    const r = run(['--print-plan'], JSON.stringify(env));
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.existsSync(sentinel), false, '--print-plan must not run any step');

    const out = lines(r.out);
    assert.equal(out[0].t, 'plan');
    assert.equal(out[0].run_id, '20260803T204500Z');
    assert.equal(out[0].transport, 'local');
    assert.equal(out[0].steps, 2);
    assert.deepEqual(out.slice(1).map((l) => l.t), ['plan-step', 'plan-step']);
    assert.deepEqual(out.slice(1).map((l) => l.id), ['one', 'two']);
    assert.equal(out[1].title, 'First');
    assert.equal(out[1].why, 'first reason');
    assert.equal(out[1].mutating, true);
    assert.equal(out[1].cmd, 'touch ' + sentinel);
});

test('--print-plan masks the command of a secret step and never echoes credentials', () => {
    const env = envelope({
        credentials: { password: 'hunter2horse', pem: null },
        steps: [step({ id: 'secret-step', secret: true, argv: ['login', '--token', 'hunter2horse'] })]
    });
    const r = run(['--print-plan'], JSON.stringify(env));
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.includes('hunter2horse'), false, 'a credential reached the plan output');
    assert.equal(lines(r.out)[1].cmd, '••••••');
});

test('--print-plan reports the resolved sha256 target so the seam is visible', () => {
    const env = envelope({
        steps: [step({
            id: 'fetch-api',
            sha256: 'd0689a353fd756815cfe560ce7cb98f764602de60d0403b51db4e5a9bd84d22a',
            argv: ['curl', '-fsSL', 'https://example/linux-amd64.tar.gz', '-o', '/var/cache/pilot/api.tar.gz']
        })]
    });
    const out = lines(run(['--print-plan'], JSON.stringify(env)).out);
    assert.equal(out[1].sha256, 'd0689a353fd756815cfe560ce7cb98f764602de60d0403b51db4e5a9bd84d22a');
    assert.equal(out[1].sha256_target, '/var/cache/pilot/api.tar.gz');
});

test('a write step is printed by its destination, never by its content', () => {
    const env = envelope({
        steps: [step({
            id: 'configure', argv: [],
            write: { path: '/opt/rustdesk-api/conf/config.yaml', mode: '0640', content: 'key: s3cret-value-here\n', owner: 'rustdesk:rustdesk' }
        })]
    });
    const r = run(['--print-plan'], JSON.stringify(env));
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.includes('s3cret-value-here'), false);
    assert.equal(lines(r.out)[1].write, '/opt/rustdesk-api/conf/config.yaml');
});

test('the step cap and the empty-steps rule hold', () => {
    assert.equal(run(['--print-plan'], JSON.stringify(envelope({ steps: [] }))).code, 3);
    assert.equal(run(['--print-plan'], JSON.stringify(envelope({ steps: {} }))).code, 3);
    const many = [];
    for (let i = 0; i < 201; i += 1) many.push(step({ id: 'step-' + i }));
    assert.equal(run(['--print-plan'], JSON.stringify(envelope({ steps: many }))).code, 3);
});

// =================================================== FINAL REVIEW, FINDING 1
//
// The plans PilotProvisionPlan actually builds must be plans the REAL helper
// accepts. Nothing checked that before: the unit tier asserts on plan objects
// and the e2e tier's stub validates nothing at all, so the first version of the
// DuckDNS step — whose argv carried a multi-line shell script — passed 1400
// unit tests and 21 browser checks while pilot-exec rejected it outright
// ("envelope.steps[N].argv[2] contains a control character", which is the very
// guard that stops a smuggled second command). Every tier a real plan is built
// in now ends at the real validator.
const Plan = require('../../js/core/provision-plan.js');

const DETECTION = {
    os_release: { id: 'debian', id_like: '', version_id: '12', pretty_name: 'Debian 12' },
    arch: 'x86_64', init: 'systemd', firewall: 'firewalld', egress: true,
    disk_free_mb: 4096, hbbs: null, api: null, public_ip: '203.0.113.10'
};

function planChoices(over) {
    return Object.assign({
        target: 'local', installHbbs: true, openFirewall: true,
        tlsTier: 'none', domain: null, duckdns: null, apiPort: 21114, sshPort: 22
    }, over || {});
}

for (const [label, over] of [
    ['no TLS', {}],
    ['own domain', { tlsTier: 'own', domain: 'rd.example.com' }],
    ['sslip.io', { tlsTier: 'sslip' }],
    ['DuckDNS', { tlsTier: 'duckdns', duckdns: { subdomain: 'pilotdemo', token: 'TOKEN-abc123XYZ' } }]
]) {
    test(`a real ${label} plan is accepted by the real helper's own validator`, () => {
        const envelope = Plan.toEnvelope(Plan.build(DETECTION, planChoices(over)),
            { run_id: '20260804T120000Z' });
        const r = run(['--print-plan'], JSON.stringify(envelope));
        assert.equal(r.code, 0, `pilot-exec rejected a plan Pilot itself builds: ${r.out}${r.err}`);
        const printed = lines(r.out);
        assert.equal(printed[0].t, 'plan');
        assert.equal(printed[0].steps, envelope.steps.length);
    });
}

test('the DuckDNS token appears nowhere in what the helper prints for a DuckDNS plan', () => {
    const TOKEN = 'TOKEN-abc123XYZ';
    const envelope = Plan.toEnvelope(Plan.build(DETECTION, planChoices({
        tlsTier: 'duckdns', duckdns: { subdomain: 'pilotdemo', token: TOKEN }
    })), { run_id: '20260804T120000Z' });
    const r = run(['--print-plan'], JSON.stringify(envelope));
    assert.equal(r.code, 0);
    assert.equal(r.out.indexOf(TOKEN), -1, 'the printed plan leaked the token');
    assert.equal(r.err.indexOf(TOKEN), -1, 'stderr leaked the token');
    const printed = lines(r.out);
    const staged = printed.filter((p) => p.id === 'tls-duckdns-token')[0];
    assert.ok(staged, 'the token-staging step must be in the plan');
    assert.equal(staged.secret, true);
    assert.equal(staged.cmd, '•'.repeat(6), 'a secret step prints as the mask, never its content');
    const update = printed.filter((p) => p.id === 'tls-duckdns')[0];
    assert.ok(update.cmd.indexOf(TOKEN) === -1 && update.cmd.indexOf('-K') !== -1,
        'the update step reads the URL from a config file, so its own command is safe to print');
});


// ============ the Server Ops envelope, validated by the thing that validates it
//
// Every Server Ops action was dead on arrival: envelopeFor() built its step out
// of the five keys that carry data, and pilot-exec rejects a missing key exactly
// as hard as an unknown one, so nothing ever ran --
//
//   envelope.steps[0] is missing key(s): check, secret, sha256, write
//
// The unit tier could not catch it. Every test there stubs the transport, so
// client and tests agreed about a shape this helper has never accepted. Two
// mirrors are not a measurement. This check builds the envelope with the REAL
// js/features/server-ops-ui.js and hands it to the REAL helper, which is the
// one assertion a stub cannot fake.
//
// --print-plan validates and renders without executing anything, so this runs
// on any machine with no RustDesk server, no root and no side effects.

const ServerOps = require('../../js/features/server-ops-ui.js');

const OPS_SERVER = { id: 'srv', transport: 'local', host: 'localhost', sshPort: 22, hasCredential: true };

test('pilot-exec accepts the envelope every Server Ops action actually sends', () => {
    for (const op of ServerOps.OPS) {
        const env = ServerOps.envelopeFor(op.id, OPS_SERVER, null);
        const r = run(['--print-plan'], JSON.stringify(env));
        assert.equal(r.code, 0,
            op.id + ' was refused by pilot-exec: ' + r.out.trim() + r.err.trim());
        const out = lines(r.out);
        const planStep = out.filter((l) => l.t === 'plan-step')[0];
        assert.ok(planStep, op.id + ' produced no plan-step');
        assert.equal(planStep.id, op.id);
        assert.ok(String(planStep.cmd).length > 0, op.id + ' rendered an empty command');
    }
});

test('a step missing any required key is refused -- this is what shipped', () => {
    const env = ServerOps.envelopeFor('status', OPS_SERVER, null);
    for (const key of ['write', 'check', 'sha256', 'secret']) {
        const broken = JSON.parse(JSON.stringify(env));
        delete broken.steps[0][key];
        const r = run(['--print-plan'], JSON.stringify(broken));
        assert.notEqual(r.code, 0, 'dropping ' + key + ' must be refused');
        assert.match(r.out + r.err, new RegExp('missing key\\(s\\).*' + key),
            'the refusal must name ' + key);
    }
});
