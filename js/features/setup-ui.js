// features/setup-ui.js — the six-step provisioning wizard.
//
// Everything in this file above the "cockpit I/O" divider is pure: given the same
// state and the same JSON line it produces the same result, with no DOM, no
// cockpit and no clock. That is deliberate — the riskiest thing this screen does
// is decide whether a run SUCCEEDED, and that decision has to be testable without
// a server.
//
// Two rules shape the rest:
//   * Manual mode renders PilotProvisionPlan.manualScript(plan) — the same plan
//     object the executor gets, never a second implementation that can drift.
//   * Redaction is NOT done here. pilot-exec redacts at the emitter (C4); this
//     file only ever renders what it was given.
'use strict';
(function (root) {
    const underNode = (typeof module !== 'undefined' && module.exports);
    const Plan = underNode ? require('../core/provision-plan.js') : root.PilotProvisionPlan;
    // GAP C (task 33): PilotServers.writeSshCredential() is what persistCredential()
    // below calls once "remember for day-2 operations" is honoured. A live lookup
    // (not a const captured once at load) so a test can substitute a fake
    // PilotServers — the same shape js/features/server-ops-ui.js's own servers()
    // already uses for exactly this reason. index.html loads js/core/servers.js
    // well before this file (C7 order), so root.PilotServers is already set in
    // the browser by the time this ever runs.
    function servers() {
        if (root.PilotServers) return root.PilotServers;
        return underNode ? require('../core/servers.js') : null;
    }

    // js/core/tls.js owns every TLS decision — the tier vocabulary, domain
    // validation, the DNS pre-flight comparison and the ACME failure
    // classification. This module collects input and calls it; it never
    // re-implements any of that (a second definition of "is this a certifiable
    // domain" is exactly the divergence js/features/overview.js was carrying).
    // A live lookup rather than a const captured at load, for the same reason
    // servers() below is: a test can substitute a fake, and index.html loads
    // js/core/tls.js well before this file (C7 order).
    function tls() {
        if (root.PilotTls) return root.PilotTls;
        return underNode ? require('../core/tls.js') : null;
    }

    // Same late-bound accessor, for the shared remediation sentence table.
    function consoleView() {
        if (root.PilotConsoleView) return root.PilotConsoleView;
        return underNode ? require('../core/console-view.js') : null;
    }

    // The TLS step sits between detect and ports because BOTH of the things it
    // feeds only exist once the other two have run: the sslip tier needs the
    // public IP that --detect reports, and the ports step must list 80/443 (and
    // must NOT list 21114 as internet-facing) only when a tier was actually
    // chosen. Visible for local and ssh alike — a localhost install needs TLS
    // exactly as much as a remote one.
    const STEP_IDS = ['target', 'hostkey', 'detect', 'tls', 'ports', 'execute', 'handover'];
    const STEP_TITLES = {
        target: 'Target',
        hostkey: 'Host key',
        detect: 'Detection & plan',
        tls: 'TLS & domain',
        ports: 'Ports',
        execute: 'Execute',
        handover: 'Handover'
    };

    // Caps. A helper that goes wrong can emit output faster than a browser can
    // render it, and an unbounded transcript is a hung tab rather than evidence.
    const MAX_LINES = 2000;
    const MAX_LINE_CHARS = 4000;
    const MAX_NOISE = 50;
    const MAX_JSON_CHARS = 1048576;

    // Tab and newline survive; everything else in the C0 range does not. Escapes
    // only — a literal control byte in a regex does not survive copy-paste.
    const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

    function str(v) {
        if (v === null || v === undefined) return '';
        try { return String(v); } catch (e) { return ''; }
    }

    function clean(v) { return str(v).replace(CONTROL, ''); }

    // Ids, run ids and port-matrix labels are meant to be single tokens, not
    // prose — unlike a title or a shell command, whitespace inside one of these
    // is corruption (a helper that mangled a JSON field), not content, so it is
    // stripped entirely rather than merely having control bytes removed.
    function cleanTag(v) { return str(v).replace(/[\x00-\x1f\x7f\s]/g, ''); }

    // ----------------------------------------------------------- state

    function blankExec() {
        return {
            runId: null, transport: null, total: 0, steps: [],
            status: 'idle', kind: null, noise: []
        };
    }

    function blankState() {
        return {
            step: 'target',
            choices: {
                target: 'local', host: '', port: 22, user: 'root',
                auth: 'agent', password: '', pem: '', remember: false,
                // The TLS step's fields. tlsTier is one of PilotTls.TIERS
                // verbatim — never a parallel vocabulary. duckdnsToken is a
                // CREDENTIAL: it lives here for exactly as long as the wizard is
                // open, travels to pilot-exec only inside the plan's secret
                // write step (on stdin), and is never persisted, never recorded
                // in <id>.json and never put in an argv.
                tlsTier: 'none', domain: '', duckdnsSub: '', duckdnsToken: ''
            },
            hostkey: null,
            detection: null,
            // The result of the spec §6.1 DNS pre-flight: resolve the chosen
            // hostname and compare it to the target's public IP BEFORE ACME is
            // invoked, so "DNS doesn't point here yet" is reported as itself
            // instead of as an opaque ACME failure that also burnt a
            // rate-limit attempt. null until a check has actually run.
            preflight: null,
            plan: null,
            required: [],
            firewall: 'none',
            aws: { groupId: '', region: '', cidr: '' },
            exec: blankExec(),
            reach: [],
            manual: false,
            errors: {},
            // GAP C (task 33): whether persistCredential() (below) actually
            // stored a day-2 credential after this run, and why not if it
            // did not. Both start false/null on a fresh wizard and are only
            // ever touched by persistCredential() itself.
            credentialSaved: false,
            credentialSaveError: null,
            // Task 34: whether registerServer() (below) actually wrote/updated
            // this run's server record, the id it registered under, and why
            // not if it did not. Only ever touched by registerServer() itself.
            registered: false,
            registrationError: null,
            registeredServerId: null
        };
    }

    // ----------------------------------------------------------- step machine

    // The whole point of step 2: a localhost install has no host key to confirm,
    // so the step is not shown, not skipped-with-a-tick, not disabled — absent.
    function visibleSteps(state) {
        const remote = !!(state && state.choices && state.choices.target === 'ssh');
        return STEP_IDS.filter(function (id) { return remote || id !== 'hostkey'; });
    }

    function nextStep(state) {
        const v = visibleSteps(state);
        const i = v.indexOf(str(state && state.step));
        if (i < 0) return v[0];
        return i + 1 < v.length ? v[i + 1] : v[i];
    }

    function prevStep(state) {
        const v = visibleSteps(state);
        const i = v.indexOf(str(state && state.step));
        if (i < 0) return v[0];
        return i > 0 ? v[i - 1] : v[0];
    }

    // GAP B (task 33): the 'pilot:open-wizard' event js/features/overview.js's
    // "Set up TLS" CTA dispatches carries {step:'tls', serverId}, and
    // js/features/server-ops-ui.js's "Run setup" CTA dispatches the same event
    // with no step at all ({}). 'tls' is a real step of this wizard (STEP_IDS),
    // so the TLS CTA lands on it; a missing or unknown step id leaves the
    // wizard where it is. Only a step id that is a member of THIS state's own
    // visibleSteps() is honoured — jumping to an id this wizard does not
    // recognise, or one that exists but is hidden for the current target
    // (hostkey on localhost), would leave every pane's isStep(id) false and
    // the wizard body blank, which is worse than simply not moving. Pure, so
    // the mapping is unit-testable with no DOM.
    function applyWizardStep(state, detail) {
        const id = (detail && typeof detail === 'object' && typeof detail.step === 'string')
            ? detail.step : null;
        if (id && visibleSteps(state).indexOf(id) !== -1) return id;
        return state && typeof state.step === 'string' ? state.step : STEP_IDS[0];
    }

    // ------------------------------------------------------------ step: tls
    //
    // Pure. Everything below hands js/core/tls.js its OWN choices shape and
    // returns what it said; none of it re-decides anything tls.js decides.

    // The C13 choices slice tls.js reads: { tlsTier, domain, duckdns }. Built
    // from the wizard's flat fields so the wizard never has to store a nested
    // object Alpine would have to bind through.
    function tlsChoices(choices) {
        const c = (choices && typeof choices === 'object') ? choices : {};
        const tier = str(c.tlsTier) || 'none';
        return {
            tlsTier: tier,
            domain: tier === 'own' ? str(c.domain) : null,
            duckdns: tier === 'duckdns'
                ? { subdomain: str(c.duckdnsSub), token: str(c.duckdnsToken) } : null
        };
    }

    // The detection slice tls.js reads. Only the public IP matters to it.
    function tlsDetection(detection) {
        const d = (detection && typeof detection === 'object') ? detection : {};
        return { public_ip: str(d.public_ip) };
    }

    // Pure. { ok, tier, host, message } straight from PilotTls.validate(), or a
    // safe "the TLS module is not loaded" refusal — never an invented verdict.
    // tier 'none' is always ok, which is what makes TLS opt-in rather than a
    // wall in front of every install.
    function validateTls(choices, detection) {
        const T = tls();
        if (!T || typeof T.validate !== 'function') {
            return { ok: false, tier: '', host: '', kind: 'GENERIC',
                message: 'The TLS module is not loaded, so a TLS tier cannot be validated. ' +
                    'Choose "No TLS" to continue.' };
        }
        return T.validate(tlsChoices(choices), tlsDetection(detection));
    }

    // Pure. The hostname the chosen tier will certify, or '' — used to
    // pre-flight DNS, to fill the ports step's advisory, and to record the
    // domain on the server record after a successful run.
    function tlsHostFor(choices, detection) {
        const T = tls();
        if (!T || typeof T.hostFor !== 'function') return '';
        return str(T.hostFor(tlsChoices(choices), tlsDetection(detection)));
    }

    // Pure. The one-line caveat tls.js attaches to a tier (the sslip rate-limit
    // bucket in particular), shown in the UI rather than buried (spec §6.1).
    // The human label for each of PilotTls.TIERS. The ids are tls.js's own and
    // are never renamed here; this is only what the <select> shows.
    const TIER_LABELS = {
        none: 'No TLS — the web client stays disabled',
        own: "My own domain — Let's Encrypt issues the certificate",
        sslip: "Automatic sslip.io hostname — no DNS setup, shared Let's Encrypt limit",
        duckdns: 'DuckDNS — free subdomain, needs an account token'
    };

    function tlsTierLabel(id) {
        const k = str(id);
        return Object.prototype.hasOwnProperty.call(TIER_LABELS, k) ? TIER_LABELS[k] : k;
    }

    function tlsAdvisory(tier) {
        const T = tls();
        return (T && typeof T.advisory === 'function') ? str(T.advisory(tier)) : '';
    }

    // Pure. Turns a finished exec into an ACME verdict, or null when no TLS
    // step failed. classifyAcmeFailure() is what maps the helper's own output
    // onto a C6 kind (TLS_RATE_LIMITED / TLS_DNS_MISMATCH / TLS_ACME_FAILED) so
    // the handover pane can say "Let's Encrypt rate-limited this name" instead
    // of "step tls-reload exited 1".
    const ACME_MESSAGE = {
        TLS_RATE_LIMITED: "Let's Encrypt rate-limited this name, so no certificate was issued. " +
            'Wait for the limit to reset, or use your own domain or DuckDNS, which have their ' +
            'own rate-limit buckets.',
        TLS_DNS_MISMATCH: 'The certificate could not be issued because DNS for this name does not ' +
            'point at this server. Fix the record and run setup again.',
        TLS_ACME_FAILED: 'The certificate could not be issued. The TLS step\'s output above has the ' +
            'reason; everything else on this server was still provisioned.'
    };

    function acmeFailureFrom(exec) {
        const T = tls();
        const e = (exec && typeof exec === 'object') ? exec : blankExec();
        const steps = Array.isArray(e.steps) ? e.steps : [];
        for (let i = 0; i < steps.length; i++) {
            const s = steps[i];
            if (str(s.id).indexOf('tls-') !== 0 || s.status !== 'failed') continue;
            const lines = Array.isArray(s.lines) ? s.lines : [];
            const text = lines.map(function (l) { return str(l.text); }).join('\n');
            const kind = (T && typeof T.classifyAcmeFailure === 'function')
                ? T.classifyAcmeFailure(text) : 'TLS_ACME_FAILED';
            return {
                stepId: s.id,
                kind: kind,
                message: Object.prototype.hasOwnProperty.call(ACME_MESSAGE, kind)
                    ? ACME_MESSAGE[kind] : ACME_MESSAGE.TLS_ACME_FAILED
            };
        }
        return null;
    }

    // --------------------------------------------------- day-2 credential
    //
    // GAP C (task 33): PilotServers.writeSecret() had NO caller anywhere in
    // the repo, so the "remember for day-2 operations" checkbox (visible
    // only for choices.target === 'ssh' — index.html:56-71) rendered, bound,
    // and persisted nothing: js/features/server-ops-ui.js's hasCredential
    // was permanently false. Only meaningful for an SSH target: a local
    // install needs no SSH credential at all (server-ops-ui.js's own
    // loadServer() already treats id 'local' as hasCredential:true
    // unconditionally), and 'agent' auth has no secret VALUE to store in the
    // first place — remembering it is correctly a no-op, not a bug, since
    // day-2 ops over an already-trusted agent connection need nothing
    // stored. Pure, so the decision of WHAT to persist is unit-testable
    // with no DOM and no cockpit.
    function credentialToRemember(choices) {
        if (!choices || choices.remember !== true || choices.target !== 'ssh') return null;
        if (choices.auth === 'password') {
            const v = str(choices.password);
            return v ? { authType: 'password', secret: v } : null;
        }
        if (choices.auth === 'pem') {
            const v = str(choices.pem);
            return v ? { authType: 'pem', secret: v } : null;
        }
        return null;
    }

    // Pure. Derives a PilotServers.validateId()-safe id from the target
    // host. The wizard's "target" step never asks the user to NAME the
    // server being provisioned — no task has built a "register this server"
    // step — so the host is the best identifier available for keying a
    // day-2 credential today. Returns null when nothing usable survives
    // sanitisation, rather than writing under an empty or wrong id.
    function slugForHost(host) {
        const dashed = str(host).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return dashed ? dashed.slice(0, 64) : null;
    }

    // ------------------------------------------------------- registration
    //
    // Task 34: PilotServers.write() had NO callers anywhere in the repo, so no
    // shipped code path ever registered a server — the wizard could finish
    // "successfully" and every management surface (Overview, Devices,
    // Address Book, Users, Audit, Server Ops) stayed permanently empty. These
    // functions decide WHAT gets registered and under WHICH id; registerServer()
    // (below the cockpit I/O divider) is the only caller.

    // Pure. The id a provisioned target is registered — and its day-2
    // credential stored — under. 'local' for a localhost target, matching
    // FALLBACK_SERVER/server-ops-ui.js's own hard-coded 'local' id elsewhere.
    // For ssh, slugForHost(host) alone (the id persistCredential() used before
    // this task) would let two targets that differ ONLY by port collide on
    // the same record — flagged as a Minor in the task 33 review and closed
    // HERE, because registerServer() is what actually makes that collision
    // bite (one provisioned server silently overwriting another's record).
    // The port is therefore folded into the id whenever it is not the SSH
    // default (22), capped so the combined id still satisfies
    // PilotServers.ID_RE / MAX_ID_LEN. persistCredential() below is switched
    // to call this SAME function, so a stored credential is always keyed
    // under the exact id its server record is registered under.
    function idForChoices(choices) {
        const c = (choices && typeof choices === 'object') ? choices : {};
        if (str(c.target) !== 'ssh') return 'local';
        const base = slugForHost(c.host);
        if (!base) return null;
        const raw = c.port;
        const port = (typeof raw === 'number' && isFinite(raw) && Math.floor(raw) === raw)
            ? Math.floor(raw) : 22;
        if (port === 22 || port < 1 || port > 65535) return base;
        const suffix = '-' + port;
        return (base.length + suffix.length <= 64 ? base : base.slice(0, 64 - suffix.length)) + suffix;
    }

    // Pure. The hbbs public key and port set to record, "as detected" rather
    // than assumed. Two cases, decided by detection alone (the same signal
    // provision-plan.js's own build() uses to choose adopt vs install):
    //   - Adopted (detection.hbbs is non-null): hbbs already existed before
    //     this run and pilot-exec never reinstalls or restarts it, so
    //     detection.hbbs.{pubkey,ports} — captured by --detect BEFORE the run
    //     — describe the real, unchanged server.
    //   - Freshly installed (detection.hbbs is null): hbbs writes its own
    //     keypair on first start, so the only place the new public key exists
    //     is the 'hbbs-key' step's captured stdout (provision-plan.js's own
    //     step of that id `cat`s exactly that file). The port set actually
    //     required for this configuration comes from `required` (this.required,
    //     populated by requiredPorts() from the very same choices this run
    //     used) rather than being re-guessed here.
    function hbbsInfoFrom(state) {
        const s = (state && typeof state === 'object') ? state : {};
        const det = s.detection;
        if (det && typeof det === 'object' && det.hbbs && typeof det.hbbs === 'object') {
            const ports = Array.isArray(det.hbbs.ports)
                ? det.hbbs.ports.filter((p) => typeof p === 'number' && isFinite(p)) : [];
            const key = (typeof det.hbbs.pubkey === 'string' && det.hbbs.pubkey.trim())
                ? det.hbbs.pubkey.trim() : null;
            return { hbbsKey: key, hbbsPorts: ports };
        }
        const exec = s.exec;
        const steps = (exec && Array.isArray(exec.steps)) ? exec.steps : [];
        let key = null;
        for (let i = 0; i < steps.length; i++) {
            if (steps[i].id !== 'hbbs-key') continue;
            const lines = Array.isArray(steps[i].lines) ? steps[i].lines : [];
            for (let j = lines.length - 1; j >= 0; j--) {
                const t = str(lines[j].text).trim();
                if (t) { key = t; break; }
            }
        }
        const req = Array.isArray(s.required) ? s.required : [];
        const seen = {};
        const ports = [];
        for (let i = 0; i < req.length; i++) {
            const r = req[i];
            if (!r || (r.component !== 'hbbs' && r.component !== 'hbbr')) continue;
            if (typeof r.port !== 'number' || seen[r.port]) continue;
            seen[r.port] = true;
            ports.push(r.port);
        }
        ports.sort((a, b) => a - b);
        return { hbbsKey: key, hbbsPorts: ports };
    }

    // Pure. The API port actually in effect: the port an ADOPTED server is
    // really listening on (detection.api.port) when there is one, otherwise
    // the same fixed default a fresh install uses (planChoicesFor()'s own
    // apiPort). Mirrors provision-plan.js's build() precedence exactly
    // (det.api ? det.api.port : ch.apiPort) — never re-derived independently.
    function apiPortFrom(state) {
        const det = state && state.detection;
        if (det && det.api && typeof det.api === 'object' &&
            typeof det.api.port === 'number' && isFinite(det.api.port)) {
            return Math.floor(det.api.port);
        }
        const P = root ? root.PilotPorts : null;
        return (P && typeof P.API_DEFAULT === 'number') ? P.API_DEFAULT : 21114;
    }

    // Pure. Builds the exact object registerServer() hands to
    // PilotServers.write() — a PilotServers.normalizeRecord()-compatible
    // shape, never a secret (writeSshCredential() is the only thing that ever
    // touches a credential, in a separate 0600 file; the DuckDNS token is
    // never persisted at all — Caddy renews over HTTP-01, so nothing needs it
    // after the record is pointed here). `existing` is the record already on
    // disk under this same id, or null on a first provision. Re-provisioning
    // the same target must UPDATE that record in place rather than create a
    // duplicate (there is only ever one id per target, by construction of
    // idForChoices()) while PRESERVING whatever this run did not itself
    // decide. tls/domain ARE decided here now that the wizard has a TLS step:
    // a run that chose a tier records tls:true and the exact hostname that
    // tier certifies, which is what makes js/features/overview.js's web-client
    // link become enabled. A run that chose 'none' carries an existing
    // record's values forward untouched rather than clobbering them — Pilot
    // does not tear down a TLS setup it merely skipped this time round.
    // createdAt is likewise preserved across re-runs. `nowIso` is passed in
    // (never read from the clock here) so this stays a pure function of its
    // inputs.
    function recordForRegistration(state, existing, nowIso) {
        const s = (state && typeof state === 'object') ? state : {};
        const c = (s.choices && typeof s.choices === 'object') ? s.choices : {};
        const id = idForChoices(c);
        const remote = str(c.target) === 'ssh';
        const base = (existing && typeof existing === 'object') ? existing : null;
        const hbbs = hbbsInfoFrom(s);
        const rawPort = c.port;
        const sshPort = (remote && typeof rawPort === 'number' && isFinite(rawPort) &&
            Math.floor(rawPort) === rawPort) ? Math.floor(rawPort) : 22;
        // Gated on validate().ok, exactly like provision-plan.js's own TLS
        // branch: a tier that was selected but never validated must not be
        // recorded as working TLS.
        const tlsOk = str(c.tlsTier) !== '' && str(c.tlsTier) !== 'none' &&
            validateTls(c, s.detection).ok === true;
        const tlsHost = tlsOk ? tlsHostFor(c, s.detection) : '';
        return {
            id: id,
            host: remote ? str(c.host) : 'localhost',
            sshPort: sshPort,
            // The account this wizard ACTUALLY connected as, recorded so day-2
            // operations reuse it instead of guessing. Guessing "root" is what
            // shipped, and on any cloud image that disables root SSH -- which is
            // most of them -- every Server Ops action hung until its alarm fired:
            // "cannot determine the remote user: id -u exited 142".
            // Local targets have no SSH user at all, hence null.
            sshUser: remote ? (str(c.user).trim() || 'root') : null,
            apiPort: apiPortFrom(s),
            tls: tlsOk ? true : (base ? base.tls === true : false),
            domain: tlsHost || ((base && base.domain) ? base.domain : null),
            hbbsKey: hbbs.hbbsKey !== null ? hbbs.hbbsKey : (base ? (base.hbbsKey || null) : null),
            hbbsPorts: hbbs.hbbsPorts.length ? hbbs.hbbsPorts
                : (base && Array.isArray(base.hbbsPorts) ? base.hbbsPorts : []),
            installDir: base ? base.installDir : undefined,
            createdAt: (base && base.createdAt) ? base.createdAt : nowIso
        };
    }

    // ----------------------------------------------------------- step 1

    const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
    const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
    const AUTHS = ['password', 'pem', 'agent'];

    // A DNS label per RFC 1123: 1-63 chars, alnum at each end, alnum/hyphen in
    // the middle. Applied per label of a dotted name, and to a bare (undotted)
    // name as a whole — a real SSH target is routinely just "server" or
    // "rustdesk" with no dot and no digit in sight, so bare names get exactly
    // the same rule as dotted ones, not a stricter invented one.
    const LABEL_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
    // Loose IPv6 literal in the bracket form ssh already requires (RFC 3986).
    const IPV6_BRACKET_RE = /^\[[0-9A-Fa-f:]+\]$/;

    function hostError(host) {
        if (host === '') return 'Enter a hostname or IP address.';
        if (host.length > 253) return 'Hostname is longer than 253 characters.';
        if (/[\x00-\x1f\x7f\s]/.test(host))
            return 'Hostname contains whitespace or control characters.';
        if (/[^\x20-\x7e]/.test(host)) return 'Hostname contains non-ASCII characters.';
        if (host.indexOf('/') >= 0) return 'Hostname contains a path separator.';
        if (IPV6_BRACKET_RE.test(host)) return '';
        // Narrow, deliberate carve-out: the bare literal "host" — the name of
        // this very field — is rejected on the theory that it is far more
        // likely to be an unedited form placeholder than a real target. This
        // is NOT a stand-in for real validation: every other bare or dotted
        // name (including ordinary short hostnames like "server", "nas" or
        // "rustdesk") is judged on RFC 1123 label rules alone, below.
        if (host === 'host') return 'Hostname is not a valid host or IP address.';
        const labels = host.indexOf('.') >= 0 ? host.split('.') : [host];
        for (let i = 0; i < labels.length; i++)
            if (!LABEL_RE.test(labels[i])) return 'Hostname is not a valid host or IP address.';
        return '';
    }

    function validateTarget(choices) {
        const c = (choices && typeof choices === 'object') ? choices : {};
        const errors = {};
        const target = str(c.target);
        if (target !== 'local' && target !== 'ssh')
            errors.target = 'Choose localhost or a remote host.';

        if (target === 'ssh') {
            const host = str(c.host);
            const hostErr = hostError(host);
            if (hostErr) errors.host = hostErr;

            const port = c.port;
            if (typeof port !== 'number' || !isFinite(port) || Math.floor(port) !== port ||
                port < 1 || port > 65535)
                errors.port = 'SSH port must be a whole number between 1 and 65535.';

            const user = str(c.user);
            if (user === '') errors.user = 'Enter the SSH username.';
            else if (!USER_RE.test(user)) errors.user = 'Username is not a valid POSIX user name.';

            const auth = str(c.auth);
            if (AUTHS.indexOf(auth) < 0)
                errors.auth = 'Choose password, key file or agent authentication.';
            else if (auth === 'password' && str(c.password) === '')
                errors.password = 'Enter the SSH password.';
            else if (auth === 'pem') {
                const pem = str(c.pem);
                if (pem === '') errors.pem = 'Paste the private key.';
                else if (pem.length > 65536) errors.pem = 'Private key is unreasonably large.';
                else if (!PEM_RE.test(pem)) errors.pem = 'That does not look like a PEM private key.';
            }
        }
        return { ok: Object.keys(errors).length === 0, errors: errors };
    }

    // ----------------------------------------------------------- step 4

    const HOST_FIREWALLS = ['firewalld', 'ufw', 'nftables'];

    // Input record: { port, proto, component, why }. The split is honest rather
    // than tidy: a recognised host backend means Pilot can add the rule itself,
    // but the same port ALSO has to pass whatever cloud or edge firewall sits in
    // front of the box, which Pilot cannot reach. Listing it only once would
    // imply Pilot had opened it end to end.
    function portRows(required, firewall) {
        const list = Array.isArray(required) ? required : [];
        const fixable = HOST_FIREWALLS.indexOf(str(firewall)) >= 0;
        const host = [];
        const cloud = [];
        for (let i = 0; i < list.length; i++) {
            const r = list[i];
            if (!r || typeof r !== 'object') continue;
            const p = r.port;
            if (typeof p !== 'number' || !isFinite(p) || Math.floor(p) !== p ||
                p < 1 || p > 65535) continue;
            const proto = str(r.proto).toLowerCase();
            if (proto !== 'tcp' && proto !== 'udp') continue;
            // component/why are prose, not tags — control characters are
            // stripped but interior spaces are content and must survive
            // ("hbbs NAT type test" is not "hbbsNATtypetest").
            const component = clean(r.component);
            const why = clean(r.why);
            if (fixable) host.push({ port: p, proto: proto, component: component, why: why, scope: 'host' });
            cloud.push({ port: p, proto: proto, component: component, why: why, scope: 'cloud' });
        }
        return { host: host, cloud: cloud, fixable: fixable };
    }

    const SG_RE = /^sg-[0-9a-f]{8,17}$/;
    const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-[0-9]$/;
    const CIDR_RE = /^[0-9]{1,3}(\.[0-9]{1,3}){3}\/[0-9]{1,2}$/;

    // The literal command the user runs themselves. Unvalidated input becomes a
    // visible placeholder rather than being interpolated: this string is meant to
    // be pasted into a shell, so it must never carry anything the user typed.
    function awsCommand(rows, opts) {
        const o = (opts && typeof opts === 'object') ? opts : {};
        const group = SG_RE.test(str(o.groupId)) ? str(o.groupId) : '<security-group-id>';
        const region = REGION_RE.test(str(o.region)) ? str(o.region) : '<region>';
        const cidr = CIDR_RE.test(str(o.cidr)) ? str(o.cidr) : '0.0.0.0/0';
        const list = Array.isArray(rows) ? rows : [];
        const seen = {};
        const perms = [];
        for (let i = 0; i < list.length; i++) {
            const r = list[i];
            if (!r || typeof r !== 'object') continue;
            const p = r.port;
            if (typeof p !== 'number' || !isFinite(p) || Math.floor(p) !== p) continue;
            const proto = str(r.proto).toLowerCase();
            if (proto !== 'tcp' && proto !== 'udp') continue;
            const key = proto + ':' + p;
            if (Object.prototype.hasOwnProperty.call(seen, key)) continue;
            seen[key] = true;
            perms.push('IpProtocol=' + proto + ',FromPort=' + p + ',ToPort=' + p +
                ',IpRanges=[{CidrIp=' + cidr + '}]');
        }
        if (perms.length === 0) return '';
        return 'aws ec2 authorize-security-group-ingress --group-id ' + group +
            ' --region ' + region + ' --ip-permissions ' + perms.join(' ');
    }

    // ----------------------------------------------------------- step 5

    const T_KINDS = ['run-start', 'step-start', 'output', 'step-end', 'run-end'];
    const RUN_STATUS = ['ok', 'partial', 'failed'];
    const STEP_STATUS = ['ok', 'skipped', 'failed'];

    function parseLine(line) {
        const text = str(line).trim();
        if (text === '' || text.charAt(0) !== '{') return null;
        if (text.length > MAX_JSON_CHARS) return null;
        let ev = null;
        try { ev = JSON.parse(text); } catch (e) { return null; }
        if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return null;
        if (T_KINDS.indexOf(str(ev.t)) < 0) return null;
        return ev;
    }

    function copyExec(exec) {
        const e = (exec && typeof exec === 'object') ? exec : blankExec();
        return {
            runId: e.runId === undefined ? null : e.runId,
            transport: e.transport === undefined ? null : e.transport,
            total: (typeof e.total === 'number' && isFinite(e.total)) ? e.total : 0,
            steps: (Array.isArray(e.steps) ? e.steps : []).map(function (s) {
                return {
                    id: s.id, title: s.title, cmd: s.cmd, status: s.status,
                    exit: s.exit, ms: s.ms,
                    lines: Array.isArray(s.lines) ? s.lines.slice() : [],
                    open: !!s.open
                };
            }),
            status: str(e.status) || 'idle',
            kind: e.kind === undefined ? null : e.kind,
            noise: Array.isArray(e.noise) ? e.noise.slice() : []
        };
    }

    function findStep(exec, id) {
        for (let i = 0; i < exec.steps.length; i++)
            if (exec.steps[i].id === id) return exec.steps[i];
        return null;
    }

    function newStep(id, title) {
        return {
            id: id, title: title || id, cmd: '', status: 'running',
            exit: null, ms: null, lines: [], open: false
        };
    }

    function pushLines(step, stream, text) {
        const parts = clean(text).split('\n');
        for (let i = 0; i < parts.length; i++) {
            if (step.lines.length >= MAX_LINES) {
                if (step.lines.length === MAX_LINES)
                    step.lines.push({
                        stream: 'stderr',
                        text: '… output truncated by Pilot after ' + MAX_LINES + ' lines'
                    });
                return;
            }
            // Trailing whitespace here is virtually always an artifact of a
            // stripped \r or a padded terminal line, never content — leading
            // whitespace (indentation) is left alone.
            step.lines.push({ stream: stream, text: parts[i].replace(/\s+$/, '').slice(0, MAX_LINE_CHARS) });
        }
    }

    function reduce(exec, event) {
        const next = copyExec(exec);
        if (!event || typeof event !== 'object' || Array.isArray(event)) return next;
        const t = str(event.t);

        if (t === 'run-start') {
            next.runId = cleanTag(event.run_id);
            next.transport = str(event.transport) === 'ssh' ? 'ssh' : 'local';
            next.total = (typeof event.steps === 'number' && isFinite(event.steps) && event.steps > 0)
                ? Math.floor(event.steps) : 0;
            next.steps = [];
            next.noise = [];
            next.status = 'running';
            next.kind = null;
            return next;
        }

        if (t === 'step-start') {
            const id = cleanTag(event.id);
            if (id === '') return next;
            let s = findStep(next, id);
            if (!s) { s = newStep(id, null); next.steps.push(s); }
            s.title = clean(event.title) || id;
            s.cmd = clean(event.cmd);
            s.status = 'running';
            s.exit = null;
            s.ms = null;
            s.lines = [];
            if (next.status === 'idle') next.status = 'running';
            if (next.total < next.steps.length) next.total = next.steps.length;
            return next;
        }

        if (t === 'output') {
            const id = cleanTag(event.id);
            if (id === '') {
                if (next.noise.length < MAX_NOISE)
                    next.noise.push(clean(event.line).trim().slice(0, MAX_LINE_CHARS));
                return next;
            }
            let s = findStep(next, id);
            if (!s) {
                s = newStep(id, null);
                next.steps.push(s);
                if (next.total < next.steps.length) next.total = next.steps.length;
            }
            pushLines(s, str(event.stream) === 'stderr' ? 'stderr' : 'stdout', event.line);
            return next;
        }

        if (t === 'step-end') {
            const id = cleanTag(event.id);
            if (id === '') return next;
            let s = findStep(next, id);
            if (!s) {
                s = newStep(id, null);
                next.steps.push(s);
                if (next.total < next.steps.length) next.total = next.steps.length;
            }
            const st = str(event.status);
            // An unrecognised status is a failure, never a success: a helper that
            // invents a word must not be able to paint a green tick.
            s.status = STEP_STATUS.indexOf(st) >= 0 ? st : 'failed';
            s.exit = (typeof event.exit === 'number' && isFinite(event.exit))
                ? Math.floor(event.exit) : null;
            s.ms = (typeof event.ms === 'number' && isFinite(event.ms) && event.ms >= 0)
                ? Math.floor(event.ms) : null;
            if (s.status === 'failed') s.open = true;
            return next;
        }

        if (t === 'run-end') {
            const st = str(event.status);
            next.status = RUN_STATUS.indexOf(st) >= 0 ? st : 'failed';
            next.kind = (event.kind === null || event.kind === undefined) ? null : clean(event.kind);
            return next;
        }

        return next;
    }

    // The banner over a failed run said "Unknown failure" while the transcript
    // directly beneath it read
    //   Create the Pilot download cache -- failed (exit 1)
    //   install: cannot create directory '/var/cache/pilot': Permission denied
    // -- the reason was already on screen, and the headline threw it away.
    // cockpit rejects the spawn on a non-zero exit with no message of its own
    // (the helper's real output is the C4 JSON on stdout, not stderr), so
    // describe()'s last resort produced that string. The transcript is the
    // better source and it is already parsed: name the step that failed and
    // quote its own last words.
    function firstFailure(exec) {
        const e = (exec && typeof exec === 'object') ? exec : blankExec();
        const steps = Array.isArray(e.steps) ? e.steps : [];
        for (let i = 0; i < steps.length; i++) {
            if (!steps[i] || steps[i].status !== 'failed') continue;
            const lines = Array.isArray(steps[i].lines) ? steps[i].lines : [];
            let reason = '';
            // stderr first -- that is where a tool explains itself.
            for (let j = lines.length - 1; j >= 0 && reason === ''; j--)
                if (lines[j] && lines[j].stream === 'stderr' && str(lines[j].text).trim() !== '')
                    reason = str(lines[j].text).trim();
            for (let j = lines.length - 1; j >= 0 && reason === ''; j--)
                if (lines[j] && str(lines[j].text).trim() !== '')
                    reason = str(lines[j].text).trim();
            const exit = (steps[i].exit === null || steps[i].exit === undefined) ? null : steps[i].exit;
            return { id: str(steps[i].id), title: str(steps[i].title), exit: exit, reason: reason };
        }
        return null;
    }

    function failureMessage(f) {
        if (!f || typeof f !== 'object') return '';
        const head = (str(f.title) || str(f.id) || 'A step') + ' failed' +
            (f.exit === null || f.exit === undefined ? '' : ' (exit ' + f.exit + ')');
        return str(f.reason) ? head + ': ' + str(f.reason) : head;
    }

    // Rows measured here win over rows inferred from the transcript: one is a
    // connection, the other is a guess about someone else's words.
    function mergeReach(fromTranscript, probed) {
        const out = [];
        const seen = {};
        const add = function (r) {
            if (!r || typeof r !== 'object') return;
            const p = typeof r.port === 'number' && isFinite(r.port) ? Math.floor(r.port) : null;
            if (p === null) return;
            const proto = str(r.proto).toLowerCase() === 'udp' ? 'udp' : 'tcp';
            const key = proto + ':' + p;
            if (Object.prototype.hasOwnProperty.call(seen, key)) return;
            seen[key] = true;
            out.push(r);
        };
        (Array.isArray(probed) ? probed : []).forEach(add);
        (Array.isArray(fromTranscript) ? fromTranscript : []).forEach(add);
        return out;
    }

    function progress(exec) {
        const e = (exec && typeof exec === 'object') ? exec : blankExec();
        const steps = Array.isArray(e.steps) ? e.steps : [];
        let done = 0;
        for (let i = 0; i < steps.length; i++) {
            const st = steps[i].status;
            if (st === 'ok' || st === 'skipped' || st === 'failed') done++;
        }
        const announced = (typeof e.total === 'number' && isFinite(e.total) && e.total > 0)
            ? Math.floor(e.total) : 0;
        const total = Math.max(announced, steps.length);
        const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        return { done: done, total: total, percent: percent };
    }

    function transcriptText(exec) {
        const e = (exec && typeof exec === 'object') ? exec : blankExec();
        const out = [];
        out.push('# pilot run ' + (e.runId || '(no run id)') +
            ' transport=' + (e.transport || 'unknown'));
        const steps = Array.isArray(e.steps) ? e.steps : [];
        for (let i = 0; i < steps.length; i++) {
            const s = steps[i];
            out.push('');
            out.push('== ' + s.id + ' — ' + (s.title || s.id));
            if (s.cmd) out.push('$ ' + s.cmd);
            const lines = Array.isArray(s.lines) ? s.lines : [];
            for (let j = 0; j < lines.length; j++)
                out.push((lines[j].stream === 'stderr' ? '2| ' : '1| ') + lines[j].text);
            out.push('-- ' + s.status + ' exit=' + (s.exit === null ? 'n/a' : s.exit) +
                (s.ms === null ? '' : ' ' + s.ms + 'ms'));
        }
        const noise = Array.isArray(e.noise) ? e.noise : [];
        if (noise.length) {
            out.push('');
            out.push('== unparsed helper output');
            for (let k = 0; k < noise.length; k++) out.push('?| ' + noise[k]);
        }
        out.push('');
        out.push('== run ' + e.status + (e.kind ? ' kind=' + e.kind : ''));
        return out.join('\n') + '\n';
    }

    const RUNID_RE = /^[0-9A-Za-z._-]{1,64}$/;

    function runPath(runId) {
        const id = str(runId);
        if (!RUNID_RE.test(id) || id.indexOf('..') >= 0 || id === '.') return null;
        return '/var/lib/pilot/runs/' + id + '.jsonl';
    }

    // ----------------------------------------------------------- step 6

    // The one rule this screen exists to enforce: a green "finished" over a
    // console nobody can reach is worse than an honest partial.
    // "Unreachable" covers two situations that need opposite responses, and
    // saying only "unreachable" is why a user who HAD opened their firewall was
    // told to go and open it again:
    //   timed out         -> the packets never arrived. Something upstream is
    //                        DROPPING them: a cloud security group or an edge
    //                        device. The server cannot see this and cannot fix
    //                        it, and no amount of ufw will change it.
    //   connection refused -> the packets DID arrive and the host answered. The
    //                        firewall is fine; nothing is listening on that port.
    // The distinction is already in the probe's own detail string; it was simply
    // being thrown away.
    function blockedReason(detail) {
        const d = str(detail).toLowerCase();
        if (d.indexOf('timed out') !== -1 || d.indexOf('timeout') !== -1)
            return 'dropped before it reached the server — open this port on the cloud or edge ' +
                'firewall (the server itself cannot do this)';
        if (d.indexOf('refused') !== -1)
            return 'the server answered but nothing is listening on this port — the firewall is ' +
                'not the problem here';
        if (d.indexOf('unreachable') !== -1 || d.indexOf('no route') !== -1)
            return 'no route to the server on this port';
        return d === '' ? '' : detail;
    }

    function handover(exec, reach) {
        const e = (exec && typeof exec === 'object') ? exec : blankExec();
        const list = Array.isArray(reach) ? reach : [];
        const blocked = [];
        for (let i = 0; i < list.length; i++) {
            const r = list[i];
            if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
            if (r.reachable === true) continue;
            const p = r.port;
            if (typeof p !== 'number' || !isFinite(p)) continue;
            blocked.push({
                port: Math.floor(p),
                proto: str(r.proto).toLowerCase() === 'udp' ? 'udp' : 'tcp',
                scope: str(r.scope) === 'host' ? 'host' : 'cloud',
                reason: blockedReason(r.detail)
            });
        }

        if (e.status === 'failed')
            return {
                status: 'failed', blocked: blocked, kind: e.kind || 'GENERIC',
                message: 'Provisioning failed. Nothing was reported as finished.'
            };

        if (blocked.length) {
            const names = blocked.map(function (b) { return b.port + '/' + b.proto; }).join(', ');
            return {
                status: 'partial', blocked: blocked, kind: 'PORT_BLOCKED',
                message: 'Partial success: ' + blocked.length + ' required port' +
                    (blocked.length === 1 ? '' : 's') + ' still unreachable — ' + names + '.'
            };
        }

        if (e.status !== 'ok')
            return {
                status: 'partial', blocked: [], kind: e.kind || 'GENERIC',
                message: 'Provisioning finished with warnings.'
            };

        return {
            status: 'ok', blocked: [], kind: null,
            message: 'Setup complete. Every required port is reachable.'
        };
    }

    // The API server prints its generated admin password once, into the journal,
    // and the verify-admin step reads it back. Two things were wrong with that:
    // the password arrived in the browser IN CLEARTEXT -- rendered into the
    // transcript, written to the persisted run file and included in "Copy full
    // transcript" -- and nothing ever captured it, so `generatedPassword` stayed
    // '' and the "don't keep the generated password" guard below could never
    // fire. Capturing it here fixes both: the value is held in memory for the
    // handover step, and scrubbed from everything that is displayed or stored.
    const ADMIN_PW_RE = /Admin Password Is:\s*(\S+)/;
    // rustdesk-api seeds exactly one account on first boot: admin, id 1
    // (verified against a real v2.7 install -- /api/admin/user/list returns a
    // single row, id=1, username=admin, is_admin=true).
    const ADMIN_USER = 'admin';
    const ADMIN_ID = 1;

    function capturePassword(exec) {
        const e = (exec && typeof exec === 'object') ? exec : blankExec();
        const steps = Array.isArray(e.steps) ? e.steps : [];
        for (let i = 0; i < steps.length; i++) {
            const lines = Array.isArray(steps[i].lines) ? steps[i].lines : [];
            for (let j = 0; j < lines.length; j++) {
                const m = ADMIN_PW_RE.exec(str(lines[j].text));
                if (m && m[1]) return m[1];
            }
        }
        return '';
    }

    // Replaces every occurrence in place. Applied to the transcript the user
    // sees AND to the raw lines handed to persist(), so the secret exists in
    // exactly one place: the field the handover step reads.
    function scrubSecret(exec, secret) {
        if (!secret || typeof secret !== 'string') return exec;
        const e = (exec && typeof exec === 'object') ? exec : blankExec();
        const steps = Array.isArray(e.steps) ? e.steps : [];
        for (let i = 0; i < steps.length; i++) {
            const lines = Array.isArray(steps[i].lines) ? steps[i].lines : [];
            for (let j = 0; j < lines.length; j++)
                lines[j].text = str(lines[j].text).split(secret).join(SECRET_MASK);
        }
        return e;
    }

    function scrubLines(raw, secret) {
        if (!secret || typeof secret !== 'string' || !Array.isArray(raw)) return raw;
        for (let i = 0; i < raw.length; i++) raw[i] = str(raw[i]).split(secret).join(SECRET_MASK);
        return raw;
    }

    const SECRET_MASK = '\u2022\u2022\u2022\u2022\u2022\u2022';

    function passwordGate(form, generated) {
        const f = (form && typeof form === 'object') ? form : {};
        const pw = str(f.password);
        const confirm = str(f.confirm);
        const errors = {};
        if (pw === '') errors.password = 'Choose a new administrator password.';
        else if (pw.length < 12) errors.password = 'Use at least 12 characters.';
        else if (pw.length > 256) errors.password = 'Use at most 256 characters.';
        else if (/[\x00-\x1f\x7f]/.test(pw))
            errors.password = 'The password contains control characters.';
        else if (pw !== pw.trim())
            errors.password = 'Remove the leading or trailing whitespace from the password.';
        else if (generated !== null && generated !== undefined && pw === str(generated))
            errors.password = 'This is still the generated password. Choose your own.';
        if (confirm !== pw) errors.confirm = 'The two passwords do not match.';
        return { ok: Object.keys(errors).length === 0, errors: errors };
    }

    // ----------------------------------------------------------- manual mode

    // Deliberately a delegation and nothing else. Manual mode is a second
    // RENDERING of one plan, not a second implementation that can drift.
    function manualFor(plan) {
        if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return '';
        if (!Plan || typeof Plan.manualScript !== 'function') return '';
        return str(Plan.manualScript(plan));
    }

    // =============================================================
    // cockpit I/O — everything below this line touches the bridge.
    // Every access is guarded so the module still loads under node.
    // =============================================================

    const Errors = underNode ? require('../core/errors.js') : root.PilotErrors;
    const EXEC = '/usr/libexec/pilot/pilot-exec';

    function two(n) { return (n < 10 ? '0' : '') + n; }

    function runIdFor(date) {
        let d = (date instanceof Date) ? date : new Date();
        if (isNaN(d.getTime())) d = new Date(0);
        return String(d.getUTCFullYear()) + two(d.getUTCMonth() + 1) + two(d.getUTCDate()) +
            'T' + two(d.getUTCHours()) + two(d.getUTCMinutes()) + two(d.getUTCSeconds()) + 'Z';
    }

    // A stream chunk can end mid-line, and half a JSON document parses as noise.
    function splitStream(buffer) {
        const parts = str(buffer).split('\n');
        const rest = parts.pop();
        return { lines: parts, rest: rest === undefined ? '' : rest };
    }

    // C2/C3: the ssh block and the credentials both travel in the stdin document.
    function sshBlock(state) {
        const c = (state && state.choices) || {};
        if (str(c.target) !== 'ssh') return null;
        const hk = state && state.hostkey;
        const confirmed = !!(hk && hk.confirmed === true && str(hk.fingerprint) !== '');
        return {
            host: str(c.host),
            port: (typeof c.port === 'number' && isFinite(c.port)) ? Math.floor(c.port) : 22,
            user: str(c.user),
            auth: AUTHS.indexOf(str(c.auth)) >= 0 ? str(c.auth) : 'agent',
            accept_fingerprint: confirmed ? str(hk.fingerprint) : null
        };
    }

    function credentialsBlock(state) {
        const c = (state && state.choices) || {};
        if (str(c.target) !== 'ssh') return null;
        const auth = str(c.auth);
        if (auth === 'password' && str(c.password) !== '')
            return { password: str(c.password), pem: null };
        if (auth === 'pem' && str(c.pem) !== '')
            return { password: null, pem: str(c.pem) };
        return null;
    }

    function detectRequest(state) {
        const remote = !!(state && state.choices && str(state.choices.target) === 'ssh');
        return {
            version: 1,
            transport: remote ? 'ssh' : 'local',
            ssh: sshBlock(state),
            credentials: credentialsBlock(state)
        };
    }

    function envelopeCtx(state, runId) {
        const remote = !!(state && state.choices && str(state.choices.target) === 'ssh');
        return {
            run_id: str(runId),
            transport: remote ? 'ssh' : 'local',
            ssh: sshBlock(state),
            credentials: credentialsBlock(state)
        };
    }

    // Feature-detected, never assumed: if core/ports.js is not loaded the step
    // says it cannot list the ports rather than rendering an empty table that
    // reads as "no ports needed".
    function requiredPorts(choices) {
        const P = root ? root.PilotPorts : null;
        if (!P || typeof P.required !== 'function') return [];
        try {
            const r = P.required(choices);
            return Array.isArray(r) ? r : [];
        } catch (e) { return []; }
    }

    // PilotProvisionPlan.build()/PilotPorts.required() need an install/firewall/TLS
    // policy shape (installHbbs, openFirewall, tlsTier, apiPort, sshPort). The
    // install and firewall halves have no step of their own in the spec, so this
    // adapter fills the same safe fixed defaults it always did: attempt an install
    // when nothing is adopted, and open the host firewall.
    //
    // The TLS half is NOT a default any more — it is whatever the wizard's own TLS
    // step collected, passed through verbatim. Hardcoding tlsTier:'none' here was
    // what made every TLS path in js/core/tls.js and js/core/provision-plan.js
    // unreachable from the UI: no plan could ever contain a tls-* step, and
    // js/features/overview.js's web-client link could only ever be disabled. Note
    // this is a pass-through, not a second gate: PilotTls.validate() inside
    // Plan.build() remains the sole authority on whether a tier is usable, so a
    // bare IP still cannot become a TLS target here.
    function planChoicesFor(choices) {
        const c = (choices && typeof choices === 'object') ? choices : {};
        const P = root ? root.PilotPorts : null;
        const target = str(c.target) === 'ssh' ? 'ssh' : 'local';
        const t = tlsChoices(c);
        return {
            target: target,
            host: (target === 'ssh' && str(c.host) !== '') ? str(c.host) : null,
            installHbbs: true,
            openFirewall: true,
            tlsTier: t.tlsTier,
            domain: t.domain,
            duckdns: t.duckdns,
            apiPort: (P && typeof P.API_DEFAULT === 'number') ? P.API_DEFAULT : 21114,
            sshPort: (P && typeof P.SSH_DEFAULT === 'number') ? P.SSH_DEFAULT : 22
        };
    }

    // The reachability step reports per-port results as ordinary transcript
    // output. Only an explicit blocked/unreachable/closed verdict counts —
    // silence is never read as success.
    const REACH_RE = /\b([0-9]{1,5})\/(tcp|udp)\b[^\n]*?\b(blocked|unreachable|closed)\b/i;

    function reachFrom(exec) {
        const e = (exec && typeof exec === 'object') ? exec : blankExec();
        const steps = Array.isArray(e.steps) ? e.steps : [];
        const out = [];
        const seen = {};
        for (let i = 0; i < steps.length; i++) {
            if (steps[i].id !== 'reachability') continue;
            const lines = Array.isArray(steps[i].lines) ? steps[i].lines : [];
            for (let j = 0; j < lines.length; j++) {
                const m = REACH_RE.exec(lines[j].text);
                if (!m) continue;
                const port = parseInt(m[1], 10);
                if (!isFinite(port) || port < 1 || port > 65535) continue;
                const proto = m[2].toLowerCase();
                const key = proto + ':' + port;
                if (Object.prototype.hasOwnProperty.call(seen, key)) continue;
                seen[key] = true;
                out.push({ port: port, proto: proto, reachable: false, scope: 'cloud' });
            }
        }
        return out;
    }

    // Every IPv4 literal in `getent ahostsv4` output. The command prints one
    // "<address> <type> <name>" line per record; PilotTls.dnsPreflight() filters
    // the list again with its own isBareIpv4(), so this deliberately over-matches
    // rather than trying to be a second address parser.
    const IPV4_RE = /(?:[0-9]{1,3}\.){3}[0-9]{1,3}/g;

    function hasSpawn() {
        return typeof cockpit !== 'undefined' && cockpit && typeof cockpit.spawn === 'function';
    }

    // pilot-exec's uncaught Fail path (main()) writes exactly one JSON line to
    // STDERR: {"t":"fatal","kind":"...","message":"..."}. With
    // { err: 'message' }, cockpit hands that whole line back as the
    // rejection's .message verbatim — so without unwrapping it here, every
    // helper failure would surface as GENERIC with a raw JSON blob as its
    // "message" instead of the kind pilot-exec actually reported.
    function unwrapFatal(text) {
        const s = str(text).trim();
        if (s.charAt(0) !== '{') return null;
        let obj = null;
        try { obj = JSON.parse(s); } catch (e) { return null; }
        if (!obj || typeof obj !== 'object' || obj.t !== 'fatal' || typeof obj.kind !== 'string')
            return null;
        return { kind: obj.kind, message: str(obj.message) || obj.kind };
    }

    // js/core/errors.js's convention for GENERIC is that the UI surfaces the raw
    // detail verbatim (§8) -- GENERIC earns no one-click remediation, so the
    // detail is the ONLY thing that says what actually went wrong. Every write
    // failure out of js/core/servers.js is GENERIC with the bridge's own
    // `problem` in detail, and 'access-denied' (a Limited-access session, the
    // Cockpit default) vs 'not-found' are two completely different next actions.
    // Dropping detail here left the registration pane saying only "could not
    // write /etc/pilot/servers/local.json", with the reason discarded.
    // A caught cockpit rejection carries .problem (a machine token) and, for
    // spawn, a .message that is USUALLY that same token -- so rendering
    // .message put "not-found" on the screen when the helper was not installed.
    // PilotErrors.problemMessage() is the prose for the ones that really
    // happen; the raw token stays available as `cause`.
    // Substituted ONLY when the message adds nothing over the token -- either
    // it is missing or it IS the token. A helper that wrote real stderr
    // ("ssh: connect to host x port 22: No route to host") is strictly more
    // specific than any sentence this table can hold, and must win.
    function problemProse(err) {
        if (!err || typeof err !== 'object') return '';
        const p = str(err.problem);
        if (p === '') return '';
        if (!Errors || typeof Errors.problemMessage !== 'function') return '';
        const msg = str(err.message).trim();
        if (msg !== '' && msg !== p) return '';
        return Errors.problemMessage(p);
    }

    function causeOf(err) {
        const d = (err && typeof err === 'object') ? err.detail : null;
        if (!d || typeof d !== 'object') return null;
        const p = str(d.problem);
        return p === '' ? null : p;
    }

    function describe(err) {
        // Checked BEFORE the kind branch: a cockpit rejection has no .kind, but
        // one that has been wrapped by a caller still carries the original
        // .problem, and the prose beats the token either way.
        const prose = problemProse(err);
        if (prose) {
            const kind = (err && typeof err === 'object' && typeof err.kind === 'string')
                ? err.kind : 'GENERIC';
            return {
                kind: kind,
                message: prose,
                cause: str(err.problem),
                remediation: (Errors && typeof Errors.remediation === 'function')
                    ? Errors.remediation(kind) : null
            };
        }
        if (err && typeof err === 'object' && typeof err.kind === 'string') {
            return {
                kind: err.kind,
                message: str(err.message),
                cause: causeOf(err),
                remediation: (Errors && typeof Errors.remediation === 'function')
                    ? Errors.remediation(err.kind) : null
            };
        }
        const unwrapped = (err && typeof err === 'object') ? unwrapFatal(err.message) : null;
        if (unwrapped) {
            return {
                kind: unwrapped.kind,
                message: unwrapped.message,
                cause: null,
                remediation: (Errors && typeof Errors.remediation === 'function')
                    ? Errors.remediation(unwrapped.kind) : null
            };
        }
        const e = (Errors && typeof Errors.create === 'function')
            ? Errors.create('GENERIC', str(err && err.message) || str(err) || 'Unknown failure', null)
            : { kind: 'GENERIC', message: str(err && err.message) || str(err) };
        return {
            kind: e.kind,
            message: str(e.message),
            cause: causeOf(err),
            remediation: (Errors && typeof Errors.remediation === 'function')
                ? Errors.remediation(e.kind) : null
        };
    }

    function fail(kind, message) {
        return (Errors && typeof Errors.create === 'function')
            ? Errors.create(kind, message, null)
            : Object.assign(new Error(message), { kind: kind });
    }

    // Task 34: registerServer()'s own notification, mirroring js/app.js's
    // module-private notifyServerChanged() and js/features/devices-ui.js's
    // emitServerChanged() exactly — same event name, same {id} detail shape,
    // same guarded/optional access to document and CustomEvent so this stays
    // safe to call from a node:test run with no DOM at all. A separate,
    // local copy rather than a cross-feature require(): overview.js's own
    // openWizardTls() dispatch is the same pattern, and setup-ui.js already
    // has no dependency on any other js/features/*.js module.
    // "Same server, new credential." notifyServerChanged() cannot express that:
    // js/app.js's switchServer() no-ops when the id is unchanged, by design, so
    // a freshly stored token was never picked up and every tab kept reporting
    // "Please log in first" against a token sitting on disk.
    function notifyCredentialsChanged(target) {
        const t = target || (root && root.document) || null;
        if (!t || typeof t.dispatchEvent !== 'function') return false;
        const CE = root && root.CustomEvent;
        if (typeof CE !== 'function') return false;
        t.dispatchEvent(new CE('pilot:credentials-changed', { detail: {}, bubbles: true }));
        return true;
    }

    function notifyServerChanged(id, target) {
        const t = target || (root && root.document) || null;
        if (!t || typeof t.dispatchEvent !== 'function') return false;
        const CE = root && root.CustomEvent;
        if (typeof CE !== 'function') return false;
        const value = (typeof id === 'string' && id.trim()) ? id.trim() : 'local';
        t.dispatchEvent(new CE('pilot:server-changed', { detail: { id: value }, bubbles: true }));
        return true;
    }

    function pilotSetupUi() {
        return Object.assign(blankState(), {
            busy: false,
            error: null,
            copied: false,
            transcriptSaved: false,
            runId: null,
            handoverResult: null,
            generatedPassword: '',
            pw: { password: '', confirm: '' },
            pwErrors: {},
            finished: false,
            // Wired by app.js: (password) => Promise. Deliberately null by
            // default and deliberately fails closed — a wizard that pretends it
            // changed the admin password is worse than one that says it cannot.
            passwordWriter: null,
            // Opt-in, and on by default: a freshly generated password nobody
            // chose is a bad thing to leave in place, but it is the user's call.
            changePassword: true,
            showGenerated: false,
            // Filled in by the user when the captured one is stale or absent.
            currentPassword: '',
            needCurrentPassword: false,
            tokenSaveError: null,
            signedIn: false,
            registeredIds: [],

            // Set by start()/checkDns() only. tlsFailure carries
            // acmeFailureFrom()'s classified verdict for a failed tls-* step.
            tlsFailure: null,

            steps() { return visibleSteps(this); },
            stepTitle(id) {
                return Object.prototype.hasOwnProperty.call(STEP_TITLES, str(id))
                    ? STEP_TITLES[str(id)] : str(id);
            },
            isStep(id) { return this.step === id; },
            // The wizard keeps NO state across a reload -- by design, since a
            // half-restored transcript would be a lie. But that stranded anyone
            // who came back to finish: the administrator password lives on the
            // handover step, and the only way there was a full re-run of a
            // 26-step install that had already succeeded. 'handover' is a
            // perfectly valid step to stand on with no run behind it (the pane
            // degrades to just the password section), so when a server is
            // already registered, offer the jump.
            async loadRegistered() {
                const S = servers();
                if (!S || typeof S.list !== 'function') return [];
                try {
                    // list() answers RECORDS, not ids -- reading their `id` is
                    // what this needs. Rendering the records themselves put
                    // "[object Object]" on the page and made registeredServerId
                    // an object, which would then have addressed the password
                    // change at nothing. Caught by driving the real page; the
                    // unit test had stubbed list() with strings, so it agreed
                    // with the mistake.
                    const rows = await S.list();
                    this.registeredIds = (Array.isArray(rows) ? rows : [])
                        .map(function (r) {
                            if (typeof r === 'string') return r;
                            // typeof, not str(): coercing a non-string id would
                            // invent a record identifier out of malformed data,
                            // and this value goes on to address a password
                            // change at a specific server.
                            return (r && typeof r === 'object' && typeof r.id === 'string') ? r.id : '';
                        })
                        .filter(function (x) { return x !== ''; });
                } catch (e) {
                    this.registeredIds = [];
                }
                return this.registeredIds;
            },
            hasRegistered() { return this.registeredIds.length > 0; },
            resumeHandover() {
                if (!this.hasRegistered()) return false;
                // The generated password is long gone on a returning visit, so
                // go straight to asking for the current one rather than making
                // the user discover that by being refused.
                if (!this.generatedPassword) this.needCurrentPassword = true;
                if (!this.registeredServerId) this.registeredServerId = this.registeredIds[0];
                this.step = 'handover';
                return true;
            },
            // nextStep() clamps at the end, so on the last step Next silently
            // did nothing -- indistinguishable from a broken button.
            isLastStep() {
                const v = visibleSteps(this);
                return v.length > 0 && v[v.length - 1] === this.step;
            },
            // describe() carries PilotErrors' remediation TOKEN ('none',
            // 'fix-dns', …). Binding that token straight to x-text printed a
            // bold "none" under every GENERIC failure — including the
            // registration failure this pane exists to explain. Everything
            // rendered goes through the shared sentence table instead.
            remediationText(e) {
                const CV = consoleView();
                const r = (e && typeof e === 'object') ? e.remediation : null;
                if (CV && typeof CV.remediationSentence === 'function') return CV.remediationSentence(r);
                return '';
            },
            // Wired in index.html: @pilot:open-wizard.document="onOpenWizard($event.detail)"
            // on #pilot-setup itself (a separate x-data scope from the outer
            // shell's tab switch in js/app.js's openWizard() — this is the
            // half of GAP B's fix that only this component can do).
            onOpenWizard(detail) { this.step = applyWizardStep(this, detail); return this.step; },

            // Alpine calls this once on mount. Deliberate fire-and-forget for
            // the same reason checkHostKey() is: init() stays synchronous, and
            // loadRegistered() owns its own failure (an empty list, never a
            // throw), so a registry that cannot be read leaves the wizard
            // exactly as it was before -- offering nothing rather than breaking.
            init() {
                this.loadRegistered();
                return true;
            },
            // §7.3: the execute pane's progress bar, "Copy full transcript" and
            // transcript region are all views OF A RUN. Before Start there is no
            // run, so they rendered as a 0% bar, a button that copies nothing
            // and an empty region -- three dead controls and no statement of
            // what to do. busy counts as "has run": the bar must appear the
            // instant Start is pressed, not only once the first step lands.
            hasRun() {
                if (this.busy) return true;
                const e = this.exec;
                return !!(e && Array.isArray(e.steps) && e.steps.length > 0);
            },
            progress() { return progress(this.exec); },
            transcript() { return transcriptText(this.exec); },
            hostPorts() { return portRows(this.required, this.firewall).host; },
            cloudPorts() { return portRows(this.required, this.firewall).cloud; },
            portsUnavailable() { return !Array.isArray(this.required) || this.required.length === 0; },
            awsLine() { return awsCommand(this.cloudPorts(), this.aws); },
            manualScript() { return manualFor(this.plan); },
            toggleStep(s) { s.open = !s.open; },

            // ---- the TLS step, rendered by index.html's pane-tls -----------
            tlsTiers() {
                const T = tls();
                return (T && Array.isArray(T.TIERS)) ? T.TIERS.slice() : ['none'];
            },
            tlsTierLabel(id) { return tlsTierLabel(id); },
            tlsAdvisory() { return tlsAdvisory(this.choices.tlsTier); },
            tlsCheck() { return validateTls(this.choices, this.detection); },
            tlsHost() { return tlsHostFor(this.choices, this.detection); },
            tlsOn() { return str(this.choices.tlsTier) !== 'none'; },
            detectedIp() { return str(this.detection && this.detection.public_ip); },

            // Clears the per-step validation errors on the way out, exactly as
            // next() does on the way in: index.html's target pane renders every
            // entry in `errors`, so a TLS message left behind would reappear
            // there as if the target were wrong.
            back() { this.errors = {}; this.step = prevStep(this); },

            next() {
                this.errors = {};
                if (this.step === 'target') {
                    const r = validateTarget(this.choices);
                    this.errors = r.errors;
                    if (!r.ok) return false;
                }
                if (this.step === 'hostkey' && !(this.hostkey && this.hostkey.confirmed === true)) {
                    this.errors = { hostkey: 'Confirm the host key fingerprint before continuing.' };
                    return false;
                }
                // Detection is what PRODUCES the plan, and every step after this
                // one consumes it: ports lists what the plan needs opened, and
                // start() has nothing to run without it. Leaving here without a
                // plan walked the user to an Execute pane whose Start button
                // could only ever fail, past two steps that had nothing to show.
                if (this.step === 'detect' && !this.plan) {
                    this.errors = { detect: 'Run detection first — Pilot needs a plan before it can continue.' };
                    return false;
                }
                if (this.step === 'tls') {
                    // PilotTls.validate() is the authority (the same one
                    // provision-plan.js's own gate calls), so a bare IP, an
                    // unresolvable tier or a missing DuckDNS token stops here
                    // with tls.js's own message rather than a second opinion.
                    const v = validateTls(this.choices, this.detection);
                    if (!v.ok) {
                        this.errors = { tls: v.message };
                        return false;
                    }
                    // The ports step is next and its content DEPENDS on the tier
                    // (80/443 instead of an internet-facing 21114), so the plan
                    // and the port list are rebuilt here rather than being left
                    // as detect() built them before a tier existed.
                    if (!this.rebuildPlan()) return false;
                }
                const from = this.step;
                this.step = nextStep(this);
                // Spec §6.1: resolve the chosen hostname and compare it to the
                // server's public IP before ACME is ever invoked. Fire-and-forget
                // for the same reason checkHostKey() is — next() stays
                // synchronous and checkDns() owns its own error state — and
                // start() re-runs it as the authoritative gate regardless.
                if (from === 'tls' && this.tlsOn()) this.checkDns();
                // Entering the host-key step for the first time (or re-entering
                // it after Back — the host may have changed) has to actually run
                // the check: nothing else in this component ever calls
                // checkHostKey(), and a wizard that lands on a blank fingerprint
                // pane with no request in flight is stuck forever. next() itself
                // stays synchronous (existing callers and tests depend on that);
                // checkHostKey() manages its own busy/error state, so this is a
                // deliberate fire-and-forget, not an unhandled-rejection risk —
                // every throwing path inside checkHostKey() is already caught.
                if (this.step === 'hostkey' && from !== 'hostkey' && !this.busy) this.checkHostKey();
                return true;
            },

            // The confirmation is now a checkbox, so it must be reversible: a
            // user who ticks it, reads the fingerprint again and thinks better
            // of it has to be able to withdraw. next() gates on
            // hostkey.confirmed === true, so clearing it really does block the
            // wizard again -- untick is not cosmetic.
            unacceptHostKey() {
                if (!this.hostkey) return false;
                this.hostkey.confirmed = false;
                return true;
            },

            acceptHostKey() {
                if (!this.hostkey) return false;
                // A changed key is a hard stop (C6) — never a confirm dialog.
                if (this.hostkey.changed === true) {
                    this.error = describe(fail('SSH_HOSTKEY_CHANGED',
                        'The host key for this server has changed. Pilot will not continue.'));
                    return false;
                }
                this.hostkey.confirmed = true;
                return true;
            },

            async checkHostKey() {
                if (this.busy) return false;
                this.busy = true;
                this.error = null;
                // pilot-exec exits non-zero (EXIT_HOSTKEY_CHANGED) exactly when
                // the key changed — which is the ONE result this pane most needs
                // to show. A plain `await p` would lose it: cockpit rejects the
                // promise on a non-zero exit and the resolved value is never
                // produced. Streaming (like --run) captures the JSON line
                // regardless of how the process exits.
                let raw = '';
                try {
                    if (!hasSpawn()) throw fail('GENERIC', 'This page cannot reach the system helper.');
                    const p = cockpit.spawn([EXEC, '--check-hostkey'],
                        { superuser: 'require', err: 'message' });
                    if (typeof p.input === 'function')
                        p.input(JSON.stringify({ host: str(this.choices.host), port: this.choices.port }));
                    if (typeof p.stream === 'function') p.stream((chunk) => { raw += str(chunk); });
                    const out = await p;
                    if (raw.trim() === '') raw = str(out);
                } catch (e) {
                    if (raw.trim() === '') {
                        // Nothing usable was ever written to stdout (e.g.
                        // SSH_UNREACHABLE raised before the first line) — this is
                        // a real failure, not a CHANGED key, so there is nothing
                        // to fall through and parse.
                        this.hostkey = null;
                        this.error = describe(e);
                        this.busy = false;
                        return false;
                    }
                    // Fall through: a non-zero exit with a captured line is
                    // exactly the CHANGED-key shape, and the line is still parsed
                    // below like any other result.
                }
                try {
                    // Real shape (pilot-exec --check-hostkey, C3): exactly
                    // {fingerprint, known, kind}, kind one of
                    // OK | SSH_HOSTKEY_UNKNOWN | SSH_HOSTKEY_CHANGED. There is no
                    // `changed` field — CHANGED is this exact kind, nothing else.
                    const parsed = JSON.parse(raw.trim());
                    const kind = str(parsed.kind);
                    this.hostkey = {
                        fingerprint: clean(parsed.fingerprint),
                        known: parsed.known === true,
                        changed: kind === 'SSH_HOSTKEY_CHANGED',
                        confirmed: false
                    };
                    if (this.hostkey.changed) {
                        // Surfaced immediately — never wait for the user to click
                        // Accept to learn the connection is refused outright.
                        this.error = describe(fail('SSH_HOSTKEY_CHANGED',
                            'The host key for this server has changed. Pilot will not continue.'));
                    }
                    return true;
                } catch (e) {
                    this.hostkey = null;
                    this.error = describe(fail('GENERIC',
                        'The helper returned no usable host-key result.'));
                    return false;
                } finally {
                    this.busy = false;
                }
            },

            // The measurement the handover verdict was always supposed to rest
            // on: can THIS host open a connection to the ports the plan says are
            // required? Failure to probe is not failure to reach -- an
            // unavailable helper yields [] and the verdict falls back to the
            // transcript, rather than inventing a blocked port.
            async probeReach() {
                const want = Array.isArray(this.required) ? this.required : [];
                if (!want.length || !hasSpawn()) return [];
                const host = str(this.choices.target) === 'ssh' ? str(this.choices.host) : '127.0.0.1';
                if (!host) return [];
                const ports = want
                    .filter(function (r) { return r && typeof r.port === 'number'; })
                    .map(function (r) {
                        return { port: r.port, proto: str(r.proto).toLowerCase() === 'udp' ? 'udp' : 'tcp' };
                    });
                if (!ports.length) return [];
                try {
                    const p = cockpit.spawn([EXEC, '--probe-ports'],
                        { superuser: 'require', err: 'message' });
                    if (typeof p.input === 'function') p.input(JSON.stringify({ host: host, ports: ports }));
                    const out = await p;
                    const parsed = JSON.parse(str(out).trim());
                    const rows = (parsed && Array.isArray(parsed.results)) ? parsed.results : [];
                    return rows
                        // `null` means "not probeable" (udp), which is not the
                        // same as blocked and must not be reported as either.
                        .filter(function (r) { return r && r.reachable !== null && r.reachable !== undefined; })
                        .map(function (r) {
                            return {
                                port: r.port,
                                proto: str(r.proto).toLowerCase() === 'udp' ? 'udp' : 'tcp',
                                reachable: r.reachable === true,
                                // The plan opened the host firewall itself, so a
                                // port still unreachable from here is upstream:
                                // a cloud security group or an edge device.
                                scope: 'cloud',
                                detail: str(r.detail)
                            };
                        });
                } catch (e) {
                    return [];
                }
            },

            async detect() {
                if (this.busy) return false;
                this.busy = true;
                this.error = null;
                try {
                    if (!hasSpawn()) throw fail('GENERIC', 'This page cannot reach the system helper.');
                    const p = cockpit.spawn([EXEC, '--detect'], { superuser: 'require', err: 'message' });
                    if (typeof p.input === 'function') p.input(JSON.stringify(detectRequest(this)));
                    const det = JSON.parse(str(await p));
                    if (!det || typeof det !== 'object')
                        throw fail('GENERIC', 'The helper returned no detection result.');
                    this.detection = det;
                    this.firewall = str(det.firewall) || 'none';
                    this.plan = Plan.build(det, planChoicesFor(this.choices));
                    this.required = requiredPorts(planChoicesFor(this.choices));
                    return true;
                } catch (e) {
                    this.detection = null;
                    this.plan = null;
                    this.error = describe(e);
                    return false;
                } finally {
                    this.busy = false;
                }
            },

            // Rebuilds the plan and the required-port list from the detection
            // already on hand plus the CURRENT choices. Called when the TLS step
            // is left, because both depend on the tier. Returns false (and shows
            // the reason) rather than leaving a stale plan behind.
            rebuildPlan() {
                if (!this.detection) {
                    this.error = describe(fail('GENERIC',
                        'There is no detection result to rebuild the plan from. Run detection first.'));
                    return false;
                }
                try {
                    const pc = planChoicesFor(this.choices);
                    this.plan = Plan.build(this.detection, pc);
                    this.required = requiredPorts(pc);
                    this.error = null;
                    return true;
                } catch (e) {
                    this.plan = null;
                    this.error = describe(e);
                    return false;
                }
            },

            // The resolver seam. `getent ahostsv4` asks NSS on the Cockpit host —
            // the same vantage point the reachability probe uses, and the only
            // one available under `connect-src 'self'` (a browser DNS query is
            // not a thing, and cockpit.http belongs to js/core/api-io.js alone).
            // Returns { resolved, resolvable }: `resolvable:false` means the
            // lookup itself could not be performed and NOTHING may be concluded
            // from it, which is deliberately different from "resolved to nothing"
            // (getent's exit status 2, a real "this name has no A record").
            async resolveHost(host) {
                const name = str(host);
                if (!name || !hasSpawn()) return { resolved: [], resolvable: false };
                try {
                    const out = str(await cockpit.spawn(['getent', 'ahostsv4', name],
                        { err: 'message' }));
                    return { resolved: out.match(IPV4_RE) || [], resolvable: true };
                } catch (e) {
                    if (e && e.exit_status === 2) return { resolved: [], resolvable: true };
                    return { resolved: [], resolvable: false };
                }
            },

            // Spec §6.1's DNS pre-flight. PilotTls.dnsPreflight() does the
            // comparing; this only supplies the two facts it needs. A verdict of
            // TLS_DNS_MISMATCH is the one that BLOCKS the run (start() below):
            // issuing anyway would fail and burn a rate-limit attempt. Anything
            // else — no public IP to compare against, or no resolver at all — is
            // recorded as "not checked" and never blocks, because a pre-flight
            // that could not run is not evidence of a problem.
            async checkDns() {
                const T = tls();
                const host = this.tlsHost();
                if (!this.tlsOn() || !host || !T || typeof T.dnsPreflight !== 'function') {
                    this.preflight = null;
                    return null;
                }
                const r = await this.resolveHost(host);
                if (!r.resolvable) {
                    this.preflight = {
                        ok: false, checked: false, kind: 'GENERIC', host: host, resolved: [],
                        message: 'Pilot could not look this name up from the Cockpit host, so DNS was ' +
                            'not pre-flighted. The certificate request will be attempted anyway.'
                    };
                    return this.preflight;
                }
                const p = T.dnsPreflight({
                    host: host,
                    expected: str(this.detection && this.detection.public_ip),
                    resolved: r.resolved
                });
                this.preflight = { ok: p.ok === true, checked: true, kind: p.kind, host: p.host,
                    resolved: p.resolved, message: p.message };
                return this.preflight;
            },

            ingest(line, raw) {
                const text = str(line);
                if (text.trim() === '') return;
                raw.push(text);
                const ev = parseLine(text);
                this.exec = ev
                    ? reduce(this.exec, ev)
                    : reduce(this.exec, { t: 'output', id: '', stream: 'stderr', line: text });
            },

            async start() {
                if (this.busy) return false;
                if (!this.plan || typeof this.plan !== 'object') {
                    this.error = describe(fail('GENERIC',
                        'There is no provisioning plan to run. Run detection first.'));
                    return false;
                }
                this.busy = true;
                this.error = null;
                this.copied = false;
                this.transcriptSaved = false;
                this.tlsFailure = null;
                this.exec = blankExec();
                this.runId = runIdFor(new Date());

                // Spec §6.1: "before invoking ACME, Pilot resolves the chosen
                // hostname and compares it to the server's public IP ... no
                // rate-limit attempt is burnt". This is that gate, and it runs
                // here rather than only on the TLS step because the DNS record
                // can change (or the user can go Back) between the two.
                if (this.tlsOn()) {
                    const pf = await this.checkDns();
                    if (pf && pf.kind === 'TLS_DNS_MISMATCH') {
                        this.error = describe(fail('TLS_DNS_MISMATCH', pf.message));
                        this.busy = false;
                        return false;
                    }
                }

                let envelope = null;
                try {
                    envelope = Plan.toEnvelope(this.plan, envelopeCtx(this, this.runId));
                    if (!envelope || envelope.version !== 1)
                        throw fail('GENERIC', 'The provisioning plan could not be encoded.');
                } catch (e) {
                    this.busy = false;
                    this.error = describe(e);
                    return false;
                }

                const raw = [];
                let carry = '';
                let streamed = false;
                try {
                    if (!hasSpawn()) throw fail('GENERIC', 'This page cannot reach the system helper.');
                    const p = cockpit.spawn([EXEC, '--run'], { superuser: 'require', err: 'message' });
                    // Credentials travel here and nowhere else: argv is world-readable.
                    if (typeof p.input === 'function') p.input(JSON.stringify(envelope));
                    if (typeof p.stream === 'function') p.stream((chunk) => {
                        streamed = true;
                        const split = splitStream(carry + str(chunk));
                        carry = split.rest;
                        for (let i = 0; i < split.lines.length; i++) this.ingest(split.lines[i], raw);
                    });
                    const out = await p;
                    // A bridge (or stub) with no working stream still has to produce
                    // the same transcript, so fall back to the resolved output.
                    if (!streamed) {
                        const split = splitStream(carry + str(out));
                        carry = split.rest;
                        for (let i = 0; i < split.lines.length; i++) this.ingest(split.lines[i], raw);
                    }
                    if (carry.trim() !== '') this.ingest(carry, raw);
                } catch (e) {
                    if (carry.trim() !== '') this.ingest(carry, raw);
                    if (this.exec.status === 'running' || this.exec.status === 'idle')
                        this.exec = reduce(this.exec,
                            { t: 'run-end', status: 'failed', kind: describe(e).kind });
                    this.error = describe(e);
                }

                // Prefer the transcript's own account of what went wrong over
                // whatever the process exit produced. Only GENERIC/UNKNOWN is
                // replaced: a classified kind (CHECKSUM_MISMATCH, a TLS
                // failure, a hard stop) is more specific than any step text and
                // must survive. A run that "succeeded" at the process level
                // while a step failed had no banner at all -- that is what the
                // !this.error arm covers.
                // Before anything is persisted or rendered: lift the generated
                // admin password out of the transcript and mask every trace of
                // it. persist() below writes `raw` to disk, so the order here
                // is load-bearing.
                this.generatedPassword = capturePassword(this.exec);
                if (this.generatedPassword) {
                    scrubSecret(this.exec, this.generatedPassword);
                    scrubLines(raw, this.generatedPassword);
                }

                const failed = firstFailure(this.exec);
                if (failed && (!this.error || this.error.kind === 'GENERIC' ||
                        this.error.kind === 'UNKNOWN'))
                    this.error = describe(fail('GENERIC', failureMessage(failed)));

                await this.persist(this.runId, raw);
                // reachFrom() scans the transcript for a port the TARGET called
                // blocked. `ss -ltun` never uses that word, so it always found
                // nothing and the handover always said "Every required port is
                // reachable" -- true of no measurement whatsoever. A listening
                // socket is not a reachable one: on the reference host every
                // port was listening while the cloud security group dropped the
                // API port outright, and the wizard called that a clean finish.
                // So the transcript scan stays (a target that DOES report a
                // blocked port is still believed) and a real probe from this
                // host is merged over it.
                this.reach = mergeReach(reachFrom(this.exec), await this.probeReach());
                this.handoverResult = handover(this.exec, this.reach);
                // A failed tls-* step is classified into a C6 kind rather than
                // left as "exit 1": a rate limit, a DNS mismatch and a generic
                // ACME failure need three different next actions.
                this.tlsFailure = acmeFailureFrom(this.exec);
                // Task 34: register the server the moment the console is
                // actually USABLE — that is "ok", or a warnings-only
                // "partial" where nothing REQUIRED is still blocked (handover()
                // only ever sets blocked.length > 0 for a required port, kind
                // PORT_BLOCKED — an optional-only warning leaves blocked
                // empty). A hard failure, or a partial that IS blocked on a
                // required port, must never create or update a record for a
                // server nobody can actually reach yet.
                const usable = this.handoverResult.status !== 'failed' &&
                    this.handoverResult.blocked.length === 0;
                if (usable) await this.registerServer();
                // GAP C (task 33): only once provisioning actually SUCCEEDED —
                // a partial or failed run must never persist a credential for
                // a server that turned out not to be usable.
                if (this.handoverResult.status === 'ok') await this.persistCredential();
                this.busy = false;
                return this.handoverResult.status === 'ok';
            },

            // GAP C (task 33): the "remember for day-2 operations" half of
            // start()'s success path. credentialToRemember() already refuses
            // anything but a real, non-empty password/pem on an ssh target,
            // so a false return here just means there was nothing TO store
            // (local target, agent auth, or the box was left unchecked) —
            // never a silent failure. A real failure (no PilotServers, a
            // bad host, or writeSshCredential() itself rejecting) is recorded
            // in credentialSaveError so the handover pane can say so, but
            // never blocks finish() — a stored password is a convenience,
            // not a precondition for calling the install itself done.
            //
            // Task 34: uses idForChoices(), the SAME id registerServer() below
            // registers the record under (previously slugForHost(host) alone,
            // which — unlike idForChoices() — ignored a non-default port).
            // Keeping both call sites on one function means a stored
            // credential is always keyed under the exact id its server
            // record actually gets, so server-ops-ui.js's readSecret(id,
            // 'ssh') for the now-active server can always find it.
            async persistCredential() {
                const cred = credentialToRemember(this.choices);
                if (!cred) return false;
                const id = idForChoices(this.choices);
                if (!id) {
                    this.credentialSaved = false;
                    this.credentialSaveError = describe(fail('GENERIC',
                        'Could not derive a server id from "' + str(this.choices.host) +
                        '" to store the credential under.'));
                    return false;
                }
                const Servers = servers();
                if (!Servers || typeof Servers.writeSshCredential !== 'function') {
                    this.credentialSaved = false;
                    this.credentialSaveError = null;
                    return false;
                }
                try {
                    await Servers.writeSshCredential(id, cred.authType, cred.secret);
                    this.credentialSaved = true;
                    this.credentialSaveError = null;
                    return true;
                } catch (e) {
                    this.credentialSaved = false;
                    this.credentialSaveError = describe(e);
                    return false;
                }
            },

            // Task 34: THE fix. PilotServers.write() had no caller anywhere in
            // the repo, so no shipped code path ever registered a server —
            // this is the one that now does. Reads any EXISTING record under
            // this same id first so re-provisioning the same target updates
            // it in place (recordForRegistration() preserves what the wizard
            // itself never collects) rather than creating a duplicate. Once
            // written, makes the server active and dispatches
            // 'pilot:server-changed' — the exact event index.html's shell
            // listens for to call switchServer(), the same event
            // js/features/overview.js's own switcher dispatches — so every
            // surface re-fetches against a console that is actually usable,
            // rather than leaving the user to discover the switcher
            // themselves. Never blocks finish(): a registration failure is
            // recorded in registrationError, exactly like persistCredential()
            // treats a credential failure as a convenience that did not land,
            // not a reason to fail the whole run.
            async registerServer() {
                const id = idForChoices(this.choices);
                if (!id) {
                    this.registered = false;
                    // describe() rather than the raw error: the handover pane
                    // renders kind + message + PilotErrors remediation, and one
                    // shape for every registrationError keeps that honest.
                    this.registrationError = describe(fail('GENERIC',
                        'Could not derive a server id from "' + str(this.choices.host) +
                        '" to register this server under.'));
                    return false;
                }
                const Servers = servers();
                if (!Servers || typeof Servers.write !== 'function') {
                    this.registered = false;
                    this.registrationError = null;
                    return false;
                }
                let existing = null;
                try { existing = await Servers.read(id); } catch (e) { existing = null; }
                const rec = recordForRegistration(this, existing, new Date().toISOString());
                try {
                    await Servers.write(rec);
                } catch (e) {
                    this.registered = false;
                    this.registrationError = describe(e);
                    return false;
                }
                this.registeredServerId = id;
                this.registered = true;
                this.registrationError = null;
                // Best-effort: the record is already safely written even if
                // either of these two steps fails, so a failure here is
                // recorded but never undoes the registration itself.
                if (typeof Servers.setActive === 'function') {
                    try { await Servers.setActive(id); } catch (e) { this.registrationError = describe(e); }
                }
                notifyServerChanged(id);
                return true;
            },

            // Persisted so a failed setup can be diagnosed after the page is gone.
            // The raw lines are written verbatim — pilot-exec already redacted them.
            async persist(id, raw) {
                const path = runPath(id);
                if (!path) return false;
                if (typeof cockpit === 'undefined' || !cockpit || typeof cockpit.file !== 'function')
                    return false;
                const f = cockpit.file(path, { superuser: 'require' });
                try {
                    await f.replace(raw.join('\n') + '\n');
                    this.transcriptSaved = true;
                    return true;
                } catch (e) {
                    this.transcriptSaved = false;
                    return false;
                } finally {
                    if (f && typeof f.close === 'function') f.close();
                }
            },

            async copyTranscript() {
                this.copied = false;
                const text = transcriptText(this.exec);
                try {
                    if (root.navigator && root.navigator.clipboard &&
                        typeof root.navigator.clipboard.writeText === 'function') {
                        await root.navigator.clipboard.writeText(text);
                        this.copied = true;
                        return true;
                    }
                } catch (e) { /* the transcript is on screen to select by hand */ }
                return false;
            },

            // The default writer: log into the API server Pilot has just
            // installed using the password IT generated, then set the chosen
            // one. There is no configured token at this point -- the server is
            // seconds old and nobody has signed in -- so the login is the only
            // way to obtain one. passwordWriter stays overridable because the
            // unit tests inject a recorder; production leaves it null and gets
            // this.
            async writeAdminPassword(newPassword) {
                const Api = root ? root.PilotApi : null;
                if (!Api || !Api.users || typeof Api.users.login !== 'function')
                    throw fail('API_UNREACHABLE', 'The API client is not loaded, so the password cannot be changed.');
                // "Admin Password Is:" is printed ONCE, at first-boot migration.
                // It is therefore stale the moment anyone changes it, and absent
                // entirely on a server Pilot adopted rather than installed --
                // which is exactly what happened in the field: the journal still
                // carried the original seed, the password had since been
                // changed, and the login failed with UsernameOrPasswordError.
                // So the captured value is a CONVENIENCE, not a requirement: the
                // user can always supply the current one instead.
                const signInWith = str(this.currentPassword) || str(this.generatedPassword);
                if (!signInWith) {
                    this.needCurrentPassword = true;
                    throw fail('API_AUTH_FAILED',
                        'Pilot has no administrator password to sign in with. Enter the current one below.');
                }
                // /api/admin/login needs no token, so the anonymous transport
                // app.js already wired is enough to obtain one.
                let session = null;
                try {
                    session = await Api.users.login(ADMIN_USER, signInWith);
                } catch (e) {
                    this.needCurrentPassword = true;
                    throw fail('API_AUTH_FAILED',
                        'The API server did not accept that administrator password. ' +
                        (this.currentPassword
                            ? 'Check it and try again.'
                            : 'The one Pilot read from the journal is printed only at first boot, so it is ' +
                              'stale if the password has been changed since. Enter the current one below.'),
                        { cause: str(e && e.message) });
                }
                const token = session && (session.token || (session.data && session.data.token));
                if (!token) {
                    this.needCurrentPassword = true;
                    throw fail('API_AUTH_FAILED',
                        'The API server did not accept that administrator password. Enter the current one below.');
                }

                // The token is baked into a transport at construction (api-io.js
                // keeps it out of every other module by design), so using it
                // means building one. The server's address comes from the record
                // just registered, never from the form.
                const Io = root ? root.PilotApiIo : null;
                const Servers = servers();
                if (!Io || typeof Io.transport !== 'function' || !Servers)
                    throw fail('API_UNREACHABLE', 'The API transport is not loaded.');
                const id = str(this.registeredServerId) || idForChoices(this.choices);
                const rec = await Servers.read(id);
                if (!rec) throw fail('API_UNREACHABLE',
                    'No server record for ' + id + ', so Pilot does not know where to send the change.');
                // Io.connFor(), not a hand-built Conn: this line had the same
                // bug js/app.js did, and fixing only app.js left the password
                // change still talking to host:21114 over https.
                Api.setTransport(Io.transport(Io.connFor(rec, token)));
                try {
                    await Api.users.resetPassword(ADMIN_ID, str(newPassword));
                    // Sign in AGAIN, with the password that now exists, and keep
                    // that token. Every admin surface needs one: js/app.js reads
                    // PilotServers.readSecret(id,'token') when it wires the
                    // transport, SECRET_KINDS has carried a 'token' entry from
                    // the start -- and nothing in the repo ever WROTE it. So the
                    // console authenticated as nobody and every tab answered
                    // "Please log in first", against a server that was working.
                    // The token minted above cannot be reused: it was issued for
                    // a password that no longer exists.
                    await this.storeToken(id, str(newPassword));
                } finally {
                    // Put the shell back in charge of the transport whatever
                    // happened -- and it now finds a token where there never was
                    // one.
                    notifyServerChanged(id, this.doc || (root ? root.document : null));
                }
                return true;
            },

            // Obtains a token for `password` and stores it as the server's
            // 'token' secret (0600 root:root, like every other secret -- never
            // in <id>.json). Returns false rather than throwing when there is
            // nothing to store: a console that cannot sign in is a problem to
            // report, not a reason to fail a password change that succeeded.
            async storeToken(id, password) {
                const Api = root ? root.PilotApi : null;
                const Servers = servers();
                if (!Api || !Api.users || typeof Api.users.login !== 'function' ||
                    !Servers || typeof Servers.writeSecret !== 'function') return false;
                try {
                    const session = await Api.users.login(ADMIN_USER, str(password));
                    const token = session && (session.token || (session.data && session.data.token));
                    if (!token) { this.tokenSaveError = fail('API_AUTH_FAILED',
                        'Signed in but the API server returned no token, so the console cannot authenticate.');
                        return false; }
                    await Servers.writeSecret(str(id), 'token', str(token));
                    this.tokenSaveError = null;
                    // The transport must be rebuilt to carry it; the server is
                    // unchanged, so server-changed alone would be a no-op.
                    notifyCredentialsChanged(this.doc || (root ? root.document : null));
                    return true;
                } catch (e) {
                    this.tokenSaveError = describe(e);
                    return false;
                }
            },

            // Sign in WITHOUT touching the password. Uses whatever password is
            // to hand, and asks for one if there is none -- the same fallback
            // the change flow uses, for the same reason: the generated password
            // is a first-boot artifact and is stale the moment anyone changes it.
            async signInOnly() {
                const pw = str(this.currentPassword) || str(this.generatedPassword);
                if (!pw) {
                    this.needCurrentPassword = true;
                    this.error = describe(fail('API_AUTH_FAILED',
                        'Enter the current administrator password to sign in.'));
                    return false;
                }
                this.busy = true;
                this.signedIn = false;
                this.error = null;
                try {
                    const id = str(this.registeredServerId) ||
                        (this.registeredIds.length ? this.registeredIds[0] : idForChoices(this.choices));
                    const ok = await this.storeToken(id, pw);
                    if (!ok) {
                        this.needCurrentPassword = true;
                        this.error = this.tokenSaveError ||
                            describe(fail('API_AUTH_FAILED', 'Could not sign in to this server.'));
                        return false;
                    }
                    notifyServerChanged(id, this.doc || (root ? root.document : null));
                    this.signedIn = true;
                    return true;
                } finally {
                    this.busy = false;
                }
            },

            async finish() {
                // Opt-in (spec §7.3 in spirit: never do something irreversible
                // to a user's server because a form happened to be on screen).
                // Skipping leaves the generated password in place, which is why
                // the pane shows it.
                if (!this.changePassword) {
                    // Declining the change is not declining a working console.
                    // Whatever password is in hand -- the one just captured from
                    // the journal, or the one typed above -- is what the token
                    // is minted from.
                    const pw = str(this.currentPassword) || str(this.generatedPassword);
                    if (pw) {
                        const id = str(this.registeredServerId) || idForChoices(this.choices);
                        await this.storeToken(id, pw);
                        notifyServerChanged(id, this.doc || (root ? root.document : null));
                    }
                    this.finished = true;
                    return true;
                }
                const gate = passwordGate(this.pw, this.generatedPassword);
                this.pwErrors = gate.errors;
                if (!gate.ok) return false;
                const writer = typeof this.passwordWriter === 'function'
                    ? this.passwordWriter
                    : this.writeAdminPassword.bind(this);
                this.busy = true;
                try {
                    await writer(str(this.pw.password));
                    this.pw = { password: '', confirm: '' };
                    // Once changed, the old ones are dead: stop holding either.
                    this.generatedPassword = '';
                    this.currentPassword = '';
                    this.needCurrentPassword = false;
                    this.finished = true;
                    return true;
                } catch (e) {
                    this.error = describe(e);
                    return false;
                } finally {
                    this.busy = false;
                }
            }
        });
    }

    const PilotSetupUi = {
        STEP_IDS, STEP_TITLES, MAX_LINES, MAX_LINE_CHARS, MAX_NOISE,
        blankExec, blankState, visibleSteps, nextStep, prevStep, applyWizardStep,
        tlsChoices, tlsDetection, validateTls, tlsHostFor, tlsAdvisory, tlsTierLabel,
        acmeFailureFrom,
        credentialToRemember, slugForHost,
        idForChoices, hbbsInfoFrom, apiPortFrom, recordForRegistration,
        validateTarget, portRows, awsCommand,
        parseLine, reduce, progress, transcriptText, runPath,
        firstFailure, failureMessage, capturePassword, scrubSecret, scrubLines, SECRET_MASK,
        handover, passwordGate, manualFor, mergeReach, blockedReason,
        notifyCredentialsChanged,
        runIdFor, splitStream, detectRequest, envelopeCtx, planChoicesFor, requiredPorts, reachFrom,
        notifyServerChanged,
        pilotSetupUi
    };

    root.pilotSetupUi = pilotSetupUi;
    root.PilotSetupUi = PilotSetupUi;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotSetupUi;
})(typeof window !== 'undefined' ? window : globalThis);
