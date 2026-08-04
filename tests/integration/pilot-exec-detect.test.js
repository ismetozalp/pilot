// Integration tests for --detect and --check-hostkey.
//
// The Detection document is the single input to PilotProvisionPlan.build(), so
// its SHAPE is asserted exhaustively — exactly the C3 keys, no more, no fewer,
// with the right types — and its PARSER is driven against hostile probe output
// directly, because a detection probe runs on a machine we do not control.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', '..', 'libexec', 'pilot-exec');

function run(args, stdin, env) {
    const r = spawnSync('python3', [HELPER].concat(args), {
        input: stdin === undefined ? '' : stdin,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: Object.assign({}, process.env, env || {})
    });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

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

function detect(probeText) {
    return pyEval([
        'text = json.loads(sys.stdin.read()) if False else ' + JSON.stringify(probeText),
        'print(json.dumps(px.parse_detection(text)))'
    ]);
}

const LOCAL_REQUEST = { version: 1, transport: 'local', ssh: null, credentials: null };

// --- the Detection document is exactly the C3 shape ----------------------

test('--detect emits exactly the C3 Detection document against this host', () => {
    const r = run(['--detect'], JSON.stringify(LOCAL_REQUEST));
    assert.equal(r.code, 0, r.err);
    const lines = r.out.split('\n').filter((l) => l.trim() !== '');
    assert.equal(lines.length, 1, '--detect must emit exactly one JSON document');
    const d = JSON.parse(lines[0]);

    assert.deepEqual(Object.keys(d).sort(),
        ['api', 'arch', 'disk_free_mb', 'egress', 'firewall', 'hbbs', 'init',
            'os_release', 'public_ip']);
    assert.deepEqual(Object.keys(d.os_release).sort(),
        ['id', 'id_like', 'pretty_name', 'version_id']);
    for (const k of Object.keys(d.os_release)) assert.equal(typeof d.os_release[k], 'string');

    assert.equal(typeof d.arch, 'string');
    assert.ok(d.arch.length > 0);
    assert.ok(['systemd', 'other'].includes(d.init), 'init was ' + d.init);
    assert.ok(['firewalld', 'ufw', 'nftables', 'none'].includes(d.firewall));
    assert.equal(typeof d.egress, 'boolean');
    assert.equal(typeof d.disk_free_mb, 'number');
    assert.ok(Number.isInteger(d.disk_free_mb) && d.disk_free_mb >= 0);
    assert.ok(d.public_ip === null || typeof d.public_ip === 'string');

    assert.ok(d.hbbs === null || typeof d.hbbs === 'object');
    if (d.hbbs) {
        assert.deepEqual(Object.keys(d.hbbs).sort(),
            ['data_dir', 'install', 'ports', 'pubkey', 'version']);
    }
    assert.ok(d.api === null || typeof d.api === 'object');
    if (d.api) assert.deepEqual(Object.keys(d.api).sort(), ['install', 'port', 'version']);
});

test('--detect reports this host\'s real architecture and init system', () => {
    const d = JSON.parse(run(['--detect'], JSON.stringify(LOCAL_REQUEST)).out.trim());
    const uname = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(d.arch, uname);
    assert.equal(d.init, fs.existsSync('/run/systemd/system') ? 'systemd' : 'other');
});

// --- the DetectRequest is validated as strictly as the envelope ----------

test('a malformed DetectRequest is rejected with exit 3', () => {
    const bad = [
        ['unknown key', { version: 1, transport: 'local', ssh: null, credentials: null, extra: 1 }],
        ['missing credentials', { version: 1, transport: 'local', ssh: null }],
        ['version 2', { version: 2, transport: 'local', ssh: null, credentials: null }],
        ['version as string', { version: '1', transport: 'local', ssh: null, credentials: null }],
        ['bad transport', { version: 1, transport: 'remote', ssh: null, credentials: null }],
        ['ssh set for local', { version: 1, transport: 'local', credentials: null, ssh: { host: 'h', port: 22, user: 'root', auth: 'agent', accept_fingerprint: null } }],
        ['ssh null for ssh', { version: 1, transport: 'ssh', ssh: null, credentials: null }],
        ['bad ssh host', { version: 1, transport: 'ssh', credentials: null, ssh: { host: 'a b', port: 22, user: 'root', auth: 'agent', accept_fingerprint: null } }]
    ];
    for (const [name, doc] of bad) {
        const r = run(['--detect'], JSON.stringify(doc));
        assert.equal(r.code, 3, name + ': got ' + r.code + ' ' + r.err);
    }
    for (const [name, raw] of [['truncated', '{"version":1'], ['array', '[]'], ['empty', '']]) {
        assert.equal(run(['--detect'], raw).code, 3, name);
    }
});

test('the detect request error paths name request.*, not envelope.*', () => {
    const r = run(['--detect'], JSON.stringify({ version: 1, transport: 'ssh', ssh: null, credentials: null }));
    assert.equal(r.code, 3);
    assert.match(r.err, /request\.ssh/);
});

// --- parse_detection against hostile probe output ------------------------

test('parse_detection tolerates noise, blank lines and unknown keys', () => {
    const d = detect([
        '',
        '# a comment',
        'this line has no separator',
        '=value with no key',
        'unknown_key=ignored',
        'os_id=fedora',
        'os_id_like=',
        'os_version_id=42',
        'os_pretty_name="Fedora Linux 42 (Server Edition)"',
        'arch=aarch64',
        'init=systemd',
        'firewall=firewalld',
        'egress=true',
        'disk_free_mb=51200',
        'hbbs_present=false',
        'api_present=false',
        'public_ip=203.0.113.10',
        ''
    ].join('\n'));
    assert.equal(d.os_release.id, 'fedora');
    assert.equal(d.os_release.id_like, '');
    assert.equal(d.os_release.version_id, '42');
    assert.equal(d.os_release.pretty_name, 'Fedora Linux 42 (Server Edition)');
    assert.equal(d.arch, 'aarch64');
    assert.equal(d.init, 'systemd');
    assert.equal(d.firewall, 'firewalld');
    assert.equal(d.egress, true);
    assert.equal(d.disk_free_mb, 51200);
    assert.equal(d.hbbs, null);
    assert.equal(d.api, null);
    assert.equal(d.public_ip, '203.0.113.10');
});

test('parse_detection returns a complete document from empty probe output', () => {
    for (const text of ['', '   ', '\n\n\n', 'garbage without any separator at all']) {
        const d = detect(text);
        assert.deepEqual(Object.keys(d).sort(),
            ['api', 'arch', 'disk_free_mb', 'egress', 'firewall', 'hbbs', 'init',
                'os_release', 'public_ip']);
        assert.equal(d.init, 'other');
        assert.equal(d.firewall, 'none');
        assert.equal(d.egress, false);
        assert.equal(d.disk_free_mb, 0);
        assert.equal(d.hbbs, null);
        assert.equal(d.api, null);
        assert.equal(d.public_ip, null);
        assert.equal(d.arch, 'unknown');
    }
});

test('an adopted hbbs is reported with sorted unique ports and a real data_dir', () => {
    const d = detect([
        'hbbs_present=true',
        'hbbs_version=1.1.16',
        'hbbs_install=deb',
        'hbbs_data_dir=/var/lib/rustdesk-server',
        'hbbs_pubkey=OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=',
        'hbbs_ports=21116,21115,21116,21117,,notaport,99999,0',
        'api_present=true',
        'api_version=2.7',
        'api_install=binary',
        'api_port=21114'
    ].join('\n'));
    assert.deepEqual(d.hbbs.ports, [21115, 21116, 21117]);
    assert.equal(d.hbbs.version, '1.1.16');
    assert.equal(d.hbbs.install, 'deb');
    assert.equal(d.hbbs.data_dir, '/var/lib/rustdesk-server');
    assert.equal(d.hbbs.pubkey, 'OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=');
    assert.deepEqual(d.api, { version: '2.7', port: 21114, install: 'binary' });
});

test('hbbs.data_dir is never the empty string — a consumer must not have to guess', () => {
    // Round 2 emitted '' here, and the plan builder only substituted its default
    // for undefined, so the install path was written to the filesystem root.
    const d = detect(['hbbs_present=true', 'hbbs_data_dir=', 'hbbs_ports='].join('\n'));
    assert.equal(d.hbbs.data_dir, '/var/lib/rustdesk-server');
    assert.deepEqual(d.hbbs.ports, []);
    assert.equal(d.hbbs.version, 'unknown');
    assert.equal(d.hbbs.install, 'unknown');
    assert.equal(d.hbbs.pubkey, '');
});

test('unrecognised enumerated values collapse to their safe default', () => {
    const d = detect([
        'init=upstart', 'firewall=iptables', 'egress=TRUE',
        'hbbs_present=true', 'hbbs_install=rpm',
        'api_present=true', 'api_install=docker', 'api_port=not-a-number'
    ].join('\n'));
    assert.equal(d.init, 'other');
    assert.equal(d.firewall, 'none');
    assert.equal(d.egress, false, 'egress must be strict: "TRUE" is not true');
    assert.equal(d.hbbs.install, 'unknown');
    assert.equal(d.api.install, 'unknown');
    assert.equal(d.api.port, 21114);
});

test('probe output cannot inject control characters or unbounded fields', () => {
    const d = detect([
        'os_pretty_name=Debian\x07GNU/Linux\x1b[31m',
        'os_id=' + 'd'.repeat(5000),
        'arch=' + 'a'.repeat(5000),
        'hbbs_present=true',
        'hbbs_pubkey=abc$(rm -rf /)def==;\'"`',
        'public_ip=not an ip at all'
    ].join('\n'));
    assert.equal(d.os_release.pretty_name, 'Debian GNU/Linux [31m'.replace(/ /g, ''),
        'control bytes must be stripped, not passed through');
    assert.ok(d.os_release.id.length <= 200);
    assert.ok(d.arch.length <= 200);
    assert.equal(/[\x00-\x1f\x7f]/.test(JSON.stringify(d)), false);
    assert.equal(d.hbbs.pubkey, 'abcrmrf/def==');
    assert.equal(d.public_ip, null, 'a non-address must not be reported as a public IP');
});

// Python's int() refuses to convert a digit string of more than 4300 characters
// (a guard against a quadratic-time DoS) — a probe running on a machine we do
// not control can trivially emit one. Each numeric field must bound the digit
// run before conversion, the same way the string fields are bounded by
// _clean's maxlen, so a hostile probe degrades to a safe default instead of
// escaping parse_detection as a raw, uncaught ValueError.

test('an oversized digit run in disk_free_mb does not raise and stays a finite integer', () => {
    const d = detect('disk_free_mb=' + '9'.repeat(5000));
    assert.equal(typeof d.disk_free_mb, 'number');
    assert.ok(Number.isFinite(d.disk_free_mb));
    assert.ok(Number.isInteger(d.disk_free_mb));
});

test('an oversized digit run in api_port does not raise and collapses to the safe default port', () => {
    const d = detect(['api_present=true', 'api_port=' + '9'.repeat(5000)].join('\n'));
    assert.equal(d.api.port, 21114, 'an out-of-range port must collapse to the default, not report a bogus port number');
});

test('an oversized digit run in an hbbs_ports token does not raise and is dropped as out of range', () => {
    const d = detect(['hbbs_present=true',
        'hbbs_ports=' + '9'.repeat(5000) + ',22,' + '8'.repeat(6000)].join('\n'));
    assert.deepEqual(d.hbbs.ports, [22], 'the one in-range port survives; the oversized tokens are dropped, not crashed on');
});

test('a payload with hostile oversized numeric fields everywhere at once degrades safely as a whole', () => {
    // Closes the class generally rather than field by field: every numeric
    // field hostile at the same time, in one probe.
    const d = detect([
        'disk_free_mb=' + '7'.repeat(6000),
        'api_present=true',
        'api_port=' + '8'.repeat(6000),
        'hbbs_present=true',
        'hbbs_ports=' + '6'.repeat(6000) + ',21116,' + '5'.repeat(6000),
    ].join('\n'));
    assert.equal(typeof d.disk_free_mb, 'number');
    assert.ok(Number.isFinite(d.disk_free_mb));
    assert.equal(d.api.port, 21114);
    assert.deepEqual(d.hbbs.ports, [21116]);
});

test('a totally malformed --detect stdin document still produces a structured fatal line, never a traceback', () => {
    // This exercises the full CLI path (not just the parser in isolation):
    // whatever is thrown must surface through main()'s Fail/BrokenPipeError
    // handling as {"t":"fatal",...} on stderr with a clean exit code, never an
    // uncaught Python traceback.
    for (const raw of ['{"version":1', '[]', '', 'not json at all', '{}']) {
        const r = run(['--detect'], raw);
        assert.equal(r.code, 3, 'raw=' + JSON.stringify(raw));
        assert.doesNotMatch(r.err, /Traceback/);
        let parsed;
        assert.doesNotThrow(() => { parsed = JSON.parse(r.err.trim()); }, 'stderr must be one JSON fatal line: ' + r.err);
        assert.equal(parsed.t, 'fatal');
        assert.equal(typeof parsed.kind, 'string');
        assert.equal(typeof parsed.message, 'string');
    }
});

test('a key repeated by the probe takes its last value, deterministically', () => {
    const d = detect(['arch=x86_64', 'arch=aarch64'].join('\n'));
    assert.equal(d.arch, 'aarch64');
});

test('a value containing an equals sign survives intact', () => {
    const d = detect('hbbs_present=true\nhbbs_pubkey=AAAA=BBBB=');
    assert.equal(d.hbbs.pubkey, 'AAAA=BBBB=');
});

// --- --check-hostkey ------------------------------------------------------

test('--check-hostkey validates its request document', () => {
    const bad = [
        ['unknown key', { host: 'h', port: 22, user: 'root' }],
        ['missing port', { host: 'h' }],
        ['host with space', { host: 'a b', port: 22 }],
        ['host with newline', { host: 'a\nb', port: 22 }],
        ['port as string', { host: 'h', port: '22' }],
        ['port 0', { host: 'h', port: 0 }],
        ['port 70000', { host: 'h', port: 70000 }]
    ];
    for (const [name, doc] of bad) {
        assert.equal(run(['--check-hostkey'], JSON.stringify(doc)).code, 3, name);
    }
    assert.equal(run(['--check-hostkey'], 'not json').code, 3);
});

test('--check-hostkey on a port with no sshd fails closed with exit 7', () => {
    const r = run(['--check-hostkey'], JSON.stringify({ host: '127.0.0.1', port: 1 }));
    assert.equal(r.code, 7);
    assert.match(r.err, /SSH_UNREACHABLE/);
    assert.equal(r.out.trim(), '', 'no fingerprint document may be emitted on failure');
});

test('openssh_fingerprint matches ssh-keygen for a real generated key', { skip: !fs.existsSync('/usr/bin/ssh-keygen') && !fs.existsSync('/bin/ssh-keygen') }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-fp-'));
    const key = path.join(dir, 'id_ed25519');
    const gen = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { encoding: 'utf8' });
    assert.equal(gen.status, 0, gen.stderr);
    const pub = fs.readFileSync(key + '.pub', 'utf8').trim().split(/\s+/);
    const expected = spawnSync('ssh-keygen', ['-l', '-f', key + '.pub'], { encoding: 'utf8' })
        .stdout.trim().split(/\s+/)[1];
    const got = pyEval(['print(json.dumps(px.openssh_fingerprint(' + JSON.stringify(pub[1]) + ')))']);
    assert.equal(got, expected);
});

