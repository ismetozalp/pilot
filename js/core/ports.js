// core/ports.js — which ports a chosen configuration needs, and who can open them.
//
// Pure: no cockpit, no I/O. Its input is the choices object build() receives.
//
// Two things here are load-bearing. First, 21116 is required on BOTH tcp and udp:
// a security group that drops UDP lets registration succeed and then makes every
// session silently fail to connect directly. Second, host-firewall and cloud-edge
// are different jobs — Pilot can apply the first and can only PRINT the second, so
// the two sets are modelled separately rather than merged into one "open these".
'use strict';
(function (root) {
    const Errors = (typeof module !== 'undefined' && module.exports)
        ? require('./errors.js')
        : root.PilotErrors;

    const SSH_DEFAULT = 22;
    const API_DEFAULT = 21114;
    const TIERS = Object.freeze(['none', 'own', 'sslip', 'duckdns']);
    const CONTROL = /[\x00-\x1f\x7f]/g;
    const MAX_DETAIL = 200;

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

    // Accepts a real integer or the digit string an HTML number input hands back.
    // Everything else is a hard failure: a port that silently becomes NaN turns
    // into a firewall rule that opens nothing.
    function toPort(v, field) {
        let n = null;
        if (typeof v === 'number' && Number.isInteger(v)) n = v;
        else if (typeof v === 'string' && /^[0-9]{1,5}$/.test(v.trim())) n = parseInt(v.trim(), 10);
        if (n === null || n < 1 || n > 65535)
            throw bad(field + ' must be a port number between 1 and 65535, got ' + label(v),
                { field: field, value: label(v) });
        return n;
    }

    function toProto(v, field) {
        if (v !== 'tcp' && v !== 'udp')
            throw bad(field + ' must be "tcp" or "udp", got ' + label(v),
                { field: field, value: label(v) });
        return v;
    }

    function req(port, proto, component, scope, restrictTo, why) {
        return Object.freeze({ port: port, proto: proto, component: component,
            scope: scope, restrictTo: restrictTo, why: why });
    }

    function required(choices) {
        if (!choices || typeof choices !== 'object' || Array.isArray(choices))
            throw bad('choices must be an object, got ' + label(choices));
        if (TIERS.indexOf(choices.tlsTier) === -1)
            throw bad('choices.tlsTier must be one of ' + TIERS.join(', ') +
                ', got ' + label(choices.tlsTier), { value: label(choices.tlsTier) });

        const tls = choices.tlsTier !== 'none';
        const out = [];
        const fixedPorts = new Map(); // track port+proto -> component for collision detection

        if (choices.target === 'ssh') {
            const sshPort = (choices.sshPort === undefined || choices.sshPort === null)
                ? SSH_DEFAULT : toPort(choices.sshPort, 'choices.sshPort');
            // Check for collision with fixed RustDesk ports.
            const fixedRD = [21115, 21116, 21117, 21118, 21119].concat(tls ? [80, 443] : []);
            for (const fp of fixedRD) {
                if (sshPort === fp)
                    throw bad('choices.sshPort ' + sshPort + ' collides with ' + fp +
                        ' (hbbs/hbbr/acme/https)', { value: sshPort });
            }
            // Host-only: the live session already proves the cloud edge allows it,
            // so telling the user to open it upstream would be noise.
            out.push(req(sshPort, 'tcp', 'ssh', 'host', null,
                'Pilot provisions and manages this host over SSH.'));
            fixedPorts.set(key(sshPort, 'tcp'), 'ssh');
        }

        out.push(req(21115, 'tcp', 'hbbs', 'both', null,
            'hbbs NAT type test — clients cannot classify their NAT without it.'));
        fixedPorts.set(key(21115, 'tcp'), 'hbbs');
        out.push(req(21116, 'tcp', 'hbbs', 'both', null,
            'hbbs ID registration and rendezvous over TCP.'));
        fixedPorts.set(key(21116, 'tcp'), 'hbbs');
        out.push(req(21116, 'udp', 'hbbs', 'both', null,
            'hbbs hole punching over UDP — without it registration still succeeds ' +
            'and every direct session silently falls back to the relay or fails.'));
        fixedPorts.set(key(21116, 'udp'), 'hbbs');
        out.push(req(21117, 'tcp', 'hbbr', 'both', null,
            'hbbr relay, used whenever a direct connection cannot be established.'));
        fixedPorts.set(key(21117, 'tcp'), 'hbbr');

        if (tls) {
            out.push(req(21118, 'tcp', 'hbbs', 'host', 'proxy',
                'hbbs websocket, reached only through the TLS proxy on this host.'));
            fixedPorts.set(key(21118, 'tcp'), 'hbbs');
            out.push(req(21119, 'tcp', 'hbbr', 'host', 'proxy',
                'hbbr websocket, reached only through the TLS proxy on this host.'));
            fixedPorts.set(key(21119, 'tcp'), 'hbbr');
            out.push(req(80, 'tcp', 'acme', 'both', null,
                'ACME HTTP-01 challenge, during issuance and at every renewal.'));
            fixedPorts.set(key(80, 'tcp'), 'acme');
            out.push(req(443, 'tcp', 'https', 'both', null,
                'The TLS proxy. The RustDesk client appends no port to a domain, ' +
                'so 443 is the only port that works.'));
            fixedPorts.set(key(443, 'tcp'), 'https');
        } else {
            out.push(req(21118, 'tcp', 'hbbs', 'both', null,
                'hbbs websocket for the web client.'));
            fixedPorts.set(key(21118, 'tcp'), 'hbbs');
            out.push(req(21119, 'tcp', 'hbbr', 'both', null,
                'hbbr websocket for the web client.'));
            fixedPorts.set(key(21119, 'tcp'), 'hbbr');
            const apiPort = (choices.apiPort === undefined || choices.apiPort === null)
                ? API_DEFAULT : toPort(choices.apiPort, 'choices.apiPort');
            // Check for collision with fixed RustDesk ports.
            const fixedRD = [21115, 21116, 21117, 21118, 21119];
            for (const fp of fixedRD) {
                if (apiPort === fp)
                    throw bad('choices.apiPort ' + apiPort + ' collides with ' + fp +
                        ' (hbbs/hbbr)', { value: apiPort });
            }
            out.push(req(apiPort, 'tcp', 'api', 'both', null,
                'The API server, which the Cockpit host must reach directly ' +
                'because no TLS proxy is configured.'));
            fixedPorts.set(key(apiPort, 'tcp'), 'api');
        }

        out.sort((a, b) => (a.port - b.port) || (a.proto < b.proto ? -1 : a.proto > b.proto ? 1 : 0));
        return out;
    }

    function filterScope(reqs, wanted) {
        if (!Array.isArray(reqs)) return [];
        return reqs.filter((r) => !!r && typeof r === 'object' &&
            (r.scope === wanted || r.scope === 'both'));
    }

    function hostFixable(reqs) { return filterScope(reqs, 'host'); }
    // scope:'edge' is part of the Requirement union but not currently produced by any branch;
    // it is available for future use when a port must be opened at the cloud layer only.
    function cloudEdge(reqs) { return filterScope(reqs, 'edge'); }

    // Only ports that must be reachable FROM OUTSIDE are probed from the Cockpit
    // host. A proxy-restricted websocket port being unreachable from there is the
    // correct outcome, not a failure.
    function probeTargets(reqs) {
        return cloudEdge(reqs).map((r) => ({ port: r.port, proto: r.proto }));
    }

    function result(port, proto, reachable, detail) {
        return { port: toPort(port, 'port'), proto: toProto(proto, 'proto'),
            reachable: reachable === true,
            detail: typeof detail === 'string'
                ? detail.replace(CONTROL, '').slice(0, MAX_DETAIL).trim() : '' };
    }

    function normalizeResults(raw) {
        if (!Array.isArray(raw)) return [];
        const out = [];
        for (const item of raw) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            try {
                let proto = item.proto;
                if (typeof proto === 'string') proto = proto.toLowerCase();
                out.push(result(item.port, proto, item.reachable, item.detail));
            }
            catch (e) { /* an unusable probe record is dropped, never guessed at */ }
        }
        return out;
    }

    function key(port, proto) { return port + '/' + proto; }

    function reachability(reqs, results) {
        const targets = cloudEdge(reqs);
        const seen = new Map();
        for (const r of normalizeResults(Array.isArray(results) ? results : []))
            seen.set(key(r.port, r.proto), r);   // a later result wins

        const blocked = [];
        const unknown = [];
        const records = [];
        for (const t of targets) {
            const hit = seen.get(key(t.port, t.proto));
            if (!hit) { unknown.push(t); records.push({ port: t.port, proto: t.proto,
                component: t.component, reachable: null, detail: 'not probed' }); continue; }
            if (!hit.reachable) blocked.push(t);
            records.push({ port: t.port, proto: t.proto, component: t.component,
                reachable: hit.reachable, detail: hit.detail });
        }
        return { ok: blocked.length === 0 && unknown.length === 0,
            checked: targets.length, blocked: blocked, unknown: unknown, records: records };
    }

    function errorFor(report) {
        if (!report || typeof report !== 'object' || report.ok === true) return null;
        const names = []
            .concat(Array.isArray(report.blocked) ? report.blocked : [])
            .concat(Array.isArray(report.unknown) ? report.unknown : [])
            .map((r) => key(r.port, r.proto));
        return Errors.create('PORT_BLOCKED',
            'These ports are not reachable from the Cockpit host: ' + names.join(', ') +
            '. A host firewall rule cannot fix a cloud or upstream firewall.',
            { ports: names });
    }

    const SG_RE = /^sg-[0-9a-f]{8,32}$/;

    function awsIngressArgv(r, groupId) {
        if (!r || typeof r !== 'object') throw bad('awsIngressArgv needs a requirement');
        if (typeof groupId !== 'string' || !SG_RE.test(groupId))
            throw bad('Not a security group id: ' + label(groupId), { value: label(groupId) });
        // Reject proxy-restricted ports: they must NOT be opened to the internet.
        if (r.restrictTo === 'proxy')
            throw bad('Cannot open port ' + toPort(r.port, 'requirement.port') +
                ' to the internet: ' + String(r.why).slice(0, 100),
                { port: toPort(r.port, 'requirement.port'), restrictTo: 'proxy' });
        // Only cloud-edge requirements are appropriate for cloud commands.
        if (r.scope !== 'edge' && r.scope !== 'both')
            throw bad('Port ' + toPort(r.port, 'requirement.port') +
                ' is ' + String(r.scope) + '-only, not a cloud-edge concern',
                { port: toPort(r.port, 'requirement.port'), scope: r.scope });
        return ['aws', 'ec2', 'authorize-security-group-ingress',
            '--group-id', groupId,
            '--protocol', toProto(r.proto, 'requirement.proto'),
            '--port', String(toPort(r.port, 'requirement.port')),
            '--cidr', '0.0.0.0/0'];
    }

    function describe(r) {
        if (!r || typeof r !== 'object') return '';
        const where = r.restrictTo === 'proxy' ? ' (proxy only)' : '';
        return key(toPort(r.port, 'requirement.port'), toProto(r.proto, 'requirement.proto')) +
            ' — ' + String(r.component).replace(CONTROL, '') + where + ' — ' +
            String(r.why).replace(CONTROL, '');
    }

    const PilotPorts = {
        SSH_DEFAULT: SSH_DEFAULT, API_DEFAULT: API_DEFAULT, TIERS: TIERS,
        required: required, hostFixable: hostFixable, cloudEdge: cloudEdge,
        probeTargets: probeTargets, result: result, normalizeResults: normalizeResults,
        reachability: reachability, errorFor: errorFor,
        awsIngressArgv: awsIngressArgv, describe: describe
    };
    root.PilotPorts = PilotPorts;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotPorts;
})(typeof window !== 'undefined' ? window : globalThis);
