// Unit tests for js/core/firewall.js.
//
// Rule generation is goldened because a whitespace change in a rich rule is the
// difference between an idempotency probe that matches and one that adds the same
// rule on every run. The golden inputs come from the REAL port matrix rather than
// a hand-written list, so a change to ports.js shows up here as a visible diff.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../../js/core/firewall.js');
const P = require('../../js/core/ports.js');

const GOLDEN = path.join(__dirname, '..', 'fixtures', 'golden');
const golden = (n) => fs.readFileSync(path.join(GOLDEN, n), 'utf8');

// The configuration the goldens are generated from: remote target on a custom SSH
// port, TLS on. It exercises every branch — ssh, acme, https, both 21116 protos,
// and the two proxy-restricted websocket ports.
const CHOICES = {
    target: 'ssh', installHbbs: true, tlsTier: 'own', domain: 'rd.example.com',
    duckdns: null, apiPort: 21114, sshPort: 2222, openFirewall: true
};
const REQS = P.required(CHOICES);

// --- golden files ---------------------------------------------------------

test('firewalld rules match the golden file byte for byte', () => {
    assert.equal(F.rules('firewalld', REQS).join('\n') + '\n', golden('firewall-firewalld.txt'));
});

test('ufw rules match the golden file byte for byte', () => {
    assert.equal(F.rules('ufw', REQS).join('\n') + '\n', golden('firewall-ufw.txt'));
});

test('nftables rules match the golden file byte for byte', () => {
    assert.equal(F.rules('nftables', REQS).join('\n') + '\n', golden('firewall-nftables.txt'));
});

test('the generated nft file matches the golden file byte for byte', () => {
    assert.equal(F.nftConfig(REQS), golden('firewall-nftables.nft'));
});

test('the nft file is idempotent by construction', () => {
    const text = F.nftConfig(REQS);
    assert.ok(text.indexOf('table inet pilot {}\ndelete table inet pilot\n') !== -1,
        'nft file does not destroy the table before rebuilding it');
    assert.ok(text.startsWith('#!/usr/sbin/nft -f\n'));
    assert.ok(text.endsWith('}\n'));
    assert.equal(/[\x00-\x08\x0b-\x1f\x7f]/.test(text), false, 'control byte in nft file');
});

// --- C1 Step conformance --------------------------------------------------

const KEYS = ['argv', 'check', 'id', 'mutating', 'secret', 'sha256', 'title', 'why', 'write'];

test('every backend emits steps in the exact C1 shape', () => {
    for (const backend of ['firewalld', 'ufw', 'nftables']) {
        const steps = F.steps(backend, REQS);
        assert.ok(steps.length > 0, backend);
        for (const s of steps) {
            assert.deepEqual(Object.keys(s).sort(), KEYS, backend + '/' + s.id);
            assert.equal(typeof s.id, 'string');
            assert.equal(typeof s.title, 'string');
            assert.equal(typeof s.why, 'string');
            assert.equal(s.mutating, true);
            assert.equal(s.secret, false);
            assert.equal(s.sha256, null);
            assert.ok(Array.isArray(s.argv));
            for (const a of s.argv) assert.equal(typeof a, 'string', backend + ' non-string argv');
            // C1: a step that writes a file carries no argv.
            if (s.write !== null) assert.deepEqual(s.argv, [], backend + '/' + s.id);
            else assert.ok(s.argv.length > 0, backend + '/' + s.id + ' has neither argv nor write');
            if (s.check !== null) {
                assert.ok(Array.isArray(s.check.argv) && s.check.argv.length > 0);
                assert.ok(s.check.expect === 'zero' || s.check.expect === 'nonzero');
            }
        }
    }
});

test('step ids are unique, stable slugs so provision-plan can splice them', () => {
    for (const backend of ['firewalld', 'ufw', 'nftables']) {
        const ids = F.steps(backend, REQS).map((s) => s.id);
        assert.equal(new Set(ids).size, ids.length, backend + ' has duplicate step ids');
        for (const id of ids) assert.match(id, /^fw-[a-z0-9-]+$/, backend + ': ' + id);
    }
});