test('openssh_fingerprint refuses input that is not base64', () => {
    const got = pyEval([
        'print(json.dumps([px.openssh_fingerprint(v) for v in ["", "!!!", "not base64!", "AAAA"]]))'
    ]);
    assert.equal(got[0], null);
    assert.equal(got[1], null);
    assert.equal(got[2], null);
    assert.equal(typeof got[3], 'string');
});

// --- the TOFU store -------------------------------------------------------

test('the known_hosts store round-trips, keys on host+port, and never duplicates', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-kh-')), 'known_hosts');
    const got = pyEval([
        'p = ' + JSON.stringify(file),
        'before = px.known_hosts_lookup("h.example", 22, p)',
        'px.known_hosts_record("h.example", 22, "ssh-ed25519", "AAAAKEY1", p)',
        'px.known_hosts_record("h.example", 22, "ssh-ed25519", "AAAAKEY1", p)',
        'px.known_hosts_record("h.example", 2222, "ssh-ed25519", "AAAAKEY2", p)',
        'out = {',
        '  "before": before,',
        '  "p22": px.known_hosts_lookup("h.example", 22, p),',
        '  "p2222": px.known_hosts_lookup("h.example", 2222, p),',
        '  "other": px.known_hosts_lookup("other.example", 22, p),',
        '  "raw": open(p, "r", encoding="utf-8").read(),',
        '}',
        'print(json.dumps(out))'
    ]);
    assert.deepEqual(got.before, []);
    assert.equal(got.p22.length, 1, 'a repeated record was written twice');
    assert.equal(got.p22[0].key, 'AAAAKEY1');
    assert.equal(got.p2222.length, 1);
    assert.equal(got.p2222[0].key, 'AAAAKEY2');
    assert.deepEqual(got.other, []);
    // A non-default port is bracketed, exactly as OpenSSH writes it.
    assert.match(got.raw, /^h\.example ssh-ed25519 AAAAKEY1$/m);
    assert.match(got.raw, /^\[h\.example\]:2222 ssh-ed25519 AAAAKEY2$/m);
});

