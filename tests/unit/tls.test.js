// Unit tests for js/core/tls.js.
//
// This module gates two things that fail silently and expensively if they are
// wrong: (1) a Caddyfile that does not listen on 443 breaks the RustDesk web
// client with no error anywhere, and (2) a hostname accepted here that DNS does
// not point at burns a Let's Encrypt rate-limit attempt. So the interesting
// cases are the ones where it must say NO.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../../js/core/tls.js');
const PilotErrors = require('../../js/core/errors.js');

const ROOT = path.join(__dirname, '..', '..');
const golden = (name) => fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'golden', name), 'utf8');

// Every hostile literal carries an explicit escape so its intent survives
// copy-paste. Nothing in this table is a valid hostname.
const HOSTILE_HOSTS = [
    '', ' ', null, undefined, 0, 1, true, false, {}, [], () => {},
    'example.com\n', '\nexample.com', 'exa\x0bmple.com', 'exam\x00ple.com',
    'example.com\x7f', 'exa mple.com', ' example.com', 'example.com ',
    'example.com\t', 'ex\rample.com',
    'example', 'example.', '.example.com', 'example..com', '..',
    '-example.com', 'example-.com', 'exa_mple.com', 'example.com:443',
    'https://example.com', 'example.com/ws/id', '*.example.com',
    '../../etc/passwd', 'example.com/../../etc/shadow',
    'ünicode.example.com', 'İstanbul.example.com', 'xn--',
    '1.2.3.4', '10.0.0.1', '255.255.255.255', 'example.123',
    'a'.repeat(64) + '.example.com',
    ('a'.repeat(63) + '.').repeat(4) + 'com'
];

test('module loads with no DOM and dual-exports', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof T.caddyfile, 'function');
    assert.equal(globalThis.PilotTls, T);
});

test('the pinned write-target constants are what provision-plan will use', () => {
    assert.equal(T.CADDYFILE_PATH, '/etc/caddy/Caddyfile');
    assert.equal(T.CADDYFILE_MODE, '0644');
    assert.equal(T.CADDYFILE_OWNER, 'root:root');
    assert.equal(T.HTTPS_PORT, 443);
    assert.equal(T.WS_ID_PORT, 21118);
    assert.equal(T.WS_RELAY_PORT, 21119);
    assert.equal(T.API_PORT_DEFAULT, 21114);
    assert.deepEqual(T.TIERS, ['none', 'own', 'sslip', 'duckdns']);
    assert.deepEqual(T.TLS_TIERS, ['own', 'sslip', 'duckdns']);
});

// --- domain validation ----------------------------------------------------

test('normalizeDomain lowercases and drops exactly one trailing dot', () => {
    assert.equal(T.normalizeDomain('RD.Example.COM'), 'rd.example.com');
    assert.equal(T.normalizeDomain('rd.example.com.'), 'rd.example.com');
    assert.equal(T.normalizeDomain('rd.example.com..'), 'rd.example.com.');
    assert.equal(T.normalizeDomain('.'), '');
});

test('normalizeDomain rejects rather than trims, so whitespace never becomes a host', () => {
    // The whole point: ' rd.example.com' must not quietly become a valid host.
    for (const v of [' rd.example.com', 'rd.example.com ', 'rd.example.com\n', 'rd\texample.com'])
        assert.equal(T.normalizeDomain(v), '', JSON.stringify(v));
});

test('isValidDomain accepts real names, including punycode and long chains', () => {
    for (const v of ['example.com', 'rd.example.com', 'a.b.c.d.example.co.uk',
        'xn--80ak6aa92e.com', 'rd-1.example.com', 'RD.EXAMPLE.COM', 'rd.example.com.',
        '203.0.113.10.sslip.io', 'pilot-demo.duckdns.org',
        'a'.repeat(63) + '.example.com'])
        assert.equal(T.isValidDomain(v), true, JSON.stringify(v));
});

test('isValidDomain rejects every hostile hostname', () => {
    for (const v of HOSTILE_HOSTS)
        assert.equal(T.isValidDomain(v), false, JSON.stringify(String(v)));
});

test('isValidDomain enforces the label and total length limits at the boundary', () => {
    assert.equal(T.isValidDomain('a'.repeat(63) + '.com'), true);
    assert.equal(T.isValidDomain('a'.repeat(64) + '.com'), false);
    // 253 is the limit; build exactly 253 and exactly 254.
    const at253 = ('a'.repeat(49) + '.').repeat(5) + 'a'.repeat(3);
    assert.equal(at253.length, 253);
    assert.equal(T.isValidDomain(at253), true);
    assert.equal(T.isValidDomain(at253 + 'a'), false);
    // A trailing dot is the FQDN form and does not count against the limit.
    assert.equal(T.isValidDomain(at253 + '.'), true);
});

