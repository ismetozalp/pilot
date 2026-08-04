// tests/unit/setup-ui.test.js — the pure half of the six-step setup wizard.
//
// Everything here runs with no DOM and no cockpit global. The reducer is fed the
// exact C4 JSON-line shapes plus the hostile variants a real helper can emit:
// truncated JSON, interleaved noise, unknown message types, embedded newlines,
// control characters, oversized fields and out-of-order step ids.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const UI = require('../../js/features/setup-ui.js');

function feed(events) {
    let exec = UI.blankExec();
    for (const e of events) exec = UI.reduce(exec, e);
    return exec;
}

const RUN_START = { t: 'run-start', run_id: '20260803T204500Z', transport: 'ssh', steps: 3 };

// ------------------------------------------------------------ module shape

test('module loads with no DOM and no cockpit global', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof UI.blankState, 'function');
    assert.equal(globalThis.PilotSetupUi, UI);
});

test('the six wizard steps are exactly the spec order', () => {
    assert.deepEqual(UI.STEP_IDS,
        ['target', 'hostkey', 'detect', 'ports', 'execute', 'handover']);
    for (const id of UI.STEP_IDS)
        assert.equal(typeof UI.STEP_TITLES[id], 'string');
});

// ------------------------------------------------------------ visibleSteps

test('the host-key step is skipped entirely for localhost', () => {
    const s = UI.blankState();
    s.choices.target = 'local';
    assert.deepEqual(UI.visibleSteps(s),
        ['target', 'detect', 'ports', 'execute', 'handover']);
});

test('the host-key step is required for a remote target', () => {
    const s = UI.blankState();
    s.choices.target = 'ssh';
    assert.deepEqual(UI.visibleSteps(s), UI.STEP_IDS);
});

test('an unusable state does not crash visibleSteps and hides host key', () => {
    assert.equal(UI.visibleSteps(null).indexOf('hostkey'), -1);
    assert.equal(UI.visibleSteps({}).indexOf('hostkey'), -1);
    assert.equal(UI.visibleSteps({ choices: null }).indexOf('hostkey'), -1);
});

test('next skips host key on localhost and stops at the last step', () => {
    const s = UI.blankState();
    s.choices.target = 'local';
    s.step = 'target';
    assert.equal(UI.nextStep(s), 'detect');
    s.step = 'handover';
    assert.equal(UI.nextStep(s), 'handover');
    s.step = 'nonesuch';
    assert.equal(UI.nextStep(s), 'target');
});

test('back from detect returns to host key only for a remote target', () => {
    const s = UI.blankState();
    s.step = 'detect';
    s.choices.target = 'local';
    assert.equal(UI.prevStep(s), 'target');
    s.choices.target = 'ssh';
    assert.equal(UI.prevStep(s), 'hostkey');
    s.step = 'target';
    assert.equal(UI.prevStep(s), 'target');
});

// ------------------------------------------------------------ validateTarget

