// core/firewall.js — host firewall rules for the detected backend, as C1 Steps.
//
// Pure: no cockpit, no I/O. It takes the Requirement records ports.js produces and
// returns Steps that provision-plan splices straight into its plan.
//
// It reads r.port / r.proto / r.scope / r.restrictTo by field and deliberately does
// NOT require ports.js: nothing here should depend on module load order, and the
// shape is small enough to validate on the way in.
//
// Every rule that can be probed carries a `check`, because the alternative is a
// firewall that accumulates a duplicate copy of every rule on each re-run.
'use strict';
(function (root) {
    const Errors = (typeof module !== 'undefined' && module.exports)
        ? require('./errors.js')
        : root.PilotErrors;

    const BACKENDS = Object.freeze(['firewalld', 'ufw', 'nftables', 'none']);
    const NFT_DIR = '/etc/nftables.d';
    const NFT_PATH = NFT_DIR + '/pilot.nft';
    const DEFAULT_PROXY = '127.0.0.1';
    const CONTROL = /[\x00-\x1f\x7f]/g;

    function label(v) {
        let s;
        try {
            s = v === null ? 'null'
                : typeof v === 'undefined' ? 'undefined'
                    : typeof v === 'object' ? Object.prototype.toString.call(v)
                        : String(v);
        } catch (e) { s = '[unprintable]'; }
        return s.replace(CONTROL, '?').slice(0, 40);
    }

    function bad(message, detail) { return Errors.create('GENERIC', message, detail || null); }

    function checkBackend(backend) {
        if (BACKENDS.indexOf(backend) === -1)
            throw Errors.create('FIREWALL_UNSUPPORTED',
                'Unsupported firewall backend "' + label(backend) + '". Pilot can configure ' +
                BACKENDS.join(', ') + '.', { backend: label(backend) });
        return backend;
    }

    // Requirements arrive from ports.js, but validating them here is what keeps a
    // typo out of a firewall rule rather than into one.
    function normalize(reqs) {
        if (!Array.isArray(reqs)) return [];
        const out = [];
        for (const r of reqs) {
            if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
            if (r.scope !== 'host' && r.scope !== 'both') continue;
            if (typeof r.port !== 'number' || !Number.isInteger(r.port) ||
                r.port < 1 || r.port > 65535)
                throw bad('Requirement port must be an integer between 1 and 65535, got ' +
                    label(r.port), { port: label(r.port) });
            if (r.proto !== 'tcp' && r.proto !== 'udp')
                throw bad('Requirement proto must be "tcp" or "udp", got ' + label(r.proto),
                    { proto: label(r.proto) });
            const restrict = (r.restrictTo === undefined) ? null : r.restrictTo;
            if (restrict !== null && restrict !== 'proxy')
                throw bad('Requirement restrictTo must be null or "proxy", got ' +
                    label(restrict), { restrictTo: label(restrict) });
            out.push({ port: r.port, proto: r.proto, restrictTo: restrict });
        }
        // Sort by port number in ascending order to make the output deterministic.
        out.sort((a, b) => a.port - b.port);
        return out;
    }

    const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;

    function proxySource(opts) {
        const raw = (opts && typeof opts === 'object' && !Array.isArray(opts))
            ? opts.proxySource : undefined;
        if (raw === undefined || raw === null) return DEFAULT_PROXY;
        if (typeof raw !== 'string')
            throw bad('opts.proxySource must be an IPv4 address or CIDR, got ' + label(raw));
        const s = raw.replace(CONTROL, '').trim();
        const m = IPV4.exec(s);
        if (!m) throw bad('opts.proxySource is not an IPv4 address or CIDR: ' + label(raw));
        for (let i = 1; i <= 4; i++)
            if (Number(m[i]) > 255)
                throw bad('opts.proxySource is not an IPv4 address or CIDR: ' + label(raw));
        const prefix = m[5] !== undefined ? Number(m[5]) : 32;
        if (prefix > 32)
            throw bad('opts.proxySource is not an IPv4 address or CIDR: ' + label(raw));

        // Semantic validation: reject anything broader than /8, and check that it is
        // loopback (127.0.0.0/8) or private (10/8, 172.16/12, 192.168/16).
        if (prefix < 8)
            throw bad('opts.proxySource must be loopback or private RFC1918 (not broader ' +
                'than /8, not public), got ' + label(raw));

        const a = Number(m[1]);
        const b = Number(m[2]);
        const c = Number(m[3]);
        const d = Number(m[4]);

        // 127.0.0.0/8: loopback
        if (a === 127) return s;
        // 10.0.0.0/8: private
        if (a === 10) return s;
        // 172.16.0.0/12: private
        if (a === 172 && b >= 16 && b <= 31) return s;
        // 192.168.0.0/16: private
        if (a === 192 && b === 168) return s;

        throw bad('opts.proxySource must be loopback or private RFC1918 (not public), ' +
            'got ' + label(raw));
    }

    function step(id, title, why, argv, write, check) {
        return { id: id, title: title, mutating: true, why: why, argv: argv,
            write: write, check: check, sha256: null, secret: false };
    }

    function slug(r, prefix) {
        return prefix + '-' + r.port + '-' + r.proto + (r.restrictTo === 'proxy' ? '-proxy' : '');
    }

    function why(r, src) {
        return r.restrictTo === 'proxy'
            ? 'Allow ' + r.port + '/' + r.proto + ' from the TLS proxy at ' + src +
              ' only, so the websocket port is not exposed directly.'
            : 'Allow ' + r.port + '/' + r.proto + ', which the RustDesk deployment needs.';
    }

    function richRule(r, src) {
        return 'rule family="ipv4" source address="' + src + '" port port="' + r.port +
            '" protocol="' + r.proto + '" accept';
    }

    function firewalldSteps(list, src) {
        const out = [];
        for (const r of list) {
            if (r.restrictTo === 'proxy') {
                const rule = richRule(r, src);
                out.push(step(slug(r, 'fw-firewalld'),
                    'Allow ' + r.port + '/' + r.proto + ' from ' + src + ' (firewalld)',
                    why(r, src),
                    ['firewall-cmd', '--permanent', '--add-rich-rule=' + rule], null,
                    { argv: ['firewall-cmd', '--permanent', '--query-rich-rule=' + rule],
                        expect: 'zero' }));
            } else {
                const spec = r.port + '/' + r.proto;
                out.push(step(slug(r, 'fw-firewalld'),
                    'Open ' + spec + ' (firewalld)', why(r, src),
                    ['firewall-cmd', '--permanent', '--add-port=' + spec], null,
                    { argv: ['firewall-cmd', '--permanent', '--query-port=' + spec],
                        expect: 'zero' }));
            }
        }
        if (out.length) {
            out.push(step('fw-firewalld-reload', 'Reload firewalld',
                'Apply the permanent rules to the running firewall.',
                ['firewall-cmd', '--reload'], null, null));
        }
        return out;
    }

    function ufwSteps(list, src) {
        // `ufw allow` is idempotent — it reports "Skipping adding existing rule" —
        // and ufw has no per-rule query subcommand, so no check is emitted.
        return list.map((r) => r.restrictTo === 'proxy'
            ? step(slug(r, 'fw-ufw'),
                'Allow ' + r.port + '/' + r.proto + ' from ' + src + ' (ufw)', why(r, src),
                ['ufw', 'allow', 'from', src, 'to', 'any', 'port', String(r.port),
                    'proto', r.proto], null, null)
            : step(slug(r, 'fw-ufw'),
                'Open ' + r.port + '/' + r.proto + ' (ufw)', why(r, src),
                ['ufw', 'allow', r.port + '/' + r.proto], null, null));
    }

    function nftConfig(reqs, opts) {
        const src = proxySource(opts);
        const list = normalize(reqs);
        const lines = [
            '#!/usr/sbin/nft -f',
            '# Generated by Pilot for the RustDesk server. Do not edit by hand.',
            '#',
            '# Re-applying this file is idempotent: the table is created if absent, deleted,',
            '# and then rebuilt, so `nft -f` twice does not append a second copy of every rule.',
            '',
            'table inet pilot {}',
            'delete table inet pilot',
            '',
            'table inet pilot {',
            '    chain input {',
            '        type filter hook input priority 0; policy accept;'
        ];
        for (const r of list) {
            lines.push(r.restrictTo === 'proxy'
                ? '        ip saddr ' + src + ' ' + r.proto + ' dport ' + r.port + ' accept'
                : '        ' + r.proto + ' dport ' + r.port + ' accept');
        }
        lines.push('    }');
        lines.push('}');
        return lines.join('\n') + '\n';
    }

    function nftSteps(reqs, list, opts) {
        if (!list.length) return [];
        return [
            step('fw-nft-dir', 'Create ' + NFT_DIR,
                'nftables include directory for Pilot-generated rules.',
                ['install', '-d', '-m', '0755', NFT_DIR], null,
                { argv: ['test', '-d', NFT_DIR], expect: 'zero' }),
            step('fw-nft-write', 'Write ' + NFT_PATH,
                'The full rule set, regenerated on every run so it never drifts.',
                [], { path: NFT_PATH, mode: '0644', content: nftConfig(reqs, opts),
                    owner: 'root:root' }, null),
            step('fw-nft-apply', 'Apply ' + NFT_PATH,
                'Load the rules into the running nftables ruleset.',
                ['nft', '-f', NFT_PATH], null, null)
        ];
    }

    function steps(backend, reqs, opts) {
        checkBackend(backend);
        const src = proxySource(opts);
        const list = normalize(reqs);
        if (backend === 'none' || !list.length) return [];
        if (backend === 'firewalld') return firewalldSteps(list, src);
        if (backend === 'ufw') return ufwSteps(list, src);
        return nftSteps(reqs, list, opts);
    }

    function rules(backend, reqs, opts) {
        return steps(backend, reqs, opts).map((s) => s.write !== null
            ? 'write ' + s.write.path + ' (' + s.write.mode + ' ' + s.write.owner + ')'
            : s.argv.join(' '));
    }

    function warnings(backend, reqs, opts) {
        checkBackend(backend);
        proxySource(opts);
        // Ports the user must open somewhere Pilot cannot reach. Proxy-restricted
        // ports are deliberately excluded: telling someone to expose 21118 upstream
        // would undo the very restriction the TLS tier just applied.
        const exposed = normalize(reqs)
            .filter((r) => r.restrictTo === null)
            .map((r) => r.port + '/' + r.proto);
        if (backend === 'none') {
            return ['No host firewall was detected, so Pilot has nothing to configure ' +
                'here. If one is added later, these ports must be allowed: ' +
                exposed.join(', ') + '.'];
        }
        return ['Pilot configured the host firewall (' + backend + '), but it cannot ' +
            'change a cloud security group or an upstream NAT. Open these there ' +
            'yourself: ' + exposed.join(', ') + '.'];
    }

    const PilotFirewall = {
        BACKENDS: BACKENDS, NFT_DIR: NFT_DIR, NFT_PATH: NFT_PATH,
        DEFAULT_PROXY: DEFAULT_PROXY,
        nftConfig: nftConfig, steps: steps, rules: rules, warnings: warnings
    };
    root.PilotFirewall = PilotFirewall;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotFirewall;
})(typeof window !== 'undefined' ? window : globalThis);
