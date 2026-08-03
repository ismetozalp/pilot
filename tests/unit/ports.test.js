// Unit tests for js/core/ports.js.
//
// The matrix decides which ports the wizard tells a user to open. Getting 21116
// wrong is the classic RustDesk failure: registration works over TCP while hole
// punching silently does not, because a security group dropped UDP. So the pair
// is asserted as a pair, and every branch of the TLS/transport matrix is covered.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../../js/core/ports.js');

// The C13 choices object, verbatim. Every case below is a spread of this.
const BASE = {
    target: 'local', installHbbs: true, tlsTier: 'none', domain: null,
    duckdns: null, apiPort: 21114, sshPort: 22, openFirewall: true
};
const pick = (reqs) => reqs.map((r) => r.port + '/' + r.proto);

// --- the matrix -----------------------------------------------------------

test('local target with no TLS: hbbs/hbbr, the websockets and the API port', () => {
    assert.deepEqual(pick(P.required(BASE)),
        ['21114/tcp', '21115/tcp', '21116/tcp', '21116/udp', '21117/tcp',
            '21118/tcp', '21119/tcp']);
});

test('ssh target adds the SSH port and nothing else', () => {
    const reqs = P.required({ ...BASE, target: 'ssh', sshPort: 2222 });
    assert.deepEqual(pick(reqs),
        ['2222/tcp', '21114/tcp', '21115/tcp', '21116/tcp', '21116/udp', '21117/tcp',
            '21118/tcp', '21119/tcp']);
    const ssh = reqs.find((r) => r.component === 'ssh');
    assert.equal(ssh.port, 2222);
    // Already proven reachable by the live session, so it is a host-firewall
    // concern only — Pilot must not tell the user to open it at the cloud edge.
    assert.equal(ssh.scope, 'host');
});

test('TLS closes the API port at the edge and opens 80 and 443 instead', () => {
    const reqs = P.required({ ...BASE, tlsTier: 'own', domain: 'rd.example.com' });
    assert.deepEqual(pick(reqs),
        ['80/tcp', '443/tcp', '21115/tcp', '21116/tcp', '21116/udp', '21117/tcp',
            '21118/tcp', '21119/tcp']);
    assert.equal(reqs.some((r) => r.component === 'api'), false,
        'with TLS the API port is reached through 443, never opened directly');
});

test('TLS restricts the websocket ports to the proxy rather than the internet', () => {
    const reqs = P.required({ ...BASE, tlsTier: 'duckdns',
        duckdns: { subdomain: 'x', token: 'y' } });
    for (const port of [21118, 21119]) {
        const r = reqs.find((x) => x.port === port);
        assert.equal(r.restrictTo, 'proxy', port + ' must be proxy-only under TLS');
        assert.equal(r.scope, 'host', port + ' must not be opened at the edge');
    }
});

test('without TLS the websocket ports are public and unrestricted', () => {
    const reqs = P.required(BASE);
    for (const port of [21118, 21119]) {
        const r = reqs.find((x) => x.port === port);
        assert.equal(r.restrictTo, null);
        assert.equal(r.scope, 'both');
    }
});

test('21116 is required on BOTH tcp and udp in every configuration', () => {
    for (const tier of P.TIERS) {
        const reqs = P.required({ ...BASE, tlsTier: tier, target: 'ssh' });
        const protos = reqs.filter((r) => r.port === 21116).map((r) => r.proto).sort();
        assert.deepEqual(protos, ['tcp', 'udp'], 'tier ' + tier);
        const udp = reqs.find((r) => r.port === 21116 && r.proto === 'udp');
        assert.match(udp.why, /hole punch/i);
    }
});

test('sslip is a TLS tier like any other', () => {
    const reqs = P.required({ ...BASE, tlsTier: 'sslip' });
    assert.ok(reqs.some((r) => r.port === 443));
    assert.equal(reqs.some((r) => r.component === 'api'), false);
});

test('a custom API port is honoured when TLS is off', () => {
    const reqs = P.required({ ...BASE, apiPort: 8443 });
    const api = reqs.find((r) => r.component === 'api');
    assert.equal(api.port, 8443);
    assert.equal(api.scope, 'both');
});