test('a corrupt or missing known_hosts file degrades to "nothing is known"', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-kh2-'));
    const corrupt = path.join(dir, 'known_hosts');
    fs.writeFileSync(corrupt, '\n# only a comment\nshort line\n\x00\x01\x02\n');
    const got = pyEval([
        'out = {',
        '  "missing": px.read_known_hosts(' + JSON.stringify(path.join(dir, 'absent')) + '),',
        '  "corrupt": px.known_hosts_lookup("h.example", 22, ' + JSON.stringify(corrupt) + '),',
        '}',
        'print(json.dumps(out))'
    ]);
    assert.deepEqual(got.missing, []);
    assert.deepEqual(got.corrupt, []);
});

test('hostkey_gate is a hard stop when the recorded key differs', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-kh3-')), 'known_hosts');
    fs.writeFileSync(file, 'h.example ssh-ed25519 AAAARECORDED\n');
    const got = pyEval([
        'px.KNOWN_HOSTS = ' + JSON.stringify(file),
        'px.scan_hostkeys = lambda host, port, timeout=15: [{"keytype": "ssh-ed25519", "key": "AAAAOFFERED"}]',
        'px.openssh_fingerprint = lambda key: "SHA256:" + key',
        'out = {}',
        'st = px.hostkey_status("h.example", 22)',
        'out["status"] = {"known": st["known"], "kind": st["kind"], "fingerprint": st["fingerprint"]}',
        'try:',
        '    px.hostkey_gate({"host": "h.example", "port": 22, "accept_fingerprint": "SHA256:AAAAOFFERED"})',
        '    out["gate"] = {"code": 0, "kind": "OK"}',
        'except px.Fail as exc:',
        '    out["gate"] = {"code": exc.code, "kind": exc.kind}',
        'print(json.dumps(out))'
    ]);
    assert.deepEqual(got.status, { known: true, kind: 'SSH_HOSTKEY_CHANGED', fingerprint: 'SHA256:AAAAOFFERED' });
    // Even with the user confirming the new fingerprint, a changed key is refused.
    assert.deepEqual(got.gate, { code: 5, kind: 'SSH_HOSTKEY_CHANGED' });
});

