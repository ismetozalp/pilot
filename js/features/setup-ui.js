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

    const STEP_IDS = ['target', 'hostkey', 'detect', 'ports', 'execute', 'handover'];
    const STEP_TITLES = {
        target: 'Target',
        hostkey: 'Host key',
        detect: 'Detection & plan',
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
                tls: 'skip', domain: ''
            },
            hostkey: null,
            detection: null,
            plan: null,
            required: [],
            firewall: 'none',
            aws: { groupId: '', region: '', cidr: '' },
            exec: blankExec(),
            reach: [],
            manual: false,
            errors: {}
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
                scope: str(r.scope) === 'host' ? 'host' : 'cloud'
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

    const PilotSetupUi = {
        STEP_IDS, STEP_TITLES, MAX_LINES, MAX_LINE_CHARS, MAX_NOISE,
        blankExec, blankState, visibleSteps, nextStep, prevStep,
        validateTarget, portRows, awsCommand,
        parseLine, reduce, progress, transcriptText, runPath,
        handover, passwordGate, manualFor
    };

    root.PilotSetupUi = PilotSetupUi;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotSetupUi;
})(typeof window !== 'undefined' ? window : globalThis);