test('every requirement is fully shaped and frozen', () => {
    const reqs = P.required({ ...BASE, target: 'ssh', tlsTier: 'own' });
    const requiredKeys = ['component', 'port', 'proto', 'restrictTo', 'scope', 'why'];
    for (const r of reqs) {
        // Check that required keys exist with correct types; allow future additions.
        for (const k of requiredKeys) {
            assert.ok(k in r, 'requirement must have ' + k);
        }
        assert.equal(Number.isInteger(r.port), true);
        assert.ok(r.port >= 1 && r.port <= 65535);
        assert.ok(r.proto === 'tcp' || r.proto === 'udp');
        assert.ok(['host', 'edge', 'both'].includes(r.scope));
        assert.ok(r.restrictTo === null || r.restrictTo === 'proxy');
        assert.ok(r.why.length > 0);
        assert.equal(Object.isFrozen(r), true);
    }
});

test('no configuration ever produces a duplicate port/proto pair', () => {
    for (const tier of P.TIERS) {
        for (const target of ['local', 'ssh']) {
            const keys = pick(P.required({ ...BASE, tlsTier: tier, target: target }));
            assert.equal(new Set(keys).size, keys.length, tier + '/' + target);
        }
    }
});

test('a custom apiPort colliding with a fixed RustDesk port throws and names it', () => {
    for (const port of [21115, 21116, 21117, 21118, 21119]) {
        assert.throws(() => P.required({ ...BASE, apiPort: port }), (e) => {
            assert.equal(e.kind, 'GENERIC');
            assert.match(e.message, /apiPort/);
            assert.match(e.message, new RegExp(port.toString()));
            return true;
        }, 'apiPort ' + port);
    }
});

test('a custom sshPort colliding with a fixed RustDesk port throws and names it', () => {
    // Without TLS: hbbs ports + websockets
    for (const port of [21115, 21116, 21117, 21118, 21119]) {
        assert.throws(() => P.required({ ...BASE, target: 'ssh', sshPort: port }), (e) => {
            assert.equal(e.kind, 'GENERIC');
            assert.match(e.message, /sshPort/);
            assert.match(e.message, new RegExp(port.toString()));
            return true;
        }, 'sshPort ' + port + ' without TLS');
    }
    // With TLS: also collide with acme and https
    for (const port of [80, 443]) {
        assert.throws(() => P.required({ ...BASE, target: 'ssh', tlsTier: 'own', sshPort: port }),
            (e) => e.kind === 'GENERIC' && /sshPort/.test(e.message), 'sshPort ' + port + ' with TLS');
    }
});

test('required() tolerates unknown extra keys in choices', () => {
    const reqs = P.required({ ...BASE, unknownKey: 'ignored', anotherUnknown: 42 });
    assert.ok(reqs.length > 0);
    assert.ok(reqs.some((r) => r.component === 'hbbs'));
});

// --- hostile choices ------------------------------------------------------

test('an unknown TLS tier throws rather than silently downgrading to plaintext', () => {
    for (const tier of ['auto', 'skip', 'NONE', '', null, undefined, 1, {}, ['own']]) {
        assert.throws(() => P.required({ ...BASE, tlsTier: tier }), (e) => {
            assert.equal(e.kind, 'GENERIC');
            assert.match(e.message, /tlsTier/);
            return true;
        }, JSON.stringify(tier));
    }
});

test('a bad port throws GENERIC and names the field', () => {
    const bad = [0, -1, 65536, 1.5, NaN, Infinity, '', ' ', 'http', '2\n1114',
        '0x50', '1e4', '123456', {}, [], true, '21114; rm -rf /'];
    for (const v of bad) {
        assert.throws(() => P.required({ ...BASE, apiPort: v }), (e) =>
            e.kind === 'GENERIC' && /apiPort/.test(e.message), 'apiPort ' + JSON.stringify(v));
        assert.throws(() => P.required({ ...BASE, target: 'ssh', sshPort: v }), (e) =>
            e.kind === 'GENERIC' && /sshPort/.test(e.message), 'sshPort ' + JSON.stringify(v));
    }
});

