// Unit tests for js/core/errors.js — the typed-error contract every Pilot module
// relies on. §8: "a fixed kind list — no invented error strings", and each kind
// carries a remediation because "retry" is wrong for most of them.
//
// C11: presence assertions only. A later section may legitimately add a kind; that
// must not turn this file red. What IS pinned: every C6 kind is present, every
// remediation is drawn from the closed vocabulary, and the hard-stop set is exact.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../js/core/errors.js');

// C6, verbatim.
const C6_KINDS = [
    'OK', 'GENERIC', 'UNKNOWN', 'CANCELLED',
    'SSH_AUTH_FAILED', 'SSH_UNREACHABLE', 'SSH_HOSTKEY_UNKNOWN', 'SSH_HOSTKEY_CHANGED',
    'OS_UNSUPPORTED', 'ARCH_UNSUPPORTED', 'NO_SYSTEMD', 'NO_EGRESS', 'CHECKSUM_MISMATCH',
    'HBBS_NOT_FOUND', 'PORT_BLOCKED', 'FIREWALL_UNSUPPORTED',
    'API_UNREACHABLE', 'API_AUTH_FAILED', 'API_VERSION_MISMATCH', 'BRIDGE_NO_ADDRESS_CAP',
    'TLS_DNS_MISMATCH', 'TLS_ACME_FAILED', 'TLS_RATE_LIMITED'
];

const VOCAB = ['retry', 'reauthorize', 'manual-mode', 'fix-dns', 'open-ports', 'hard-stop', 'none'];

test('module loads with no cockpit global — it is pure', () => {
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof E.create, 'function');
});

test('KIND contains every C6 kind, and every key maps to itself', () => {
    for (const k of C6_KINDS) {
        assert.equal(E.KIND[k], k, `KIND.${k} is present and self-mapped`);
    }
    // Self-mapping across the WHOLE object, including anything added later:
    // callers pass kind strings around freely, so KIND.X !== 'X' would be a trap.
    for (const k of Object.keys(E.KIND)) {
        assert.equal(E.KIND[k], k, `KIND.${k} maps to itself`);
    }
});

test('VALUES is exactly the seven remediations C16 permits', () => {
    assert.deepEqual(E.VALUES.slice().sort(), VOCAB.slice().sort());
});

test('remediation() is total over KIND and never leaves the vocabulary', () => {
    for (const k of Object.keys(E.KIND)) {
        const r = E.remediation(k);
        assert.ok(VOCAB.includes(r), `remediation(${k}) = ${JSON.stringify(r)} is outside the vocabulary`);
    }
});

test('every kind maps to the remediation §8 specifies', () => {
    const expected = {
        // Nothing to offer: the caller surfaces the raw detail verbatim (§8).
        OK: 'none', GENERIC: 'none', UNKNOWN: 'none', CANCELLED: 'none',
        // API_VERSION_MISMATCH is refused by the compatibility probe naming the
        // missing endpoints (§7.1). The fix — pin or upgrade the API server — is
        // not one of the seven one-click actions, so it is honestly 'none'.
        API_VERSION_MISMATCH: 'none',

        SSH_AUTH_FAILED: 'reauthorize',
        SSH_HOSTKEY_UNKNOWN: 'reauthorize',   // TOFU: confirm the fingerprint
        API_AUTH_FAILED: 'reauthorize',

        SSH_UNREACHABLE: 'retry',
        HBBS_NOT_FOUND: 'retry',              // re-run detection against the right host
        API_UNREACHABLE: 'retry',
        TLS_ACME_FAILED: 'retry',

        OS_UNSUPPORTED: 'manual-mode',
        ARCH_UNSUPPORTED: 'manual-mode',
        NO_SYSTEMD: 'manual-mode',
        NO_EGRESS: 'manual-mode',
        BRIDGE_NO_ADDRESS_CAP: 'manual-mode',

        PORT_BLOCKED: 'open-ports',
        FIREWALL_UNSUPPORTED: 'open-ports',

        TLS_DNS_MISMATCH: 'fix-dns',
        TLS_RATE_LIMITED: 'fix-dns',          // offer own domain or DuckDNS

        SSH_HOSTKEY_CHANGED: 'hard-stop',
        CHECKSUM_MISMATCH: 'hard-stop'
    };
    for (const [k, r] of Object.entries(expected)) {
        assert.equal(E.remediation(k), r, `remediation(${k})`);
    }
});

