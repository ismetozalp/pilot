// core/tls.js — TLS tier selection, domain validation, DNS pre-flight and
// Caddyfile generation.
//
// Pure: no cockpit, no I/O, no filesystem, no Step objects. This module decides
// WHAT the reverse proxy must look like; js/core/provision-plan.js turns
// caddyfile() plus CADDYFILE_PATH/MODE/OWNER into the C1 write Step, and
// libexec/pilot-exec writes it. Nothing else generates a Caddyfile.
//
// Two facts drive every decision here and must not be re-derived:
//
//   1. Caddy MUST listen on 443. The RustDesk client appends no port to the
//      api-server URL (hbb_common websocket.rs check_ws), so a custom port
//      silently breaks the web client and both wss:// endpoints.
//   2. A bare IP address is not a TLS target. Let's Encrypt does not issue for
//      IP addresses, and without a hostname there is no /ws/id or /ws/relay
//      routing at all — so every TLS tier rejects one rather than emitting a
//      config that cannot work.
'use strict';
(function (root) {
    const TIERS = ['none', 'own', 'sslip', 'duckdns'];
    // The tiers that actually terminate TLS, i.e. everything except 'none'.
    const TLS_TIERS = ['own', 'sslip', 'duckdns'];

    const CADDYFILE_PATH = '/etc/caddy/Caddyfile';
    const CADDYFILE_MODE = '0644';
    const CADDYFILE_OWNER = 'root:root';

    const API_PORT_DEFAULT = 21114;
    const WS_ID_PORT = 21118;      // hbbs websocket rendezvous
    const WS_RELAY_PORT = 21119;   // hbbr websocket relay
    const HTTPS_PORT = 443;

    const MAX_DOMAIN = 253;
    const MAX_LABEL = 63;

    const SSLIP_SUFFIX = 'sslip.io';
    const DUCKDNS_SUFFIX = 'duckdns.org';

    // Let's Encrypt refuses to issue for EC2's own hostnames by policy, so a
    // user who pastes the instance's public DNS name gets a clear reason here
    // instead of an opaque ACME failure later.
    const LE_REFUSED_SUFFIX = '.compute.amazonaws.com';

    // The only characters a hostname may contain. Anything else — whitespace,
    // control bytes, ':', '*', unicode — is REJECTED, never trimmed away, so
    // ' a.com', 'a.com\n' and 'a\x0bb.com' can never quietly become 'a.com'.
    const HOST_CHARS = /^[A-Za-z0-9.-]+$/;
    const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
    const DIGITS_RE = /^[0-9]+$/;
    const TOKEN_RE = /^[A-Za-z0-9-]{8,128}$/;

    const RATE_LIMIT_RE = /rate\s*limit|ratelimited|too many certificates|too many failed authorizations/i;
    const ACME_DNS_RE = /dns problem|nxdomain|no valid a records|could not resolve|servfail/i;

    function str(v) { return typeof v === 'string' ? v : ''; }

    // Anything echoed back into a user-visible message goes through here: no
    // control byte ever reaches a message, and a megabyte of paste cannot
    // become a megabyte of error text.
    function printable(v) {
        const s = str(v).replace(/[\x00-\x1f\x7f]/g, '?');
        return s.length > 64 ? s.slice(0, 64) + '...' : s;
    }

    function isPort(v) {
        return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535;
    }

    // Lowercases and drops ONE trailing dot (the fully-qualified form).
    // Returns '' for anything that is not a plausible hostname; '' is the single
    // "no host" value used by every host-producing function in this module.
    function normalizeDomain(v) {
        const s = str(v);
        if (!s || s.length > MAX_DOMAIN + 1) return '';
        if (!HOST_CHARS.test(s)) return '';
        const bare = s.charAt(s.length - 1) === '.' ? s.slice(0, -1) : s;
        return bare.toLowerCase();
    }

    function isValidDomain(v) {
        const d = normalizeDomain(v);
        if (!d || d.length > MAX_DOMAIN) return false;
        const labels = d.split('.');
        if (labels.length < 2) return false;   // a single-label name gets no public certificate
        for (let i = 0; i < labels.length; i++) {
            const l = labels[i];
            if (l.length === 0 || l.length > MAX_LABEL) return false;
            if (!LABEL_RE.test(l)) return false;
        }
        // An all-numeric last label means this is an address, not a name:
        // '1.2.3.4' and '10.0.0.1.5' alike. Rejected for every TLS tier.
        if (DIGITS_RE.test(labels[labels.length - 1])) return false;
        return true;
    }

    function isBareIpv4(v) {
        const s = str(v);
        const parts = s.split('.');
        if (parts.length !== 4) return false;
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (!DIGITS_RE.test(p)) return false;
            if (p.length > 3) return false;
            if (p.length > 1 && p.charAt(0) === '0') return false;  // no octal-looking octets
            if (Number(p) > 255) return false;
        }
        return true;
    }

    // sslip.io resolves whatever address is embedded in the name, so a private
    // or loopback address produces a name that resolves fine and can never be
    // certified. Caught here rather than at ACME time.
    function isPublicIpv4(v) {
        if (!isBareIpv4(v)) return false;
        const o = str(v).split('.').map(Number);
        if (o[0] === 0 || o[0] === 127 || o[0] === 10) return false;
        if (o[0] === 169 && o[1] === 254) return false;
        if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false;
        if (o[0] === 192 && o[1] === 168) return false;
        if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return false;
        if (o[0] >= 224) return false;
        return true;
    }

    function sslipHost(ip) {
        return isPublicIpv4(ip) ? str(ip) + '.' + SSLIP_SUFFIX : '';
    }

    function duckdnsHost(sub) {
        const s = str(sub).toLowerCase();
        if (!s || s.length > MAX_LABEL) return '';
        if (!LABEL_RE.test(s)) return '';   // one label only: 'x.duckdns.org' is rejected
        return s + '.' + DUCKDNS_SUFFIX;
    }

    function isValidDuckdnsToken(t) {
        return TOKEN_RE.test(str(t));
    }

    function leRefuses(v) {
        const d = normalizeDomain(v);
        return !!d && d.slice(-LE_REFUSED_SUFFIX.length) === LE_REFUSED_SUFFIX;
    }

    // The hostname a tier will certify, or '' when there is none. Reads exactly
    // the C13 choices keys: tlsTier, domain, duckdns.{subdomain}.
    function hostFor(choices, detection) {
        const c = choices || {};
        const d = detection || {};
        const tier = str(c.tlsTier);
        if (tier === 'own') return isValidDomain(c.domain) ? normalizeDomain(c.domain) : '';
        if (tier === 'sslip') return sslipHost(d.public_ip);
        if (tier === 'duckdns') return duckdnsHost(c.duckdns ? c.duckdns.subdomain : '');
        return '';
    }

    function result(ok, tier, host, kind, message) {
        return { ok: ok, tier: tier, host: host, kind: kind, message: message };
    }

    const ADVICE = {
        none: 'TLS is skipped: the web client stays disabled and 21114 must be reachable from the Cockpit host.',
        own: 'Point the domain at this server first — the DNS pre-flight checks it before ACME runs.',
        sslip: "sslip.io is not on the Public Suffix List, so every sslip.io name shares one Let's Encrypt rate-limit bucket and issuance can need a retry. Your own domain or DuckDNS avoids that.",
        duckdns: "duckdns.org is on the Public Suffix List, so this name gets its own Let's Encrypt rate-limit bucket."
    };

    function advisory(tier) {
        return ADVICE[str(tier)] || '';
    }

    // Pure validation of the C13 choices object. Returns a plain record rather
    // than a PilotErrors object so this module keeps no load-order dependency;
    // `kind` is always a C6 kind and the caller builds the error.
    function validate(choices, detection) {
        const c = choices || {};
        const d = detection || {};
        const tier = str(c.tlsTier);

        if (TIERS.indexOf(tier) === -1)
            return result(false, '', '', 'GENERIC',
                'Unknown TLS tier "' + printable(tier) + '". Expected one of: ' + TIERS.join(', ') + '.');

        if (tier === 'none')
            return result(true, 'none', '', 'OK',
                'TLS skipped. The web client stays disabled and the API is reached over plain HTTP.');

        if (tier === 'own') {
            const raw = str(c.domain);
            if (!raw)
                return result(false, tier, '', 'GENERIC',
                    'Enter the domain whose DNS already points at this server.');
            if (isBareIpv4(raw))
                return result(false, tier, '', 'GENERIC',
                    'A bare IP address cannot be used for TLS: certificates are not issued for IP ' +
                    'addresses, and without a hostname there is no /ws/id or /ws/relay routing. ' +
                    'Use a domain, the automatic sslip.io hostname, or DuckDNS.');
            if (!isValidDomain(raw))
                return result(false, tier, '', 'GENERIC',
                    'Not a usable domain name: "' + printable(raw) + '". Use an ASCII name of at ' +
                    'least two labels, e.g. rustdesk.example.com (punycode for international names).');
            const host = normalizeDomain(raw);
            if (leRefuses(host))
                return result(false, tier, host, 'GENERIC',
                    "Let's Encrypt refuses to issue certificates for " + LE_REFUSED_SUFFIX +
                    ' names by policy. Use your own domain, the automatic sslip.io hostname, or DuckDNS.');
            return result(true, tier, host, 'OK', 'A certificate will be requested for ' + host + '.');
        }

        if (tier === 'sslip') {
            const ip = str(d.public_ip);
            if (!ip)
                return result(false, tier, '', 'GENERIC',
                    'No public IP address was detected, so the automatic sslip.io hostname cannot ' +
                    'be built. Use your own domain or DuckDNS.');
            if (!isPublicIpv4(ip))
                return result(false, tier, '', 'GENERIC',
                    'The detected address "' + printable(ip) + '" is not a public IPv4 address, so ' +
                    'no certificate can be issued for it. Use your own domain or DuckDNS.');
            return result(true, tier, sslipHost(ip), 'OK', advisory('sslip'));
        }

        // duckdns. The token is a secret: it is validated but never echoed.
        const dd = c.duckdns || {};
        const host = duckdnsHost(dd.subdomain);
        if (!host)
            return result(false, tier, '', 'GENERIC',
                'Enter just the DuckDNS subdomain — the part before .duckdns.org — using ' +
                'lowercase letters, digits and hyphens.');
        if (!isValidDuckdnsToken(dd.token))
            return result(false, tier, host, 'GENERIC',
                'Enter the DuckDNS account token: 8 to 128 characters, letters, digits and hyphens only.');
        return result(true, tier, host, 'OK', 'A certificate will be requested for ' + host + '.');
    }

    // DNS pre-flight, expressed as a pure comparison so the resolver stays
    // outside this module. `resolved` is whatever A records were looked up;
    // `expected` is the server's public IP.
    function dnsPreflight(opts) {
        const o = opts || {};
        const host = normalizeDomain(o.host);
        const expected = str(o.expected);
        const resolved = Array.isArray(o.resolved) ? o.resolved.filter(isBareIpv4) : [];
        const base = { ok: false, kind: 'GENERIC', message: '', host: host, expected: expected, resolved: resolved };

        if (!isValidDomain(host)) {
            base.message = 'No hostname to pre-flight.';
            return base;
        }
        if (!isBareIpv4(expected)) {
            base.message = 'No server IPv4 address to compare against, so DNS cannot be pre-flighted.';
            return base;
        }
        if (resolved.length === 0) {
            base.kind = 'TLS_DNS_MISMATCH';
            base.message = host + ' has no A record yet. Point it at ' + expected +
                ' and try again — issuing now would fail and consume a rate-limit attempt.';
            return base;
        }
        if (resolved.indexOf(expected) === -1) {
            base.kind = 'TLS_DNS_MISMATCH';
            base.message = host + ' resolves to ' + resolved.slice(0, 5).join(', ') +
                ', not to ' + expected + '. Update the record and try again.';
            return base;
        }
        base.ok = true;
        base.kind = 'OK';
        base.message = host + ' resolves to ' + expected + '.';
        return base;
    }

    // Maps ACME/Caddy failure text onto a C6 kind. Only called when the tls step
    // has already failed, so the floor is TLS_ACME_FAILED, never OK.
    function classifyAcmeFailure(text) {
        const s = str(text);
        if (RATE_LIMIT_RE.test(s)) return 'TLS_RATE_LIMITED';
        if (ACME_DNS_RE.test(s)) return 'TLS_DNS_MISMATCH';
        return 'TLS_ACME_FAILED';
    }

    // The value for `rustdesk.api-server`. It MUST be https://<domain> with no
    // port when TLS is on: the client picks wss:// only when this string starts
    // with https, and silently downgrades to plaintext ws:// otherwise.
    function apiServerUrl(opts) {
        const o = opts || {};
        const tlsHost = normalizeDomain(o.tlsHost);
        if (isValidDomain(tlsHost)) return 'https://' + tlsHost;
        const port = (o.apiPort === undefined || o.apiPort === null) ? API_PORT_DEFAULT : o.apiPort;
        if (!isPort(port)) return '';
        const plain = str(o.plainHost);
        if (isBareIpv4(plain)) return 'http://' + plain + ':' + port;
        if (isValidDomain(plain)) return 'http://' + normalizeDomain(plain) + ':' + port;
        return '';
    }

    function webClientUrl(host) {
        const d = normalizeDomain(host);
        return isValidDomain(d) ? 'https://' + d + '/' : '';
    }

    const TIER_NOTES = {
        own: ['# Tier: own domain. Its DNS must already point at this server.'],
        sslip: [
            '# Tier: automatic sslip.io hostname.',
            '# sslip.io is not on the Public Suffix List, so every sslip.io name shares',
            "# one Let's Encrypt rate-limit bucket and issuance can need a retry."
        ],
        duckdns: [
            '# Tier: DuckDNS.',
            '# duckdns.org is on the Public Suffix List, so this name has its own',
            "# Let's Encrypt rate-limit bucket."
        ]
    };

    function proxyLines(indent, port) {
        return [
            indent + 'reverse_proxy 127.0.0.1:' + port + ' {',
            indent + '    header_up X-Real-IP {remote_host}',
            indent + '    header_up X-Forwarded-For {remote_host}',
            indent + '    header_up X-Forwarded-Proto {scheme}',
            indent + '}'
        ];
    }

    // opts: { tier: 'own'|'sslip'|'duckdns', host: string, apiPort?: number }
    // Throws on anything it cannot render honestly — validate() is the gate that
    // keeps that from happening in the wizard.
    function caddyfile(opts) {
        const o = opts || {};
        const tier = str(o.tier);
        if (TLS_TIERS.indexOf(tier) === -1)
            throw new Error('PilotTls.caddyfile: tier must be one of ' + TLS_TIERS.join(', ') +
                ', got "' + printable(tier) + '"');
        if (isBareIpv4(str(o.host)))
            throw new Error('PilotTls.caddyfile: a bare IP address gets no TLS and no /ws/* routing');
        const host = normalizeDomain(o.host);
        if (!isValidDomain(host))
            throw new Error('PilotTls.caddyfile: not a usable hostname: "' + printable(o.host) + '"');
        const apiPort = (o.apiPort === undefined || o.apiPort === null) ? API_PORT_DEFAULT : o.apiPort;
        if (!isPort(apiPort))
            throw new Error('PilotTls.caddyfile: apiPort must be an integer from 1 to 65535, got "' +
                printable(String(apiPort)) + '"');

        let lines = [
            '# Managed by Pilot. Regenerated on every run - do not edit by hand.'
        ];
        lines = lines.concat(TIER_NOTES[tier]);
        lines = lines.concat([
            '#',
            '# Caddy listens on ' + HTTPS_PORT + ' and nothing else: the RustDesk client appends no',
            '# port to the api-server URL, so a custom port silently breaks the web client',
            '# and both wss:// endpoints below.',
            '#',
            '# X-Real-IP and X-Forwarded-For are SET, not appended: ' + WS_ID_PORT + ' and ' + WS_RELAY_PORT + ' are',
            '# reachable directly, so a header supplied by the client would otherwise be',
            '# trusted and forge the logged address.',
            'https://' + host + ' {',
            '    encode zstd gzip',
            '',
            '    # hbbs websocket rendezvous. handle, not handle_path: hbbs matches on the',
            '    # full path, so /ws/id must survive the proxy.',
            '    handle /ws/id {'
        ]);
        lines = lines.concat(proxyLines('        ', WS_ID_PORT));
        lines = lines.concat([
            '    }',
            '',
            '    # hbbr websocket relay, likewise path-preserving.',
            '    handle /ws/relay {'
        ]);
        lines = lines.concat(proxyLines('        ', WS_RELAY_PORT));
        lines = lines.concat([
            '    }',
            '',
            '    # Everything else is the API server and its web client.',
            '    handle {'
        ]);
        lines = lines.concat(proxyLines('        ', apiPort));
        lines = lines.concat([
            '    }',
            '}',
            ''
        ]);
        return lines.join('\n');
    }

    const PilotTls = {
        TIERS: TIERS,
        TLS_TIERS: TLS_TIERS,
        CADDYFILE_PATH: CADDYFILE_PATH,
        CADDYFILE_MODE: CADDYFILE_MODE,
        CADDYFILE_OWNER: CADDYFILE_OWNER,
        API_PORT_DEFAULT: API_PORT_DEFAULT,
        WS_ID_PORT: WS_ID_PORT,
        WS_RELAY_PORT: WS_RELAY_PORT,
        HTTPS_PORT: HTTPS_PORT,
        SSLIP_SUFFIX: SSLIP_SUFFIX,
        DUCKDNS_SUFFIX: DUCKDNS_SUFFIX,
        LE_REFUSED_SUFFIX: LE_REFUSED_SUFFIX,
        normalizeDomain: normalizeDomain,
        isValidDomain: isValidDomain,
        isBareIpv4: isBareIpv4,
        isPublicIpv4: isPublicIpv4,
        sslipHost: sslipHost,
        duckdnsHost: duckdnsHost,
        isValidDuckdnsToken: isValidDuckdnsToken,
        leRefuses: leRefuses,
        hostFor: hostFor,
        validate: validate,
        dnsPreflight: dnsPreflight,
        classifyAcmeFailure: classifyAcmeFailure,
        apiServerUrl: apiServerUrl,
        webClientUrl: webClientUrl,
        advisory: advisory,
        caddyfile: caddyfile
    };
    root.PilotTls = PilotTls;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotTls;
})(typeof window !== 'undefined' ? window : globalThis);