test('omitted ports fall back to the C13 defaults', () => {
    const reqs = P.required({ ...BASE, target: 'ssh', apiPort: undefined, sshPort: null });
    assert.equal(reqs.find((r) => r.component === 'ssh').port, P.SSH_DEFAULT);
    assert.equal(reqs.find((r) => r.component === 'api').port, P.API_DEFAULT);
    assert.equal(P.SSH_DEFAULT, 22);
    assert.equal(P.API_DEFAULT, 21114);
});

test('a numeric-looking string port is accepted, with whitespace trimmed', () => {
    // DOCUMENTED tolerance: an HTML number input hands back a string.
    assert.equal(P.required({ ...BASE, apiPort: '8443' })
        .find((r) => r.component === 'api').port, 8443);
    assert.equal(P.required({ ...BASE, apiPort: ' 8443 ' })
        .find((r) => r.component === 'api').port, 8443);
    assert.equal(P.required({ ...BASE, apiPort: '08443' })
        .find((r) => r.component === 'api').port, 8443);
});

test('a missing or non-object choices argument throws GENERIC', () => {
    for (const v of [null, undefined, 42, 'none', [], true])
        assert.throws(() => P.required(v), (e) => e.kind === 'GENERIC', JSON.stringify(v));
});

test('an unknown target is treated as local, never as a silent ssh', () => {
    // Only the literal 'ssh' adds an SSH rule; anything else is a local install.
    for (const t of ['local', 'LOCAL', 'ssh2', '', null, undefined, 7, {}]) {
        const reqs = P.required({ ...BASE, target: t });
        assert.equal(reqs.some((r) => r.component === 'ssh'), false, JSON.stringify(t));
    }
});

// --- classification -------------------------------------------------------

test('hostFixable and cloudEdge partition by scope, and neither is empty', () => {
    const reqs = P.required({ ...BASE, target: 'ssh', tlsTier: 'own' });
    const host = P.hostFixable(reqs);
    const edge = P.cloudEdge(reqs);
    assert.ok(host.length > 0 && edge.length > 0);
    for (const r of host) assert.ok(r.scope === 'host' || r.scope === 'both');
    for (const r of edge) assert.ok(r.scope === 'edge' || r.scope === 'both');
    // SSH and the proxy-only websockets are host-only, so the sets differ.
    assert.ok(host.length > edge.length);
    assert.equal(edge.some((r) => r.component === 'ssh'), false);
    assert.equal(edge.some((r) => r.port === 21118), false);
});

test('with TLS off every port is both host-fixable and a cloud-edge concern', () => {
    const reqs = P.required(BASE);
    assert.equal(P.hostFixable(reqs).length, reqs.length);
    assert.equal(P.cloudEdge(reqs).length, reqs.length);
});

test('classification helpers tolerate rubbish input', () => {
    for (const v of [null, undefined, 42, 'x', {}]) {
        assert.deepEqual(P.hostFixable(v), []);
        assert.deepEqual(P.cloudEdge(v), []);
        assert.deepEqual(P.probeTargets(v), []);
    }
    assert.deepEqual(P.hostFixable([null, 3, { scope: 'nope' }, { scope: 'host' }]),
        [{ scope: 'host' }]);
});

test('probeTargets probes exactly what the Cockpit host must be able to reach', () => {
    const reqs = P.required({ ...BASE, target: 'ssh', tlsTier: 'own' });
    assert.deepEqual(P.probeTargets(reqs), [
        { port: 80, proto: 'tcp' }, { port: 443, proto: 'tcp' },
        { port: 21115, proto: 'tcp' }, { port: 21116, proto: 'tcp' },
        { port: 21116, proto: 'udp' }, { port: 21117, proto: 'tcp' }
    ]);
});

// --- reachability modelling -----------------------------------------------

const REQS = P.required(BASE);
const allOk = () => P.probeTargets(REQS).map((t) => P.result(t.port, t.proto, true, 'open'));

test('a fully reachable probe set reports ok with nothing blocked or unknown', () => {
    const rep = P.reachability(REQS, allOk());
    assert.equal(rep.ok, true);
    assert.equal(rep.checked, 7);
    assert.deepEqual(rep.blocked, []);
    assert.deepEqual(rep.unknown, []);
    assert.equal(rep.records.length, 7);
    assert.equal(P.errorFor(rep), null);
});