test('an unknown host key is refused until a matching fingerprint is confirmed', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-kh4-')), 'known_hosts');
    const got = pyEval([
        'px.KNOWN_HOSTS = ' + JSON.stringify(file),
        'px.scan_hostkeys = lambda host, port, timeout=15: [{"keytype": "ssh-ed25519", "key": "AAAANEW"}]',
        'px.openssh_fingerprint = lambda key: "SHA256:" + key',
        'out = {}',
        'def gate(fp):',
        '    try:',
        '        px.hostkey_gate({"host": "n.example", "port": 22, "accept_fingerprint": fp})',
        '        return {"code": 0, "kind": "OK"}',
        '    except px.Fail as exc:',
        '        return {"code": exc.code, "kind": exc.kind}',
        'out["none"] = gate(None)',
        'out["wrong"] = gate("SHA256:AAAAWRONG")',
        'out["right"] = gate("SHA256:AAAANEW")',
        'out["recorded"] = px.known_hosts_lookup("n.example", 22, ' + JSON.stringify(file) + ')',
        'out["second"] = gate(None)',
        'print(json.dumps(out))'
    ]);
    assert.deepEqual(got.none, { code: 4, kind: 'SSH_HOSTKEY_UNKNOWN' });
    assert.deepEqual(got.wrong, { code: 5, kind: 'SSH_HOSTKEY_CHANGED' });
    assert.deepEqual(got.right, { code: 0, kind: 'OK' });
    assert.equal(got.recorded.length, 1, 'the confirmed key was not recorded for TOFU');
    // Trust on FIRST use: once recorded, no further confirmation is needed.
    assert.deepEqual(got.second, { code: 0, kind: 'OK' });
});