test('isValidDomain rejects anything whose last label is numeric — an address is not a name', () => {
    for (const v of ['1.2.3.4', '10.0.0.1.5', 'example.1', '127.0.0.1', '0.0.0.0'])
        assert.equal(T.isValidDomain(v), false, v);
});

test('a 10000-character paste is rejected without pathological work', () => {
    const t0 = Date.now();
    assert.equal(T.isValidDomain('a'.repeat(10000) + '.com'), false);
    assert.equal(T.isValidDomain(('a.'.repeat(5000)) + 'com'), false);
    assert.ok(Date.now() - t0 < 1000, 'validation took suspiciously long');
});

// --- IP helpers -----------------------------------------------------------

test('isBareIpv4 accepts dotted quads and nothing else', () => {
    for (const v of ['1.2.3.4', '0.0.0.0', '255.255.255.255', '203.0.113.10'])
        assert.equal(T.isBareIpv4(v), true, v);
    for (const v of ['', null, undefined, {}, [], 1234, '1.2.3', '1.2.3.4.5',
        '256.1.1.1', '1.2.3.256', '01.2.3.4', '1.2.3.04', '1.2.3.-4',
        ' 1.2.3.4', '1.2.3.4 ', '1.2.3.4\n', '1.2.3.4\x00', '1.2.3.4:443',
        '::1', 'a.b.c.d', '1.2.3.4/24'])
        assert.equal(T.isBareIpv4(v), false, JSON.stringify(String(v)));
});