test('one blocked UDP port fails the whole pre-flight and names the port', () => {
    const results = allOk().map((r) =>
        (r.port === 21116 && r.proto === 'udp')
            ? P.result(21116, 'udp', false, 'timed out') : r);
    const rep = P.reachability(REQS, results);
    assert.equal(rep.ok, false);
    assert.deepEqual(rep.blocked.map((r) => r.port + '/' + r.proto), ['21116/udp']);
    const err = P.errorFor(rep);
    assert.equal(err.kind, 'PORT_BLOCKED');
    assert.match(err.message, /21116\/udp/);
});

test('a required port with NO result is unknown, never assumed reachable', () => {
    const rep = P.reachability(REQS, allOk().filter((r) => r.port !== 21117));
    assert.equal(rep.ok, false);
    assert.deepEqual(rep.unknown.map((r) => r.port), [21117]);
    assert.deepEqual(rep.blocked, []);
    const rec = rep.records.find((r) => r.port === 21117);
    assert.equal(rec.reachable, null);
    assert.match(P.errorFor(rep).message, /21117\/tcp/);
});

test('a result for a port that was never required is ignored', () => {
    const rep = P.reachability(REQS, allOk().concat([P.result(3389, 'tcp', true, 'open')]));
    assert.equal(rep.ok, true);
    assert.equal(rep.records.some((r) => r.port === 3389), false);
});

test('a later result for the same port/proto wins', () => {
    const rep = P.reachability(REQS,
        allOk().concat([P.result(21115, 'tcp', false, 'blocked by security group')]));
    assert.equal(rep.ok, false);
    assert.deepEqual(rep.blocked.map((r) => r.port), [21115]);
});

test('proxy-restricted ports are never probed and so never block the wizard', () => {
    const tlsReqs = P.required({ ...BASE, tlsTier: 'own' });
    const rep = P.reachability(tlsReqs,
        P.probeTargets(tlsReqs).map((t) => P.result(t.port, t.proto, true, 'open')));
    assert.equal(rep.ok, true);
    assert.equal(rep.records.some((r) => r.port === 21118), false);
});

test('reachability never throws on rubbish and reports every requirement unknown', () => {
    for (const v of [null, undefined, 42, 'x', {}, [null, 'x', 5, {}]]) {
        const rep = P.reachability(REQS, v);
        assert.equal(rep.ok, false, JSON.stringify(v));
        assert.equal(rep.unknown.length, 7);
    }
    const rep = P.reachability(null, allOk());
    assert.equal(rep.ok, true);
    assert.equal(rep.checked, 0);
});

test('result() rejects a bad port or proto', () => {
    for (const v of [0, 65536, 'x', null, {}, '2\n1'])
        assert.throws(() => P.result(v, 'tcp', true, ''), (e) => e.kind === 'GENERIC');
    for (const v of ['TCP', 'sctp', '', null, 6, {}])
        assert.throws(() => P.result(80, v, true, ''), (e) => e.kind === 'GENERIC');
});

test('result() coerces reachable strictly and sanitises detail', () => {
    assert.equal(P.result(80, 'tcp', 'yes', '').reachable, false);
    assert.equal(P.result(80, 'tcp', 1, '').reachable, false);
    assert.equal(P.result(80, 'tcp', true, '').reachable, true);
    const r = P.result(80, 'tcp', false, 'a\x00b\x1b[31mc' + 'z'.repeat(500));
    assert.equal(/[\x00-\x1f\x7f]/.test(r.detail), false);
    assert.ok(r.detail.length <= 200);
    assert.equal(P.result(80, 'tcp', true, null).detail, '');
    assert.equal(P.result(80, 'tcp', true, { a: 1 }).detail, '');
});

