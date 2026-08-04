// core/errors.js — typed error kinds shared by every Pilot module.
//
// House pattern: IIFE assigning to root.PilotXxx with a dual module.exports so the
// pure logic is directly loadable by `node --test` without a DOM.
//
// The whole point is that a failure becomes an ACTION in the UI, not a toast. `kind`
// drives which remediation the user is offered, so the list is deliberately narrow
// and exhaustive rather than free-form strings (spec §8).
'use strict';
(function (root) {

    // The canonical list (spec §8). Key === value throughout: callers pass kind
    // strings around freely, and a key that did not map to itself would be a trap.
    const KIND = {
        OK: 'OK',
        GENERIC: 'GENERIC',
        UNKNOWN: 'UNKNOWN',
        CANCELLED: 'CANCELLED',

        SSH_AUTH_FAILED: 'SSH_AUTH_FAILED',
        SSH_UNREACHABLE: 'SSH_UNREACHABLE',
        SSH_HOSTKEY_UNKNOWN: 'SSH_HOSTKEY_UNKNOWN',
        SSH_HOSTKEY_CHANGED: 'SSH_HOSTKEY_CHANGED',

        OS_UNSUPPORTED: 'OS_UNSUPPORTED',
        ARCH_UNSUPPORTED: 'ARCH_UNSUPPORTED',
        NO_SYSTEMD: 'NO_SYSTEMD',
        NO_EGRESS: 'NO_EGRESS',
        CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',

        HBBS_NOT_FOUND: 'HBBS_NOT_FOUND',
        PORT_BLOCKED: 'PORT_BLOCKED',
        FIREWALL_UNSUPPORTED: 'FIREWALL_UNSUPPORTED',

        API_UNREACHABLE: 'API_UNREACHABLE',
        API_AUTH_FAILED: 'API_AUTH_FAILED',
        API_VERSION_MISMATCH: 'API_VERSION_MISMATCH',
        BRIDGE_NO_ADDRESS_CAP: 'BRIDGE_NO_ADDRESS_CAP',

        TLS_DNS_MISMATCH: 'TLS_DNS_MISMATCH',
        TLS_ACME_FAILED: 'TLS_ACME_FAILED',
        TLS_RATE_LIMITED: 'TLS_RATE_LIMITED'
    };

    // The closed remediation vocabulary. Anything outside it is a bug, and the unit
    // suite asserts REMEDIATION is total over KIND and lands only in here.
    const VALUES = ['retry', 'reauthorize', 'manual-mode', 'fix-dns',
        'open-ports', 'hard-stop', 'none'];

    const REMEDIATION = {
        // No one-click fix — the UI surfaces the raw detail verbatim (§8).
        [KIND.OK]: 'none',
        [KIND.GENERIC]: 'none',
        [KIND.UNKNOWN]: 'none',
        [KIND.CANCELLED]: 'none',
        // Refusal is enforced by the compatibility probe, which names the missing
        // endpoints (§7.1). The actual fix — pin or upgrade the API server — is not
        // one of the seven one-click actions, so claiming one here would be a lie.
        [KIND.API_VERSION_MISMATCH]: 'none',

        // Credentials or a trust decision the user must make again.
        [KIND.SSH_AUTH_FAILED]: 'reauthorize',
        [KIND.SSH_HOSTKEY_UNKNOWN]: 'reauthorize',
        [KIND.API_AUTH_FAILED]: 'reauthorize',

        // Transient or wrong-target: the same action can succeed unchanged.
        [KIND.SSH_UNREACHABLE]: 'retry',
        [KIND.HBBS_NOT_FOUND]: 'retry',
        [KIND.API_UNREACHABLE]: 'retry',
        [KIND.TLS_ACME_FAILED]: 'retry',

        // Pilot cannot drive this target automatically; §4.4 manual mode renders the
        // SAME plan as a copy-pasteable script rather than a second implementation.
        [KIND.OS_UNSUPPORTED]: 'manual-mode',
        [KIND.ARCH_UNSUPPORTED]: 'manual-mode',
        [KIND.NO_SYSTEMD]: 'manual-mode',
        // No egress means the automatic download cannot run; the plan falls back to
        // streaming over SSH, and where that is impossible the user runs it by hand.
        [KIND.NO_EGRESS]: 'manual-mode',
        // A bridge without the `address` capability (§2.8) cannot proxy the control
        // plane at all, so the surface degrades to instructions rather than a retry.
        [KIND.BRIDGE_NO_ADDRESS_CAP]: 'manual-mode',

        // Ports: §6.3 splits these into host-firewall (Pilot can fix) and cloud/edge
        // (the user must open), and the UI shows the literal command either way.
        [KIND.PORT_BLOCKED]: 'open-ports',
        [KIND.FIREWALL_UNSUPPORTED]: 'open-ports',

        // §6.1 DNS pre-flight: catch the mismatch before burning an ACME attempt.
        [KIND.TLS_DNS_MISMATCH]: 'fix-dns',
        // A shared sslip.io rate-limit bucket is fixed by moving to a domain with
        // its own bucket, i.e. by changing DNS — not by retrying into the limit.
        [KIND.TLS_RATE_LIMITED]: 'fix-dns',

        // §8: never "warn and continue". A changed host key is a possible MITM and a
        // digest mismatch is a possibly-tampered binary.
        [KIND.SSH_HOSTKEY_CHANGED]: 'hard-stop',
        [KIND.CHECKSUM_MISMATCH]: 'hard-stop'
    };

    function has(obj, key) {
        return typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);
    }

    // Unknown or nullish becomes UNKNOWN — never a silent success, and never an
    // inherited property: a bare `KIND[k]` truthiness test would accept
    // 'constructor' and 'toString' as if they were kinds.
    function normalize(kind) {
        return has(KIND, kind) ? KIND[kind] : KIND.UNKNOWN;
    }

    function remediation(kind) {
        const k = normalize(kind);
        return has(REMEDIATION, k) ? REMEDIATION[k] : 'none';
    }

    function isHardStop(kind) {
        return remediation(kind) === 'hard-stop';
    }

    // Messages arrive from anywhere: a caught cockpit problem object, an ACME error
    // body, a transcript line. Coerce without losing the useful text, and never
    // produce a bare "[object Object]".
    function messageText(message, kind) {
        if (typeof message === 'string') return message === '' ? kind : message;
        if (message === null || message === undefined) return kind;
        if (typeof message === 'object') {
            const p = message.problem || message.message;
            if (typeof p === 'string' && p !== '') return p;
            try { return JSON.stringify(message); } catch (e) { return kind; }
        }
        return String(message);
    }

    // Cockpit's channel `problem` codes are machine tokens -- 'not-found',
    // 'access-denied', 'terminated'. cockpit.spawn() sets .message to that same
    // token whenever the process produced no stderr of its own, so anything
    // that renders a caught spawn rejection's .message puts a bare token on the
    // screen: a first run with the helper not installed read, in full, as
    // "not-found". Every one of these has a specific and completely different
    // next action, so each gets a real sentence.
    //
    // 'not-found' and 'access-denied' are the two that actually happen: the
    // first is `sudo make install` never having been run (the plugin's web
    // assets can be dropped in or symlinked, but the privileged helper has to
    // be installed to a root-owned path), and the second is Cockpit's default
    // Limited-access session, which every account starts in.
    const PROBLEM_MESSAGE = {
        'not-found': "Pilot's system helper is not installed on this machine. " +
            'Run `sudo make install` from the Pilot source directory, then try again.',
        'access-denied': 'Pilot needs administrative access to do this. Use ' +
            '"Turn on administrative access" in Cockpit\'s top-right menu, then try again.',
        'authentication-failed': 'Cockpit could not authenticate this session. Sign in again.',
        'not-supported': 'This Cockpit session cannot run system commands.',
        'no-cockpit': 'Cockpit is not running on this machine.',
        terminated: "The helper was stopped before it finished. Nothing was left half-applied -- try again.",
        disconnected: "The connection to this machine's Cockpit bridge was lost. Reload the page and try again.",
        'internal-error': 'Cockpit reported an internal error. Reload the page and try again.',
        timeout: 'The helper did not respond in time.'
    };

    // '' means "no better wording than whatever the caller already has".
    function problemMessage(problem) {
        if (typeof problem !== 'string') return '';
        return has(PROBLEM_MESSAGE, problem) ? PROBLEM_MESSAGE[problem] : '';
    }

    function create(kind, message, detail) {
        const k = normalize(kind);
        const e = new Error(messageText(message, k));
        e.name = 'PilotError';
        e.kind = k;
        e.detail = detail === undefined ? null : detail;
        e.remediation = remediation(k);
        return e;
    }

    function isPilotError(e) {
        return !!e && typeof e === 'object' && e.name === 'PilotError' && typeof e.kind === 'string';
    }

    const PilotErrors = {
        KIND, REMEDIATION, VALUES, PROBLEM_MESSAGE,
        create, remediation, isHardStop, normalize, isPilotError, problemMessage
    };
    root.PilotErrors = PilotErrors;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotErrors;
})(typeof window !== 'undefined' ? window : globalThis);