test('isPublicIpv4 rejects every address a public certificate can never cover', () => {
    for (const v of ['203.0.113.10', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1'])
        assert.equal(T.isPublicIpv4(v), true, v);
    for (const v of ['0.0.0.0', '127.0.0.1', '10.1.2.3', '169.254.1.1',
        '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1',
        '100.127.255.255', '224.0.0.1', '239.1.1.1', '255.255.255.255'])
        assert.equal(T.isPublicIpv4(v), false, v);
});

test('sslipHost builds a name only from a public IPv4 address', () => {
    assert.equal(T.sslipHost('203.0.113.10'), '203.0.113.10.sslip.io');
    assert.equal(T.isValidDomain(T.sslipHost('203.0.113.10')), true);
    for (const v of ['192.168.1.1', '127.0.0.1', '', null, undefined, 'not-an-ip', '1.2.3.4\n'])
        assert.equal(T.sslipHost(v), '', JSON.stringify(String(v)));
});

test('duckdnsHost takes ONE label and appends the suffix itself', () => {
    assert.equal(T.duckdnsHost('pilot-demo'), 'pilot-demo.duckdns.org');
    assert.equal(T.duckdnsHost('Pilot-Demo'), 'pilot-demo.duckdns.org');
    for (const v of ['', ' ', null, undefined, {}, 'pilot demo', 'pilot.demo',
        'pilot-demo.duckdns.org', '-pilot', 'pilot-', 'pilot_demo', 'pilot\n',
        'a'.repeat(64), '../etc', 'pilot/demo'])
        assert.equal(T.duckdnsHost(v), '', JSON.stringify(String(v)));
});

test('isValidDuckdnsToken accepts a real token shape and rejects hostile ones', () => {
    assert.equal(T.isValidDuckdnsToken('3aa1c9f0-2b7e-4c1d-9a55-77b0e2f1c3d4'), true);
    assert.equal(T.isValidDuckdnsToken('a'.repeat(128)), true);
    for (const v of ['', ' ', null, undefined, 0, {}, 'short', 'a'.repeat(129),
        'token with space', 'token\nwith-newline', 'tok\x00en-value',
        'token;rm -rf /', "token' or '1'='1"])
        assert.equal(T.isValidDuckdnsToken(v), false, JSON.stringify(String(v)));
});

test('leRefuses knows the one suffix Let\'s Encrypt will not issue for', () => {
    assert.equal(T.leRefuses('ec2-203-0-113-10.eu-central-1.compute.amazonaws.com'), true);
    assert.equal(T.leRefuses('EC2-1-2-3-4.compute.amazonaws.com.'), true);
    assert.equal(T.leRefuses('rd.example.com'), false);
    assert.equal(T.leRefuses('compute.amazonaws.com.evil.example'), false);
    assert.equal(T.leRefuses(''), false);
    assert.equal(T.leRefuses(null), false);
});

// --- tier selection over the C13 choices object ---------------------------

const CHOICES = (over) => Object.assign({
    target: 'ssh', installHbbs: true, tlsTier: 'none', domain: null,
    duckdns: null, apiPort: 21114, sshPort: 22, openFirewall: true
}, over || {});

const DETECTION = (over) => Object.assign({ public_ip: '203.0.113.10' }, over || {});

test('hostFor reads exactly the C13 keys, for every tier', () => {
    assert.equal(T.hostFor(CHOICES({ tlsTier: 'none' }), DETECTION()), '');
    assert.equal(T.hostFor(CHOICES({ tlsTier: 'own', domain: 'RD.Example.com.' }), DETECTION()),
        'rd.example.com');
    assert.equal(T.hostFor(CHOICES({ tlsTier: 'sslip' }), DETECTION()), '203.0.113.10.sslip.io');
    assert.equal(T.hostFor(CHOICES({ tlsTier: 'duckdns', duckdns: { subdomain: 'pilot-demo', token: 'a'.repeat(20) } }),
        DETECTION()), 'pilot-demo.duckdns.org');
});

test('hostFor yields no host rather than a broken one', () => {
    assert.equal(T.hostFor(CHOICES({ tlsTier: 'own', domain: '1.2.3.4' }), DETECTION()), '');
    assert.equal(T.hostFor(CHOICES({ tlsTier: 'own', domain: 'rd.example.com\n' }), DETECTION()), '');
    assert.equal(T.hostFor(CHOICES({ tlsTier: 'sslip' }), DETECTION({ public_ip: '192.168.1.10' })), '');
    assert.equal(T.hostFor(CHOICES({ tlsTier: 'sslip' }), DETECTION({ public_ip: null })), '');
    assert.equal(T.hostFor(CHOICES({ tlsTier: 'duckdns', duckdns: null }), DETECTION()), '');
    assert.equal(T.hostFor(CHOICES({ tlsTier: 'nope' }), DETECTION()), '');
    assert.equal(T.hostFor(null, null), '');
    assert.equal(T.hostFor(undefined, undefined), '');
});

// --- validate -------------------------------------------------------------

test('validate passes the skip tier and says what is lost', () => {
    const r = T.validate(CHOICES({ tlsTier: 'none' }), DETECTION());
    assert.equal(r.ok, true);
    assert.equal(r.tier, 'none');
    assert.equal(r.host, '');
    assert.equal(r.kind, 'OK');
    assert.match(r.message, /web client/i);
});

test('validate accepts an own domain and returns it normalised', () => {
    const r = T.validate(CHOICES({ tlsTier: 'own', domain: 'RD.Example.COM.' }), DETECTION());
    assert.equal(r.ok, true);
    assert.equal(r.host, 'rd.example.com');
    assert.equal(r.kind, 'OK');
});

test('validate rejects a bare IP for EVERY TLS tier — C17', () => {
    // A bare IP gets no certificate and no /ws/* routing, so it can never be a
    // TLS target however it arrives.
    for (const ip of ['1.2.3.4', '203.0.113.10', '127.0.0.1', '192.168.1.10']) {
        const own = T.validate(CHOICES({ tlsTier: 'own', domain: ip }), DETECTION());
        assert.equal(own.ok, false, ip);
        assert.equal(own.kind, 'GENERIC');
        assert.equal(own.host, '');
        assert.match(own.message, /bare IP address|not a usable domain/i);
    }
    // And the sslip tier never produces one either: it always appends a suffix.
    const sslip = T.validate(CHOICES({ tlsTier: 'sslip' }), DETECTION());
    assert.equal(T.isBareIpv4(sslip.host), false);
    assert.ok(sslip.host.endsWith('.sslip.io'));
});

test('validate rejects hostile own domains without echoing a control byte', () => {
    for (const v of HOSTILE_HOSTS) {
        const r = T.validate(CHOICES({ tlsTier: 'own', domain: v }), DETECTION());
        assert.equal(r.ok, false, JSON.stringify(String(v)));
        assert.equal(r.kind, 'GENERIC');
        assert.equal(r.host, '');
        assert.doesNotMatch(r.message, /[\x00-\x1f\x7f]/, 'control byte leaked into the message');
        assert.ok(r.message.length < 400, 'message is unbounded: ' + r.message.length);
    }
});

test('validate refuses an EC2 hostname for the reason Let\'s Encrypt gives', () => {
    const r = T.validate(CHOICES({
        tlsTier: 'own', domain: 'ec2-203-0-113-10.eu-central-1.compute.amazonaws.com'
    }), DETECTION());
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'GENERIC');
    assert.match(r.message, /compute\.amazonaws\.com/);
});

test('validate requires a public IPv4 for the automatic tier and warns about the shared bucket', () => {
    const ok = T.validate(CHOICES({ tlsTier: 'sslip' }), DETECTION());
    assert.equal(ok.ok, true);
    assert.equal(ok.host, '203.0.113.10.sslip.io');
    assert.match(ok.message, /rate-limit/i);

    for (const ip of [null, '', '192.168.1.10', '127.0.0.1', '10.0.0.5', 'not-an-ip', '1.2.3.4\n']) {
        const r = T.validate(CHOICES({ tlsTier: 'sslip' }), DETECTION({ public_ip: ip }));
        assert.equal(r.ok, false, JSON.stringify(String(ip)));
        assert.equal(r.kind, 'GENERIC');
        assert.equal(r.host, '');
    }
    assert.equal(T.validate(CHOICES({ tlsTier: 'sslip' }), null).ok, false);
});

test('validate requires both a DuckDNS subdomain and a token', () => {
    const ok = T.validate(CHOICES({
        tlsTier: 'duckdns', duckdns: { subdomain: 'pilot-demo', token: 'a'.repeat(20) }
    }), DETECTION());
    assert.equal(ok.ok, true);
    assert.equal(ok.host, 'pilot-demo.duckdns.org');

    const noSub = T.validate(CHOICES({ tlsTier: 'duckdns', duckdns: { subdomain: '', token: 'a'.repeat(20) } }), DETECTION());
    assert.equal(noSub.ok, false);
    assert.match(noSub.message, /subdomain/i);

    const noTok = T.validate(CHOICES({ tlsTier: 'duckdns', duckdns: { subdomain: 'pilot-demo', token: '' } }), DETECTION());
    assert.equal(noTok.ok, false);
    assert.match(noTok.message, /token/i);

    assert.equal(T.validate(CHOICES({ tlsTier: 'duckdns', duckdns: null }), DETECTION()).ok, false);
});

test('validate never echoes the DuckDNS token, valid or not', () => {
    const secret = 'S3CRET-token-value-do-not-log';
    for (const sub of ['pilot-demo', '', 'bad sub']) {
        const r = T.validate(CHOICES({ tlsTier: 'duckdns', duckdns: { subdomain: sub, token: secret } }), DETECTION());
        assert.equal(r.message.includes(secret), false, 'token leaked for subdomain ' + JSON.stringify(sub));
        assert.equal(JSON.stringify(r).includes(secret), false, 'token leaked into the result object');
    }
});

test('validate rejects every tier value that is not one of the four', () => {
    for (const v of ['', ' ', 'skip', 'auto', 'None', 'OWN', 'tls', null, undefined, 0, 1,
        {}, [], 'own\n', 'own; rm -rf /']) {
        const r = T.validate(CHOICES({ tlsTier: v }), DETECTION());
        assert.equal(r.ok, false, JSON.stringify(String(v)));
        assert.equal(r.kind, 'GENERIC');
        assert.equal(r.tier, '');
        assert.doesNotMatch(r.message, /[\x00-\x1f\x7f]/);
    }
    assert.equal(T.validate(null, null).ok, false);
    assert.equal(T.validate(undefined, undefined).ok, false);
});

test('every kind this module returns is a real C6 kind', () => {
    const kinds = new Set();
    const sample = [
        T.validate(CHOICES({ tlsTier: 'none' }), DETECTION()),
        T.validate(CHOICES({ tlsTier: 'own', domain: 'rd.example.com' }), DETECTION()),
        T.validate(CHOICES({ tlsTier: 'own', domain: '1.2.3.4' }), DETECTION()),
        T.validate(CHOICES({ tlsTier: 'nope' }), DETECTION()),
        T.dnsPreflight({ host: 'rd.example.com', resolved: ['1.2.3.4'], expected: '1.2.3.4' }),
        T.dnsPreflight({ host: 'rd.example.com', resolved: [], expected: '1.2.3.4' }),
        T.dnsPreflight({ host: '', resolved: [], expected: '' })
    ];
    for (const r of sample) kinds.add(r.kind);
    for (const t of ['x', 'urn:ietf:params:acme:error:rateLimited', 'DNS problem: NXDOMAIN'])
        kinds.add(T.classifyAcmeFailure(t));
    for (const k of kinds)
        assert.equal(PilotErrors.KIND[k], k, k + ' is not a kind in PilotErrors.KIND');
});

// --- DNS pre-flight -------------------------------------------------------

test('dnsPreflight passes when the name already points at the server', () => {
    const r = T.dnsPreflight({ host: 'RD.Example.com.', resolved: ['203.0.113.10'], expected: '203.0.113.10' });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'OK');
    assert.equal(r.host, 'rd.example.com');
    assert.match(r.message, /203\.0\.113\.10/);
});