test('normalizeResults drops unusable entries instead of throwing', () => {
    const out = P.normalizeResults([
        { port: 80, proto: 'tcp', reachable: true, detail: 'open' },
        { port: '443', proto: 'TCP', reachable: true },
        { port: 0, proto: 'tcp', reachable: true },
        { port: 21116, proto: 'sctp', reachable: true },
        null, 5, 'x', [], { port: 21117, proto: 'udp', reachable: 'true' }
    ]);
    assert.deepEqual(out, [
        { port: 80, proto: 'tcp', reachable: true, detail: 'open' },
        { port: 443, proto: 'tcp', reachable: true, detail: '' },
        { port: 21117, proto: 'udp', reachable: false, detail: '' }
    ]);
    assert.deepEqual(P.normalizeResults(null), []);
    assert.deepEqual(P.normalizeResults('nope'), []);
});

// --- the cloud/edge command Pilot can only SUGGEST -------------------------

test('awsIngressArgv is literal argv, never a shell string', () => {
    const req = P.required(BASE).find((r) => r.port === 21116 && r.proto === 'udp');
    assert.deepEqual(P.awsIngressArgv(req, 'sg-0123abcd'), [
        'aws', 'ec2', 'authorize-security-group-ingress',
        '--group-id', 'sg-0123abcd', '--protocol', 'udp',
        '--port', '21116', '--cidr', '0.0.0.0/0'
    ]);
});

test('awsIngressArgv refuses a security group id it cannot vouch for', () => {
    const req = P.required(BASE)[0];
    for (const g of ['', 'sg-', 'sg-xyz', '0123abcd', 'sg-0123abcd; rm -rf /',
        'sg-0123abcd\nmalice', null, undefined, 42, {}])
        assert.throws(() => P.awsIngressArgv(req, g), (e) =>
            e.kind === 'GENERIC', JSON.stringify(g));
});

test('awsIngressArgv rejects proxy-restricted ports that must not be internet-facing', () => {
    // Proxy-restricted ports (21118, 21119) under TLS must not be opened to the internet.
    const tlsReqs = P.required({ ...BASE, tlsTier: 'own' });
    for (const port of [21118, 21119]) {
        const req = tlsReqs.find((r) => r.port === port);
        assert.equal(req.restrictTo, 'proxy');
        assert.throws(() => P.awsIngressArgv(req, 'sg-0123abcd'), (e) =>
            e.kind === 'GENERIC' && /proxy/i.test(e.message), port + ' must be proxy-only');
    }
});

test('awsIngressArgv rejects host-only ports that are not cloud-edge concerns', () => {
    // SSH is host-only; the 21114 API port under TLS is not cloud-edge either.
    const reqs = P.required({ ...BASE, target: 'ssh', tlsTier: 'own' });
    const sshReq = reqs.find((r) => r.component === 'ssh');
    assert.equal(sshReq.scope, 'host');
    assert.throws(() => P.awsIngressArgv(sshReq, 'sg-0123abcd'), (e) =>
        e.kind === 'GENERIC' && /host-only/.test(e.message), 'SSH is host-only');
});

test('awsIngressArgv succeeds for genuinely cloud-edge ports', () => {
    // Ports with scope 'both' or 'edge' and no proxy restriction should work.
    const reqs = P.required({ ...BASE, tlsTier: 'own' });
    const edgeReqs = P.cloudEdge(reqs);
    assert.ok(edgeReqs.length > 0);
    for (const req of edgeReqs) {
        const argv = P.awsIngressArgv(req, 'sg-0123abcd');
        assert.ok(Array.isArray(argv));
        assert.ok(argv.includes('--port'));
        assert.ok(argv.includes('--cidr'));
    }
});

test('describe renders a requirement as one readable line', () => {
    const req = P.required(BASE).find((r) => r.port === 21116 && r.proto === 'udp');
    const s = P.describe(req);
    assert.match(s, /21116\/udp/);
    assert.match(s, /hbbs/);
    assert.equal(/[\x00-\x1f\x7f]/.test(s), false);
});

// --- module hygiene -------------------------------------------------------

test('loads under node with no window and no cockpit', () => {
    assert.equal(typeof globalThis.window, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
});

test('index.html loads ports.js after ostarget.js', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.includes('js/core/ports.js'), 'ports.js is not referenced');
    assert.ok(srcs.indexOf('js/core/ostarget.js') < srcs.indexOf('js/core/ports.js'),
        'ports.js must load after ostarget.js');
});
