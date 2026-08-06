// core/provision-plan.js — the ordered provisioning plan, as pure data. Zero I/O.
//
// House pattern: IIFE assigning to root.PilotProvisionPlan with a dual CommonJS
// export, so node --test requires it directly with no DOM and no cockpit.
//
// This module computes WHAT to do; libexec/pilot-exec executes it. Nothing here
// touches cockpit, the filesystem, the network or the clock — which is why the
// riskiest logic in the project (OS-specific sequencing) is fully unit-testable.
//
// It is deliberately thin over four modules that already own their slice of the
// decision:
//   - ostarget.js   knows which archive + pinned SHA256 a given arch downloads.
//   - ports.js      knows which ports a configuration needs and who can reach them.
//   - firewall.js   knows how to turn those ports into C1 Steps for a backend.
//   - tls.js        knows whether a TLS choice is valid, and renders the Caddyfile.
// provision-plan.js does NOT re-derive any of that: two generators for the same
// artifact (a Caddyfile, a firewall rule) is a defect this project already paid
// for once, so every write step below is a thin envelope around what those
// modules already produced.
'use strict';
(function (root) {
    const isNode = typeof module !== 'undefined' && module.exports;
    const Errors = isNode ? require('./errors.js') : root.PilotErrors;
    const OsTarget = isNode ? require('./ostarget.js') : root.PilotOsTarget;
    const Ports = isNode ? require('./ports.js') : root.PilotPorts;
    const Firewall = isNode ? require('./firewall.js') : root.PilotFirewall;
    const Tls = isNode ? require('./tls.js') : root.PilotTls;

    function err(kind, message, detail) { return Errors.create(kind, message, detail); }

    const API_DIR = '/opt/rustdesk-api';
    const API_USER = 'rustdesk-api';
    const BIN_DIR = '/usr/local/bin';
    const HBBS_DATA = '/var/lib/rustdesk-server';
    const CACHE = '/var/cache/pilot';
    const UNIT_DIR = '/etc/systemd/system';
    const ID_PORT = 21116;
    const RELAY_PORT = 21117;

    // The DuckDNS account token is a credential, so it is handled exactly the way
    // every other secret on this branch is: it NEVER appears in an argv (both
    // /proc/<pid>/cmdline on the target and the remote command line ssh builds are
    // readable by anyone who can list processes), only in a 0600 root:root file
    // that is written by a secret write step and removed by the step that consumes
    // it. libexec/pilot-exec seeds its redactor from every secret step's write
    // content, so the bare token is masked out of every transcript line as well.
    const DUCKDNS_TOKEN_PATH = '/run/pilot/duckdns.token';
    // curl reads the URL from a config file (-K) rather than from argv, so the
    // token is never a command-line argument of the curl process either. DuckDNS
    // answers 200 with the body "KO" for a bad token, so `curl -fsS` alone would
    // exit 0 on a rejected update and the failure would surface much later as an
    // opaque ACME error: the body is checked explicitly instead.
    // ONE line, semicolon-separated, exactly like the hbbs-key step's own
    // wait-for-file script: libexec/pilot-exec REJECTS any argv element
    // containing a control character (a newline included), and rightly so —
    // that check is what stops a hostile detection value smuggling a second
    // command into a rendered plan. Caught by running the real helper against a
    // real DuckDNS envelope, not by inspection; tests/integration now does that
    // on every run.
    const DUCKDNS_SCRIPT =
        'set -e; umask 077; conf=$(mktemp); ' +
        'trap \'rm -f "$conf" ' + DUCKDNS_TOKEN_PATH + '\' EXIT; ' +
        '[ -s ' + DUCKDNS_TOKEN_PATH + ' ] || { echo "no staged DuckDNS token" >&2; exit 1; }; ' +
        'printf \'url = "https://www.duckdns.org/update?domains=%s&token=%s&ip="\\n\' ' +
        '"$1" "$(cat ' + DUCKDNS_TOKEN_PATH + ')" > "$conf"; ' +
        'out=$(curl -fsS -K "$conf"); printf \'%s\\n\' "$out"; ' +
        '[ "$out" = OK ] || { echo "DuckDNS refused the update" >&2; exit 1; }';

    const CTRL_RE = /[\x00-\x1f\x7f]/;
    const RUN_ID_RE = /^[0-9]{8}T[0-9]{6}Z$/;
    const HOST_RE = /^[A-Za-z0-9._:\[\]-]{1,255}$/;
    const USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,31}$/;
    const FP_RE = /^SHA256:[A-Za-z0-9+/]{43}=?$/;

    function str(v) { return typeof v === 'string' ? v : ''; }
    function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
    function isPort(v) { return typeof v === 'number' && isFinite(v) && v === Math.floor(v) && v >= 1 && v <= 65535; }
    function port(v, name) {
        if (!isPort(v)) throw err('GENERIC', name + ' must be an integer port between 1 and 65535');
        return v;
    }

    // Every step is built here so the nine C1 keys are always present, even for
    // Steps spliced in verbatim from another module (they already carry all nine,
    // but routing every step through here keeps that invariant in one place).
    function step(s) {
        return { id: s.id, title: s.title, mutating: s.mutating === true, why: s.why,
            argv: s.argv || [], write: s.write || null, check: s.check || null,
            sha256: s.sha256 || null, secret: s.secret === true };
    }

    // ------------------------------------------------------------------ inputs

    function normalizeChoices(c) {
        if (!isObj(c)) throw err('GENERIC', 'choices must be an object');
        if (c.target !== 'local' && c.target !== 'ssh')
            throw err('GENERIC', 'choices.target must be "local" or "ssh"');
        if (typeof c.installHbbs !== 'boolean') throw err('GENERIC', 'choices.installHbbs must be a boolean');
        if (typeof c.openFirewall !== 'boolean') throw err('GENERIC', 'choices.openFirewall must be a boolean');
        if (Tls.TIERS.indexOf(c.tlsTier) === -1)
            throw err('GENERIC', 'choices.tlsTier must be one of ' + Tls.TIERS.join('|'));
        // domain/duckdns are handed to PilotTls.validate() verbatim below — this
        // module does not re-validate their shape, so there is exactly one
        // domain/DuckDNS validator in the codebase.
        const domain = (c.tlsTier === 'own') ? (typeof c.domain === 'string' ? c.domain : null) : null;
        const duckdns = (c.tlsTier === 'duckdns' && isObj(c.duckdns)) ? c.duckdns : null;
        // Additive beyond C13, optional: display host for an ssh plan.
        let host = null;
        if (c.host !== undefined && c.host !== null) {
            host = str(c.host);
            if (!HOST_RE.test(host)) throw err('GENERIC', 'choices.host is not a usable host');
        }
        return { target: c.target, installHbbs: c.installHbbs, tlsTier: c.tlsTier, domain: domain,
            duckdns: duckdns, apiPort: port(c.apiPort, 'choices.apiPort'),
            sshPort: port(c.sshPort, 'choices.sshPort'), openFirewall: c.openFirewall,
            host: c.target === 'ssh' ? host : null };
    }

    function cleanAbsDir(raw, fallback) {
        const dir = str(raw).trim() || fallback;
        if (dir.charAt(0) !== '/' || dir.indexOf('..') !== -1 || CTRL_RE.test(dir))
            throw err('GENERIC', 'detection path must be an absolute, traversal-free directory: ' + JSON.stringify(raw));
        return dir;
    }

    function normalizeDetection(d) {
        if (!isObj(d)) throw err('GENERIC', 'detection must be an object');

        // Arch + pinned assets come from ostarget.js alone — it owns the per-
        // component archive names and the SHA256 digests (spec §2.7).
        const serverAsset = OsTarget.serverAsset(d.arch);
        const apiAsset = OsTarget.apiAsset(d.arch);
        const arch = serverAsset.arch;
        const osRelease = isObj(d.os_release) ? d.os_release : {};
        const family = OsTarget.family(osRelease);

        const fwRaw = str(d.firewall);
        const fw = ['firewalld', 'ufw', 'nftables'].indexOf(fwRaw) === -1 ? 'none' : fwRaw;

        let hbbs = null;
        if (isObj(d.hbbs)) {
            // An empty data_dir behaves exactly like a missing one — never '//'.
            const dir = cleanAbsDir(d.hbbs.data_dir, HBBS_DATA);
            // Pinned enum (task-13 --detect contract): install is 'deb'|'binary',
            // anything else — including a corrupted/hostile detection line — is
            // 'unknown', exactly like the detect script's own normalization.
            const hbbsInstall = ['deb', 'binary'].indexOf(d.hbbs.install) === -1 ? 'unknown' : d.hbbs.install;
            hbbs = { version: str(d.hbbs.version) || 'unknown', install: hbbsInstall,
                ports: Array.isArray(d.hbbs.ports) ? d.hbbs.ports.filter(isPort) : [],
                pubkey: str(d.hbbs.pubkey), dataDir: dir };
        }
        // Pinned shape (task-13 --detect contract, task-13-brief.md:95/205):
        // detection.api is exactly { version, port, install } — there is no
        // `dir`. install is 'binary' or 'unknown' (never 'deb': the API server
        // is never package-installed); port falls back to the same default the
        // detect script itself uses when its own probe cannot read one.
        let api = null;
        if (isObj(d.api)) {
            const apiInstall = d.api.install === 'binary' ? 'binary' : 'unknown';
            api = { version: str(d.api.version) || 'unknown', install: apiInstall,
                port: isPort(d.api.port) ? d.api.port : Ports.API_DEFAULT };
        }

        // The public IP is used both as a DNS pre-flight input (tls.js validates
        // it for the sslip tier) and as the plain-http fallback address — reuse
        // tls.js's own IPv4 check rather than a second regex for the same shape.
        const publicIp = Tls.isBareIpv4(d.public_ip) ? str(d.public_ip) : null;

        return { osRelease: osRelease, family: family, arch: arch,
            serverAsset: serverAsset, apiAsset: apiAsset,
            init: str(d.init) === 'systemd' ? 'systemd' : 'other', firewall: fw,
            egress: d.egress === true,
            diskFreeMb: (typeof d.disk_free_mb === 'number' && isFinite(d.disk_free_mb)) ? d.disk_free_mb : 0,
            hbbs: hbbs, api: api, publicIp: publicIp };
    }

    // ------------------------------------------------------ generated files

    // THE hostname every client-facing name is built from -- the API's
    // id-server/relay-server, and the relay hbbs advertises. With TLS on it must
    // be the certificate's name, because a signed-in client builds
    // wss://<id-server>/ws/id from it and anything else fails the handshake.
    // One definition: this used to be computed twice with different answers,
    // which is the bug that broke every signed-in client.
    function rendezvousHostFor(ch, det, domain) {
        return domain || (ch.host || det.publicIp || '127.0.0.1');
    }

    function configYaml(ch, det, domain) {
        const addr = ch.host || det.publicIp || '127.0.0.1';
        // ONE hostname for every name the client is handed. This used to be two:
        // api-server took the TLS `domain` while id-server/relay-server took the
        // SSH `addr`, and on a real deployment those were
        // 203.0.113.10.sslip.io and ec2-203-0-113-10....amazonaws.com.
        //
        // That divergence breaks every SIGNED-IN client, because a RustDesk
        // client >= 1.4.1 does its rendezvous over WebSocket and builds the URL
        // as wss://<id-server>/ws/id -- from the id-server THE API ADVERTISES,
        // not from the client's own setting. The certificate only covers the TLS
        // domain, so the handshake dies with `tlsv1 alert internal error`, which
        // the client reports as "Failed to secure tcp: deadline has elapsed" --
        // an error naming neither TLS nor the hostname that caused it.
        //
        // When TLS is on, the certificate's name is the only name that works, so
        // it is the name everything uses. With TLS off there is no certificate
        // and no wss://, so the plain address is correct and unchanged.
        const rendezvousHost = rendezvousHostFor(ch, det, domain);
        // apiServerUrl() is the ONE place that decides https:// vs http://: the
        // client picks wss:// only when this string starts with https, otherwise
        // it silently downgrades to plaintext ws://.
        const api = Tls.apiServerUrl({ tlsHost: domain || '', apiPort: ch.apiPort, plainHost: addr });
        const key = det.hbbs && det.hbbs.pubkey
            ? '  key: "' + det.hbbs.pubkey + '"'
            : '  key-file: ' + (det.hbbs ? det.hbbs.dataDir : HBBS_DATA) + '/id_ed25519.pub';
        // This file REPLACES the one the release ships, so every key the
        // application needs has to be here. It used to carry five, and the
        // missing ones did not fall back to the shipped defaults -- they fell
        // back to Go's ZERO VALUES, which broke the server two different ways on
        // a real install:
        //
        //   gin.resources-path   omitted -> "" -> InitI18n opens "/i18n" ->
        //                        panic at startup, restart counter 403.
        //   app.captcha-threshold omitted -> 0, and the shipped config documents
        //                        0 as "always" -> EVERY admin login answered
        //                        "Captcha error", correct password or not, so
        //                        the handover password change could never work.
        //
        // Both were invisible while a stock config happened to be underneath.
        // The values below are the release's own defaults; the ones Pilot
        // manages are substituted. A key omitted here is a key set to zero.
        return '# Generated by Pilot - do not edit by hand.\n' +
            '# Carries the release defaults: an omitted key is NOT inherited from\n' +
            "# the shipped config -- it takes Go's zero value, which has broken\n" +
            '# startup (resources-path) and login (captcha-threshold) before.\n' +
            'lang: "en"\n' +
            'app:\n' +
            '  web-client: 1\n' +
            '  register: false\n' +
            '  register-status: 1\n' +
            '  captcha-threshold: 3\n' +
            '  ban-threshold: 0\n' +
            '  show-swagger: 1\n' +
            '  token-expire: 168h\n' +
            '  web-sso: true\n' +
            '  disable-pwd-login: false\n' +
            'admin:\n' +
            '  title: "RustDesk API Admin"\n' +
            '  hello-file: "./conf/admin/hello.html"\n' +
            '  id-server-port: ' + ID_PORT + '\n' +
            '  relay-server-port: ' + RELAY_PORT + '\n' +
            'gin:\n' +
            '  api-addr: 0.0.0.0:' + ch.apiPort + '\n' +
            '  mode: "release"\n' +
            "  resources-path: 'resources'\n" +
            '  trust-proxy: ""\n' +
            'gorm:\n' +
            '  type: "sqlite"\n' +
            '  max-idle-conns: 10\n' +
            '  max-open-conns: 100\n' +
            'logger:\n' +
            '  path: "./runtime/log.txt"\n' +
            '  level: "info"\n' +
            '  report-caller: true\n' +
            'jwt:\n' +
            '  key: ""\n' +
            '  expire-duration: 168h\n' +
            'proxy:\n' +
            '  enable: false\n' +
            'rustdesk:\n' +
            '  id-server: ' + rendezvousHost + ':' + ID_PORT + '\n' +
            '  relay-server: ' + rendezvousHost + ':' + RELAY_PORT + '\n' +
            '  api-server: ' + api + '\n' +
            '  personal: 1\n' +
            // Present in the release config, absent from Pilot's until now, so it
            // took Go's zero value like every other omitted key. It is what the
            // web client is told to dial; with TLS off there is no wss:// to
            // offer, and "" is then both the release default and correct.
            '  ws-host: "' + (domain ? 'wss://' + domain : '') + '"\n' +
            key + '\n';
    }

    function apiUnit() {
        // WorkingDirectory is mandatory: the SQLite path, hello-file, resources-path
        // and logger.path are all resolved relative to the working directory.
        return '[Unit]\n' +
            'Description=RustDesk API server (managed by Pilot)\n' +
            'After=network-online.target\n' +
            'Wants=network-online.target\n' +
            '\n' +
            '[Service]\n' +
            'Type=simple\n' +
            'User=' + API_USER + '\n' +
            'Group=' + API_USER + '\n' +
            'WorkingDirectory=' + API_DIR + '\n' +
            'ExecStart=' + API_DIR + '/apimain\n' +
            'Restart=on-failure\n' +
            'RestartSec=5\n' +
            'NoNewPrivileges=true\n' +
            'ProtectHome=true\n' +
            '\n' +
            '[Install]\n' +
            'WantedBy=multi-user.target\n';
    }

    // args are appended to ExecStart. Both daemons need them, and a unit written
    // without them produces a server that looks healthy and cannot do its job:
    //
    //   -k _   makes hbbs/hbbr ENFORCE the keypair in their working directory.
    //          Without it the server does not participate in key-based
    //          encryption at all, while clients that have a key still try to --
    //          and the client reports "Failed to secure tcp: deadline has
    //          elapsed", naming neither the key nor the server. Verified safe on
    //          a FIRST start: with no keypair present, `hbbs -k _` generates one
    //          and starts normally, which is exactly what a fresh provision does.
    //
    //   -r     is the relay hbbs hands to clients that cannot punch directly.
    //          Without it there is no fallback: the punch fails and the client
    //          waits out its deadline. Sessions on the reference deployment go
    //          through this relay, so it is load-bearing, not belt-and-braces.
    function hbbUnit(name, bin, dataDir, args) {
        const extra = (Array.isArray(args) && args.length) ? ' ' + args.join(' ') : '';
        return '[Unit]\n' +
            'Description=RustDesk ' + name + ' (managed by Pilot)\n' +
            'After=network-online.target\n' +
            'Wants=network-online.target\n' +
            '\n' +
            '[Service]\n' +
            'Type=simple\n' +
            'WorkingDirectory=' + dataDir + '\n' +
            'ExecStart=' + BIN_DIR + '/' + bin + extra + '\n' +
            'Restart=on-failure\n' +
            'RestartSec=5\n' +
            '\n' +
            '[Install]\n' +
            'WantedBy=multi-user.target\n';
    }

    // Package manager per detected family (from ostarget.js's family()). Table-
    // driven: an unrecognised family degrades to a step that fails loudly rather
    // than guessing a package manager that is not there.
    function pkgInstallArgv(family, pkg) {
        if (family === 'fedora') return ['dnf', '-y', 'install', pkg];
        if (family === 'debian') return ['apt-get', '-y', 'install', pkg];
        if (family === 'suse') return ['zypper', '-n', 'install', pkg];
        if (family === 'arch') return ['pacman', '-S', '--noconfirm', pkg];
        return ['sh', '-c', 'echo "no known package manager for this OS" >&2; exit 1'];
    }

    // ---------------------------------------------------------------- build

    function build(detection, choices) {
        const ch = normalizeChoices(choices);
        const det = normalizeDetection(detection);
        const warnings = [];
        const steps = [];

        if (!det.egress)
            warnings.push('NO_EGRESS: the target reported no outbound internet access, so the download steps will fail. Use manual mode or give the target egress.');
        if (det.init !== 'systemd')
            warnings.push('NO_SYSTEMD: the target does not run systemd, so the service steps cannot be executed automatically. Use manual mode.');
        if (det.diskFreeMb < 512)
            warnings.push('Only ' + det.diskFreeMb + ' MB of disk is free; the download and unpack steps need roughly 512 MB.');
        if (ch.installHbbs && det.hbbs)
            warnings.push('hbbs is already present, so it is adopted and left untouched; the install was skipped.');
        if (det.api)
            warnings.push('The RustDesk API server is already present, so it is adopted and left untouched; the install was skipped.');
        if (ch.tlsTier === 'none')
            warnings.push('TLS is off: the web client stays disabled and rustdesk.api-server is plain http, which keeps clients on ws://.');

        // RULE 2: TLS is gated on validate().ok, never on hostFor() emptiness —
        // hostFor() returns '' for both tier:'none' and a selected-but-invalid
        // tier, so the two cannot be told apart that way.
        let domain = null;
        if (ch.tlsTier !== 'none') {
            const v = Tls.validate(ch, { public_ip: det.publicIp });
            if (!v.ok) {
                // sslip's failure mode is always "no confirmed public IP to
                // build/certify the hostname from", which is a DNS-shaped
                // problem; own-domain and DuckDNS failures are input errors.
                const kind = ch.tlsTier === 'sslip' ? 'TLS_DNS_MISMATCH' : 'GENERIC';
                throw err(kind, v.message, { tier: ch.tlsTier });
            }
            domain = v.host;
            if (ch.tlsTier === 'sslip') warnings.push(Tls.advisory('sslip'));
        }

        const doInstallHbbs = !det.hbbs;
        if (doInstallHbbs && !ch.installHbbs)
            throw err('HBBS_NOT_FOUND', 'no RustDesk server was detected on the target and choices.installHbbs is false');
        const dataDir = det.hbbs ? det.hbbs.dataDir : HBBS_DATA;

        steps.push(step({ id: 'cache-dir', title: 'Create the Pilot download cache', mutating: true,
            why: 'Downloads are verified in a fixed directory so a re-run reuses them instead of refetching.',
            argv: ['install', '-d', '-m', '0755', CACHE] }));

        // ---- hbbs/hbbr: adopt vs install, decided by detection alone --------
        if (doInstallHbbs) {
            const zip = CACHE + '/' + det.serverAsset.name;
            // The origin is named in the title, not just the version. This is a
            // FORK of rustdesk-server (see js/core/ostarget.js for why), and an
            // operator approving a plan that installs software on their machine
            // is entitled to see where it comes from without reading the URL.
            steps.push(step({ id: 'install-hbbs-fetch',
                title: 'Download the RustDesk server ' + OsTarget.SERVER_VERSION + ' (' + det.arch + ')' +
                    (OsTarget.SERVER_IS_FORK ? ' from ' + OsTarget.SERVER_UPSTREAM : ''),
                mutating: true,
                why: OsTarget.SERVER_IS_FORK
                    ? 'The pinned release is fetched and checked against a recorded SHA256 before anything is unpacked. ' +
                      'This is a fork of rustdesk-server: the official build cannot serve a signed-in RustDesk client 1.4.1 or newer, ' +
                      'which is what the address book requires. Pilot moves back to the official repo once that is fixed upstream.'
                    : 'The pinned release is fetched and checked against a recorded SHA256 before anything is unpacked.',
                argv: ['curl', '-fsSL', det.serverAsset.url, '-o', zip], sha256: det.serverAsset.sha256 }));
            steps.push(step({ id: 'install-hbbs-unpack', title: 'Unpack hbbs, hbbr and rustdesk-utils into ' + BIN_DIR,
                mutating: true, why: 'The zip nests the binaries under an arch directory, so they are flattened into one bin directory.',
                argv: ['unzip', '-o', '-j', zip, '-d', BIN_DIR] }));
            steps.push(step({ id: 'install-hbbs-data', title: 'Create ' + dataDir, mutating: true,
                why: 'hbbs keeps its database and its generated keypair in its working directory.',
                argv: ['install', '-d', '-m', '0750', dataDir] }));
            steps.push(step({ id: 'install-hbbs-unit', title: 'Write ' + UNIT_DIR + '/rustdesk-hbbs.service',
                mutating: true, why: 'No rpm exists upstream, so a Pilot-generated unit is the portable path.',
                write: { path: UNIT_DIR + '/rustdesk-hbbs.service', mode: '0644', owner: 'root:root',
                    content: hbbUnit('ID/rendezvous server', 'hbbs', dataDir,
                        ['-k', '_', '-r', rendezvousHostFor(ch, det, domain) + ':' + RELAY_PORT]) } }));
            steps.push(step({ id: 'install-hbbr-unit', title: 'Write ' + UNIT_DIR + '/rustdesk-hbbr.service',
                mutating: true, why: 'The relay is a separate process and therefore a separate unit.',
                write: { path: UNIT_DIR + '/rustdesk-hbbr.service', mode: '0644', owner: 'root:root',
                    content: hbbUnit('relay server', 'hbbr', dataDir, ['-k', '_']) } }));
            steps.push(step({ id: 'install-hbbs-reload', title: 'Reload the systemd unit files', mutating: true,
                why: 'systemd will not see a newly written unit until it is told to reload.',
                argv: ['systemctl', 'daemon-reload'] }));
            steps.push(step({ id: 'install-hbbs-enable', title: 'Enable and start hbbs and hbbr', mutating: true,
                why: 'enable --now starts the services and survives a reboot; it does not restart a running service.',
                argv: ['systemctl', 'enable', '--now', 'rustdesk-hbbs.service', 'rustdesk-hbbr.service'] }));
            steps.push(step({ id: 'hbbs-key', title: 'Read the public key hbbs generated on first start', mutating: false,
                why: 'hbbs writes id_ed25519.pub itself on first start; the API server and every client need that key.',
                argv: ['sh', '-c',
                    'i=0; while [ $i -lt 30 ]; do if [ -s "$1" ]; then cat "$1"; exit 0; fi; i=$((i+1)); sleep 1; done; exit 1',
                    'sh', dataDir + '/id_ed25519.pub'] }));
        } else {
            steps.push(step({ id: 'adopt-hbbs', title: 'Adopt the existing RustDesk server', mutating: false,
                why: 'hbbs is already installed; Pilot records its public key and ports and never reinstalls or restarts it.',
                argv: ['cat', dataDir + '/id_ed25519.pub'] }));
        }

        // ---- API server: adopt vs install, decided by detection alone -------
        const doInstallApi = !det.api;
        // Precedence: when ADOPTING, the port that matters is the one the
        // already-running server actually listens on (det.api.port) — never the
        // wizard's choices.apiPort, which is only a fresh-install choice and may
        // not match what is really there. Everything downstream that talks to
        // the live API server (the firewall rule, the Caddyfile upstream, the
        // health check) must use this effective port, not ch.apiPort directly.
        const apiPort = det.api ? det.api.port : ch.apiPort;
        if (doInstallApi) {
            const tgz = CACHE + '/' + det.apiAsset.name;
            steps.push(step({ id: 'fetch-api', title: 'Download the API server ' + OsTarget.API_VERSION + ' (' + det.arch + ')',
                mutating: true, why: 'The pinned release is fetched and checked against a recorded SHA256 before anything is unpacked.',
                argv: ['curl', '-fsSL', det.apiAsset.url, '-o', tgz], sha256: det.apiAsset.sha256 }));
            steps.push(step({ id: 'install-dir', title: 'Create ' + API_DIR, mutating: true,
                why: 'The API server runs from a fixed directory because its SQLite path is relative to the working directory.',
                argv: ['install', '-d', '-m', '0755', API_DIR] }));
            steps.push(step({ id: 'install-user', title: 'Create the ' + API_USER + ' system user', mutating: true,
                why: 'The API server must not run as root.',
                argv: ['useradd', '--system', '--home-dir', API_DIR, '--shell', '/usr/sbin/nologin', API_USER],
                check: { argv: ['id', '-u', API_USER], expect: 'zero' } }));
            // VERIFIED against the real v2.7 assets, both arm64 and amd64: every
            // member is named "./release/<x>", so there are TWO leading components
            // to strip, not one. Stripping one left everything under
            // <API_DIR>/release/, so ExecStart=<API_DIR>/apimain pointed at
            // nothing and the unit crash-looped with status=203/EXEC.
            steps.push(step({ id: 'install', title: 'Unpack the API server into ' + API_DIR, mutating: true,
                why: 'Every entry in the tarball is named ./release/<x>, so the two leading path components are stripped.',
                argv: ['tar', 'xzf', tgz, '-C', API_DIR, '--strip-components=2'] }));
            // A step of its own, NOT a `check`: `check` is a pre-condition
            // idempotency guard -- satisfied means SKIP -- so it can never verify
            // what a step produced. Without this the wrong strip depth surfaced
            // ten steps later as `verify` refusing to connect to 21114, with
            // nothing on screen naming the cause. Now the step that got it wrong
            // is the step that fails.
            steps.push(step({ id: 'install-verify', title: 'Confirm the API binary landed where the unit expects',
                mutating: false,
                why: 'The unit execs ' + API_DIR + '/apimain; if the archive layout ever changes, this is where it is caught.',
                argv: ['test', '-x', API_DIR + '/apimain'] }));
            steps.push(step({ id: 'install-data', title: 'Create ' + API_DIR + '/data', mutating: true,
                why: 'The SQLite database is created at ./data/rustdeskapi.db relative to the working directory.',
                argv: ['install', '-d', '-m', '0750', API_DIR + '/data'] }));
            steps.push(step({ id: 'install-own', title: 'Give ' + API_USER + ' ownership of ' + API_DIR, mutating: true,
                why: 'The service writes its database, logs and runtime files under its own working directory.',
                argv: ['chown', '-R', API_USER + ':' + API_USER, API_DIR] }));
            steps.push(step({ id: 'configure-dir', title: 'Create ' + API_DIR + '/conf', mutating: true,
                why: 'config.yaml is read from conf/ relative to the working directory.',
                argv: ['install', '-d', '-m', '0755', API_DIR + '/conf'] }));
            steps.push(step({ id: 'configure', title: 'Write ' + API_DIR + '/conf/config.yaml', mutating: true,
                why: 'This is where the hbbs id/relay servers, the server key and the API address are wired together.',
                write: { path: API_DIR + '/conf/config.yaml', mode: '0640', owner: API_USER + ':' + API_USER,
                    content: configYaml(ch, det, domain) } }));
            steps.push(step({ id: 'unit', title: 'Write ' + UNIT_DIR + '/rustdesk-api.service', mutating: true,
                why: 'The unit pins WorkingDirectory=' + API_DIR + ', without which the database and log paths resolve to the wrong place.',
                write: { path: UNIT_DIR + '/rustdesk-api.service', mode: '0644', owner: 'root:root', content: apiUnit() } }));
            steps.push(step({ id: 'unit-reload', title: 'Reload the systemd unit files', mutating: true,
                why: 'systemd will not see a newly written unit until it is told to reload.',
                argv: ['systemctl', 'daemon-reload'] }));
            // Same trap as Caddy's, and the old `why` even stated it as a
            // feature: "it does not restart an already-running service". That is
            // precisely the problem -- the unit and config.yaml were rewritten
            // two steps ago, and a service that keeps running keeps using the
            // old ones. Enable for the reboot, restart to apply what was just
            // written.
            steps.push(step({ id: 'unit-enable', title: 'Enable rustdesk-api at boot', mutating: true,
                why: 'Survives a reboot. This does NOT apply the unit and config just written.',
                argv: ['systemctl', 'enable', 'rustdesk-api.service'] }));
            steps.push(step({ id: 'unit-restart', title: 'Start rustdesk-api on the new configuration', mutating: true,
                why: 'The unit and config.yaml were just rewritten; only a restart makes them take effect.',
                argv: ['systemctl', 'restart', 'rustdesk-api.service'] }));
            // `systemctl enable --now` exits 0 for a unit that started and then
            // died: with Restart=on-failure it sits in "activating
            // (auto-restart)", which systemd reports as a successful start. That
            // is how a service crash-looping on a missing binary was recorded as
            // "ok exit=0". Type=simple means a healthy unit is active the moment
            // start returns, so asking immediately is fair.
            steps.push(step({ id: 'unit-active', title: 'Confirm rustdesk-api is actually running',
                mutating: false,
                why: 'enable --now reports success for a service that started and immediately died.',
                argv: ['systemctl', 'is-active', '--quiet', 'rustdesk-api.service'] }));
        } else {
            // detection.api.install is 'binary' (found at the same /opt/rustdesk-api
            // layout Pilot itself installs to — the detect script's only positive
            // signal) or 'unknown' (present, but not established as a Pilot-shaped
            // binary install — e.g. a corrupted detection line). Only the 'binary'
            // case is a fair bet that a rustdesk-api.service systemd unit exists;
            // for 'unknown' we check the running process directly instead of
            // assuming a unit name for software Pilot never named.
            steps.push(step({ id: 'adopt-api', title: 'Adopt the existing RustDesk API server', mutating: false,
                why: 'The API server is already installed; Pilot leaves its binary, config and database untouched.',
                argv: det.api.install === 'binary'
                    ? ['systemctl', 'is-active', 'rustdesk-api.service']
                    : ['pgrep', '-f', 'apimain'] }));
        }

        // ---- host firewall: splice PilotFirewall's Steps verbatim (RULE 1) --
        if (ch.openFirewall) {
            // Ports.required() must open the EFFECTIVE api port (see apiPort
            // above), not blindly ch.apiPort — adopting a server on a different
            // port than the wizard default must not open the wrong one.
            const reqs = Ports.required(Object.assign({}, ch, { apiPort: apiPort }));
            if (det.firewall === 'none') {
                warnings.push('FIREWALL_UNSUPPORTED: ' + Firewall.warnings('none', reqs)[0]);
            } else {
                const fwSteps = Firewall.steps(det.firewall, reqs);
                for (let i = 0; i < fwSteps.length; i++) steps.push(step(fwSteps[i]));
                const w = Firewall.warnings(det.firewall, reqs);
                if (w.length) warnings.push(w[0]);
            }
        } else {
            warnings.push('choices.openFirewall is off: Pilot applies no host firewall rules; open the required ports yourself.');
        }

        steps.push(step({ id: 'reachability', title: 'List the ports the target is actually listening on', mutating: false,
            why: 'The plan records what the target believes; the wizard then probes the same ports from the Cockpit host, which is what catches a cloud firewall.',
            argv: ['ss', '-ltun'] }));

        // ---- TLS: splice PilotTls's Caddyfile verbatim (RULE 1) -------------
        if (domain) {
            steps.push(step({ id: 'tls-caddy', title: 'Install Caddy', mutating: true,
                why: 'Caddy terminates TLS on 443 and obtains the certificate itself.',
                argv: pkgInstallArgv(det.family, 'caddy'),
                check: { argv: ['sh', '-c', 'command -v caddy >/dev/null'], expect: 'zero' } }));
            if (ch.tlsTier === 'duckdns') {
                steps.push(step({ id: 'tls-duckdns-token',
                    title: 'Stage the DuckDNS token in a root-only file', mutating: true, secret: true,
                    why: 'The token is a credential, so it travels in a 0600 root:root file that the next step ' +
                        'reads and deletes — never in an argv, where /proc/<pid>/cmdline would expose it to ' +
                        'every local user.',
                    write: { path: DUCKDNS_TOKEN_PATH, mode: '0600', owner: 'root:root',
                        content: str(ch.duckdns.token) + '\n' } }));
                steps.push(step({ id: 'tls-duckdns', title: 'Point the DuckDNS record at this server', mutating: true,
                    why: 'ACME only succeeds once the name resolves here, so the record is updated before issuance. ' +
                        'curl reads the URL (and therefore the token) from a config file, and the staged token ' +
                        'file is removed on every exit path.',
                    argv: ['sh', '-c', DUCKDNS_SCRIPT, 'sh', str(ch.duckdns.subdomain)] }));
            }
            steps.push(step({ id: 'tls-caddyfile', title: 'Write ' + Tls.CADDYFILE_PATH, mutating: true,
                why: 'One site block proxies the API and both websocket paths, so the web client reaches everything over 443.',
                write: { path: Tls.CADDYFILE_PATH, mode: Tls.CADDYFILE_MODE, owner: Tls.CADDYFILE_OWNER,
                    content: Tls.caddyfile({ tier: ch.tlsTier, host: domain, apiPort: apiPort }) } }));
            // The comment here used to claim "enable --now applies the new
            // Caddyfile whether or not Caddy was already running". It does not,
            // and the field proved it: Caddy had been up since 10:11, Pilot
            // wrote a new Caddyfile at 17:53, `enable --now` exited 0, and Caddy
            // carried on serving the OLD config -- HTTP only, no certificate,
            // 443 never bound. `--now` starts a stopped unit; it does nothing at
            // all to a running one. Enabling (for reboot) and applying the new
            // configuration are two different jobs and need two commands.
            steps.push(step({ id: 'tls-enable', title: 'Enable Caddy at boot', mutating: true,
                why: 'Survives a reboot. This does NOT apply the new Caddyfile -- the next step does that.',
                argv: ['systemctl', 'enable', 'caddy.service'] }));
            steps.push(step({ id: 'tls-reload', title: 'Load the new Caddyfile', mutating: true,
                why: 'reload-or-restart is what actually applies the file just written: it reloads a ' +
                    'running Caddy (no dropped connections) and starts a stopped one.',
                argv: ['systemctl', 'reload-or-restart', 'caddy.service'] }));
            // Caddy binds 443 only once it has a certificate, so this is the
            // one check that proves TLS is genuinely working rather than
            // configured. Without it the run reported success while the site
            // was HTTP-only and every console request over TLS failed.
            steps.push(step({ id: 'tls-verify', title: 'Confirm Caddy is serving HTTPS', mutating: false,
                why: 'Caddy listens on 443 only after it obtains a certificate; anything less is not TLS.',
                argv: ['sh', '-c',
                    'for i in $(seq 1 30); do ss -ltn | grep -q ":443" && exit 0; sleep 2; done; ' +
                    'echo "caddy never bound 443: no certificate was obtained" >&2; exit 1'] }));
        }

        steps.push(step({ id: 'verify', title: 'Wait for the API server to answer', mutating: false,
            why: 'The Swagger document is served only because Pilot writes show-swagger: 1, so this proves both the service and the generated config. ' +
                'Probes the port the server is actually on: the already-running port when adopted, the chosen port when freshly installed.',
            // -o /dev/null and -w: this is a HEALTH CHECK -- all it needs is
            // "did the server answer 200". Without them curl printed the whole
            // document: 221 KB and ~6000 lines of swagger JSON, which Pilot then
            // truncated at 2000 lines, drowning every other step in the
            // transcript the user has to read (and paste into bug reports).
            argv: ['curl', '-fsS', '--retry', '10', '--retry-delay', '2', '--retry-connrefused', '--max-time', '60',
                // No trailing newline in the format: libexec/pilot-exec refuses
                // any argv element containing a control character, so a literal
                // \n here would have been rejected at envelope validation and
                // taken the whole run with it.
                '-o', '/dev/null', '-w', 'api answered HTTP %{http_code} in %{time_total}s',
                'http://127.0.0.1:' + apiPort + '/admin/swagger/doc.json'] }));
        steps.push(step({ id: 'verify-admin', title: 'Capture the generated admin password', mutating: false, secret: true,
            why: 'The API server prints its generated admin password once, into the journal.',
            argv: ['journalctl', '-u', 'rustdesk-api.service', '--no-pager', '-n', '200'] }));

        return { target: ch.target, host: ch.host, arch: det.arch, warnings: warnings, steps: steps };
    }

    // ----------------------------------------------------------- envelope

    function assertPlan(plan, fn) {
        if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !Array.isArray(plan.steps))
            throw err('GENERIC', fn + '() needs a plan produced by build()');
    }

    function stepIds(plan) {
        assertPlan(plan, 'stepIds');
        return plan.steps.map((s) => s.id);
    }

    function toEnvelope(plan, ctx) {
        assertPlan(plan, 'toEnvelope');
        if (plan.target !== 'local' && plan.target !== 'ssh')
            throw err('GENERIC', 'plan.target must be "local" or "ssh"');
        if (!isObj(ctx)) throw err('GENERIC', 'toEnvelope() needs a ctx object');
        const runId = str(ctx.run_id);
        if (!RUN_ID_RE.test(runId)) throw err('GENERIC', 'ctx.run_id must look like 20260803T204500Z');

        let ssh = null;
        if (plan.target === 'ssh') {
            if (!isObj(ctx.ssh)) throw err('GENERIC', 'ctx.ssh is required when plan.target is "ssh"');
            const host = str(ctx.ssh.host);
            if (!HOST_RE.test(host)) throw err('GENERIC', 'ctx.ssh.host is not a usable host');
            if (plan.host !== null && plan.host !== undefined && plan.host !== host)
                throw err('GENERIC', 'ctx.ssh.host does not match the host the plan was built for');
            const user = str(ctx.ssh.user);
            if (!USER_RE.test(user)) throw err('GENERIC', 'ctx.ssh.user is not a usable user name');
            const auth = str(ctx.ssh.auth);
            if (['password', 'pem', 'agent'].indexOf(auth) === -1)
                throw err('GENERIC', 'ctx.ssh.auth must be password|pem|agent');
            let fp = null;
            if (ctx.ssh.accept_fingerprint !== undefined && ctx.ssh.accept_fingerprint !== null) {
                fp = str(ctx.ssh.accept_fingerprint);
                if (!FP_RE.test(fp))
                    throw err('SSH_HOSTKEY_UNKNOWN', 'ctx.ssh.accept_fingerprint is not an ssh-keygen SHA256 fingerprint');
            }
            ssh = { host: host, port: port(ctx.ssh.port, 'ctx.ssh.port'), user: user, auth: auth, accept_fingerprint: fp };
        } else if (ctx.ssh !== undefined && ctx.ssh !== null) {
            throw err('GENERIC', 'ctx.ssh must be null for a local plan');
        }

        let credentials = null;
        if (ctx.credentials !== undefined && ctx.credentials !== null) {
            if (!isObj(ctx.credentials)) throw err('GENERIC', 'ctx.credentials must be an object or null');
            const c = ctx.credentials;
            if (c.password !== undefined && c.password !== null && typeof c.password !== 'string')
                throw err('GENERIC', 'ctx.credentials.password must be a string or null');
            if (c.pem !== undefined && c.pem !== null && typeof c.pem !== 'string')
                throw err('GENERIC', 'ctx.credentials.pem must be a string or null');
            credentials = { password: (c.password === undefined || c.password === null) ? null : c.password,
                pem: (c.pem === undefined || c.pem === null) ? null : c.pem };
        }

        // Deep copy: the envelope travels on stdin and must never alias the plan the
        // UI is still rendering.
        return { version: 1, transport: plan.target, run_id: runId, ssh: ssh, credentials: credentials,
            steps: JSON.parse(JSON.stringify(plan.steps)) };
    }

    // ------------------------------------------------------- manual mode

    // Manual mode is the SAME plan, rendered. Anything not in this safe set is
    // single-quoted, so plan data can never become shell syntax.
    const SAFE_RE = /^[A-Za-z0-9_@%+=:,.\/-]+$/;
    function sq(s) { return "'" + String(s).split("'").join("'\\''") + "'"; }
    function q(s) { return SAFE_RE.test(String(s)) ? String(s) : sq(s); }
    function argvLine(argv) { return argv.map(q).join(' '); }
    function dirOf(p) {
        const i = String(p).lastIndexOf('/');
        return i <= 0 ? '/' : String(p).slice(0, i);
    }
    function destOf(argv) {
        const i = argv.indexOf('-o');
        return (i === -1 || i + 1 >= argv.length) ? '' : argv[i + 1];
    }

    // Whether a step's argv carries a credential is, in general, UNDECIDABLE:
    // a heuristic that infers "safe" from the absence of a recognized pattern
    // fails OPEN — flag-space-value (--token X), curl -u basic auth, non-
    // Authorization headers (X-Api-Key, Cookie), JSON bodies, positional
    // args and env-var assignments are all ordinary ways to pass a credential,
    // and none of them look like the others. Guessing at that shape is a
    // losing game, so this renderer does not try.
    //
    // What IS decidable is that one SPECIFIC, Pilot-authored command is safe:
    // verify-admin's argv is always exactly this fixed journalctl invocation,
    // with no runtime-supplied value in it at all. That is checked by exact
    // match, not by inference, and is the only entry in ARGV_SAFE_STEPS.
    // Enrolling a step here is a deliberate, reviewable decision — it is the
    // opt-in allow-path, never the default.
    function isVerifyAdminArgv(argv) {
        const expected = ['journalctl', '-u', 'rustdesk-api.service', '--no-pager', '-n', '200'];
        if (!Array.isArray(argv) || argv.length !== expected.length) return false;
        for (let i = 0; i < expected.length; i++) if (argv[i] !== expected[i]) return false;
        return true;
    }
    const ARGV_SAFE_STEPS = { 'verify-admin': isVerifyAdminArgv };

    // For secret steps, render variable assignments before the command.
    // Returns { preLines, commandLine, mustRunManually, outputSensitive }:
    //   - preLines: setup lines (env checks, variable assignments)
    //   - commandLine: full rendered command (or null to use normal argv rendering)
    //   - mustRunManually: true if this secret step's argv is not on the
    //     explicit allow-path and has no safe rewrite — the FAIL-CLOSED default
    //   - outputSensitive: true only for a step that matched its exact,
    //     enrolled allow-path entry — never set from an inference
    function renderSecretStep(step) {
        const preLines = [];
        if (!step.secret) return { preLines: [], commandLine: null, mustRunManually: false, outputSensitive: false };

        // Explicit, opt-in allow-path: render only if this step's id is
        // enrolled AND its argv matches that enrollment's exact expected
        // shape. This is the ONLY way a secret:true step's command is
        // rendered instead of suppressed — never inferred from what the
        // argv appears not to contain.
        const validator = ARGV_SAFE_STEPS[step.id];
        if (validator && validator(step.argv)) {
            return { preLines: [], commandLine: null, mustRunManually: false, outputSensitive: true };
        }

        // Fail closed: not on the explicit allow-path above, so refuse to render
        // it in cleartext.
        return { preLines: [], commandLine: null, mustRunManually: true, outputSensitive: false };
    }

    // The write-step counterpart of ARGV_SAFE_STEPS, and the same shape of
    // decision: a secret write step's CONTENT is a credential, so the heredoc
    // the ordinary write path emits would print it in cleartext into an artifact
    // whose whole purpose is to be pasted somewhere. Enrolment is per id and
    // explicit; an unenrolled secret write step is suppressed, never guessed at.
    //
    // Each entry renders the file from an environment variable the operator sets
    // themselves, so the script is safe to share and still does the real thing
    // when run. `: "${VAR:?message}"` exits non-zero naming the variable when it
    // is unset, so an unset token can never silently write an empty file.
    const WRITE_SAFE_STEPS = {
        'tls-duckdns-token': {
            envVar: 'DUCKDNS_TOKEN',
            hint: 'set DUCKDNS_TOKEN to your DuckDNS account token before running this script'
        }
    };

    function renderSecretWrite(step) {
        const spec = (step && step.write && Object.prototype.hasOwnProperty.call(WRITE_SAFE_STEPS, step.id))
            ? WRITE_SAFE_STEPS[step.id] : null;
        if (!spec) return null;
        const path = step.write.path;
        return [
            ': "${' + spec.envVar + ':?' + spec.hint + '}"',
            'install -d -m 0755 ' + q(dirOf(path)),
            'umask 077',
            'printf \'%s\\n\' "$' + spec.envVar + '" > ' + q(path),
            'chmod ' + q(step.write.mode) + ' ' + q(path),
            'chown ' + q(step.write.owner) + ' ' + q(path)
        ];
    }

    // Find a collision-free heredoc delimiter by checking content for collisions.
    function findDelimiter(content) {
        let num = 0;
        while (true) {
            const delim = 'PILOT_EOF_' + num;
            const contentStr = String(content);
            const lines = contentStr.split('\n');
            let collides = false;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i] === delim) {
                    collides = true;
                    break;
                }
            }
            if (!collides) return delim;
            num++;
        }
    }

    function manualScript(plan) {
        assertPlan(plan, 'manualScript');
        const warnings = Array.isArray(plan.warnings) ? plan.warnings : [];
        const out = ['#!/bin/sh',
            '# Generated by Pilot - manual provisioning script. Run every line as root, in order.',
            '# target=' + plan.target + ' arch=' + plan.arch + ' steps=' + plan.steps.length,
            'set -eu'];
        for (let i = 0; i < warnings.length; i++) out.push('# WARNING: ' + warnings[i]);
        const n = plan.steps.length;
        for (let i = 0; i < n; i++) {
            const s = plan.steps[i];
            out.push('');
            out.push('# [' + (i + 1) + '/' + n + '] ' + s.title);
            out.push('# ' + s.why);
            const secretInfo = renderSecretStep(s);
            if (s.secret) {
                out.push(secretInfo.outputSensitive
                    ? '# SECRET: this command is safe to run and safe to share - its OUTPUT contains a credential; do not paste the OUTPUT into a shared log.'
                    : '# SECRET: this step carries a credential - do not paste it into a shared log.');
            }

            // Render check probes as real guards: if ! check; then cmd; fi
            if (s.check) {
                const checkLine = argvLine(s.check.argv);
                const expectZero = s.check.expect === 'zero';
                const condition = expectZero ? '! ' : '';
                out.push('if ' + condition + checkLine + ' >/dev/null 2>&1; then');
            }

            if (s.write) {
                // A secret write step's content IS the credential, so it never
                // reaches the heredoc below: it is either rendered from an
                // environment variable (the explicit, enrolled allow-path) or
                // suppressed entirely. Printing it is the one unacceptable option.
                const safeWrite = s.secret ? renderSecretWrite(s) : null;
                if (s.secret && !safeWrite) {
                    out.push('# MANUAL STEP: This step writes a credential to ' + q(s.write.path) +
                        ' and must be done by hand on the target.');
                    out.push('# Do not include this step in a shareable script.');
                } else if (safeWrite) {
                    for (let j = 0; j < safeWrite.length; j++) out.push(safeWrite[j]);
                } else {
                    out.push('install -d -m 0755 ' + q(dirOf(s.write.path)));
                    const delim = findDelimiter(s.write.content);
                    out.push('cat > ' + q(s.write.path) + " <<'" + delim + "'");
                    out.push(String(s.write.content).replace(/\n$/, ''));
                    out.push(delim);
                    out.push('chmod ' + q(s.write.mode) + ' ' + q(s.write.path));
                    out.push('chown ' + q(s.write.owner) + ' ' + q(s.write.path));
                }
            } else {
                for (let j = 0; j < secretInfo.preLines.length; j++) out.push(secretInfo.preLines[j]);
                if (secretInfo.mustRunManually) {
                    out.push('# MANUAL STEP: This step carries credentials and must be run manually on the target.');
                    out.push('# Do not include this step in a shareable script.');
                } else if (secretInfo.commandLine) {
                    out.push(secretInfo.commandLine);
                } else {
                    out.push(argvLine(s.argv));
                }
            }

            if (s.sha256) {
                out.push("printf '%s  %s\\n' " + q(s.sha256) + ' ' + q(destOf(s.argv)) + ' | sha256sum -c -');
            }

            // Close the check guard if present
            if (s.check) {
                out.push('else');
                out.push('echo "skip: ' + s.id + ' (already satisfied)"');
                out.push('fi');
            }
        }
        if (n > 0) out.push('');  // Blank line at end only if there are steps
        out.push('');
        return out.join('\n');
    }

    const PilotProvisionPlan = { build, toEnvelope, stepIds, manualScript };
    root.PilotProvisionPlan = PilotProvisionPlan;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotProvisionPlan;
})(typeof window !== 'undefined' ? window : globalThis);