test('dnsPreflight passes when the server IP is one of several A records', () => {
    const r = T.dnsPreflight({
        host: 'rd.example.com', resolved: ['1.2.3.4', '203.0.113.10'], expected: '203.0.113.10'
    });
    assert.equal(r.ok, true);
});

test('dnsPreflight reports TLS_DNS_MISMATCH before ACME burns an attempt', () => {
    const wrong = T.dnsPreflight({ host: 'rd.example.com', resolved: ['1.2.3.4'], expected: '203.0.113.10' });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.kind, 'TLS_DNS_MISMATCH');
    assert.match(wrong.message, /1\.2\.3\.4/);
    assert.match(wrong.message, /203\.0\.113\.10/);

    const none = T.dnsPreflight({ host: 'rd.example.com', resolved: [], expected: '203.0.113.10' });
    assert.equal(none.kind, 'TLS_DNS_MISMATCH');
    assert.match(none.message, /no A record/i);
});

test('dnsPreflight ignores every resolver answer that is not a bare IPv4 address', () => {
    // A near-miss answer must NOT satisfy the comparison: ' 1.2.3.4' and
    // '1.2.3.4\n' are not the same string as '1.2.3.4'.
    const r = T.dnsPreflight({
        host: 'rd.example.com',
        resolved: [null, undefined, '', ' 203.0.113.10', '203.0.113.10\n', '203.0.113.10\x00',
            '0203.0.113.10', 'example.com', {}, [], 42, '::1'],
        expected: '203.0.113.10'
    });
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'TLS_DNS_MISMATCH');
    assert.deepEqual(r.resolved, []);
    assert.match(r.message, /no A record/i);
});