test('isHardStop is true for exactly SSH_HOSTKEY_CHANGED and CHECKSUM_MISMATCH', () => {
    // §8: "Hard stops — checksum mismatch and host-key change — are never warn and
    // continue." Widening this set silently would be a security regression, so the
    // assertion is exhaustive over KIND rather than a spot check.
    const hard = Object.keys(E.KIND).filter((k) => E.isHardStop(k)).sort();
    assert.deepEqual(hard, ['CHECKSUM_MISMATCH', 'SSH_HOSTKEY_CHANGED']);
});

test('isHardStop is false for junk rather than throwing', () => {
    for (const v of [null, undefined, '', 'hard-stop', 0, 1, {}, [], true, 'ok',
        '__proto__', 'constructor', 'toString']) {
        assert.equal(E.isHardStop(v), false, JSON.stringify(String(v)));
    }
});

test('normalize maps every real kind to itself', () => {
    for (const k of C6_KINDS) assert.equal(E.normalize(k), k);
});

test('normalize maps hostile and inherited-property input to UNKNOWN', () => {
    // The prototype-chain cases are the dangerous ones: a plain `KIND[k]` truthiness
    // test would let 'constructor' and 'toString' through as if they were kinds.
    const hostile = [
        null, undefined, '', ' ', 'ok', 'Ok', 'OK ', ' OK', 'OK\n', 'OK ',
        '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf',
        0, 1, -1, NaN, Infinity, true, false, {}, [], ['OK'], { kind: 'OK' },
        () => 'OK', Symbol('OK'), 9007199254740993n
    ];
    for (const v of hostile) {
        assert.equal(E.normalize(v), 'UNKNOWN', String(typeof v) + ' ' + String(v));
    }
});

test('normalize does not mutate or pollute Object.prototype', () => {
    E.normalize('__proto__');
    E.create('__proto__', 'x', { a: 1 });
    assert.equal(({}).a, undefined);
    assert.equal(Object.prototype.a, undefined);
});

test('create() returns a throwable Error carrying the C16 four fields', () => {
    const e = E.create('PORT_BLOCKED', '21114 is closed', { port: 21114, scope: 'cloud' });
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'PilotError');
    assert.equal(e.kind, 'PORT_BLOCKED');
    assert.equal(e.message, '21114 is closed');
    assert.deepEqual(e.detail, { port: 21114, scope: 'cloud' });
    assert.equal(e.remediation, 'open-ports');
});

test('create() normalizes an unrecognised kind instead of inventing one', () => {
    for (const bad of ['NOT_A_KIND', '', null, undefined, 42, {}, '__proto__', 'constructor']) {
        const e = E.create(bad, 'boom');
        assert.equal(e.kind, 'UNKNOWN', JSON.stringify(String(bad)));
        assert.equal(e.remediation, 'none');
    }
});

test('create() defaults message to the kind and detail to null', () => {
    const e = E.create('NO_EGRESS');
    assert.equal(e.message, 'NO_EGRESS');
    assert.equal(e.detail, null);
    const f = E.create('NO_EGRESS', '');
    assert.equal(f.message, 'NO_EGRESS', 'an empty message falls back to the kind');
});

test('create() coerces a non-string message rather than producing [object Object]', () => {
    assert.equal(E.create('GENERIC', 12345).message, '12345');
    assert.equal(E.create('GENERIC', null).message, 'GENERIC');
    assert.equal(E.create('GENERIC', undefined).message, 'GENERIC');
    // Objects are a real risk: callers pass a caught cockpit error straight in.
    const e = E.create('GENERIC', { problem: 'access-denied' });
    assert.equal(typeof e.message, 'string');
    assert.ok(e.message.includes('access-denied'), 'the useful text survives coercion');
});