test('firewalld probes each rule for idempotency before applying it', () => {
    const steps = F.steps('firewalld', REQS);
    const port = steps.find((s) => s.id === 'fw-firewalld-21115-tcp');
    assert.deepEqual(port.argv,
        ['firewall-cmd', '--permanent', '--add-port=21115/tcp']);
    assert.deepEqual(port.check,
        { argv: ['firewall-cmd', '--permanent', '--query-port=21115/tcp'], expect: 'zero' });

    const rich = steps.find((s) => s.id === 'fw-firewalld-21118-tcp-proxy');
    const rule = 'rule family="ipv4" source address="127.0.0.1" ' +
        'port port="21118" protocol="tcp" accept';
    assert.deepEqual(rich.argv, ['firewall-cmd', '--permanent', '--add-rich-rule=' + rule]);
    assert.deepEqual(rich.check,
        { argv: ['firewall-cmd', '--permanent', '--query-rich-rule=' + rule], expect: 'zero' });
    // The probe and the mutation must describe the SAME rule, or every run re-adds it.
    assert.equal(rich.check.argv[2].slice('--query-rich-rule='.length),
        rich.argv[2].slice('--add-rich-rule='.length));
});

test('firewalld reloads exactly once, and last', () => {
    const steps = F.steps('firewalld', REQS);
    const reloads = steps.filter((s) => s.id === 'fw-firewalld-reload');
    assert.equal(reloads.length, 1);
    assert.equal(steps[steps.length - 1].id, 'fw-firewalld-reload');
    assert.deepEqual(reloads[0].argv, ['firewall-cmd', '--reload']);
    assert.equal(reloads[0].check, null);
});

test('nftables writes the file with an explicit mode and owner, then applies it', () => {
    const steps = F.steps('nftables', REQS);
    assert.deepEqual(steps.map((s) => s.id), ['fw-nft-dir', 'fw-nft-write', 'fw-nft-apply']);
    assert.deepEqual(steps[0].argv, ['install', '-d', '-m', '0755', '/etc/nftables.d']);
    assert.deepEqual(steps[0].check, { argv: ['test', '-d', '/etc/nftables.d'], expect: 'zero' });
    assert.deepEqual(steps[1].write, {
        path: '/etc/nftables.d/pilot.nft', mode: '0644',
        content: F.nftConfig(REQS), owner: 'root:root'
    });
    assert.deepEqual(steps[1].argv, []);
    assert.deepEqual(steps[2].argv, ['nft', '-f', '/etc/nftables.d/pilot.nft']);
});

test('ufw emits one allow per requirement and never a shell string', () => {
    const steps = F.steps('ufw', REQS);
    assert.equal(steps.length, 9);
    for (const s of steps) {
        assert.equal(s.argv[0], 'ufw');
        assert.equal(s.argv.some((a) => /[;&|]/.test(a)), false, 'shell metacharacter: ' + s.id);
    }
    const proxied = steps.find((s) => s.id === 'fw-ufw-21118-tcp-proxy');
    assert.deepEqual(proxied.argv,
        ['ufw', 'allow', 'from', '127.0.0.1', 'to', 'any', 'port', '21118', 'proto', 'tcp']);
});

// --- scope filtering ------------------------------------------------------

test('only host-fixable requirements become rules', () => {
    const reqs = [
        { port: 21115, proto: 'tcp', scope: 'both', restrictTo: null },
        { port: 9000, proto: 'tcp', scope: 'edge', restrictTo: null },
        { port: 22, proto: 'tcp', scope: 'host', restrictTo: null }
    ];
    const ids = F.steps('ufw', reqs).map((s) => s.id);
    assert.deepEqual(ids, ['fw-ufw-22-tcp', 'fw-ufw-21115-tcp']);
    assert.equal(ids.some((i) => i.includes('9000')), false,
        'an edge-only requirement must not become a host firewall rule');
});

test('an all-edge requirement set produces no steps and no reload', () => {
    const reqs = [{ port: 9000, proto: 'tcp', scope: 'edge', restrictTo: null }];
    for (const b of ['firewalld', 'ufw', 'nftables']) assert.deepEqual(F.steps(b, reqs), []);
    for (const b of ['firewalld', 'ufw', 'nftables']) assert.deepEqual(F.rules(b, reqs), []);
});

// --- backend "none" and unknown backends ----------------------------------

test('backend none produces no steps but does warn, naming the ports', () => {
    assert.deepEqual(F.steps('none', REQS), []);
    assert.deepEqual(F.rules('none', REQS), []);
    const w = F.warnings('none', REQS);
    assert.equal(w.length, 1);
    assert.match(w[0], /no host firewall/i);
    assert.match(w[0], /21116\/udp/);
    assert.match(w[0], /2222\/tcp/);
});

