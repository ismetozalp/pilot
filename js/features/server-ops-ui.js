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
// A design gap this task inherited rather than invented: no earlier task ever
// writes a day-2 SSH credential (PilotServers.writeSecret(id, 'ssh', ...) has
// no caller anywhere in this codebase yet), and no server record carries an
// ssh `user` or `auth` field. This file therefore treats the mere PRESENCE of
// /etc/pilot/servers/<id>.ssh as `hasCredential`, and — if a remote op is ever
// actually run — sends the stored secret verbatim as the SSH password with
// user "root". That is a real limitation (no PEM-based day-2 credential is
// modelled), called out in the task report, not silently assumed away.
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
            why: 'Restarts the ID/rendezvous service. Every in-flight rendezvous is dropped.'
        }),
        Object.freeze({
            id: 'restart-hbbr', label: 'Restart hbbr', danger: true, needsCredential: true,
            why: 'Restarts the relay service. Every in-flight relayed session is dropped.'
        }),
        Object.freeze({
            id: 'restart-api', label: 'Restart API server', danger: true, needsCredential: true,
            why: 'Restarts rustdesk-api. The admin console and API are briefly unreachable.'
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
            id: 'rotate-key', label: 'Rotate server keypair', danger: true, needsCredential: true,
            why: 'Regenerates the hbbs id_ed25519 keypair. Every already-deployed client ' +
                'breaks until it is reconfigured with the new key — this cannot be undone ' +
                'from here.'
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

    // The argv actually executed ON THE TARGET, inside one pilot-exec envelope
    // step — never the credential, which travels only in the envelope's
    // `credentials` block (stdin), never here.
    function opArgv(op, server) {
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
            case 'doctor':
                return ['rustdesk-utils', 'doctor'];
            case 'recheck-ports':
                return ['ss', '-H', '-ltnu'];
            case 'rotate-key':
                return ['sh', '-c',
                    'rm -f ' + sq(HBBS_DATA + '/id_ed25519') + ' ' + sq(HBBS_DATA + '/id_ed25519.pub') +
                    ' && systemctl restart ' + UNIT.hbbs];
            default:
                return null;
        }
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
    function envelopeFor(opId, server, credential) {
        const op = findOp(opId);
        const remote = server && server.transport === 'ssh';
        return {
            version: 1,
            run_id: runIdFor(),
            transport: remote ? 'ssh' : 'local',
            ssh: remote ? {
                host: str(server.host), port: (typeof server.sshPort === 'number' ? server.sshPort : 22),
                user: 'root', auth: 'password', accept_fingerprint: null
            } : null,
            credentials: remote ? { password: str(credential), pem: null } : null,
            steps: [{ id: op.id, title: op.label, mutating: !!op.danger, why: op.why, argv: opArgv(opId, server) }]
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

    function serverOpsUi() {
        return Object.assign(blankState(), {
            OPS: OPS,

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
            opDisabled: function (opId) { return !this.isOpAllowed(opId) || !!this.opBusy[opId]; },
            opAlert: function (opId) { return this.opAlerts[opId] || null; },
            opOutput: function (opId) { return this.output[opId] || ''; },

            reasonBlocked: function (opId) {
                if (!this.server) return 'No server is configured yet.';
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
                                domain: rec.domain, transport: transport, hasCredential: true
                            };
                            self.loading = false;
                            return true;
                        }
                        return Promise.resolve(Servers.readSecret(id, 'ssh'))
                            .then(function (secret) { return secret; }, function () { return null; })
                            .then(function (secret) {
                                self.server = {
                                    id: rec.id, host: rec.host, sshPort: rec.sshPort, apiPort: rec.apiPort,
                                    domain: rec.domain, transport: transport,
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
                if (op.danger) { this.confirm = { opId: opId, typed: '' }; return true; }
                return this.execute(opId);
            },

            cancelConfirm: function () { this.confirm = null; },

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
                this.confirm = null;
                return this.execute(opId);
            },

            // The one method that touches the bridge. Every failure here is
            // recorded under opAlerts[opId] only — a failing op never taints
            // any other op or the surface's own alert (spec §7.2).
            execute: function (opId) {
                const self = this;
                const server = this.server;
                if (!isOpAllowed(opId, server)) return Promise.resolve(false);
                self.opBusy[opId] = true;
                self.opAlerts[opId] = null;

                const Servers = servers();
                const credP = (server.transport === 'ssh' && Servers && typeof Servers.readSecret === 'function')
                    ? Promise.resolve(Servers.readSecret(server.id, 'ssh')).catch(function () { return null; })
                    : Promise.resolve(null);

                return credP.then(function (credential) {
                    if (!hasSpawn()) throw fail('GENERIC', 'This page cannot reach the system helper.', null);
                    let envelope;
                    try { envelope = envelopeFor(opId, server, credential); }
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
                    this.opAlerts[opId] = errorView(
                        fail(exec.kind || 'GENERIC', 'The operation did not finish successfully.', null),
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
        '      <p class="mb-2">No RustDesk server configured yet.</p>',
        '      <button type="button" class="btn btn-sm btn-primary" data-testid="server-ops-empty-action"',
        '              @click="$dispatch(\'pilot:open-wizard\', {})">Run setup</button>',
        '    </div>',
        '  </template>',
        '  <template x-if="server">',
        '    <div>',
        '      <div class="btn-toolbar mb-3" role="toolbar">',
        '        <template x-for="op in OPS" :key="op.id">',
        '          <div class="me-2 mb-2">',
        '            <button type="button" class="btn btn-sm"',
        '                    :class="op.danger ? \'btn-outline-danger\' : \'btn-outline-secondary\'"',
        '                    :disabled="opDisabled(op.id)"',
        '                    :data-testid="\'op-\' + op.id" :title="op.why"',
        '                    @click="request(op.id)" x-text="op.label"></button>',
        '            <div class="small text-secondary" x-show="!isOpAllowed(op.id)"',
        '                 :data-testid="\'op-\' + op.id + \'-reason\'" x-text="reasonBlocked(op.id)"></div>',
        '          </div>',
        '        </template>',
        '      </div>',
        '      <template x-if="confirm">',
        '        <div class="alert alert-warning" role="alertdialog" data-testid="server-ops-confirm">',
        '          <p x-text="OPS.find(o => o.id === confirm.opId).why"></p>',
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
        isOpAllowed: isOpAllowed, opArgv: opArgv,
        parseUnitState: parseUnitState, unitStatesFrom: unitStatesFrom, STATUS_UNITS: STATUS_UNITS,
        parseRelayLog: parseRelayLog, summarise: summarise,
        blankState: blankState, serverOpsUi: serverOpsUi,
        TEMPLATE: TEMPLATE, mount: mount
    };
    root.PilotServerOpsUi = PilotServerOpsUi;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotServerOpsUi;
})(typeof window !== 'undefined' ? window : globalThis);