test('dnsPreflight refuses to judge when an input is unusable', () => {
    for (const opts of [
        undefined, null, {},
        { host: '', resolved: ['1.2.3.4'], expected: '1.2.3.4' },
        { host: '1.2.3.4', resolved: ['1.2.3.4'], expected: '1.2.3.4' },
        { host: 'rd.example.com\n', resolved: ['1.2.3.4'], expected: '1.2.3.4' },
        { host: 'rd.example.com', resolved: ['1.2.3.4'], expected: '' },
        { host: 'rd.example.com', resolved: ['1.2.3.4'], expected: null },
        { host: 'rd.example.com', resolved: ['1.2.3.4'], expected: '999.1.1.1' },
        { host: 'rd.example.com', resolved: 'not-an-array', expected: '1.2.3.4' }
    ]) {
        const r = T.dnsPreflight(opts);
        assert.equal(r.ok, false, JSON.stringify(opts));
        assert.ok(r.kind === 'GENERIC' || r.kind === 'TLS_DNS_MISMATCH', r.kind);
    }
    assert.equal(T.dnsPreflight({ host: 'rd.example.com', resolved: 'x', expected: '1.2.3.4' }).kind,
        'TLS_DNS_MISMATCH');
    assert.equal(T.dnsPreflight({ host: 'rd.example.com', resolved: ['1.2.3.4'], expected: '' }).kind,
        'GENERIC');
});

test('dnsPreflight caps how many addresses it quotes back', () => {
    const many = [];
    for (let i = 1; i <= 40; i++) many.push('10.9.0.' + i);
    many[0] = '1.2.3.4';
    const r = T.dnsPreflight({ host: 'rd.example.com', resolved: many, expected: '203.0.113.10' });
    assert.equal(r.ok, false);
    assert.ok(r.message.length < 400, 'message is unbounded: ' + r.message.length);
});

// --- ACME failure classification -----------------------------------------

test('classifyAcmeFailure names the two failures a user can act on', () => {
    for (const t of [
        'urn:ietf:params:acme:error:rateLimited: too many certificates already issued',
        'Error creating new order :: too many failed authorizations recently',
        'acme: rate limit exceeded'
    ]) assert.equal(T.classifyAcmeFailure(t), 'TLS_RATE_LIMITED', t);

    for (const t of [
        'DNS problem: NXDOMAIN looking up A for rd.example.com',
        'no valid A records found for rd.example.com',
        'could not resolve rd.example.com',
        'SERVFAIL looking up A'
    ]) assert.equal(T.classifyAcmeFailure(t), 'TLS_DNS_MISMATCH', t);
});

test('classifyAcmeFailure prefers the rate limit when a message mentions both', () => {
    // Retrying a rate-limited issuance makes it worse, so that reading wins.
    assert.equal(
        T.classifyAcmeFailure('DNS problem earlier; now rateLimited: too many certificates'),
        'TLS_RATE_LIMITED');
});