test('a recognised backend warns about the cloud edge it cannot reach', () => {
    for (const b of ['firewalld', 'ufw', 'nftables']) {
        const w = F.warnings(b, REQS);
        assert.equal(w.length, 1, b);
        assert.match(w[0], /cloud|upstream/i, b);
        assert.match(w[0], /21116\/udp/, b);
        // Proxy-only ports must NOT be listed as ports to open upstream.
        assert.equal(/21118/.test(w[0]), false, b + ' told the user to expose 21118');
    }
});

test('an unrecognised backend throws FIREWALL_UNSUPPORTED, never a silent no-op', () => {
    for (const b of ['iptables', 'pf', 'FIREWALLD', '', ' ', null, undefined, 42, {}, [],
        'firewalld;rm -rf /']) {
        for (const fn of ['steps', 'rules', 'warnings']) {
            assert.throws(() => F[fn](b, REQS), (e) => {
                assert.equal(e.kind, 'FIREWALL_UNSUPPORTED');
                assert.equal(/[\x00-\x1f\x7f]/.test(e.message), false);
                return true;
            }, fn + ' ' + JSON.stringify(b));
        }
    }
});

test('BACKENDS lists exactly the four the detector can report', () => {
    assert.deepEqual([...F.BACKENDS], ['firewalld', 'ufw', 'nftables', 'none']);
    for (const b of F.BACKENDS) assert.doesNotThrow(() => F.steps(b, REQS));
});

// --- hostile requirement input --------------------------------------------

test('a malformed requirement throws GENERIC rather than emitting a broken rule', () => {
    const bad = [
        { port: 0, proto: 'tcp', scope: 'host', restrictTo: null },
        { port: 65536, proto: 'tcp', scope: 'host', restrictTo: null },
        { port: '21115; rm -rf /', proto: 'tcp', scope: 'host', restrictTo: null },
        { port: '2\n1115', proto: 'tcp', scope: 'host', restrictTo: null },
        { port: 21115, proto: 'TCP', scope: 'host', restrictTo: null },
        { port: 21115, proto: 'sctp', scope: 'host', restrictTo: null },
        { port: 21115, proto: 'tcp', scope: 'host', restrictTo: 'anything' },
        { port: null, proto: 'tcp', scope: 'host', restrictTo: null }
    ];
    for (const r of bad) {
        for (const b of ['firewalld', 'ufw', 'nftables']) {
            assert.throws(() => F.steps(b, [r]), (e) =>
                e.kind === 'GENERIC', b + ' ' + JSON.stringify(r));
        }
    }
});

test('non-object entries in the requirement list are ignored, not crashed on', () => {
    const reqs = [null, undefined, 5, 'x', [],
        { port: 21115, proto: 'tcp', scope: 'host', restrictTo: null }];
    assert.deepEqual(F.rules('ufw', reqs), ['ufw allow 21115/tcp']);
});

test('a non-array requirement list yields no steps', () => {
    for (const v of [null, undefined, 42, 'x', {}])
        for (const b of ['firewalld', 'ufw', 'nftables', 'none'])
            assert.deepEqual(F.steps(b, v), []);
});

// --- proxySource ----------------------------------------------------------

test('proxySource defaults to loopback and is honoured when set', () => {
    assert.equal(F.DEFAULT_PROXY, '127.0.0.1');
    const reqs = [{ port: 21118, proto: 'tcp', scope: 'host', restrictTo: 'proxy' }];
    assert.deepEqual(F.rules('ufw', reqs),
        ['ufw allow from 127.0.0.1 to any port 21118 proto tcp']);
    assert.deepEqual(F.rules('ufw', reqs, { proxySource: '10.0.0.0/8' }),
        ['ufw allow from 10.0.0.0/8 to any port 21118 proto tcp']);
    assert.ok(F.nftConfig(reqs, { proxySource: '10.0.0.0/8' })
        .includes('ip saddr 10.0.0.0/8 tcp dport 21118 accept'));
});

