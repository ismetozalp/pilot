// features/server-ops-ui.js — Server Ops: day-2 operations on an already
// provisioned server (spec §4.2's "remember for day-2 operations" checkbox and
// §5's /etc/pilot/servers/<id>.ssh exist FOR this screen).
//
// Every operation in OPS runs through the same libexec/pilot-exec helper the
// setup wizard uses — this file adds no new transport and no new privileged
// code path. It reuses js/features/setup-ui.js's C4 transcript reducer
// (parseLine/reduce/splitStream/blankExec/runIdFor) rather than writing a
// second JSON-line parser, exactly as the task brief asks.
//
// Everything above the "cockpit I/O" divider is pure and unit-tested with no
// DOM and no cockpit reference: OPS, isOpAllowed, opArgv, parseUnitState,
// parseRelayLog, summarise and blankState. Only the Alpine component
// (serverOpsUi()) below the divider touches the bridge, and every access to
// `cockpit` there is guarded.
//
// GAP C (task 33) fixed the two halves of a design gap this task originally
// inherited rather than invented: js/features/setup-ui.js now persists the
// credential via PilotServers.writeSshCredential() when "remember for day-2
// operations" is checked and provisioning succeeds, tagged with its real
// auth type (password | pem); this file reads it back with
// PilotServers.readSecret() + decodeSshCredential() and sends it to
// pilot-exec as whichever of ssh.auth/credentials.{password,pem} that tag
// says, never assuming "password" unconditionally. It still treats the mere
// PRESENCE of /etc/pilot/servers/<id>.ssh as `hasCredential`, and no server
// record carries an ssh `user` field (the day-2 user is always "root").
'use strict';
(function (root) {
    function need(name, path) {
        if (root[name]) return root[name];
        if (typeof require === 'function') {
            try { return require(path); } catch (e) { return null; }
        }
        return null;
    }

    const Errors = need('PilotErrors', '../core/errors.js');
    const View = need('PilotConsoleView', '../core/console-view.js');
    const SetupUi = need('PilotSetupUi', './setup-ui.js');
    const Semver = need('PilotSemver', '../core/semver.js');
    const OsTarget = need('PilotOsTarget', '../core/ostarget.js');
    const EmptyState = need('PilotEmptyState', '../core/emptystate.js');

    const MOUNT_ID = 'pilot-server-ops';
    const SERVER_CHANGED_EVENT = 'pilot:server-changed';
    const EXEC = '/usr/libexec/pilot/pilot-exec';

    // Real systemd unit names hbbs/hbbr/rustdesk-api are installed under
    // (js/core/provision-plan.js's own hbbUnit()/apiUnit() naming, kept in
    // lockstep here rather than re-derived).
    const UNIT = Object.freeze({ hbbs: 'rustdesk-hbbs.service', hbbr: 'rustdesk-hbbr.service', api: 'rustdesk-api.service' });
    const HBBS_DATA = '/var/lib/rustdesk-server';

    function str(v) { return (v === null || v === undefined) ? '' : String(v); }

    // Single-quote shell escaping for the one op (rotate-key) that composes a
    // compound `sh -c` command — the same helper shape as provision-plan.js's
    // own sq(), kept local since that module is not otherwise a dependency here.
    function sq(s) { return "'" + str(s).split("'").join("'\\''") + "'"; }

    // ================================================================
    // OPS — the day-2 operation table (pure data).
    // ================================================================
    //
    // needsCredential is true for every op: all eight reach the target only
    // through pilot-exec, and for a remote (non-local) server that means an
    // SSH transport, which needs the stored credential — there is no op here
    // that reaches the target any other way. The real distinction the brief
    // asks the UI to respect is LOCAL vs REMOTE, not op-by-op: a local target
    // needs no SSH credential at all, so isOpAllowed()'s caller computes
    // server.hasCredential as unconditionally true for the local target (see
    // loadServer() below) rather than needsCredential varying per op here.
    const OPS = Object.freeze([
        Object.freeze({
            id: 'status', label: 'Service status', danger: false, needsCredential: true,
            why: 'Reads systemctl status for hbbs, hbbr and the API server.'
        }),
        Object.freeze({
            id: 'restart-hbbs', label: 'Restart hbbs', danger: true, needsCredential: true,
            why: 'Restarts the ID/rendezvous service. Every in-flight rendezvous is dropped.',
            // What the operator is actually agreeing to. `why` is one sentence
            // for the button; this is the consequence, stated plainly, because
            // "are you sure?" is not a question anyone can answer without it.
            impact: Object.freeze([
                'Devices cannot find each other for a few seconds while hbbs restarts.',
                'Sessions already established keep running -- they no longer need hbbs.',
                'Every device re-registers automatically; none needs reconfiguring.'
            ]),
            reversible: true
        }),
        Object.freeze({
            id: 'restart-hbbr', label: 'Restart hbbr', danger: true, needsCredential: true,
            why: 'Restarts the relay service. Every in-flight relayed session is dropped.',
            impact: Object.freeze([
                'Any screen-sharing session currently going THROUGH the relay is cut immediately.',
                'Directly connected sessions are unaffected -- they do not use the relay.',
                'New sessions can relay again as soon as hbbr is back, within seconds.'
            ]),
            reversible: true
        }),
        Object.freeze({
            id: 'restart-api', label: 'Restart API server', danger: true, needsCredential: true,
            why: 'Restarts rustdesk-api. The admin console and API are briefly unreachable.',
            impact: Object.freeze([
                'This Pilot console loses its API for a few seconds and reconnects on its own.',
                'Address book and login stop responding for that moment; signed-in clients stay signed in.',
                'Screen-sharing sessions are NOT affected -- they never touch the API.'
            ]),
            reversible: true
        }),
        Object.freeze({
            id: 'relay-log', label: 'Recent relay sessions', danger: false, needsCredential: true,
            why: 'Reads hbbr’s recent log output and parses it into relay sessions.'
        }),
        Object.freeze({
            id: 'doctor', label: 'Run diagnostics', danger: false, needsCredential: true,
            why: 'Runs rustdesk-utils doctor against this server.'
        }),
        Object.freeze({
            id: 'recheck-ports', label: 'Re-check reachability', danger: false, needsCredential: true,
            why: 'Re-runs the port-reachability probe against this server.'
        }),
        Object.freeze({
            id: 'versions', label: 'Check for updates', danger: false, needsCredential: true,
            why: 'Reads the installed API and RustDesk server versions, then compares them with the ' +
                'latest release of each configured repository.'
        }),
        Object.freeze({
            id: 'update-api', label: 'Update API server', danger: true, needsCredential: true,
            why: 'Downloads the configured API release, verifies its checksum, and installs it over ' +
                'the running server.',
            impact: Object.freeze([
                'The API, admin console and address book are unavailable for a few seconds.',
                'Screen-sharing sessions are NOT affected -- they never touch the API.',
                'Your config.yaml is never written: the upstream one is excluded from the unpack, ' +
                    'and a timestamped copy is taken first anyway.',
                'The database is untouched -- the archive ships an empty data/ directory.'
            ]),
            reversible: true,
            // A choice, not a policy. Keeping the configured file is right almost
            // always -- it carries the id-server, the key and the TLS wiring, and
            // losing it breaks every signed-in client. But a new API version can
            // add keys the old file has never heard of, and an operator who wants
            // to start from the shipped defaults should not have to edit the
            // server by hand to get them. Default is KEEP; taking the upstream
            // file is opt-in and says what it costs.
            options: Object.freeze([Object.freeze({
                key: 'resetConfig',
                label: 'Also replace config.yaml with the upstream default',
                warn: 'This discards the id-server, relay, key, TLS and web-client settings ' +
                    'Pilot wrote. Signed-in clients stop working until the server is ' +
                    'reconfigured. A timestamped copy of the current file is kept either way.'
            })])
        }),
        Object.freeze({
            id: 'update-server', label: 'Update RustDesk server', danger: true, needsCredential: true,
            why: 'Downloads the configured hbbs/hbbr release, verifies its checksum, and replaces the ' +
                'binaries.',
            impact: Object.freeze([
                'hbbs and hbbr restart, so devices re-register and relayed sessions are cut.',
                'The id_ed25519 keypair is NOT touched, so no client needs reconfiguring.',
                'Established direct sessions keep running -- they need neither daemon.',
                'The previous binaries are kept beside the new ones with a .bak suffix.'
            ]),
            reversible: true
        }),
        Object.freeze({
            id: 'rotate-key', label: 'Rotate server keypair', danger: true, needsCredential: true,
            why: 'Regenerates the hbbs id_ed25519 keypair. Every already-deployed client ' +
                'breaks until it is reconfigured with the new key — this cannot be undone ' +
                'from here.',
            impact: Object.freeze([
                'EVERY device stops connecting the moment hbbs restarts -- not gradually, all at once.',
                'Each one stays broken until someone edits its Key field by hand, on the device itself.',
                'The old key is deleted, not archived: there is no undo button here and no rollback.',
                'Pilot shows you the new key afterwards, but cannot push it to any device.'
            ]),
            reversible: false
        })
    ]);

    const DANGER_OPS = OPS.filter(function (o) { return o.danger === true; }).map(function (o) { return o.id; });

    function findOp(id) {
        for (let i = 0; i < OPS.length; i++) if (OPS[i].id === id) return OPS[i];
        return null;
    }

    // ================================================================
    // isOpAllowed / opArgv — pure.
    // ================================================================

    function isOpAllowed(op, server) {
        if (!server || typeof server !== 'object') return false;
        const found = findOp(op);
        if (!found) return false;
        if (found.needsCredential && server.hasCredential !== true) return false;
        return true;
    }

    // provision-plan.js supports a customised hbbs data directory
    // (det.hbbs.dataDir, C8), but no task persists that path into the server
    // registry (js/core/servers.js's normalizeRecord carries no such field) —
    // a real gap upstream of this one. Rather than silently assume the
    // default is always right, this reads an optional server.hbbsDataDir when
    // a caller supplies one (so it is ready the moment some later task DOES
    // start persisting it) and only falls back to the documented default
    // when it is absent.
    function hbbsDataDirFor(server) {
        const s = (server && typeof server === 'object') ? server : {};
        const dir = s.hbbsDataDir;
        return (typeof dir === 'string' && dir.trim() !== '') ? dir.trim() : HBBS_DATA;
    }

    // The argv actually executed ON THE TARGET, inside one pilot-exec envelope
    // step — never the credential, which travels only in the envelope's
    // `credentials` block (stdin), never here.
    // The SSH account for day-2 work on this server. Older records predate the
    // field entirely, and those deployments were provisioned as root, so root is
    // the honest fallback -- but only for them.
    function sshUserFor(server) {
        const u = str(server && server.sshUser).trim();
        return u === '' ? 'root' : u;
    }

    // Where downloads land, matching js/core/provision-plan.js's own cache so a
    // re-run reuses the file instead of refetching it.
    const CACHE_DIR = '/var/cache/pilot';
    const API_DIR = '/opt/rustdesk-api';
    const API_USER = 'rustdesk-api';
    const BIN_DIR = '/usr/local/bin';

    // The upstream config.yaml inside the API tarball. EXCLUDED from the unpack
    // rather than restored afterwards: never writing it cannot half-fail, and a
    // restore step can. Verified against the real v2.7 archive -- with this
    // exclude the configured file is byte-identical afterwards, the database is
    // untouched (the archive's data/ is an empty directory carrying no .db), and
    // apimain and resources/version are updated.
    const API_TAR_CONFIG = './release/conf/config.yaml';

    // `plan` carries what the CHECK produced -- the asset url, its sha256 from
    // the release metadata, and the version -- because an update command cannot
    // be built without knowing which release it is installing.
    function opArgv(op, server, plan) {
        const found = findOp(op);
        if (!found) return null;
        switch (found.id) {
            case 'status':
                return ['systemctl', 'is-active', UNIT.hbbs, UNIT.hbbr, UNIT.api];
            case 'restart-hbbs':
                return ['systemctl', 'restart', UNIT.hbbs];
            case 'restart-hbbr':
                return ['systemctl', 'restart', UNIT.hbbr];
            case 'restart-api':
                return ['systemctl', 'restart', UNIT.api];
            case 'relay-log':
                return ['journalctl', '-u', UNIT.hbbr, '--no-pager', '-o', 'cat', '-n', '2000'];
            case 'doctor': {
                // `doctor` takes the server address as a positional argument:
                //     doctor [rustdesk-server]   Check for server connection problems
                // Run bare it prints "ERROR: You must supply the rustdesk-server
                // address" and its usage, and exits -- so this op could never
                // once have produced a diagnosis. It is the address the CLIENTS
                // dial that is worth checking (doctor resolves it, compares the
                // reverse DNS and probes the ports), which is the record's host,
                // not localhost.
                const host = str(server && server.host).trim();
                if (host === '') return null;
                return ['rustdesk-utils', 'doctor', host];
            }
            case 'recheck-ports':
                return ['ss', '-H', '-ltnu'];
            case 'versions':
                // One command, three facts, in a shape that survives a missing
                // component: a server with no API installed still reports its
                // arch and its hbbs version rather than failing the whole read.
                // `|| true` on each line for the same reason -- this is a REPORT,
                // and a partial answer is more useful than an error.
                return ['sh', '-c',
                    'echo "arch=$(uname -m)"; ' +
                    'echo "api=$(cat ' + sq(API_DIR + '/resources/version') + ' 2>/dev/null || echo none)"; ' +
                    // PATH first, then Pilot's own bin dir. hbbs can arrive two
                    // ways -- Pilot unpacks the release zip into /usr/local/bin,
                    // while a distribution package puts it in /usr/bin -- and
                    // reading only one of them reported "no hbbs installed" on a
                    // server that plainly had one. Caught by running this against
                    // the real deployment rather than trusting the happy path.
                    'echo "hbbs=$({ command -v hbbs >/dev/null 2>&1 && hbbs --version || ' +
                        sq(BIN_DIR + '/hbbs') + ' --version; } 2>/dev/null | ' +
                        "awk '{print $NF}' || echo none)\""];
            case 'update-api': {
                const p = (plan && typeof plan === 'object') ? plan : {};
                const url = str(p.url), sha = str(p.sha256);
                // No release chosen means nothing to install. Returning null
                // blocks the op rather than running a command with an empty URL.
                if (!url || !/^[0-9a-f]{64}$/.test(sha)) return null;
                const tgz = CACHE_DIR + '/rustdesk-api-update.tar.gz';
                const stamp = str(p.stamp) || 'bak';
                return ['sh', '-c',
                    'set -e; ' +
                    'install -d -m 0755 ' + sq(CACHE_DIR) + '; ' +
                    'curl -fsSL ' + sq(url) + ' -o ' + sq(tgz) + '; ' +
                    // Verified BEFORE anything is stopped or unpacked: a corrupt
                    // or substituted download must not reach a running server.
                    'printf %s ' + sq(sha + '  ' + tgz) + ' | sha256sum -c -; ' +
                    'cp -a ' + sq(API_DIR + '/conf/config.yaml') + ' ' +
                        sq(API_DIR + '/conf/config.yaml.' + stamp) + '; ' +
                    'cp -a ' + sq(API_DIR + '/data/rustdeskapi.db') + ' ' +
                        sq(API_DIR + '/data/rustdeskapi.db.' + stamp) + ' 2>/dev/null || true; ' +
                    'systemctl stop ' + UNIT.api + '; ' +
                    // The exclude is what protects the configured file: it is
                    // never written, rather than written and restored, because
                    // "never happened" cannot half-fail. Dropping the exclude is
                    // how the operator asks for the upstream file instead.
                    'tar xzf ' + sq(tgz) + ' -C ' + sq(API_DIR) + ' --strip-components=2' +
                        (p.resetConfig === true ? '' : ' --exclude=' + sq(API_TAR_CONFIG)) + '; ' +
                    'test -x ' + sq(API_DIR + '/apimain') + '; ' +
                    'chown -R ' + API_USER + ':' + API_USER + ' ' + sq(API_DIR) + '; ' +
                    'systemctl start ' + UNIT.api + '; ' +
                    'systemctl is-active ' + UNIT.api];
            }
            case 'update-server': {
                const p = (plan && typeof plan === 'object') ? plan : {};
                const url = str(p.url), sha = str(p.sha256);
                if (!url || !/^[0-9a-f]{64}$/.test(sha)) return null;
                const zip = CACHE_DIR + '/rustdesk-server-update.zip';
                const stamp = str(p.stamp) || 'bak';
                // The keypair lives in the DATA directory, not beside the
                // binaries, so replacing the binaries cannot disturb it -- which
                // is why no client needs reconfiguring after this.
                return ['sh', '-c',
                    'set -e; ' +
                    'install -d -m 0755 ' + sq(CACHE_DIR) + '; ' +
                    'curl -fsSL ' + sq(url) + ' -o ' + sq(zip) + '; ' +
                    'printf %s ' + sq(sha + '  ' + zip) + ' | sha256sum -c -; ' +
                    'for b in hbbs hbbr rustdesk-utils; do ' +
                        'if [ -e ' + sq(BIN_DIR) + '/$b ]; then ' +
                        'cp -a ' + sq(BIN_DIR) + '/$b ' + sq(BIN_DIR) + '/$b.' + stamp + '; fi; done; ' +
                    'systemctl stop ' + UNIT.hbbs + ' ' + UNIT.hbbr + '; ' +
                    'unzip -o -j ' + sq(zip) + ' -d ' + sq(BIN_DIR) + '; ' +
                    'test -x ' + sq(BIN_DIR + '/hbbs') + '; ' +
                    'systemctl start ' + UNIT.hbbs + ' ' + UNIT.hbbr + '; ' +
                    'systemctl is-active ' + UNIT.hbbs + ' ' + UNIT.hbbr];
            }
            case 'rotate-key': {
                // `rm -f` on a missing path exits 0 — this op would otherwise
                // report SUCCESS while rotating nothing, which is worse than an
                // error: an operator who believes a compromised key has been
                // rotated, and has not, stops treating it as compromised. So
                // the key file's existence is checked FIRST, and the whole
                // step fails loudly (non-zero exit, naming the path) rather
                // than silently no-op'ing through to a green "done".
                const dir = hbbsDataDirFor(server);
                const priv = dir + '/id_ed25519';
                const pub = dir + '/id_ed25519.pub';
                return ['sh', '-c',
                    'if [ ! -e ' + sq(priv) + ' ]; then echo ' +
                    sq('rotate-key: no keypair found at ' + priv + ' -- nothing was rotated') +
                    ' >&2; exit 1; fi; rm -f ' + sq(priv) + ' ' + sq(pub) +
                    ' && systemctl restart ' + UNIT.hbbs];
            }
            default:
                return null;
        }
    }

    // ================================================================
    // parseVersions / updateFor — pure.
    // ================================================================

    // The `versions` op prints key=value lines. Anything unrecognised is ignored
    // rather than throwing: this is a report, and a partial answer beats an
    // error. 'none' is the op's own word for "not installed" and becomes ''.
    function parseVersions(text) {
        const out = { arch: '', api: '', hbbs: '' };
        const lines = str(text).split(/\r?\n/);
        for (const raw of lines) {
            const m = /^(arch|api|hbbs)=(.*)$/.exec(raw.trim());
            if (!m) continue;
            const v = m[2].trim();
            out[m[1]] = (v === '' || v === 'none') ? '' : v.slice(0, 64);
        }
        return out;
    }

    // A release tag is 'v2.7' or '1.4.3' depending on the project; the installed
    // marker never carries the v. Compared on the bare numbers so 'v2.7' and
    // '2.7' are correctly the same version rather than an endless "update
    // available" that installs what is already there.
    function bareVersion(v) {
        const s = str(v).trim();
        return /^[vV]/.test(s) ? s.slice(1) : s;
    }

    // Is `latest` newer than `installed`? Delegates the ordering to PilotSemver
    // rather than comparing strings, because '2.10' > '2.9' is false as text.
    function isNewer(latest, installed) {
        const a = bareVersion(latest), b = bareVersion(installed);
        if (!a || !b) return false;
        // No early equality check: both paths below already answer false for
        // equal versions -- compare() returns 0, and the fallback is a !== b. One
        // was here and a mutation could not kill it, which is the definition of
        // code that is not doing anything.
        if (Semver && typeof Semver.compare === 'function') {
            try { return Semver.compare(a, b) > 0; } catch (e) { /* fall through */ }
        }
        return a !== b;
    }

    // Which asset in a release belongs on this machine, and its checksum.
    //
    // The FILENAME comes from js/core/ostarget.js rather than being spelled
    // again here: the two projects name their ARM builds differently for the
    // same machine (arm64v8 vs arm64), and one shared guess produces a 404 on
    // half of all ARM installs. That module already got this right and is
    // asserted on it.
    //
    // The DIGEST comes from the release document -- GitHub publishes
    // "sha256:<hex>" per asset. There is no pinned digest for a release that did
    // not exist when Pilot was built, so this is the only trustworthy source,
    // and an asset without one is refused rather than installed unverified.
    function pickReleaseAsset(release, arch, kind) {
        const rel = (release && typeof release === 'object') ? release : {};
        const assets = Array.isArray(rel.assets) ? rel.assets : [];
        let want = '';
        try {
            const a = (kind === 'api') ? OsTarget.apiAsset(arch) : OsTarget.serverAsset(arch);
            want = str(a && a.name);
        } catch (e) { return null; }
        if (!want) return null;
        for (const a of assets) {
            if (!a || str(a.name) !== want) continue;
            const url = str(a.browser_download_url);
            const m = /^sha256:([0-9a-f]{64})$/i.exec(str(a.digest));
            if (!url || !m) return null;
            return { name: want, url: url, sha256: m[1].toLowerCase() };
        }
        return null;
    }

    // ================================================================
    // parseUnitState — one systemctl is-active word -> a closed vocabulary.
    // ================================================================

    const UNIT_STATE_WORDS = ['active', 'inactive', 'failed'];

    function parseUnitState(text) {
        const first = str(text).trim().split(/\s+/)[0] || '';
        const lower = first.toLowerCase();
        return UNIT_STATE_WORDS.indexOf(lower) >= 0 ? lower : 'unknown';
    }

    // Zips the ordered systemctl is-active output (one line per unit, in the
    // SAME order opArgv('status', ...) named the units) against display labels.
    // Not itself required by the interface, but pure and exported for reuse
    // and direct testing.
    const STATUS_UNITS = Object.freeze([
        { key: 'hbbs', unit: UNIT.hbbs, label: 'ID/rendezvous (hbbs)' },
        { key: 'hbbr', unit: UNIT.hbbr, label: 'Relay (hbbr)' },
        { key: 'api', unit: UNIT.api, label: 'API server' }
    ]);

    function unitStatesFrom(text) {
        const lines = str(text).split('\n');
        return STATUS_UNITS.map(function (u, i) {
            return { key: u.key, unit: u.unit, label: u.label, state: parseUnitState(lines[i]) };
        });
    }

    // ================================================================
    // parseRelayLog — the real hbbr.log format -> session records.
    // ================================================================
    //
    // Two passes over the split lines, deliberately: pass 1 registers every
    // NEW/PAIRED event (which carry the session id) and remembers which id
    // owns which raw peer address; pass 2 attributes every CLOSED event
    // (which carries NO id — only an address) via that map. This is what
    // makes "out-of-order lines" (a closed line physically preceding its own
    // new/paired lines in the text) resolve correctly: attribution never
    // depends on the order lines were scanned in.

    const MAX_LOG_LINES = 20000;

    const TS_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d+) ([+-])(\d{2}):(\d{2})$/;

    function parseTimestamp(raw) {
        const m = TS_RE.exec(str(raw));
        if (!m) return null;
        const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
        const h = Number(m[4]), mi = Number(m[5]), s = Number(m[6]);
        const fracMs = Math.round(Number('0.' + m[7]) * 1000);
        const sign = m[8] === '-' ? -1 : 1;
        const offsetMin = sign * (Number(m[9]) * 60 + Number(m[10]));
        let ms = Date.UTC(y, mo - 1, d, h, mi, s, fracMs);
        if (!isFinite(ms)) return null;
        ms -= offsetMin * 60000;
        return isFinite(ms) ? ms : null;
    }

    // Accepts the bracketed IPv6(-mapped) form the real log uses,
    // "[::ffff:1.2.3.4]:5678", and a plain "1.2.3.4:5678" as a fallback.
    function parseAddr(raw) {
        const s = str(raw).trim();
        let m = /^\[([0-9A-Fa-f.:]+)\]:(\d{1,5})$/.exec(s);
        if (m) return { raw: s, host: m[1], port: Number(m[2]) };
        m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(s);
        if (m) return { raw: s, host: m[1], port: Number(m[2]) };
        return null;
    }

    function normalizeIp(host) {
        const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(str(host));
        return m ? m[1] : str(host);
    }

    function peerFrom(addr) {
        return { raw: addr.raw, ip: normalizeIp(addr.host), port: addr.port };
    }

    const RS_PREFIX = /^\[(?<ts>[^\]]+)\] INFO \[src\/relay_server\.rs:\d+\] /;
    const NEW_RE = /^New relay request (?<id>[0-9A-Za-z-]{1,64}) from (?<addr>\S+)$/;
    const PAIRED_RE = /^Relayrequest (?<id>[0-9A-Za-z-]{1,64}) from (?<addr>\S+) got paired$/;
    const CLOSED_RE = /^Relay of (?<addr>\S+) closed$/;

    function parseEvent(rawLine) {
        const line = str(rawLine).replace(/\r$/, '');
        const head = RS_PREFIX.exec(line);
        if (!head) return null;
        const ts = parseTimestamp(head.groups.ts);
        if (ts === null) return null;
        const rest = line.slice(head[0].length);
        let m = NEW_RE.exec(rest);
        if (m) {
            const addr = parseAddr(m.groups.addr);
            if (!addr) return null;
            return { kind: 'new', ts: ts, id: m.groups.id, addr: addr };
        }
        m = PAIRED_RE.exec(rest);
        if (m) {
            const addr = parseAddr(m.groups.addr);
            if (!addr) return null;
            return { kind: 'paired', ts: ts, id: m.groups.id, addr: addr };
        }
        m = CLOSED_RE.exec(rest);
        if (m) {
            const addr = parseAddr(m.groups.addr);
            if (!addr) return null;
            return { kind: 'closed', ts: ts, addr: addr };
        }
        return null;
    }

    function newSession(id, order) {
        return { id: id, startedAt: null, pairedAt: null, closedAt: null, durationMs: null,
            peers: [], _order: order, _peerRaw: Object.create(null) };
    }

    function addPeer(session, addr) {
        if (session._peerRaw[addr.raw]) return;
        session._peerRaw[addr.raw] = true;
        session.peers.push(peerFrom(addr));
    }

    function parseRelayLog(text) {
        const rawLines = str(text).split('\n');
        const lines = rawLines.length > MAX_LOG_LINES ? rawLines.slice(0, MAX_LOG_LINES) : rawLines;

        const sessions = Object.create(null);
        const addrToId = Object.create(null);
        const order = [];
        let seq = 0;

        // Pass 1: NEW and PAIRED — both carry the session id.
        for (let i = 0; i < lines.length; i++) {
            const ev = parseEvent(lines[i]);
            if (!ev || ev.kind === 'closed') continue;
            let s = sessions[ev.id];
            if (!s) { s = newSession(ev.id, seq++); sessions[ev.id] = s; order.push(ev.id); }
            addPeer(s, ev.addr);
            addrToId[ev.addr.raw] = ev.id;
            if (ev.kind === 'new' && s.startedAt === null) s.startedAt = ev.ts;
            if (ev.kind === 'paired' && s.pairedAt === null) s.pairedAt = ev.ts;
        }

        // Pass 2: CLOSED — attributed purely via the address map built above,
        // so a closed line that appears BEFORE its own new/paired lines in
        // the text still resolves correctly.
        for (let i = 0; i < lines.length; i++) {
            const ev = parseEvent(lines[i]);
            if (!ev || ev.kind !== 'closed') continue;
            const id = addrToId[ev.addr.raw];
            if (id === undefined) continue;               // orphan close: nothing to attribute it to
            const s = sessions[id];
            if (!s || s.closedAt !== null) continue;        // first close wins
            s.closedAt = ev.ts;
        }

        return order.map(function (id) {
            const s = sessions[id];
            if (s.startedAt !== null && s.closedAt !== null)
                s.durationMs = Math.max(0, s.closedAt - s.startedAt);
            return { id: s.id, startedAt: s.startedAt, pairedAt: s.pairedAt,
                closedAt: s.closedAt, durationMs: s.durationMs, peers: s.peers };
        });
    }

    // ================================================================
    // summarise — aggregate counts/durations over a session array.
    // ================================================================
    //
    // Deliberately re-derives and re-clamps duration from each session's own
    // fields rather than trusting an already-computed durationMs blindly —
    // this is what lets a hand-built session (bypassing parseRelayLog's own
    // clamp entirely) still be summarised without ever going negative.

    function summarise(lines) {
        const list = Array.isArray(lines) ? lines : [];
        let total = 0, paired = 0, unpaired = 0, closed = 0, unclosed = 0;
        let sumDurationMs = 0, durationCount = 0, maxDurationMs = 0;
        for (let i = 0; i < list.length; i++) {
            const s = list[i];
            if (!s || typeof s !== 'object') continue;
            total++;
            if (s.pairedAt !== null && s.pairedAt !== undefined) paired++; else unpaired++;
            if (s.closedAt !== null && s.closedAt !== undefined) closed++; else unclosed++;

            let dur = null;
            if (typeof s.startedAt === 'number' && isFinite(s.startedAt) &&
                typeof s.closedAt === 'number' && isFinite(s.closedAt)) {
                dur = Math.max(0, s.closedAt - s.startedAt);
            } else if (typeof s.durationMs === 'number' && isFinite(s.durationMs)) {
                dur = Math.max(0, s.durationMs);
            }
            if (dur !== null) {
                sumDurationMs += dur;
                durationCount++;
                if (dur > maxDurationMs) maxDurationMs = dur;
            }
        }
        return {
            total: total, paired: paired, unpaired: unpaired, closed: closed, unclosed: unclosed,
            totalDurationMs: sumDurationMs,
            avgDurationMs: durationCount ? Math.round(sumDurationMs / durationCount) : null,
            maxDurationMs: durationCount ? maxDurationMs : null
        };
    }

    // ================================================================
    // blankState — the component's initial data shape.
    // ================================================================

    function blankState() {
        return {
            server: null,          // {id, host, sshPort, apiPort, domain, transport, hasCredential} | null
            loading: false,
            alert: null,           // a surface-wide load failure (PilotConsoleView.errorView shape)
            opAlerts: {},           // per-op alert, keyed by op id — independent failure (spec §7.2)
            opBusy: {},             // per-op busy flag, keyed by op id
            confirm: null,           // { opId, typed } while a danger confirmation is open
            unitStates: [],          // [{key,unit,label,state}] from the last 'status' run
            updates: {},              // { 'update-api': {latest,url,sha256,installed,stamp} }
            installed: { arch: '', api: '', hbbs: '' },
            relaySessions: [],        // from the last 'relay-log' run
            relaySummary: null,
            output: {}               // free-text output per op id (doctor/recheck-ports/rotate-key)
        };
    }

    // =============================================================
    // cockpit I/O — everything below this line touches the bridge.
    // Every access is guarded so the module still loads under node.
    // =============================================================

    function fail(kind, message, detail) {
        return (Errors && typeof Errors.create === 'function')
            ? Errors.create(kind, message, detail || null)
            : Object.assign(new Error(message), { kind: kind });
    }

    function errorView(err, context) {
        if (View && typeof View.errorView === 'function') return View.errorView(err, context);
        return { context: str(context), kind: (err && err.kind) || 'UNKNOWN',
            message: str(err && err.message), detail: '', remediation: 'none', actionLabel: '' };
    }

    function hasSpawn() {
        return typeof cockpit !== 'undefined' && cockpit && typeof cockpit.spawn === 'function';
    }

    function servers() { return root.PilotServers || null; }

    // Task 32's js/core/emptystate.js is the single source of truth for this
    // copy; this call site was built (Task 30) before that module existed, so
    // it hardcoded the identical text behind this fallback. The fallback stays
    // — never a hard dependency — so this file still works standing alone
    // (e.g. under a stripped-down test load that never requires emptystate.js).
    function serverEmptyState() {
        if (EmptyState && typeof EmptyState.forKind === 'function') {
            const k = EmptyState.forKind('server');
            if (k) return k;
        }
        return { message: 'No RustDesk server configured yet.', ctaLabel: 'Run setup', tab: 'setup' };
    }

    // Same unwrap setup-ui.js's describe()/unwrapFatal() perform on pilot-exec's
    // uncaught {"t":"fatal",...} stderr envelope — duplicated narrowly (rather
    // than reached into setup-ui's private scope) since it is not exported there.
    function unwrapFatal(text) {
        const s = str(text).trim();
        if (s.charAt(0) !== '{') return null;
        let obj = null;
        try { obj = JSON.parse(s); } catch (e) { return null; }
        if (!obj || typeof obj !== 'object' || obj.t !== 'fatal' || typeof obj.kind !== 'string') return null;
        return { kind: obj.kind, message: str(obj.message) || obj.kind };
    }

    function describeError(e) {
        if (e && typeof e === 'object' && typeof e.kind === 'string') return e;
        const unwrapped = (e && typeof e === 'object') ? unwrapFatal(e.message) : null;
        if (unwrapped) return fail(unwrapped.kind, unwrapped.message, null);
        return fail('GENERIC', str(e && e.message) || str(e) || 'Unknown failure', null);
    }

    function runIdFor() {
        return (SetupUi && typeof SetupUi.runIdFor === 'function')
            ? SetupUi.runIdFor(new Date()) : String(Date.now());
    }

    // Builds a one-step Envelope v1 for a single day-2 op — the same shape
    // js/core/provision-plan.js's toEnvelope() produces, but hand-assembled
    // here since there is no provisioning PLAN behind a day-2 op, only one
    // ad hoc command.
    //
    // `credential` is js/core/servers.js's decodeSshCredential() shape,
    // {authType, secret} | null — GAP C (task 33): this used to unconditionally
    // hardcode auth:'password' and send the raw stored string as the SSH
    // password no matter what it actually was, because writeSecret() had no
    // caller and the stored secret carried no auth-type tag at all. A stored
    // PEM would have been sent to pilot-exec AS A PASSWORD (a clean
    // SSH_AUTH_FAILED, but with no way to explain the real cause).
    function envelopeFor(opId, server, credential, plan) {
        const op = findOp(opId);
        const remote = server && server.transport === 'ssh';
        const authType = (credential && typeof credential.authType === 'string') ? credential.authType : 'password';
        const secret = (credential && typeof credential.secret === 'string') ? credential.secret : '';
        return {
            version: 1,
            run_id: runIdFor(),
            transport: remote ? 'ssh' : 'local',
            ssh: remote ? {
                host: str(server.host), port: (typeof server.sshPort === 'number' ? server.sshPort : 22),
                // The account the wizard connected as, not a guess. Hardcoding
                // 'root' here meant every op on a cloud image that disables root
                // SSH hung until pilot-exec's alarm fired, and reported
                // "cannot determine the remote user: id -u exited 142" -- an
                // error about a probe, naming nothing an operator could act on.
                // pilot-exec escalates with sudo once connected, so a non-root
                // account is the normal case, not the exception.
                // Records written before sshUser existed carry none; 'root'
                // remains the fallback because that is what those deployments
                // were actually provisioned with.
                user: sshUserFor(server), auth: authType, accept_fingerprint: null
            } : null,
            credentials: remote ? {
                password: authType === 'password' ? secret : null,
                pem: authType === 'pem' ? secret : null
            } : null,
            // EVERY key pilot-exec's STEP_KEYS names, present, in the same shape
            // js/core/provision-plan.js's step() produces. The helper rejects a
            // step with a missing key as hard as one with an unknown key -- it
            // validates the whole set, not the keys it happens to need -- so a
            // step built with only the five that carry data was refused before
            // it ran, and EVERY Server Ops action died with
            // "envelope.steps[0] is missing key(s): check, secret, sha256, write".
            //
            // The four constants below are not padding: null/false is what each
            // one MEANS for an operation that runs a command and nothing else.
            // No file is written, no idempotency guard applies, no download is
            // verified, and no argument is a secret.
            steps: [{
                id: op.id,
                title: op.label,
                mutating: !!op.danger,
                why: op.why,
                argv: opArgv(opId, server, plan),
                write: null,
                check: null,
                sha256: null,
                secret: false
            }]
        };
    }

    function outputTextFrom(exec) {
        const steps = (exec && Array.isArray(exec.steps)) ? exec.steps : [];
        const lines = [];
        for (let i = 0; i < steps.length; i++) {
            const s = steps[i];
            const stepLines = Array.isArray(s.lines) ? s.lines : [];
            for (let j = 0; j < stepLines.length; j++) lines.push(stepLines[j].text);
        }
        return lines.join('\n');
    }

    // A failed step with no C6 kind (e.g. rotate-key's own on-target existence
    // guard, which just exits 1 after an ordinary stderr line — it is not a
    // PilotErrors kind, just a plain shell failure) would otherwise surface as
    // the generic "did not finish successfully", burying the one line that
    // actually says WHY (naming a path, in rotate-key's case) inside the
    // output pane instead of the headline alert. This promotes the last
    // stderr line to the alert message when there is no better kind-specific
    // one already.
    function lastStderrLine(exec) {
        const steps = (exec && Array.isArray(exec.steps)) ? exec.steps : [];
        for (let i = steps.length - 1; i >= 0; i--) {
            const lines = Array.isArray(steps[i].lines) ? steps[i].lines : [];
            for (let j = lines.length - 1; j >= 0; j--) {
                if (lines[j].stream === 'stderr' && str(lines[j].text).trim() !== '')
                    return str(lines[j].text).trim();
            }
        }
        return '';
    }

    function serverOpsUi() {
        return Object.assign(blankState(), {
            OPS: OPS,

            emptyState: function () { return serverEmptyState(); },

            init: function (doc) {
                const target = doc || root.document || null;
                const self = this;
                if (target && typeof target.addEventListener === 'function')
                    target.addEventListener(SERVER_CHANGED_EVENT, function (ev) { self.onServerChanged(ev); });
                // Task 24's lesson, restated here: a surface can mount before
                // wireApi()'s async chain ever dispatches the event, so the
                // very first load must not depend solely on the listener —
                // it also has to ask once, right here, at cold boot.
                return this.loadActive();
            },

            onServerChanged: function (ev) {
                if (!ev || typeof ev !== 'object') return false;
                const id = (ev.detail && typeof ev.detail.id === 'string') ? ev.detail.id : null;
                this.loadServer(id);
                return true;
            },

            loadActive: function () {
                const Servers = servers();
                if (!Servers || typeof Servers.active !== 'function')
                    return this.loadServer(null);
                const self = this;
                return Promise.resolve().then(function () { return Servers.active(); })
                    .then(function (id) { return self.loadServer(id); },
                        function () { return self.loadServer(null); });
            },

            isOpAllowed: function (opId) { return isOpAllowed(opId, this.server); },
            opDisabled: function (opId) {
                if (!this.isOpAllowed(opId) || this.opBusy[opId]) return true;
                // An update with no release chosen would refuse in opArgv anyway;
                // disabling it here says so BEFORE the click, and points at the
                // check as the thing to do first.
                if (opId === 'update-api' || opId === 'update-server') return !this.updateAvailable(opId);
                return false;
            },
            isBusy: function (opId) { return !!this.opBusy[opId]; },
            // The label says what is happening, not only that something is. A
            // spinner alone is invisible to a screen reader and ambiguous next
            // to seven other buttons.
            opLabel: function (op) {
                if (!op) return '';
                return this.isBusy(op.id) ? op.label + '\u2026' : op.label;
            },
            opAlert: function (opId) { return this.opAlerts[opId] || null; },
            opOutput: function (opId) { return this.output[opId] || ''; },

            reasonBlocked: function (opId) {
                if (!this.server) return 'No server is configured yet.';
                if ((opId === 'update-api' || opId === 'update-server') && !this.updateAvailable(opId))
                    return 'Run "Check for updates" first — nothing is known about newer releases yet.';
                const op = findOp(opId);
                if (!op) return 'Unknown operation.';
                if (op.needsCredential && this.server.hasCredential !== true)
                    return 'No stored credential for this server. Re-run setup with ' +
                        '“remember for day-2 operations” checked, or connect manually.';
                return '';
            },

            loadServer: function (id) {
                const Servers = servers();
                const self = this;
                self.alert = null;
                if (!id || !Servers || typeof Servers.read !== 'function') {
                    self.server = null;
                    return Promise.resolve(false);
                }
                self.loading = true;
                return Promise.resolve().then(function () { return Servers.read(id); })
                    .then(function (rec) {
                        const transport = id === 'local' ? 'local' : 'ssh';
                        if (transport === 'local' || typeof Servers.readSecret !== 'function') {
                            self.server = {
                                id: rec.id, host: rec.host, sshPort: rec.sshPort, apiPort: rec.apiPort,
                                domain: rec.domain, transport: transport, hasCredential: true,
                                sshUser: rec.sshUser || null
                            };
                            self.loading = false;
                            return true;
                        }
                        return Promise.resolve(Servers.readSecret(id, 'ssh'))
                            .then(function (secret) { return secret; }, function () { return null; })
                            .then(function (secret) {
                                self.server = {
                                    id: rec.id, host: rec.host, sshPort: rec.sshPort, apiPort: rec.apiPort,
                                    domain: rec.domain, transport: transport, sshUser: rec.sshUser || null,
                                    hasCredential: typeof secret === 'string' && secret !== ''
                                };
                                self.loading = false;
                                return true;
                            });
                    })
                    .catch(function () {
                        // No record for this id: exactly "no server configured"
                        // (spec §7.3) — never an alert, never a dead control.
                        self.server = null;
                        self.loading = false;
                        return false;
                    });
            },

            clearOpAlert: function (opId) { this.opAlerts[opId] = null; },

            // Entry point every op button calls. Danger ops open a
            // confirmation instead of running immediately (spec: every
            // danger:true op requires an explicit confirmation step).
            request: function (opId) {
                this.clearOpAlert(opId);
                if (!isOpAllowed(opId, this.server)) return false;
                const op = findOp(opId);
                if (op.danger) {
                    // Options start FALSE: every one of them is a widening of
                    // what the operation does, so the safe answer is the one the
                    // operator gets without choosing.
                    const opts = {};
                    for (const o of (op.options || [])) opts[o.key] = false;
                    this.confirm = { opId: opId, typed: '', opts: opts };
                    return true;
                }
                return this.execute(opId);
            },

            cancelConfirm: function () { this.confirm = null; },

            // The op the open confirmation refers to. Returns a harmless empty
            // shape rather than null so the dialog cannot throw mid-render if
            // `confirm` is cleared between Alpine evaluating x-if and the
            // bindings inside it -- the same batching gap that has bitten this
            // codebase before.
            confirmOp: function () {
                const c = this.confirm;
                const op = c ? findOp(c.opId) : null;
                return op || { id: '', label: '', why: '', impact: [], reversible: true, options: [] };
            },

            // The repositories to check, from the operator's settings. Read
            // fresh each time rather than cached: the Settings tab can change
            // them while this surface is open.
            async updateRepos() {
                const S = root.PilotSettings ||
                    (typeof require === 'function' ? require('../core/settings.js') : null);
                if (!S || typeof S.read !== 'function') return { api: '', server: '' };
                try {
                    const doc = await S.read();
                    const u = (doc && doc.update) ? doc.update : {};
                    return { api: str(u.apiRepo), server: str(u.serverRepo) };
                } catch (e) { return { api: '', server: '' }; }
            },

            // One GitHub release document, fetched the only way this plugin can:
            // through the host. manifest.json sets connect-src 'self', so a
            // browser fetch() to api.github.com is blocked outright -- it appears
            // to work in a unit test and fails silently in the browser, which is
            // the note js/features/update.js opens with.
            async latestRelease(repo) {
                const Upd = root.PilotUpdate ||
                    (typeof require === 'function' ? require('./update.js') : null);
                const api = (Upd && typeof Upd.releasesApiUrl === 'function')
                    ? Upd.releasesApiUrl(repo) : '';
                if (!api) return null;
                if (typeof cockpit === 'undefined' || !cockpit || typeof cockpit.spawn !== 'function')
                    return null;
                const out = await cockpit.spawn(
                    ['curl', '-fsSL', '--max-time', '20', '-H', 'Accept: application/vnd.github+json', api],
                    { err: 'message' });
                try { return JSON.parse(str(out)); } catch (e) { return null; }
            },

            // Reads what is installed on the target, then asks each configured
            // repository what the newest release is. Populates this.updates, which
            // is what unlocks the two update buttons -- until it runs they refuse,
            // because opArgv() will not build a command without a release.
            async checkUpdates() {
                this.opAlerts.versions = null;
                const ok = await this.execute('versions');
                if (!ok) return false;
                const inst = parseVersions(this.opOutput('versions'));
                this.installed = inst;
                const repos = await this.updateRepos();
                const stamp = runIdFor();
                const found = {};
                const pairs = [
                    { op: 'update-api', repo: repos.api, kind: 'api', have: inst.api },
                    { op: 'update-server', repo: repos.server, kind: 'server', have: inst.hbbs }
                ];
                for (const p of pairs) {
                    if (!p.repo || !p.have) continue;
                    let rel = null;
                    try { rel = await this.latestRelease(p.repo); } catch (e) { rel = null; }
                    if (!rel) continue;
                    const tag = str(rel.tag_name);
                    if (!isNewer(tag, p.have)) continue;
                    const asset = pickReleaseAsset(rel, inst.arch, p.kind);
                    // A newer release with no usable asset for this architecture
                    // is NOT an update -- offering the button would produce a 404
                    // against a stopped service.
                    if (!asset) continue;
                    found[p.op] = { latest: bareVersion(tag), installed: p.have, repo: p.repo,
                        url: asset.url, sha256: asset.sha256, stamp: stamp };
                }
                this.updates = found;
                return true;
            },

            updateAvailable: function (opId) { return !!(this.updates && this.updates[opId]); },

            // What a given update op should install. Populated by checkUpdates();
            // null until then, which is what blocks the op -- opArgv() refuses to
            // build a command without a release and a checksum.
            updatePlanFor: function (opId) {
                const found = (this.updates && this.updates[opId]) ? this.updates[opId] : null;
                if (!found) return null;
                return {
                    url: found.url, sha256: found.sha256, version: found.latest,
                    stamp: found.stamp || 'bak'
                };
            },

            confirmOptions: function () {
                const op = this.confirmOp();
                return Array.isArray(op.options) ? op.options : [];
            },

            confirmOptOn: function (key) {
                return !!(this.confirm && this.confirm.opts && this.confirm.opts[key]);
            },

            confirmDisabled: function () {
                const c = this.confirm;
                if (!c) return true;
                if (c.opId === 'rotate-key')
                    return str(c.typed).trim() !== (this.server && this.server.id);
                return false;
            },

            confirmRun: function () {
                if (this.confirmDisabled()) return false;
                const opId = this.confirm.opId;
                const opts = Object.assign({}, this.confirm.opts || {});
                this.confirm = null;
                return this.execute(opId, opts);
            },

            // The one method that touches the bridge. Every failure here is
            // recorded under opAlerts[opId] only — a failing op never taints
            // any other op or the surface's own alert (spec §7.2).
            execute: function (opId, opts) {
                const self = this;
                const server = this.server;
                if (!isOpAllowed(opId, server)) return Promise.resolve(false);
                self.opBusy[opId] = true;
                self.opAlerts[opId] = null;

                const Servers = servers();
                // decodeSshCredential() turns the raw stored string into
                // {authType, secret} | null (GAP C, task 33) — falls back to
                // null (never a bare string) if an older Servers object
                // without it is ever installed, which envelopeFor() already
                // treats as "no credential" rather than misreading raw JSON
                // as a password.
                const credP = (server.transport === 'ssh' && Servers && typeof Servers.readSecret === 'function')
                    ? Promise.resolve(Servers.readSecret(server.id, 'ssh'))
                        .then(function (raw) {
                            return (typeof Servers.decodeSshCredential === 'function')
                                ? Servers.decodeSshCredential(raw) : null;
                        }, function () { return null; })
                    : Promise.resolve(null);

                return credP.then(function (credential) {
                    if (!hasSpawn()) throw fail('GENERIC', 'This page cannot reach the system helper.', null);
                    let envelope;
                    // The plan an update needs -- which release, its checksum --
                    // comes from updatePlanFor(); the operator's choices from the
                    // confirmation dialog are merged on top.
                    const plan = Object.assign({}, self.updatePlanFor(opId), opts || {});
                    try { envelope = envelopeFor(opId, server, credential, plan); }
                    catch (e) { throw describeError(e); }

                    const p = cockpit.spawn([EXEC, '--run'], { superuser: 'require', err: 'message' });
                    let exec = (SetupUi && typeof SetupUi.blankExec === 'function') ? SetupUi.blankExec()
                        : { steps: [], status: 'idle' };
                    let carry = '';
                    let streamed = false;

                    function ingest(line) {
                        if (str(line).trim() === '') return;
                        const ev = (SetupUi && typeof SetupUi.parseLine === 'function') ? SetupUi.parseLine(line) : null;
                        exec = (SetupUi && typeof SetupUi.reduce === 'function')
                            ? SetupUi.reduce(exec, ev || { t: 'output', id: '', stream: 'stderr', line: line })
                            : exec;
                    }

                    if (typeof p.input === 'function') p.input(JSON.stringify(envelope));
                    if (typeof p.stream === 'function') p.stream(function (chunk) {
                        streamed = true;
                        const split = (SetupUi && typeof SetupUi.splitStream === 'function')
                            ? SetupUi.splitStream(carry + str(chunk)) : { lines: [], rest: carry + str(chunk) };
                        carry = split.rest;
                        for (let i = 0; i < split.lines.length; i++) ingest(split.lines[i]);
                    });

                    return p.then(function (out) {
                        if (!streamed) {
                            const split = (SetupUi && typeof SetupUi.splitStream === 'function')
                                ? SetupUi.splitStream(carry + str(out)) : { lines: [], rest: '' };
                            carry = split.rest;
                            for (let i = 0; i < split.lines.length; i++) ingest(split.lines[i]);
                        }
                        if (carry.trim() !== '') ingest(carry);
                        return exec;
                    }, function (e) {
                        if (carry.trim() !== '') ingest(carry);
                        throw describeError(e);
                    });
                }).then(function (exec) {
                    self.applyResult(opId, exec);
                    self.opBusy[opId] = false;
                    return exec.status !== 'failed';
                }, function (e) {
                    self.opAlerts[opId] = errorView(e, findOp(opId) ? findOp(opId).label : opId);
                    self.opBusy[opId] = false;
                    return false;
                });
            },

            applyResult: function (opId, exec) {
                if (exec && exec.status === 'failed') {
                    const detail = lastStderrLine(exec);
                    this.opAlerts[opId] = errorView(
                        fail(exec.kind || 'GENERIC', detail || 'The operation did not finish successfully.', null),
                        findOp(opId) ? findOp(opId).label : opId);
                }
                const text = outputTextFrom(exec);
                if (opId === 'status') {
                    this.unitStates = unitStatesFrom(text);
                } else if (opId === 'relay-log') {
                    this.relaySessions = parseRelayLog(text);
                    this.relaySummary = summarise(this.relaySessions);
                } else {
                    this.output[opId] = text;
                }
            }
        });
    }

    // ------------------------------------------------------------- markup

    const TEMPLATE = [
        '<div x-data="pilotServerOpsUi()" x-init="init()" data-testid="server-ops-root">',
        '  <h5 class="mb-3">Server Ops</h5>',
        '  <template x-if="!server">',
        '    <div data-testid="server-ops-empty">',
        '      <p class="mb-2" x-text="emptyState().message"></p>',
        '      <button type="button" class="btn btn-sm btn-primary" data-testid="server-ops-empty-action"',
        '              @click="$dispatch(\'pilot:open-wizard\', {})" x-text="emptyState().ctaLabel"></button>',
        '    </div>',
        '  </template>',
        '  <template x-if="server">',
        '    <div>',
        '      <div class="btn-toolbar mb-3" role="toolbar">',
        '        <template x-for="op in OPS" :key="op.id">',
        '          <div class="me-2 mb-2">',
        '            <button type="button" class="btn btn-sm"',
        '                    :class="op.danger ? \'btn-outline-danger\' : \'btn-outline-secondary\'"',
        '                    :disabled="opDisabled(op.id)" :aria-busy="isBusy(op.id)"',
        '                    :data-testid="\'op-\' + op.id" :title="op.why"',
        '                    @click="op.id === \'versions\' ? checkUpdates() : request(op.id)">',
        // These operations reach a remote host over SSH; several seconds is
        // normal and a dozen is not unusual. A button that only greys out looks
        // broken -- and the honest report was exactly that: "nothing happens".
        // The spinner is a <template x-if>, never x-show: Bootstrap's spinner
        // classes carry `display: inline-block`, and x-show sets an INLINE
        // display, which a utility class marked !important overrides -- the bug
        // that kept the "not connected" banner on screen earlier.
        '              <template x-if="isBusy(op.id)">',
        '                <span class="spinner-border spinner-border-sm me-1" role="status"',
        '                      aria-hidden="true" :data-testid="\'op-\' + op.id + \'-spinner\'"></span>',
        '              </template>',
        '              <span x-text="opLabel(op)"></span>',
        '            </button>',
        '            <div class="small text-secondary" x-show="!isOpAllowed(op.id)"',
        '                 :data-testid="\'op-\' + op.id + \'-reason\'" x-text="reasonBlocked(op.id)"></div>',
        '          </div>',
        '        </template>',
        '      </div>',
        '      <template x-if="confirm">',
        '        <div class="alert alert-warning" role="alertdialog" data-testid="server-ops-confirm">',
        // Name the action being confirmed. "Are you sure?" over an unnamed
        // operation is answerable only by whoever still remembers which button
        // they pressed.
        '          <h3 class="h6" data-testid="server-ops-confirm-title"',
        '              x-text="confirmOp().label + \' — are you sure?\'"></h3>',
        '          <p x-text="confirmOp().why"></p>',
        // The consequences, itemised. This is the part the operator is
        // actually agreeing to, and it is not derivable from the button label.
        '          <ul class="mb-2" data-testid="server-ops-confirm-impact">',
        '            <template x-for="line in confirmOp().impact || []" :key="line">',
        '              <li x-text="line"></li>',
        '            </template>',
        '          </ul>',
        // Reversibility is the single fact that decides whether someone should
        // click, so it is stated outright rather than left to be inferred from
        // the wording above.
        '          <p class="mb-2" data-testid="server-ops-confirm-reversible">',
        '            <strong x-text="confirmOp().reversible === false',
        '                    ? \'This cannot be undone.\'',
        '                    : \'This is reversible: the service comes back on its own.\'"></strong>',
        '          </p>',
        // Per-op choices. Each one WIDENS what the operation does, so each is off
        // until chosen, and the cost is shown next to it rather than in a
        // footnote -- "replace config.yaml" reads harmless until you know it
        // discards the id-server and the key.
        '          <template x-for="o in confirmOptions()" :key="o.key">',
        '            <div class="form-check mb-2">',
        '              <input class="form-check-input" type="checkbox"',
        '                     :id="\'pilot-ops-opt-\' + o.key" :data-testid="\'confirm-opt-\' + o.key"',
        '                     x-model="confirm.opts[o.key]">',
        '              <label class="form-check-label" :for="\'pilot-ops-opt-\' + o.key" x-text="o.label"></label>',
        '              <template x-if="confirmOptOn(o.key)">',
        '                <div class="text-danger small" :data-testid="\'confirm-opt-\' + o.key + \'-warn\'"',
        '                     x-text="o.warn"></div>',
        '              </template>',
        '            </div>',
        '          </template>',
        '          <template x-if="confirm.opId === \'rotate-key\'">',
        '            <div class="mb-2">',
        '              <label class="form-label small" for="pilot-server-ops-confirm-id">',
        '                Type the server id (<span x-text="server.id"></span>) to confirm</label>',
        '              <input id="pilot-server-ops-confirm-id" class="form-control form-control-sm"',
        '                     x-model="confirm.typed" data-testid="server-ops-confirm-input">',
        '            </div>',
        '          </template>',
        '          <button type="button" class="btn btn-sm btn-danger me-2" :disabled="confirmDisabled()"',
        '                  @click="confirmRun()" data-testid="server-ops-confirm-run">Confirm</button>',
        '          <button type="button" class="btn btn-sm btn-outline-secondary" @click="cancelConfirm()"',
        '                  data-testid="server-ops-confirm-cancel">Cancel</button>',
        '        </div>',
        '      </template>',
        // What the check found. Rendered ONLY after one has run: before that
        // there is nothing truthful to say, and "up to date" would be a claim
        // Pilot has not earned.
        '      <template x-if="installed.arch">',
        '        <div class="card mb-3" data-testid="update-report">',
        '          <div class="card-body">',
        '            <h3 class="h6">Installed</h3>',
        '            <p class="mb-1 small">',
        '              <span>API server: </span><strong x-text="installed.api || \'not installed\'"></strong>',
        '              <span> · RustDesk server: </span><strong x-text="installed.hbbs || \'not installed\'"></strong>',
        '              <span> · </span><span x-text="installed.arch"></span>',
        '            </p>',
        '            <template x-for="op in OPS" :key="op.id + \'-upd\'">',
        '              <template x-if="updateAvailable(op.id)">',
        '                <p class="mb-1 small" :data-testid="\'update-\' + op.id">',
        '                  <span x-text="op.label"></span>',
        '                  <span>: </span>',
        '                  <strong x-text="updates[op.id].installed"></strong>',
        '                  <span> → </span>',
        '                  <strong x-text="updates[op.id].latest"></strong>',
        '                  <span class="text-secondary"> from </span>',
        '                  <span class="text-secondary" x-text="updates[op.id].repo"></span>',
        '                </p>',
        '              </template>',
        '            </template>',
        '            <template x-if="!updateAvailable(\'update-api\') && !updateAvailable(\'update-server\')">',
        '              <p class="mb-0 small text-secondary" data-testid="update-none">',
        '                No newer release was found in the configured repositories.</p>',
        '            </template>',
        '          </div>',
        '        </div>',
        '      </template>',
        '      <template x-for="op in OPS" :key="op.id + \'-alert\'">',
        '        <template x-if="opAlert(op.id)">',
        '          <div class="alert alert-danger" role="alert" :data-testid="\'op-\' + op.id + \'-alert\'">',
        '            <strong x-text="opAlert(op.id).context"></strong>',
        '            <div x-text="opAlert(op.id).message"></div>',
        '            <div class="small text-secondary" x-text="opAlert(op.id).kind"></div>',
        '          </div>',
        '        </template>',
        '      </template>',
        '      <div x-show="unitStates.length" data-testid="server-ops-status">',
        '        <table class="table table-sm">',
        '          <thead><tr><th scope="col">Service</th><th scope="col">State</th></tr></thead>',
        '          <tbody><template x-for="u in unitStates" :key="u.key">',
        '            <tr data-testid="server-ops-status-row">',
        '              <td x-text="u.label"></td><td :data-testid="\'server-ops-status-\' + u.key" x-text="u.state"></td>',
        '            </tr>',
        '          </template></tbody>',
        '        </table>',
        '      </div>',
        '      <div x-show="relaySessions.length" data-testid="server-ops-relay">',
        '        <p class="small text-secondary" x-show="relaySummary" data-testid="server-ops-relay-summary">',
        '          <span x-text="relaySummary ? relaySummary.total : 0"></span> session(s),',
        '          <span x-text="relaySummary ? relaySummary.closed : 0"></span> closed</p>',
        '        <table class="table table-sm">',
        '          <thead><tr><th scope="col">Session</th><th scope="col">Peers</th><th scope="col">Duration (ms)</th></tr></thead>',
        '          <tbody><template x-for="s in relaySessions" :key="s.id">',
        '            <tr data-testid="server-ops-relay-row">',
        '              <td x-text="s.id"></td>',
        '              <td x-text="s.peers.map(p => p.ip).join(\', \')"></td>',
        '              <td x-text="s.durationMs === null ? \'—\' : s.durationMs"></td>',
        '            </tr>',
        '          </template></tbody>',
        '        </table>',
        '      </div>',
        '      <template x-for="op in OPS" :key="op.id + \'-output\'">',
        '        <template x-if="opOutput(op.id)">',
        '          <pre class="small" :data-testid="\'op-\' + op.id + \'-output\'" x-text="opOutput(op.id)"></pre>',
        '        </template>',
        '      </template>',
        '    </div>',
        '  </template>',
        '</div>'
    ].join('\n');

    function mount(doc) {
        if (View && typeof View.mountInto === 'function') return View.mountInto(doc || null, MOUNT_ID, TEMPLATE);
        const d = doc || root.document || null;
        if (!d || typeof d.getElementById !== 'function') return false;
        const host = d.getElementById(MOUNT_ID);
        if (!host || host.getAttribute('data-pilot-mounted')) return false;
        host.setAttribute('data-pilot-mounted', '1');
        host.insertAdjacentHTML('beforeend', TEMPLATE);
        return true;
    }

    if (root.document && typeof root.document.addEventListener === 'function')
        root.document.addEventListener('alpine:init', function () { mount(root.document); });

    root.pilotServerOpsUi = serverOpsUi;

    const PilotServerOpsUi = {
        OPS: OPS, DANGER_OPS: DANGER_OPS,
        isOpAllowed: isOpAllowed, opArgv: opArgv, hbbsDataDirFor: hbbsDataDirFor,
        parseUnitState: parseUnitState, unitStatesFrom: unitStatesFrom, STATUS_UNITS: STATUS_UNITS,
        parseVersions: parseVersions, bareVersion: bareVersion, isNewer: isNewer,
        pickReleaseAsset: pickReleaseAsset,
        parseRelayLog: parseRelayLog, summarise: summarise,
        blankState: blankState, serverOpsUi: serverOpsUi, serverEmptyState: serverEmptyState,
        envelopeFor: envelopeFor,
        TEMPLATE: TEMPLATE, mount: mount
    };
    root.PilotServerOpsUi = PilotServerOpsUi;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotServerOpsUi;
})(typeof window !== 'undefined' ? window : globalThis);
