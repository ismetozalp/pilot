// core/ostarget.js — os-release parsing, per-component arch mapping, init check.
//
// Pure: no cockpit, no I/O, no DOM. It answers exactly three questions about a
// provisioned target: which OS is this, which archive do I download for it, and
// can I install a systemd unit.
//
// The arch table is deliberately NOT shared between the two upstream projects.
// rustdesk/rustdesk-server publishes arm64v8/armv7; lejianwen/rustdesk-api
// publishes arm64/armv7l — for the same machine. One shared table would produce a
// 404 on half of all ARM installs, so the mapping is per-component and asserted.
'use strict';
(function (root) {
    // Under node the sibling module is required relative to this file; in the
    // browser errors.js has already run and put PilotErrors on the global.
    const Errors = (typeof module !== 'undefined' && module.exports)
        ? require('./errors.js')
        : root.PilotErrors;

    // TEMPORARY FORK -- switch back to rustdesk/rustdesk-server when upstream
    // fixes this. Official hbbs 1.1.16 (the newest official release, 2026-07-20)
    // cannot serve a RustDesk client >= 1.4.1 that is SIGNED IN to the API: the
    // client fails every connection, while the same client signed out works.
    // Since Pilot exists to manage the address book, and the address book
    // requires being signed in, the official server cannot run a working Pilot
    // deployment. Measured on a live 1.4.9 client against both servers.
    //
    // The fork tracks the CLIENT version line (1.4.x) rather than the 1.1.x
    // server line, publishes the same asset names and the same three binaries,
    // and needs no other change to the plan.
    //
    // Upstream to watch: https://github.com/rustdesk/rustdesk-server/releases
    // and https://github.com/lejianwen/rustdesk-api/issues/482
    const SERVER_VERSION = '1.4.3';
    const SERVER_UPSTREAM = 'wy414012/rustdesk-server';
    const SERVER_IS_FORK = true;
    const API_VERSION = '2.7';
    const SERVER_BASE =
        'https://github.com/' + SERVER_UPSTREAM + '/releases/download/' + SERVER_VERSION + '/';
    const API_BASE =
        'https://github.com/lejianwen/rustdesk-api/releases/download/v' + API_VERSION + '/';

    const MAX_TEXT = 262144;   // an os-release larger than this is not an os-release
    const MAX_FIELD = 256;
    const CONTROL = /[\x00-\x1f\x7f]/g;

    // `uname -m` spellings we accept, mapped to the four arch ids C1's Plan uses.
    const ARCH = {
        x86_64: 'amd64', amd64: 'amd64',
        aarch64: 'arm64', arm64: 'arm64',
        armv7l: 'armv7l',
        i686: 'i386', i386: 'i386', i586: 'i386'
    };

    // Digests for the FORK's tag 1.4.3, double-verified: the GitHub releases API
    // `digest` field AND a local sha256sum of each downloaded zip. Both agree.
    // The zips carry the same three binaries (hbbs, hbbr, rustdesk-utils) in the
    // same flat layout as the official release, so the unpack step is unchanged.
    const SERVER_ASSETS = {
        amd64: { name: 'rustdesk-server-linux-amd64.zip',
            sha256: '1feb4d64de2b7af684a44bd4315db3de29ee4e9a630cfbaea5f598ebd85055ac' },
        arm64: { name: 'rustdesk-server-linux-arm64v8.zip',
            sha256: '80034ffbe4514d1c6a56af159f5783b06b8c2eb01c8df6e9669a1e6f5e2b2045' },
        armv7l: { name: 'rustdesk-server-linux-armv7.zip',
            sha256: '610c15203355526d0d80878182807c2f9d2a4074eee3c57b3164878941cb187f' },
        i386: { name: 'rustdesk-server-linux-i386.zip',
            sha256: 'eaebf49ef54ba69af94e81cdddcc5007806316848058271b9499c380d2b105eb' }
    };

    // Digests double-verified (GitHub API digest AND local sha256sum) for v2.7.
    // i386 is deliberately absent: upstream publishes no 32-bit build at all.
    const API_ASSETS = {
        amd64: { name: 'linux-amd64.tar.gz',
            sha256: 'd0689a353fd756815cfe560ce7cb98f764602de60d0403b51db4e5a9bd84d22a' },
        arm64: { name: 'linux-arm64.tar.gz',
            sha256: '830bbab588c39c7d39130e28fe4aa01f00150ebaa0385a48d1fc664cba33ccfc' },
        armv7l: { name: 'linux-armv7l.tar.gz',
            sha256: '9e3b520999cc060441c56c0713fc4d49387ec957670ce9a6e8453352882c75f3' }
    };

    const FAMILY = {
        fedora: 'fedora', rhel: 'fedora', centos: 'fedora', rocky: 'fedora',
        almalinux: 'fedora', ol: 'fedora', amzn: 'fedora',
        debian: 'debian', ubuntu: 'debian', raspbian: 'debian', linuxmint: 'debian',
        opensuse: 'suse', 'opensuse-leap': 'suse', 'opensuse-tumbleweed': 'suse',
        sles: 'suse', sled: 'suse',
        arch: 'arch', archarm: 'arch', manjaro: 'arch'
    };

    // A bounded, printable rendering of arbitrary input for an error message.
    // Raw `uname -m` output reaches the user's screen through here, so escape
    // sequences and unbounded length are stripped rather than forwarded.
    function label(v) {
        let s;
        try {
            s = v === null ? 'null'
                : typeof v === 'undefined' ? 'undefined'
                    : typeof v === 'object' ? Object.prototype.toString.call(v)
                        : String(v);
        } catch (e) {
            s = '[unprintable]';
        }
        return s.replace(CONTROL, '?').slice(0, 40);
    }

    function clean(s) {
        return String(s).replace(CONTROL, '').slice(0, MAX_FIELD).trim();
    }

    function unquote(v) {
        let s = String(v);
        if (s.length >= 2 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"')
            return s.slice(1, -1).replace(/\\([\\"$`])/g, '$1');
        if (s.length >= 2 && s.charAt(0) === "'" && s.charAt(s.length - 1) === "'")
            return s.slice(1, -1);
        return s;
    }

    const WANTED = { ID: 'id', ID_LIKE: 'id_like', VERSION_ID: 'version_id',
        PRETTY_NAME: 'pretty_name' };
    const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

    function parseOsRelease(text) {
        const out = { id: '', id_like: '', version_id: '', pretty_name: '' };
        if (typeof text !== 'string' || text === '') return out;
        const lines = text.slice(0, MAX_TEXT).split(/\r?\n/);
        for (const raw of lines) {
            const line = raw.trim();
            if (line === '' || line.charAt(0) === '#') continue;
            const m = ASSIGN.exec(line);
            if (!m) continue;
            const key = WANTED[m[1].toUpperCase()];
            if (!key) continue;
            // Shell semantics: a later assignment overrides an earlier one.
            out[key] = clean(unquote(m[2]));
        }
        out.id = out.id.toLowerCase();
        out.id_like = out.id_like.toLowerCase();
        return out;
    }

    function family(rel) {
        if (!rel || typeof rel !== 'object' || Array.isArray(rel)) return 'unknown';
        const id = clean(rel.id === undefined || rel.id === null ? '' : rel.id).toLowerCase();
        if (FAMILY[id]) return FAMILY[id];
        const like = clean(rel.id_like === undefined || rel.id_like === null
            ? '' : rel.id_like).toLowerCase();
        for (const token of like.split(/\s+/)) if (FAMILY[token]) return FAMILY[token];
        return 'unknown';
    }

    function normalizeArch(raw) {
        if (typeof raw !== 'string') return null;
        const s = raw.replace(CONTROL, '').trim().toLowerCase();
        if (!/^[a-z0-9_]{1,16}$/.test(s)) return null;
        return ARCH[s] || null;
    }

    function asset(table, raw, what, hint) {
        const a = normalizeArch(raw);
        const e = a ? table[a] : null;
        if (!e) {
            throw Errors.create('ARCH_UNSUPPORTED',
                'No ' + what + ' build for architecture "' + label(raw) + '"' + hint(a),
                { arch: a, raw: label(raw) });
        }
        const base = table === SERVER_ASSETS ? SERVER_BASE : API_BASE;
        return { arch: a, name: e.name, url: base + e.name, sha256: e.sha256 };
    }

    function serverAsset(raw) {
        return asset(SERVER_ASSETS, raw, 'RustDesk server', () => '.');
    }

    function apiAsset(raw) {
        return asset(API_ASSETS, raw, 'API server', (a) => a === 'i386'
            // The one case that is NOT a typo: the machine is fine, the project
            // simply publishes no 32-bit build. Saying so is the difference
            // between a clear stop and a half-finished install.
            ? ': the API server has no 32-bit build. Install the RustDesk server ' +
              'on its own here, and run the API server on a 64-bit host.'
            : '.');
    }

    function initOk(init) { return init === 'systemd'; }

    function asError(kind, message) {
        const e = Errors.create(kind, message, null);
        return { kind: e.kind, message: e.message,
            remediation: e.remediation === undefined ? null : e.remediation };
    }

    function evaluate(detection) {
        const d = (detection && typeof detection === 'object' && !Array.isArray(detection))
            ? detection : {};
        const osRelease = typeof d.os_release === 'string'
            ? parseOsRelease(d.os_release)
            : parseOsRelease(serialize(d.os_release));
        const fam = family(osRelease);
        const rawArch = typeof d.arch === 'string' ? d.arch : '';
        const arch = normalizeArch(d.arch);
        const init = d.init === 'systemd' ? 'systemd' : 'other';

        const warnings = [];
        const errors = [];
        let sAsset = null;
        let aAsset = null;

        if (!osRelease.id) {
            errors.push(asError('OS_UNSUPPORTED',
                'Cannot identify the operating system: /etc/os-release has no usable ID.'));
        } else if (fam === 'unknown') {
            warnings.push('Unrecognised distribution "' + osRelease.id +
                '". Pilot installs from generic archives, so this is expected to work, ' +
                'but it is not one of the distributions Pilot is tested against.');
        }

        try { sAsset = serverAsset(d.arch); }
        catch (e) { errors.push(asError(e.kind, e.message)); }

        try { aAsset = apiAsset(d.arch); }
        catch (e) {
            // Do not report the same unsupported arch twice: when the machine is
            // unsupported outright, serverAsset already said so. Only the i386
            // partial case adds information here.
            if (arch) errors.push(asError(e.kind, e.message));
        }

        if (!initOk(init)) {
            errors.push(asError('NO_SYSTEMD',
                'The target does not run systemd, so Pilot cannot install services ' +
                'automatically. Use manual mode.'));
        }

        return { osRelease: osRelease, family: fam, rawArch: rawArch, arch: arch,
            init: init, serverAsset: sAsset, apiAsset: aAsset,
            warnings: warnings, errors: errors, ok: errors.length === 0 };
    }

    // Turn a Detection.os_release OBJECT back into os-release text so exactly one
    // parser (and one sanitiser) is used for both input shapes.
    function serialize(obj) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
        const out = [];
        for (const k of Object.keys(WANTED)) {
            const v = obj[WANTED[k]];
            if (typeof v !== 'string') continue;
            out.push(k + '=' + JSON.stringify(v.replace(CONTROL, '')));
        }
        return out.join('\n');
    }

    const PilotOsTarget = {
        SERVER_VERSION: SERVER_VERSION, API_VERSION: API_VERSION,
        SERVER_UPSTREAM: SERVER_UPSTREAM, SERVER_IS_FORK: SERVER_IS_FORK,
        SERVER_BASE: SERVER_BASE, API_BASE: API_BASE,
        parseOsRelease: parseOsRelease, family: family, normalizeArch: normalizeArch,
        serverAsset: serverAsset, apiAsset: apiAsset, initOk: initOk, evaluate: evaluate
    };
    root.PilotOsTarget = PilotOsTarget;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotOsTarget;
})(typeof window !== 'undefined' ? window : globalThis);