test('proxySource rejects anything that is not an IPv4 address or CIDR', () => {
    const reqs = [{ port: 21118, proto: 'tcp', scope: 'host', restrictTo: 'proxy' }];
    const bad = ['', ' ', 'localhost', '999.0.0.1', '10.0.0.0/33', '::1',
        '127.0.0.1 accept; drop', '127.0.0.1\naccept', '127.0.0.1"', 42, {}, [], true];
    for (const v of bad) {
        assert.throws(() => F.rules('ufw', reqs, { proxySource: v }), (e) =>
            e.kind === 'GENERIC' && /proxySource/.test(e.message), JSON.stringify(v));
        assert.throws(() => F.nftConfig(reqs, { proxySource: v }), (e) =>
            e.kind === 'GENERIC', JSON.stringify(v));
    }
    // A missing opts object, or a missing key, is the default — not an error.
    assert.doesNotThrow(() => F.rules('ufw', reqs));
    assert.doesNotThrow(() => F.rules('ufw', reqs, {}));
    assert.doesNotThrow(() => F.rules('ufw', reqs, { proxySource: null }));
});

test('proxySource must be loopback or private RFC1918, rejecting public and overly broad ranges', () => {
    const reqs = [{ port: 21118, proto: 'tcp', scope: 'host', restrictTo: 'proxy' }];
    // These must be rejected (semantic): public addresses, overly broad prefixes, anything not loopback/private.
    // Note: IPv6 is caught at syntax, not semantics, so not included here.
    const reject = ['0.0.0.0/0', '0.0.0.0/1', '8.8.8.8', '1.2.3.0/24',
        '200.0.0.0/8', '8.8.8.0/24', '44.0.0.0/8'];
    for (const v of reject) {
        assert.throws(() => F.rules('ufw', reqs, { proxySource: v }), (e) =>
            e.kind === 'GENERIC' && /private.*RFC1918|loopback/.test(e.message), v);
    }
    // These must be accepted: loopback and private ranges.
    const accept = ['127.0.0.1', '127.0.0.0/8', '127.255.255.255', '10.0.0.5',
        '10.0.0.0/8', '172.16.0.1', '172.31.255.255', '192.168.1.10', '192.168.0.0/16'];
    for (const v of accept) {
        assert.doesNotThrow(() => F.rules('ufw', reqs, { proxySource: v }), v);
        assert.doesNotThrow(() => F.nftConfig(reqs, { proxySource: v }), v);
    }
});

test('proxySource semantic validation does not affect the default path', () => {
    // The default (no opts or null proxySource) must still be 127.0.0.1.
    assert.equal(F.DEFAULT_PROXY, '127.0.0.1');
    const reqs = [{ port: 21118, proto: 'tcp', scope: 'host', restrictTo: 'proxy' }];
    assert.ok(F.rules('ufw', reqs)[0].includes('127.0.0.1'));
    assert.ok(F.nftConfig(reqs).includes('ip saddr 127.0.0.1'));
});

// --- module hygiene -------------------------------------------------------

test('no generated argv element contains a shell metacharacter or control byte', () => {
    for (const b of ['firewalld', 'ufw', 'nftables']) {
        for (const s of F.steps(b, REQS)) {
            for (const a of s.argv.concat(s.check ? s.check.argv : [])) {
                assert.equal(/[\x00-\x1f\x7f]/.test(a), false, b + ': control byte in ' + s.id);
                assert.equal(/[;&|`$]/.test(a), false, b + ': metacharacter in ' + s.id);
            }
        }
    }
});

test('module loads and exports pure functions without globals', () => {
    // The module must not require window or cockpit to be loaded or used.
    assert.equal(typeof globalThis.window, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    // The module must export the expected surface and work without any global state.
    assert.ok(typeof F.steps === 'function');
    assert.ok(typeof F.rules === 'function');
    assert.ok(typeof F.warnings === 'function');
    assert.ok(typeof F.nftConfig === 'function');
    assert.deepEqual(F.BACKENDS, ['firewalld', 'ufw', 'nftables', 'none']);
    // Pure functions must work: no I/O, no side effects.
    const reqs = [{ port: 80, proto: 'tcp', scope: 'host', restrictTo: null }];
    assert.ok(Array.isArray(F.steps('ufw', reqs)));
    assert.ok(Array.isArray(F.rules('ufw', reqs)));
    assert.ok(Array.isArray(F.warnings('ufw', reqs)));
    assert.ok(typeof F.nftConfig(reqs) === 'string');
});

test('index.html loads firewall.js after ports.js', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.includes('js/core/firewall.js'), 'firewall.js is not referenced');
    assert.ok(srcs.indexOf('js/core/ports.js') < srcs.indexOf('js/core/firewall.js'),
        'firewall.js must load after ports.js');
});