// --- additional exhaustiveness: each firewall backend, and a hostile fingerprint compare ---

test('each firewall backend is reported individually, not just collapsed to none', () => {
    const ufw = detect('firewall=ufw');
    assert.equal(ufw.firewall, 'ufw');
    const nft = detect('firewall=nftables');
    assert.equal(nft.firewall, 'nftables');
    const firewalld = detect('firewall=firewalld');
    assert.equal(firewalld.firewall, 'firewalld');
    const none = detect('firewall=none');
    assert.equal(none.firewall, 'none');
});

test('a fingerprint comparison is exact equality, not a prefix/substring match', () => {
    // A comparison implemented as `accepted in offered` or `offered.startswith(accepted)`
    // would wrongly accept a truncated or extended fingerprint. hostkey_gate must use
    // strict equality so a MITM cannot exploit a lenient compare.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-kh5-')), 'known_hosts');
    const got = pyEval([
        'px.KNOWN_HOSTS = ' + JSON.stringify(file),
        'px.scan_hostkeys = lambda host, port, timeout=15: [{"keytype": "ssh-ed25519", "key": "AAAANEWKEY"}]',
        'px.openssh_fingerprint = lambda key: "SHA256:" + key',
        'def gate(fp):',
        '    try:',
        '        px.hostkey_gate({"host": "p.example", "port": 22, "accept_fingerprint": fp})',
        '        return {"code": 0, "kind": "OK"}',
        '    except px.Fail as exc:',
        '        return {"code": exc.code, "kind": exc.kind}',
        'out = {',
        '  "prefix": gate("SHA256:AAAANEW"),',
        '  "suffixed": gate("SHA256:AAAANEWKEYX"),',
        '  "exact": gate("SHA256:AAAANEWKEY"),',
        '}',
        'print(json.dumps(out))'
    ]);
    assert.deepEqual(got.prefix, { code: 5, kind: 'SSH_HOSTKEY_CHANGED' },
        'a fingerprint that is only a PREFIX of the real one must not be accepted');
    assert.deepEqual(got.suffixed, { code: 5, kind: 'SSH_HOSTKEY_CHANGED' },
        'a fingerprint the real one is only a prefix OF must not be accepted');
    assert.deepEqual(got.exact, { code: 0, kind: 'OK' });
});