test('localhost needs no credentials at all', () => {
    const r = UI.validateTarget({ target: 'local' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, {});
});

test('a complete remote target with agent auth validates', () => {
    const r = UI.validateTarget({
        target: 'ssh', host: 'rd.example.com', port: 22, user: 'ubuntu', auth: 'agent'
    });
    assert.equal(r.ok, true);
});

test('an unknown target choice is rejected', () => {
    assert.match(UI.validateTarget({ target: '' }).errors.target, /localhost/i);
    assert.match(UI.validateTarget({ target: 'ftp' }).errors.target, /localhost/i);
    assert.match(UI.validateTarget(null).errors.target, /localhost/i);
});

test('hostile hostnames are all rejected with a reason', () => {
    const base = { target: 'ssh', port: 22, user: 'root', auth: 'agent' };
    const bad = [
        '', ' ', 'a b', 'host\nname', 'host\r\nname', 'host\tname',
        'host name', 'host', 'exämple.com', '例え.jp',
        '../../etc/passwd', 'a/b', 'host..name', '-lead.example.com',
        'trail-.example.com', 'x'.repeat(254)
    ];
    for (const host of bad) {
        const r = UI.validateTarget(Object.assign({}, base, { host: host }));
        assert.equal(r.ok, false, JSON.stringify(host));
        assert.equal(typeof r.errors.host, 'string', JSON.stringify(host));
    }
});

test('IPv4, IPv6 and plain short hostnames are accepted', () => {
    const base = { target: 'ssh', port: 22, user: 'root', auth: 'agent' };
    for (const host of ['1.2.3.4', '203.0.113.10', '[2001:db8::1]', 'srv1', 'a'])
        assert.equal(UI.validateTarget(Object.assign({}, base, { host })).ok, true, host);
});

// A wizard whose whole job is provisioning RustDesk over SSH must not refuse
// the literal word "rustdesk" (or any other ordinary bare hostname) as a
// target — bare names get the same RFC 1123 label rule as dotted ones, not an
// invented stricter one. Only the literal placeholder-shaped "host" (the name
// of this very field) is carved out below.
test('realistic bare hostnames used for real SSH targets are all accepted', () => {
    const base = { target: 'ssh', port: 22, user: 'root', auth: 'agent' };
    for (const host of ['server', 'nas', 'rustdesk', 'prod', 'db', 'web', 'vpn',
        'gateway', 'router', 'my-server', 'RustDesk'])
        assert.equal(UI.validateTarget(Object.assign({}, base, { host })).ok, true, host);
});

test('a DNS label over 63 characters is rejected even under the 253-character overall cap', () => {
    const base = { target: 'ssh', port: 22, user: 'root', auth: 'agent' };
    const r = UI.validateTarget(Object.assign({}, base, { host: 'a'.repeat(64) }));
    assert.equal(r.ok, false);
    assert.equal(typeof r.errors.host, 'string');
    assert.equal(UI.validateTarget(Object.assign({}, base, { host: 'a'.repeat(63) })).ok, true);
});

test('a leading or trailing dot is rejected as an empty label', () => {
    const base = { target: 'ssh', port: 22, user: 'root', auth: 'agent' };
    for (const host of ['.example.com', 'example.com.', '.', 'a..b'])
        assert.equal(UI.validateTarget(Object.assign({}, base, { host })).ok, false, host);
});

test('embedded null bytes and unicode in a hostname are rejected', () => {
    const base = { target: 'ssh', port: 22, user: 'root', auth: 'agent' };
    for (const host of ['a\x00b', 'héllo.com', 'srv\x00'])
        assert.equal(UI.validateTarget(Object.assign({}, base, { host })).ok, false, JSON.stringify(host));
});

test('the SSH port must be a whole number in range', () => {
    const base = { target: 'ssh', host: 'h', user: 'root', auth: 'agent' };
    for (const port of [0, -1, 65536, 22.5, NaN, Infinity, '22', null, undefined])
        assert.equal(typeof UI.validateTarget(Object.assign({}, base, { port })).errors.port,
            'string', String(port));
    assert.equal(UI.validateTarget(Object.assign({}, base, { port: 65535 })).ok, true);
});

test('the username must be a POSIX user name', () => {
    const base = { target: 'ssh', host: 'h', port: 22, auth: 'agent' };
    for (const user of ['', 'root user', 'Root', 'ro\not', '1abc', 'a'.repeat(33), '../root'])
        assert.equal(typeof UI.validateTarget(Object.assign({}, base, { user })).errors.user,
            'string', JSON.stringify(user));
    assert.equal(UI.validateTarget(Object.assign({}, base, { user: 'ec2-user' })).ok, true);
});

test('password auth demands a password and PEM auth demands a real key', () => {
    const base = { target: 'ssh', host: 'h', port: 22, user: 'root' };
    assert.match(UI.validateTarget(Object.assign({}, base,
        { auth: 'password', password: '' })).errors.password, /password/i);
    assert.equal(UI.validateTarget(Object.assign({}, base,
        { auth: 'password', password: 'hunter2' })).ok, true);
    assert.match(UI.validateTarget(Object.assign({}, base,
        { auth: 'pem', pem: '' })).errors.pem, /private key/i);
    assert.match(UI.validateTarget(Object.assign({}, base,
        { auth: 'pem', pem: 'not a key' })).errors.pem, /PEM/i);
    assert.equal(UI.validateTarget(Object.assign({}, base, {
        auth: 'pem',
        pem: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----'
    })).ok, true);
    assert.match(UI.validateTarget(Object.assign({}, base, {
        auth: 'pem', pem: '-----BEGIN RSA PRIVATE KEY-----\n' + 'A'.repeat(70000)
    })).errors.pem, /large/i);
    assert.match(UI.validateTarget(Object.assign({}, base,
        { auth: 'kerberos' })).errors.auth, /password/i);
});

// ------------------------------------------------------------ portRows

const REQUIRED = [
    { port: 21115, proto: 'tcp', component: 'hbbs NAT type test', why: 'always' },
    { port: 21116, proto: 'tcp', component: 'hbbs rendezvous', why: 'always' },
    { port: 21116, proto: 'udp', component: 'hbbs rendezvous', why: 'hole punching' },
    { port: 21114, proto: 'tcp', component: 'rustdesk-api', why: 'no TLS' }
];

test('with a recognised host firewall Pilot claims the host rules and still warns about the edge', () => {
    const r = UI.portRows(REQUIRED, 'firewalld');
    assert.equal(r.fixable, true);
    assert.equal(r.host.length, 4);
    assert.equal(r.cloud.length, 4);
    assert.ok(r.host.every((x) => x.scope === 'host'));
    assert.ok(r.cloud.every((x) => x.scope === 'cloud'));
    assert.deepEqual(r.host.map((x) => x.port + '/' + x.proto),
        ['21115/tcp', '21116/tcp', '21116/udp', '21114/tcp']);
});

test('21116 appears as both TCP and UDP, which a UDP-blocking group breaks silently', () => {
    const r = UI.portRows(REQUIRED, 'ufw');
    const p21116 = r.cloud.filter((x) => x.port === 21116).map((x) => x.proto).sort();
    assert.deepEqual(p21116, ['tcp', 'udp']);
});

test('with no recognised host firewall nothing is host-fixable', () => {
    for (const fw of ['none', '', null, undefined, 'iptables-legacy']) {
        const r = UI.portRows(REQUIRED, fw);
        assert.equal(r.fixable, false, String(fw));
        assert.deepEqual(r.host, []);
        assert.equal(r.cloud.length, 4);
    }
});

test('nftables is a recognised host backend', () => {
    assert.equal(UI.portRows(REQUIRED, 'nftables').fixable, true);
});

test('malformed port records are dropped rather than rendered', () => {
    const r = UI.portRows([
        null, undefined, 'sg', 42, [],
        { port: 0, proto: 'tcp' }, { port: 65536, proto: 'tcp' },
        { port: 22.5, proto: 'tcp' }, { port: NaN, proto: 'tcp' },
        { port: '21115', proto: 'tcp' }, { port: 21115, proto: 'sctp' },
        { port: 21115, proto: '' }, { port: 21115 }
    ], 'firewalld');
    assert.deepEqual(r.host, []);
    assert.deepEqual(r.cloud, []);
    assert.deepEqual(UI.portRows(null, 'firewalld').cloud, []);
});

test('control characters in a port label never survive into a row', () => {
    // The fixture carries a real control byte (\x07), not a plain space —
    // component/why are prose, and a plain interior space is content, not
    // corruption; see the next test.
    const r = UI.portRows([{ port: 443, proto: 'TCP', component: 'ca\x07ddy', why: 'a\x01b' }],
        'firewalld');
    assert.equal(r.host[0].component, 'caddy');
    assert.equal(r.host[0].why, 'ab');
    assert.equal(r.host[0].proto, 'tcp');
});

test('a multi-word port-row label keeps its interior spaces intact', () => {
    const r = UI.portRows([
        { port: 21114, proto: 'tcp', component: 'hbbs NAT type test', why: 'no TLS' }
    ], 'firewalld');
    assert.equal(r.host[0].component, 'hbbs NAT type test');
    assert.equal(r.host[0].why, 'no TLS');
});

test('control characters are stripped from a prose label without removing its spaces', () => {
    const r = UI.portRows([
        { port: 443, proto: 'tcp', component: 'ca\x07 ddy label', why: 'x\x01y z' }
    ], 'firewalld');
    assert.equal(r.host[0].component, 'ca ddy label');
    assert.equal(r.host[0].why, 'xy z');
});

// ------------------------------------------------------------ awsCommand

test('the aws command is literal, one -ip-permissions entry per port', () => {
    const rows = UI.portRows(REQUIRED, 'none').cloud;
    const cmd = UI.awsCommand(rows, { groupId: 'sg-0123456789abcdef0', region: 'eu-west-1' });
    assert.equal(cmd,
        'aws ec2 authorize-security-group-ingress --group-id sg-0123456789abcdef0 ' +
        '--region eu-west-1 --ip-permissions ' +
        'IpProtocol=tcp,FromPort=21115,ToPort=21115,IpRanges=[{CidrIp=0.0.0.0/0}] ' +
        'IpProtocol=tcp,FromPort=21116,ToPort=21116,IpRanges=[{CidrIp=0.0.0.0/0}] ' +
        'IpProtocol=udp,FromPort=21116,ToPort=21116,IpRanges=[{CidrIp=0.0.0.0/0}] ' +
        'IpProtocol=tcp,FromPort=21114,ToPort=21114,IpRanges=[{CidrIp=0.0.0.0/0}]');
});

test('an unknown or hostile group id and region degrade to visible placeholders', () => {
    const rows = [{ port: 443, proto: 'tcp' }];
    for (const bad of ['', 'sg', 'sg-XYZ', 'sg-0123; rm -rf /', 'sg-0123456789abcdef01234']) {
        const cmd = UI.awsCommand(rows, { groupId: bad, region: 'eu-west-1' });
        assert.ok(cmd.includes('--group-id <security-group-id>'), JSON.stringify(bad));
        assert.ok(!cmd.includes('rm -rf'), JSON.stringify(bad));
    }
    for (const bad of ['', 'EU-WEST-1', 'eu west 1', 'eu-west-1;id'])
        assert.ok(UI.awsCommand(rows, { region: bad }).includes('--region <region>'),
            JSON.stringify(bad));
});

test('a duplicate port/proto pair is emitted once', () => {
    const cmd = UI.awsCommand([
        { port: 443, proto: 'tcp' }, { port: 443, proto: 'tcp' }, { port: 443, proto: 'udp' }
    ], {});
    assert.equal(cmd.split('IpProtocol=').length - 1, 2);
});

test('no cloud ports means no command at all rather than a broken one', () => {
    assert.equal(UI.awsCommand([], {}), '');
    assert.equal(UI.awsCommand(null, {}), '');
    assert.equal(UI.awsCommand([{ port: 'x', proto: 'tcp' }], {}), '');
});

test('a valid CIDR is honoured and an invalid one falls back to anywhere', () => {
    assert.ok(UI.awsCommand([{ port: 443, proto: 'tcp' }], { cidr: '10.0.0.0/8' })
        .includes('CidrIp=10.0.0.0/8'));
    assert.ok(UI.awsCommand([{ port: 443, proto: 'tcp' }], { cidr: 'evil}' })
        .includes('CidrIp=0.0.0.0/0'));
});

// ------------------------------------------------------------ parseLine

test('parseLine accepts every documented message type', () => {
    for (const t of ['run-start', 'step-start', 'output', 'step-end', 'run-end'])
        assert.equal(UI.parseLine(JSON.stringify({ t: t })).t, t);
});

test('parseLine rejects noise, truncation and unknown types', () => {
    for (const bad of ['', '   ', 'Warning: something', '{"t":"output"', '[1,2,3]',
        'null', '"a string"', '{}', '{"t":"nonesuch"}', '{"t":42}', null, undefined, 42])
        assert.equal(UI.parseLine(bad), null, JSON.stringify(bad));
});

test('parseLine refuses an absurdly oversized line instead of parsing it', () => {
    const huge = '{"t":"output","line":"' + 'a'.repeat(1100000) + '"}';
    assert.equal(UI.parseLine(huge), null);
});

// ------------------------------------------------------------ reduce

test('run-start seeds the run and clears any previous attempt', () => {
    const exec = feed([
        { t: 'step-start', id: 'ghost', title: 'Ghost', cmd: 'true' },
        RUN_START
    ]);
    assert.equal(exec.runId, '20260803T204500Z');
    assert.equal(exec.transport, 'ssh');
    assert.equal(exec.total, 3);
    assert.deepEqual(exec.steps, []);
    assert.equal(exec.status, 'running');
});

test('an unknown transport on run-start is treated as local', () => {
    assert.equal(feed([{ t: 'run-start', run_id: 'r', transport: 'telnet', steps: 1 }]).transport,
        'local');
});

test('reduce never mutates the exec it was given', () => {
    const before = feed([RUN_START, { t: 'step-start', id: 'fetch-api', title: 'F', cmd: 'curl' }]);
    const snapshot = JSON.stringify(before);
    const after = UI.reduce(before, { t: 'output', id: 'fetch-api', stream: 'stdout', line: 'x' });
    assert.equal(JSON.stringify(before), snapshot);
    assert.equal(after.steps[0].lines.length, 1);
});

test('a full happy step carries title, command, exit code and duration', () => {
    const exec = feed([
        RUN_START,
        { t: 'step-start', id: 'fetch-api', title: 'Download API server', cmd: 'curl -fsSL https://x -o /tmp/a' },
        { t: 'output', id: 'fetch-api', stream: 'stdout', line: 'downloading' },
        { t: 'output', id: 'fetch-api', stream: 'stderr', line: '100%' },
        { t: 'step-end', id: 'fetch-api', status: 'ok', exit: 0, ms: 8432 }
    ]);
    assert.equal(exec.steps.length, 1);
    const s = exec.steps[0];
    assert.equal(s.title, 'Download API server');
    assert.equal(s.cmd, 'curl -fsSL https://x -o /tmp/a');
    assert.equal(s.status, 'ok');
    assert.equal(s.exit, 0);
    assert.equal(s.ms, 8432);
    assert.deepEqual(s.lines, [
        { stream: 'stdout', text: 'downloading' },
        { stream: 'stderr', text: '100%' }
    ]);
    assert.equal(s.open, false);
});

test('a failed step opens itself so the reason is not one click away', () => {
    const exec = feed([
        RUN_START,
        { t: 'step-start', id: 'unit', title: 'Install unit', cmd: 'systemctl enable x' },
        { t: 'step-end', id: 'unit', status: 'failed', exit: 1, ms: 12 }
    ]);
    assert.equal(exec.steps[0].status, 'failed');
    assert.equal(exec.steps[0].open, true);
});

test('a skipped idempotency probe is recorded as skipped, not as success', () => {
    const exec = feed([
        RUN_START,
        { t: 'step-start', id: 'adopt-hbbs', title: 'Adopt hbbs', cmd: 'true' },
        { t: 'step-end', id: 'adopt-hbbs', status: 'skipped', exit: 0, ms: 3 }
    ]);
    assert.equal(exec.steps[0].status, 'skipped');
});

test('an unknown step status is treated as failed rather than as success', () => {
    const exec = feed([
        RUN_START,
        { t: 'step-start', id: 'a', title: 'A', cmd: 'x' },
        { t: 'step-end', id: 'a', status: 'probably-fine', exit: 0, ms: 1 }
    ]);
    assert.equal(exec.steps[0].status, 'failed');
});

test('output for a step that never announced itself still lands somewhere visible', () => {
    const exec = feed([
        RUN_START,
        { t: 'output', id: 'surprise', stream: 'stdout', line: 'hello' }
    ]);
    assert.equal(exec.steps.length, 1);
    assert.equal(exec.steps[0].id, 'surprise');
    assert.equal(exec.steps[0].lines[0].text, 'hello');
});

test('an id-less output line is kept as noise rather than dropped', () => {
    const exec = feed([RUN_START, { t: 'output', stream: 'stdout', line: 'orphan' }]);
    assert.deepEqual(exec.steps, []);
    assert.deepEqual(exec.noise, ['orphan']);
});

test('step-start and step-end without an id are ignored', () => {
    const exec = feed([RUN_START,
        { t: 'step-start', title: 'no id' }, { t: 'step-end', status: 'ok', exit: 0, ms: 1 }]);
    assert.deepEqual(exec.steps, []);
});

test('embedded newlines become separate transcript lines', () => {
    const exec = feed([
        RUN_START,
        { t: 'step-start', id: 'a', title: 'A', cmd: 'x' },
        { t: 'output', id: 'a', stream: 'stdout', line: 'one\ntwo\nthree' }
    ]);
    assert.deepEqual(exec.steps[0].lines.map((l) => l.text), ['one', 'two', 'three']);
});

test('control characters are stripped from ids, titles, commands and output', () => {
    const exec = feed([
        { t: 'run-start', run_id: '2026 0803', transport: 'local', steps: 1 },
        { t: 'step-start', id: 'fe tch', title: 'Download', cmd: 'curl x' },
        { t: 'output', id: 'fetch', stream: 'stdout', line: 'ok \r' },
        { t: 'run-end', status: 'ok', kind: null }
    ]);
    assert.equal(exec.runId, '20260803');
    assert.equal(exec.steps[0].id, 'fetch');
    assert.equal(exec.steps[0].title, 'Download');
    assert.equal(exec.steps[0].cmd, 'curl x');
    assert.equal(exec.steps[0].lines[0].text, 'ok');
});

test('an oversized output line is truncated instead of freezing the pane', () => {
    const exec = feed([
        RUN_START,
        { t: 'step-start', id: 'a', title: 'A', cmd: 'x' },
        { t: 'output', id: 'a', stream: 'stdout', line: 'z'.repeat(50000) }
    ]);
    assert.equal(exec.steps[0].lines[0].text.length, 4000);
});

test('a runaway step stops at the line cap and says so once', () => {
    let exec = feed([RUN_START, { t: 'step-start', id: 'a', title: 'A', cmd: 'x' }]);
    for (let i = 0; i < 2500; i++)
        exec = UI.reduce(exec, { t: 'output', id: 'a', stream: 'stdout', line: 'line ' + i });
    assert.equal(exec.steps[0].lines.length, 2001);
    assert.match(exec.steps[0].lines[2000].text, /truncated by Pilot after 2000 lines/);
});

test('noise is capped so a non-JSON flood cannot grow without bound', () => {
    let exec = feed([RUN_START]);
    for (let i = 0; i < 200; i++)
        exec = UI.reduce(exec, { t: 'output', stream: 'stdout', line: 'noise ' + i });
    assert.equal(exec.noise.length, 50);
});

test('a missing or nonsense exit code and duration become null, not zero', () => {
    const exec = feed([
        RUN_START,
        { t: 'step-start', id: 'a', title: 'A', cmd: 'x' },
        { t: 'step-end', id: 'a', status: 'ok', exit: 'zero', ms: -5 }
    ]);
    assert.equal(exec.steps[0].exit, null);
    assert.equal(exec.steps[0].ms, null);
});

test('run-end records the C6 kind and an unknown run status is failure', () => {
    assert.equal(feed([RUN_START, { t: 'run-end', status: 'partial', kind: 'PORT_BLOCKED' }]).kind,
        'PORT_BLOCKED');
    assert.equal(feed([RUN_START, { t: 'run-end', status: 'weird', kind: null }]).status, 'failed');
    assert.equal(feed([RUN_START, { t: 'run-end', status: 'ok', kind: null }]).kind, null);
});

test('reduce survives garbage events without changing anything', () => {
    const start = feed([RUN_START]);
    for (const bad of [null, undefined, 42, 'x', [], { t: 'nonesuch' }, {}])
        assert.deepEqual(UI.reduce(start, bad), start);
});

test('a re-run of the same step id resets that step rather than duplicating it', () => {
    const exec = feed([
        RUN_START,
        { t: 'step-start', id: 'a', title: 'A', cmd: 'x' },
        { t: 'output', id: 'a', stream: 'stdout', line: 'first' },
        { t: 'step-end', id: 'a', status: 'failed', exit: 1, ms: 5 },
        { t: 'step-start', id: 'a', title: 'A', cmd: 'x' },
        { t: 'output', id: 'a', stream: 'stdout', line: 'second' }
    ]);
    assert.equal(exec.steps.length, 1);
    assert.deepEqual(exec.steps[0].lines.map((l) => l.text), ['second']);
    assert.equal(exec.steps[0].status, 'running');
});

// ------------------------------------------------------------ progress

test('progress counts finished steps against the announced total', () => {
    const exec = feed([
        RUN_START,
        { t: 'step-start', id: 'a', title: 'A', cmd: 'x' },
        { t: 'step-end', id: 'a', status: 'ok', exit: 0, ms: 1 },
        { t: 'step-start', id: 'b', title: 'B', cmd: 'x' }
    ]);
    assert.deepEqual(UI.progress(exec), { done: 1, total: 3, percent: 33 });
});

test('a failed or skipped step still counts as finished for the bar', () => {
    const exec = feed([
        { t: 'run-start', run_id: 'r', transport: 'local', steps: 2 },
        { t: 'step-start', id: 'a', title: 'A', cmd: 'x' },
        { t: 'step-end', id: 'a', status: 'skipped', exit: 0, ms: 1 },
        { t: 'step-start', id: 'b', title: 'B', cmd: 'x' },
        { t: 'step-end', id: 'b', status: 'failed', exit: 1, ms: 1 }
    ]);
    assert.deepEqual(UI.progress(exec), { done: 2, total: 2, percent: 100 });
});

test('progress never divides by zero and never exceeds 100', () => {
    assert.deepEqual(UI.progress(UI.blankExec()), { done: 0, total: 0, percent: 0 });
    assert.deepEqual(UI.progress(null), { done: 0, total: 0, percent: 0 });
    const exec = feed([
        { t: 'run-start', run_id: 'r', transport: 'local', steps: 1 },
        { t: 'step-start', id: 'a', title: 'A', cmd: 'x' },
        { t: 'step-end', id: 'a', status: 'ok', exit: 0, ms: 1 },
        { t: 'step-start', id: 'b', title: 'B', cmd: 'x' },
        { t: 'step-end', id: 'b', status: 'ok', exit: 0, ms: 1 }
    ]);
    assert.equal(UI.progress(exec).percent, 100);
    assert.equal(UI.progress(exec).total, 2);
});

// ------------------------------------------------------------ transcriptText

test('the copyable transcript carries commands, streams, exit codes and the verdict', () => {
    const exec = feed([
        RUN_START,
        { t: 'step-start', id: 'fetch-api', title: 'Download API server', cmd: 'curl -fsSL https://x' },
        { t: 'output', id: 'fetch-api', stream: 'stdout', line: 'ok' },
        { t: 'output', id: 'fetch-api', stream: 'stderr', line: 'warn' },
        { t: 'step-end', id: 'fetch-api', status: 'ok', exit: 0, ms: 8432 },
        { t: 'output', stream: 'stdout', line: 'stray helper chatter' },
        { t: 'run-end', status: 'partial', kind: 'PORT_BLOCKED' }
    ]);
    const text = UI.transcriptText(exec);
    assert.ok(text.includes('# pilot run 20260803T204500Z transport=ssh'));
    assert.ok(text.includes('== fetch-api — Download API server'));
    assert.ok(text.includes('$ curl -fsSL https://x'));
    assert.ok(text.includes('1| ok'));
    assert.ok(text.includes('2| warn'));
    assert.ok(text.includes('-- ok exit=0 8432ms'));
    assert.ok(text.includes('?| stray helper chatter'));
    assert.ok(text.includes('== run partial kind=PORT_BLOCKED'));
    assert.equal(text.slice(-1), '\n');
});

test('a transcript for an untouched run is still valid text', () => {
    assert.equal(typeof UI.transcriptText(UI.blankExec()), 'string');
    assert.ok(UI.transcriptText(null).includes('(no run id)'));
});

// ------------------------------------------------------------ runPath

test('the transcript is persisted under /var/lib/pilot/runs', () => {
    assert.equal(UI.runPath('20260803T204500Z'), '/var/lib/pilot/runs/20260803T204500Z.jsonl');
});

test('a run id that could escape the runs directory yields no path at all', () => {
    for (const bad of ['', '..', '../../etc/shadow', 'a/b', 'a b', 'a\nb', 'a b',
        'ünïcode', 'x'.repeat(65), null, undefined, '.'])
        assert.equal(UI.runPath(bad), null, JSON.stringify(bad));
});

// ------------------------------------------------------------ handover

const OK_RUN = feed([RUN_START, { t: 'run-end', status: 'ok', kind: null }]);

test('handover reports success only when every required port is reachable', () => {
    const h = UI.handover(OK_RUN, [
        { port: 21115, proto: 'tcp', reachable: true, scope: 'cloud' },
        { port: 21116, proto: 'udp', reachable: true, scope: 'cloud' }
    ]);
    assert.equal(h.status, 'ok');
    assert.equal(h.kind, null);
    assert.deepEqual(h.blocked, []);
});

test('a still-blocked port makes handover PARTIAL and names the port', () => {
    const h = UI.handover(OK_RUN, [
        { port: 21115, proto: 'tcp', reachable: true, scope: 'cloud' },
        { port: 21116, proto: 'udp', reachable: false, scope: 'cloud' }
    ]);
    assert.equal(h.status, 'partial');
    assert.equal(h.kind, 'PORT_BLOCKED');
    assert.deepEqual(h.blocked, [{ port: 21116, proto: 'udp', scope: 'cloud' }]);
    assert.ok(h.message.includes('21116/udp'));
    assert.match(h.message, /partial/i);
});

test('several blocked ports are all named and pluralised', () => {
    const h = UI.handover(OK_RUN, [
        { port: 21114, proto: 'tcp', reachable: false, scope: 'cloud' },
        { port: 21116, proto: 'udp', reachable: false, scope: 'host' }
    ]);
    assert.equal(h.blocked.length, 2);
    assert.ok(h.message.includes('21114/tcp'));
    assert.ok(h.message.includes('21116/udp'));
    assert.ok(h.message.includes('ports'));
    assert.equal(h.blocked[1].scope, 'host');
});

test('a missing or malformed reachable flag is treated as blocked, never as reachable', () => {
    const h = UI.handover(OK_RUN, [
        { port: 21115, proto: 'tcp', scope: 'cloud' },
        { port: 21116, proto: 'tcp', reachable: 'yes', scope: 'cloud' }
    ]);
    assert.equal(h.status, 'partial');
    assert.equal(h.blocked.length, 2);
});

test('a failed run is never dressed up as partial success', () => {
    const failed = feed([RUN_START, { t: 'run-end', status: 'failed', kind: 'CHECKSUM_MISMATCH' }]);
    const h = UI.handover(failed, []);
    assert.equal(h.status, 'failed');
    assert.equal(h.kind, 'CHECKSUM_MISMATCH');
});

test('a partial run with no port evidence is still reported as partial', () => {
    const partial = feed([RUN_START, { t: 'run-end', status: 'partial', kind: 'NO_EGRESS' }]);
    const h = UI.handover(partial, []);
    assert.equal(h.status, 'partial');
    assert.equal(h.kind, 'NO_EGRESS');
});

test('garbage reachability records are ignored rather than crashing handover', () => {
    const h = UI.handover(OK_RUN, [null, 'x', 42, {}, { port: 'a', reachable: false }, []]);
    assert.equal(h.status, 'ok');
    assert.deepEqual(UI.handover(OK_RUN, null).blocked, []);
});

// ------------------------------------------------------------ passwordGate

test('handover will not finish while the generated password is still in place', () => {
    const r = UI.passwordGate({ password: 'GeneratedPw12', confirm: 'GeneratedPw12' },
        'GeneratedPw12');
    assert.equal(r.ok, false);
    assert.match(r.errors.password, /generated/i);
});

test('a genuinely new, confirmed password passes the gate', () => {
    assert.equal(UI.passwordGate({ password: 'correct horse battery', confirm: 'correct horse battery' },
        'GeneratedPw12').ok, true);
});

test('the password gate rejects empty, short, oversized, control-laden and mismatched input', () => {
    assert.match(UI.passwordGate({ password: '', confirm: '' }, 'g').errors.password, /Choose/);
    assert.match(UI.passwordGate({ password: 'short', confirm: 'short' }, 'g').errors.password, /12/);
    assert.match(UI.passwordGate({ password: 'a'.repeat(257), confirm: 'a'.repeat(257) }, 'g')
        .errors.password, /256/);
    // A genuine control byte gets its own, accurately-worded message...
    assert.match(UI.passwordGate({ password: 'abcdefgh\x01ijkl', confirm: 'abcdefgh\x01ijkl' }, 'g')
        .errors.password, /control/i);
    // ...distinct from mere leading/trailing whitespace, which is a different
    // mistake (an accidental copy-paste space) and is named as such rather
    // than being blamed on "control characters" it does not contain.
    assert.match(UI.passwordGate({ password: 'abcdefghijkl ', confirm: 'abcdefghijkl ' }, 'g')
        .errors.password, /whitespace/i);
    assert.match(UI.passwordGate({ password: 'abcdefghijkl', confirm: 'abcdefghijkm' }, 'g')
        .errors.confirm, /match/i);
    assert.equal(UI.passwordGate(null, 'g').ok, false);
});

test('the gate does not demand a change when nothing was generated', () => {
    assert.equal(UI.passwordGate({ password: 'abcdefghijkl', confirm: 'abcdefghijkl' }, null).ok, true);
});

// ------------------------------------------------------------ manualFor

test('manual mode renders the same plan object through provision-plan', () => {
    const Plan = require('../../js/core/provision-plan.js');
    const plan = {
        target: 'local', host: null, arch: 'amd64', warnings: [],
        steps: [{
            id: 'fetch-api', title: 'Download API server', mutating: true,
            why: 'The API server tarball is required.',
            argv: ['curl', '-fsSL', 'https://example.invalid/linux-amd64.tar.gz'],
            write: null, check: null, sha256: null, secret: false
        }]
    };
    assert.equal(UI.manualFor(plan), Plan.manualScript(plan));
});

test('manual mode renders nothing rather than a wrong script when there is no plan', () => {
    assert.equal(UI.manualFor(null), '');
    assert.equal(UI.manualFor(undefined), '');
    assert.equal(UI.manualFor('a plan'), '');
});

// ------------------------------------------------------------ blankState

test('a blank state starts on the target step with localhost preselected', () => {
    const s = UI.blankState();
    assert.equal(s.step, 'target');
    assert.equal(s.choices.target, 'local');
    assert.equal(s.choices.port, 22);
    assert.equal(s.choices.remember, false);
    assert.equal(s.plan, null);
    assert.equal(s.manual, false);
    assert.equal(s.exec.status, 'idle');
    assert.notEqual(UI.blankState().choices, s.choices);
});