test('classifyAcmeFailure falls back to TLS_ACME_FAILED, never to OK', () => {
    for (const t of ['', ' ', null, undefined, 0, {}, [], 'timeout after 30s',
        'connection refused on port 80', 'x'.repeat(5000)])
        assert.equal(T.classifyAcmeFailure(t), 'TLS_ACME_FAILED', JSON.stringify(String(t)));
});

// --- Caddyfile: golden files ---------------------------------------------

test('caddyfile matches the golden file for the own-domain tier', () => {
    assert.equal(T.caddyfile({ tier: 'own', host: 'rd.example.com' }), golden('Caddyfile-own'));
});

test('caddyfile matches the golden file for the sslip.io tier', () => {
    assert.equal(T.caddyfile({ tier: 'sslip', host: '203.0.113.10.sslip.io' }),
        golden('Caddyfile-sslip'));
});

test('caddyfile matches the golden file for the DuckDNS tier', () => {
    assert.equal(T.caddyfile({ tier: 'duckdns', host: 'pilot-demo.duckdns.org' }),
        golden('Caddyfile-duckdns'));
});

test('the three goldens differ only in their tier notes and site line', () => {
    const strip = (s) => s.split('\n').filter((l) => !l.startsWith('#') && !l.startsWith('https://')).join('\n');
    assert.equal(strip(golden('Caddyfile-own')), strip(golden('Caddyfile-sslip')));
    assert.equal(strip(golden('Caddyfile-own')), strip(golden('Caddyfile-duckdns')));
    assert.notEqual(golden('Caddyfile-own'), golden('Caddyfile-sslip'));
    assert.notEqual(golden('Caddyfile-sslip'), golden('Caddyfile-duckdns'));
});

// --- Caddyfile: the invariants that break the web client silently ---------