test('create() keeps an oversized message and an embedded newline intact', () => {
    // Transcript lines and ACME errors are long and multi-line; truncating them in
    // the error object would hide the one line that explains the failure.
    const long = 'x'.repeat(20000);
    assert.equal(E.create('TLS_ACME_FAILED', long).message.length, 20000);
    const multi = 'line1\nline2\nline3';
    assert.equal(E.create('TLS_ACME_FAILED', multi).message, multi);
});

test('create() preserves unicode and control bytes in detail without stringifying it', () => {
    const detail = { host: 'ünïcode.example', note: 'a b', list: [1, 2, 3] };
    const e = E.create('SSH_UNREACHABLE', 'nope', detail);
    assert.deepEqual(e.detail, detail);
    assert.equal(e.detail.list[2], 3);
});

test('create() accepts falsy details without turning them into null', () => {
    assert.equal(E.create('GENERIC', 'x', 0).detail, 0);
    assert.equal(E.create('GENERIC', 'x', false).detail, false);
    assert.equal(E.create('GENERIC', 'x', '').detail, '');
    assert.equal(E.create('GENERIC', 'x', null).detail, null);
    assert.equal(E.create('GENERIC', 'x').detail, null);
});

test('isPilotError only accepts a genuine Pilot error', () => {
    assert.equal(E.isPilotError(E.create('OK')), true);
    assert.equal(E.isPilotError(new Error('plain')), false);
    assert.equal(E.isPilotError({ name: 'PilotError' }), false);       // no kind
    assert.equal(E.isPilotError({ name: 'PilotError', kind: 'OK' }), true);
    assert.equal(E.isPilotError(null), false);
    assert.equal(E.isPilotError(undefined), false);
    assert.equal(E.isPilotError(0), false);
    assert.equal(E.isPilotError('PilotError'), false);
});

test('a created error survives being thrown and caught by kind', () => {
    // This is how every caller in the plan uses it: `catch (e) { if (e.kind === ...`.
    assert.throws(
        () => { throw E.create('CHECKSUM_MISMATCH', 'digest differs', { expected: 'a', got: 'b' }); },
        (e) => e.kind === 'CHECKSUM_MISMATCH' && e.remediation === 'hard-stop' && E.isHardStop(e.kind));
});

// --- problemMessage: cockpit's machine tokens never reach a screen ---------

test('problemMessage: every cockpit problem that really happens gets a real sentence', () => {
    // cockpit.spawn() sets .message to the problem token itself when the
    // process wrote no stderr, so anything rendering .message shows the token.
    for (const p of Object.keys(E.PROBLEM_MESSAGE)) {
        const m = E.problemMessage(p);
        assert.equal(typeof m, 'string');
        assert.ok(m.length > 20, p + ' must get a sentence, not a token: ' + JSON.stringify(m));
        assert.ok(!/^[a-z-]+$/.test(m), p + ' still looks like a token: ' + m);
        assert.ok(/[.!]$/.test(m.trim()), p + ' must read as a sentence: ' + m);
    }
});

test('problemMessage: the two that actually happen say what to DO', () => {
    // A first run with no `sudo make install` read, in full, as "not-found".
    assert.match(E.problemMessage('not-found'), /helper is not installed/i);
    assert.match(E.problemMessage('not-found'), /make install/);
    // Cockpit starts every account in Limited access, including sudoers.
    assert.match(E.problemMessage('access-denied'), /administrative access/i);
    assert.notEqual(E.problemMessage('not-found'), E.problemMessage('access-denied'));
});

test('problemMessage: an unknown or hostile problem yields nothing, never a guess', () => {
    for (const bad of ['', 'wat', null, undefined, 7, {}, [], true,
        '__proto__', 'constructor', 'toString', 'hasOwnProperty'])
        assert.equal(E.problemMessage(bad), '', JSON.stringify(bad));
});