test('the site address is https with NO port, so Caddy listens on 443 — C17', () => {
    for (const tier of T.TLS_TIERS) {
        const host = tier === 'sslip' ? '203.0.113.10.sslip.io'
            : tier === 'duckdns' ? 'pilot-demo.duckdns.org' : 'rd.example.com';
        const out = T.caddyfile({ tier: tier, host: host });
        const site = out.split('\n').filter((l) => l.startsWith('https://'));
        assert.equal(site.length, 1, tier + ': expected exactly one site block');
        // A port on the site address is exactly the mistake that breaks the
        // client, which appends no port of its own.
        assert.match(site[0], /^https:\/\/[a-z0-9.-]+ \{$/, tier + ': ' + site[0]);
        assert.equal(site[0], 'https://' + host + ' {');
        assert.equal(/:\d+/.test(site[0]), false, tier + ': site address carries a port');
    }
});

test('the only ports in the file are the three upstreams', () => {
    const out = T.caddyfile({ tier: 'own', host: 'rd.example.com' });
    const ports = [...out.matchAll(/127\.0\.0\.1:(\d+)/g)].map((m) => m[1]);
    assert.deepEqual(ports, ['21118', '21119', '21114']);
    assert.equal(/:8443|:8080|:80\b/.test(out), false, 'an unexpected port appears in the file');
});

test('routing uses handle, never handle_path, so /ws/id and /ws/relay survive', () => {
    const out = T.caddyfile({ tier: 'own', host: 'rd.example.com' });
    // Directives only — the comment in the file names handle_path to explain
    // why it is not used, and that mention is not a use.
    const directives = out.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    assert.equal(directives.some((l) => l.startsWith('handle_path')), false,
        'handle_path strips the matched prefix — hbbs matches on the full path');
    assert.ok(out.includes('handle /ws/id {'));
    assert.ok(out.includes('handle /ws/relay {'));
    assert.ok(out.includes('handle {'));
    // /ws/id must be routed to hbbs and /ws/relay to hbbr, not the other way round.
    assert.ok(out.indexOf('handle /ws/id {') < out.indexOf('127.0.0.1:21118'));
    assert.ok(out.indexOf('127.0.0.1:21118') < out.indexOf('handle /ws/relay {'));
    assert.ok(out.indexOf('handle /ws/relay {') < out.indexOf('127.0.0.1:21119'));
    // The catch-all must come last, or it would swallow both websocket paths.
    assert.ok(out.indexOf('127.0.0.1:21119') < out.lastIndexOf('handle {'));
});

test('every upstream gets X-Real-IP and X-Forwarded-For set, not appended', () => {
    const out = T.caddyfile({ tier: 'own', host: 'rd.example.com' });
    assert.equal((out.match(/header_up X-Real-IP \{remote_host\}/g) || []).length, 3);
    assert.equal((out.match(/header_up X-Forwarded-For \{remote_host\}/g) || []).length, 3);
    assert.equal((out.match(/header_up X-Forwarded-Proto \{scheme\}/g) || []).length, 3);
    // header_down / add_header would append and let a client forge the address.
    assert.equal(out.includes('header_up +X-Forwarded-For'), false);
});

test('caddyfile honours a custom API port on the catch-all route only', () => {
    const out = T.caddyfile({ tier: 'own', host: 'rd.example.com', apiPort: 28080 });
    const ports = [...out.matchAll(/127\.0\.0\.1:(\d+)/g)].map((m) => m[1]);
    assert.deepEqual(ports, ['21118', '21119', '28080']);
    assert.notEqual(out, golden('Caddyfile-own'));
    // null/undefined mean "the default", not "no port".
    assert.equal(T.caddyfile({ tier: 'own', host: 'rd.example.com', apiPort: null }), golden('Caddyfile-own'));
    assert.equal(T.caddyfile({ tier: 'own', host: 'rd.example.com' }), golden('Caddyfile-own'));
});

test('caddyfile normalises the host it is given', () => {
    assert.equal(T.caddyfile({ tier: 'own', host: 'RD.Example.COM.' }), golden('Caddyfile-own'));
});

test('caddyfile ends with exactly one newline and no trailing whitespace', () => {
    const out = T.caddyfile({ tier: 'own', host: 'rd.example.com' });
    assert.equal(out.endsWith('}\n'), true);
    assert.equal(out.endsWith('\n\n'), false);
    for (const line of out.split('\n'))
        assert.equal(/[ \t]$/.test(line), false, 'trailing whitespace: ' + JSON.stringify(line));
    assert.doesNotMatch(out, /[\x00-\x08\x0b-\x1f\x7f]/, 'control byte in generated config');
});

test('caddyfile refuses a bare IP for every tier — C17', () => {
    for (const tier of T.TLS_TIERS)
        for (const ip of ['1.2.3.4', '203.0.113.10', '127.0.0.1'])
            assert.throws(() => T.caddyfile({ tier: tier, host: ip }), /bare IP address/, tier + ' ' + ip);
});

test('caddyfile refuses the skip tier and any unknown tier', () => {
    for (const tier of ['none', '', ' ', 'skip', 'auto', 'OWN', null, undefined, 0, {}, [], 'own\n'])
        assert.throws(() => T.caddyfile({ tier: tier, host: 'rd.example.com' }),
            /tier must be one of/, JSON.stringify(String(tier)));
    assert.throws(() => T.caddyfile(), /tier must be one of/);
    assert.throws(() => T.caddyfile(null), /tier must be one of/);
});

test('caddyfile refuses every hostile hostname rather than emitting a broken config', () => {
    for (const v of HOSTILE_HOSTS)
        assert.throws(() => T.caddyfile({ tier: 'own', host: v }),
            /bare IP address|not a usable hostname/, JSON.stringify(String(v)));
});

test('caddyfile refuses an apiPort that is not a real port', () => {
    for (const p of ['21114', 0, -1, 65536, 1.5, NaN, Infinity, true, {}, [], '21114\n'])
        assert.throws(() => T.caddyfile({ tier: 'own', host: 'rd.example.com', apiPort: p }),
            /apiPort must be an integer/, JSON.stringify(String(p)));
});

test('a hostile hostname can never be smuggled into the generated config', () => {
    // The injection worth blocking: a "host" carrying a newline and a second
    // site block, or a directive of its own.
    for (const v of ['rd.example.com\n}\nhttp://evil.example {', 'rd.example.com {', 'rd.example.com # x',
        'rd.example.com ', 'a.com\nrespond "pwned"'])
        assert.throws(() => T.caddyfile({ tier: 'own', host: v }), /not a usable hostname/,
            JSON.stringify(String(v)));
});

test('the generated config carries no secret material', () => {
    const secret = 'S3CRET-token-value-do-not-log';
    const out = T.caddyfile({ tier: 'duckdns', host: T.duckdnsHost('pilot-demo') });
    assert.equal(out.includes(secret), false);
    assert.equal(/token/i.test(out), false, 'the DuckDNS token has no place in a Caddyfile');
    assert.equal(/password|secret|api-token|Authorization/i.test(out), false);
});

// --- URLs derived from the tier -------------------------------------------

test('apiServerUrl is https with no port when TLS is on — C17', () => {
    // The client picks wss:// only when api-server starts with https; anything
    // else silently downgrades to plaintext ws://.
    assert.equal(T.apiServerUrl({ tlsHost: 'rd.example.com', plainHost: '203.0.113.10', apiPort: 21114 }),
        'https://rd.example.com');
    assert.equal(T.apiServerUrl({ tlsHost: 'RD.Example.com.', plainHost: '', apiPort: 28080 }),
        'https://rd.example.com');
});

test('apiServerUrl falls back to http with an explicit port when TLS is off', () => {
    assert.equal(T.apiServerUrl({ tlsHost: '', plainHost: '203.0.113.10' }), 'http://203.0.113.10:21114');
    assert.equal(T.apiServerUrl({ tlsHost: '', plainHost: '203.0.113.10', apiPort: 28080 }),
        'http://203.0.113.10:28080');
    assert.equal(T.apiServerUrl({ tlsHost: null, plainHost: 'Rd.Example.com' }), 'http://rd.example.com:21114');
});

test('apiServerUrl yields nothing rather than a URL it cannot justify', () => {
    for (const o of [undefined, null, {}, { tlsHost: '', plainHost: '' },
        { tlsHost: 'rd.example.com\n', plainHost: '' },
        { tlsHost: '', plainHost: '1.2.3.4\n' },
        { tlsHost: '', plainHost: 'not a host' },
        { tlsHost: '', plainHost: '203.0.113.10', apiPort: 0 },
        { tlsHost: '', plainHost: '203.0.113.10', apiPort: '21114' },
        { tlsHost: '1.2.3.4', plainHost: '' }])
        assert.equal(T.apiServerUrl(o), '', JSON.stringify(o));
});

test('webClientUrl exists only for a real hostname, and points AT the web client', () => {
    assert.equal(T.webClientUrl('rd.example.com'), 'https://rd.example.com/webclient/');
    assert.equal(T.webClientUrl('RD.Example.com.'), 'https://rd.example.com/webclient/');
    for (const v of ['', null, undefined, '1.2.3.4', 'rd.example.com\n', 'localhost'])
        assert.equal(T.webClientUrl(v), '', JSON.stringify(String(v)));
});

test('adminUrl points at the console rustdesk-api serves, on the same hostname rule', () => {
    assert.equal(T.ADMIN_PATH, '/_admin/');
    assert.equal(T.adminUrl('rd.example.com'), 'https://rd.example.com/_admin/');
    assert.equal(T.adminUrl('RD.Example.com.'), 'https://rd.example.com/_admin/');
    // Same refusals as webClientUrl: no certificate, no link.
    for (const v of ['', null, undefined, '1.2.3.4', 'rd.example.com\n', 'localhost'])
        assert.equal(T.adminUrl(v), '', JSON.stringify(String(v)));
    // Named, not inferred from the root's 302 -- a redirect is someone else's
    // decision and can change.
    assert.notEqual(T.ADMIN_PATH, '/');
});

test('the web client path is the one rustdesk-api actually serves', () => {
    // Measured against a live v2.7, all three:
    //   /webclient/   200, the Flutter client
    //   /            302 -> /_admin/, the admin console
    //   /webclient2/ 404, the v2 preview this version does not ship
    // Returning the ROOT is what shipped, and it looked right because the
    // admin console loads: nothing 404s, you just never reach the web client.
    assert.equal(T.WEB_CLIENT_PATH, '/webclient/');
    assert.ok(T.WEB_CLIENT_PATH.charAt(T.WEB_CLIENT_PATH.length - 1) === '/',
        '/webclient without the trailing slash is a 404 on a real server');
    assert.ok(T.WEB_CLIENT_PATH.indexOf('webclient2') === -1,
        'webclient2 is the v2 preview and is not shipped by the pinned API version');
    assert.ok(T.webClientUrl('rd.example.com').endsWith(T.WEB_CLIENT_PATH),
        'the URL must be built from the path constant, not a second copy of it');
});

test('advisory says the one thing each tier needs the user to know', () => {
    assert.match(T.advisory('sslip'), /rate-limit/i);
    assert.match(T.advisory('duckdns'), /Public Suffix List/i);
    assert.match(T.advisory('own'), /DNS/i);
    assert.match(T.advisory('none'), /web client/i);
    for (const v of ['', 'nope', null, undefined, {}, 0])
        assert.equal(T.advisory(v), '', JSON.stringify(String(v)));
});

// --- structural ------------------------------------------------------------

test('index.html loads js/core/tls.js', () => {
    // C5 rule 4: whichever task creates a module registers it in the same task.
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(html.includes('<script src="js/core/tls.js"></script>'),
        'index.html does not load js/core/tls.js');
});
