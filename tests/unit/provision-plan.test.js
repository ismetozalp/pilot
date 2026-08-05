// tests/unit/provision-plan.test.js — PilotProvisionPlan: plan construction across
// adopt/install (for BOTH hbbs and the API server), arch, TLS tier, firewall
// backend and transport, plus envelope construction with hostile ctx input.
// Zero I/O: every assertion is pure data.
//
// A number of cases below deliberately differ from a naive hand-rolled spec
// because this module is a thin composition of ostarget.js/ports.js/firewall.js/
// tls.js (RULE 1/2/3 of the task brief): the exact step ids, warnings and
// tolerances of THOSE modules are the ground truth, not a re-derivation here.
// In particular:
//   - firewall step ids are firewall.js's own fw-<backend>-<port>-<proto> slugs,
//     not a hand-rolled "firewall"/"firewall-<port>-<proto>" vocabulary.
//   - ostarget.js's normalizeArch() tolerates the case/whitespace a real
//     `uname -m` produces (e.g. "AMD64", "x86_64\n"), so those are NOT hostile
//     here even though a naive implementation might reject them.
//   - tls.js's normalizeDomain() treats one trailing dot as the FQDN form and
//     accepts it; duckdnsHost() lowercases before validating. Both are reused
//     verbatim rather than re-validated more strictly.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const P = require('../../js/core/provision-plan.js');
const Errors = require('../../js/core/errors.js');
const OsTarget = require('../../js/core/ostarget.js');
const Ports = require('../../js/core/ports.js');
const Firewall = require('../../js/core/firewall.js');
const Tls = require('../../js/core/tls.js');

const GOLDEN = path.join(__dirname, '..', 'fixtures', 'golden');
function golden(name) { return fs.readFileSync(path.join(GOLDEN, name), 'utf8'); }

function throwsKind(fn, kind) {
    assert.throws(fn, (e) => {
        assert.equal(e.kind, kind, 'expected kind ' + kind + ', got ' + e.kind + ': ' + e.message);
        return true;
    });
}

// A detection with an existing hbbs (adopt path) — Debian, amd64, no firewall.
function detAdopt(over) {
    const d = {
        os_release: { id: 'debian', id_like: '', version_id: '12', pretty_name: 'Debian GNU/Linux 12 (bookworm)' },
        arch: 'x86_64', init: 'systemd', firewall: 'none', egress: true, disk_free_mb: 4096,
        hbbs: { version: '1.1.16', install: 'deb', ports: [21115, 21116, 21117],
                pubkey: 'AbCdEf0123456789+/=', data_dir: '/var/lib/rustdesk-server' },
        api: null, public_ip: '203.0.113.10'
    };
    return Object.assign(d, over || {});
}
// Greenfield: nothing installed.
function detFresh(over) { return detAdopt(Object.assign({ hbbs: null }, over || {})); }

function choices(over) {
    return Object.assign({
        target: 'local', installHbbs: false, tlsTier: 'none', domain: null, duckdns: null,
        apiPort: 21114, sshPort: 22, openFirewall: false
    }, over || {});
}

function byId(plan, id) { return plan.steps.filter((s) => s.id === id)[0] || null; }

// ------------------------------------------------------------------ shape

test('the module exposes the C1 functions', () => {
    assert.equal(typeof P.build, 'function');
    assert.equal(typeof P.toEnvelope, 'function');
    assert.equal(typeof P.stepIds, 'function');
    assert.equal(typeof P.planFor, 'undefined', 'C1: there is no planFor()');
});

test('build returns the exact C1 Plan shape', () => {
    const plan = P.build(detAdopt(), choices());
    assert.deepEqual(Object.keys(plan).sort(), ['arch', 'host', 'steps', 'target', 'warnings']);
    assert.equal(plan.target, 'local');
    assert.equal(plan.host, null);
    assert.equal(plan.arch, 'amd64');
    assert.ok(Array.isArray(plan.warnings));
    assert.ok(plan.steps.length > 0);
});

test('every step carries all nine C1 keys, never omitted', () => {
    const plan = P.build(detFresh(), choices({ installHbbs: true, tlsTier: 'own',
        domain: 'rd.example.com', openFirewall: true, target: 'ssh', host: '10.0.0.9' }));
    const keys = ['argv', 'check', 'id', 'mutating', 'secret', 'sha256', 'title', 'why', 'write'];
    for (const s of plan.steps) {
        assert.deepEqual(Object.keys(s).sort(), keys, 'step ' + s.id);
        assert.equal(typeof s.mutating, 'boolean');
        assert.equal(typeof s.secret, 'boolean');
        assert.ok(Array.isArray(s.argv));
        assert.ok(s.write === null || typeof s.write === 'object');
        assert.ok(s.check === null || typeof s.check === 'object');
        assert.ok(s.sha256 === null || typeof s.sha256 === 'string');
        if (s.write !== null) {
            assert.deepEqual(s.argv, [], 'a write step must have argv []: ' + s.id);
            assert.deepEqual(Object.keys(s.write).sort(), ['content', 'mode', 'owner', 'path']);
        }
        if (s.check !== null) {
            assert.ok(Array.isArray(s.check.argv));
            assert.ok(s.check.expect === 'zero' || s.check.expect === 'nonzero');
        }
    }
});

test('step ids are unique', () => {
    const plan = P.build(detFresh(), choices({ installHbbs: true, tlsTier: 'duckdns',
        duckdns: { subdomain: 'pilotdemo', token: 'a1b2c3d4e5f6a7b8' }, openFirewall: true,
        domain: null }));
    const ids = P.stepIds(plan);
    assert.equal(ids.length, new Set(ids).size, 'duplicate step id in ' + ids.join(','));
});

test('build is pure: it mutates neither argument and is deterministic', () => {
    const d = detFresh(); const c = choices({ installHbbs: true });
    const dCopy = JSON.parse(JSON.stringify(d)); const cCopy = JSON.parse(JSON.stringify(c));
    const a = P.build(d, c);
    const b = P.build(d, c);
    assert.deepEqual(d, dCopy);
    assert.deepEqual(c, cCopy);
    assert.deepEqual(a, b);
});

// ------------------------------------------------------- adopt vs install (hbbs)

test('adopt path contains no install and no restart of the existing hbbs', () => {
    const plan = P.build(detAdopt(), choices());
    const ids = P.stepIds(plan);
    assert.ok(ids.indexOf('adopt-hbbs') !== -1);
    for (const id of ids) assert.ok(id.indexOf('install-hbbs') !== 0, 'adopt plan must not install hbbs: ' + id);
    assert.equal(ids.indexOf('hbbs-key'), -1, 'the key is read from detection when adopting');
    for (const s of plan.steps) {
        const line = s.argv.join(' ');
        assert.ok(line.indexOf('restart') === -1, 'no restart anywhere in the adopt path: ' + line);
        assert.ok(!/rustdesk-hbb[sr]/.test(line) || s.argv[0] === 'cat',
            'the only hbbs touch is reading its key: ' + line);
    }
    assert.equal(byId(plan, 'adopt-hbbs').mutating, false);
});

test('install path emits the hbbs steps in order, then the key read', () => {
    const plan = P.build(detFresh(), choices({ installHbbs: true }));
    const ids = P.stepIds(plan);
    const want = ['cache-dir', 'install-hbbs-fetch', 'install-hbbs-unpack', 'install-hbbs-data',
        'install-hbbs-unit', 'install-hbbr-unit', 'install-hbbs-reload', 'install-hbbs-enable', 'hbbs-key'];
    assert.deepEqual(ids.slice(0, want.length), want);
    assert.equal(ids.indexOf('adopt-hbbs'), -1);
    // enable --now starts, it never restarts a running unit.
    assert.deepEqual(byId(plan, 'install-hbbs-enable').argv,
        ['systemctl', 'enable', '--now', 'rustdesk-hbbs.service', 'rustdesk-hbbr.service']);
});

test('no hbbs and installHbbs false is HBBS_NOT_FOUND, not a half plan', () => {
    throwsKind(() => P.build(detFresh(), choices({ installHbbs: false })), 'HBBS_NOT_FOUND');
});

test('installHbbs true against an existing hbbs adopts and warns instead of reinstalling', () => {
    const plan = P.build(detAdopt(), choices({ installHbbs: true }));
    assert.ok(P.stepIds(plan).indexOf('adopt-hbbs') !== -1);
    assert.ok(plan.warnings.some((w) => w.indexOf('already present') !== -1), plan.warnings.join('|'));
});

// ------------------------------------------------ adopt vs install (API server)
//
// This decision is independent of hbbs's: detection.api drives it, and there is
// no choices flag for it at all — the task brief's "same for the API server"
// requirement, which the original hand-written brief implementation omitted.
//
// detection.api's shape is PINNED by the --detect task (task-13-brief.md:95,205):
// exactly { version, port, install }, install being 'binary' or 'unknown' (the
// API server is never package-installed, so 'deb' is not a legal value here).
// There is no `dir` field — every fixture below uses the real shape.

test('detection.api present adopts the API server: no fetch/install/configure, no restart', () => {
    const plan = P.build(detAdopt({ api: { version: '2.7', port: 21114, install: 'binary' } }), choices());
    const ids = P.stepIds(plan);
    assert.ok(ids.indexOf('adopt-api') !== -1);
    for (const id of ['fetch-api', 'install-dir', 'install-user', 'install', 'install-data',
        'install-own', 'configure-dir', 'configure', 'unit', 'unit-reload', 'unit-enable'])
        assert.equal(ids.indexOf(id), -1, 'adopt-api plan must not install the API server: ' + id);
    for (const s of plan.steps) assert.ok(s.argv.join(' ').indexOf('restart') === -1, s.id);
    assert.equal(byId(plan, 'adopt-api').mutating, false);
    assert.ok(plan.warnings.some((w) => w.indexOf('API server is already present') !== -1), plan.warnings.join('|'));
});

test('an install:"binary" adoption probes the systemd unit; install:"unknown" probes the process', () => {
    const bin = P.build(detAdopt({ api: { version: '2.7', port: 21114, install: 'binary' } }), choices());
    assert.deepEqual(byId(bin, 'adopt-api').argv, ['systemctl', 'is-active', 'rustdesk-api.service']);
    // 'unknown' is only reachable via a corrupted/hostile detection line in
    // practice (the real detect script always emits 'binary' when api_present),
    // but the plan must not assume a Pilot-named systemd unit exists for it.
    const unknown = P.build(detAdopt({ api: { version: '2.7', port: 21114, install: 'unknown' } }), choices());
    assert.deepEqual(byId(unknown, 'adopt-api').argv, ['pgrep', '-f', 'apimain']);
    assert.ok(byId(unknown, 'adopt-api').argv.join(' ').indexOf('systemctl') === -1);
});

test('detection.api absent installs the API server, independent of the hbbs decision', () => {
    // hbbs is adopted (detAdopt default) while the API server is freshly installed
    // (api: null) — the two decisions must not be coupled to each other.
    const plan = P.build(detAdopt({ api: null }), choices());
    const ids = P.stepIds(plan);
    assert.ok(ids.indexOf('adopt-hbbs') !== -1);
    assert.ok(ids.indexOf('adopt-api') === -1);
    assert.ok(ids.indexOf('fetch-api') !== -1);
    assert.ok(ids.indexOf('configure') !== -1);
});

test('hbbs install + API adopt (or the reverse) both work: the two decisions are independent', () => {
    const bothInstall = P.build(detFresh({ api: null }), choices({ installHbbs: true }));
    assert.ok(P.stepIds(bothInstall).indexOf('install-hbbs-fetch') !== -1);
    assert.ok(P.stepIds(bothInstall).indexOf('fetch-api') !== -1);

    const hbbsInstallApiAdopt = P.build(detFresh({ api: { version: '2.7', port: 21114, install: 'binary' } }),
        choices({ installHbbs: true }));
    const ids = P.stepIds(hbbsInstallApiAdopt);
    assert.ok(ids.indexOf('install-hbbs-fetch') !== -1);
    assert.ok(ids.indexOf('adopt-api') !== -1);
    assert.ok(ids.indexOf('fetch-api') === -1);
});

// --- regression: adopting must use the REAL port, never the wizard default ---
//
// This is the exact defect a reviewer found in the first version of this task:
// the verify step (and the firewall rule, and the Caddyfile upstream) used
// choices.apiPort unconditionally, so adopting a server that is actually
// listening on a different port than the wizard's default silently probed,
// firewalled and proxied the WRONG port. det.api.port must win whenever the
// API server is adopted; choices.apiPort only applies to a fresh install.

test('REGRESSION: adopting an API server on a non-default port targets det.api.port everywhere, not choices.apiPort', () => {
    const plan = P.build(detAdopt({ api: { version: '2.7', port: 28114, install: 'binary' } }),
        choices({ apiPort: 21114 })); // wizard default left untouched
    assert.ok(byId(plan, 'verify').argv.join(' ').indexOf('127.0.0.1:28114') !== -1,
        'verify must probe the port the adopted server actually listens on');
    assert.equal(byId(plan, 'verify').argv.join(' ').indexOf('21114'), -1,
        'verify must not probe choices.apiPort when adopting');
});

test('REGRESSION: adopting on a non-default port also drives the firewall rule and the Caddyfile upstream', () => {
    const fw = P.build(detAdopt({ api: { version: '2.7', port: 28114, install: 'binary' }, firewall: 'ufw' }),
        choices({ apiPort: 21114, openFirewall: true }));
    assert.ok(byId(fw, 'fw-ufw-28114-tcp'), 'the firewall must open the port the adopted server is really on');
    assert.equal(byId(fw, 'fw-ufw-21114-tcp'), null, 'the firewall must not open the unused wizard default');

    const tls = P.build(detAdopt({ api: { version: '2.7', port: 28114, install: 'binary' } }),
        choices({ apiPort: 21114, tlsTier: 'own', domain: 'rd.example.com' }));
    assert.ok(byId(tls, 'tls-caddyfile').write.content.indexOf('127.0.0.1:28114') !== -1,
        'the Caddyfile must proxy to the port the adopted server is really on');
    assert.equal(byId(tls, 'tls-caddyfile').write.content.indexOf('127.0.0.1:21114'), -1,
        'the Caddyfile must not proxy to the unused wizard default');
});

test('a fresh install still uses choices.apiPort — there is no det.api.port to defer to', () => {
    const plan = P.build(detFresh({ api: null }), choices({ installHbbs: true, apiPort: 28114 }));
    assert.ok(byId(plan, 'verify').argv.join(' ').indexOf('127.0.0.1:28114') !== -1);
    assert.ok(byId(plan, 'configure').write.content.indexOf('api-addr: 0.0.0.0:28114') !== -1);
});

// -------------------------------------------------------------- C14 shape

test('C14: downloads are literal argv with -o as its own element', () => {
    const plan = P.build(detFresh(), choices({ installHbbs: true }));
    assert.deepEqual(byId(plan, 'install-hbbs-fetch').argv, ['curl', '-fsSL',
        'https://github.com/rustdesk/rustdesk-server/releases/download/1.1.16/rustdesk-server-linux-amd64.zip',
        '-o', '/var/cache/pilot/rustdesk-server-linux-amd64.zip']);
    assert.deepEqual(byId(plan, 'fetch-api').argv, ['curl', '-fsSL',
        'https://github.com/lejianwen/rustdesk-api/releases/download/v2.7/linux-amd64.tar.gz',
        '-o', '/var/cache/pilot/linux-amd64.tar.gz']);
    for (const s of plan.steps) {
        for (const a of s.argv) {
            assert.ok(a.indexOf('curl') === -1 || s.argv[0] === 'curl',
                'curl must never be buried in a shell string: ' + s.id);
        }
        if (s.argv[0] === 'sh') assert.equal(s.sha256, null, 'a shell step is never a download: ' + s.id);
    }
});

test('C14: directory creation is a separate preceding step', () => {
    const plan = P.build(detFresh(), choices({ installHbbs: true }));
    const ids = P.stepIds(plan);
    assert.deepEqual(byId(plan, 'cache-dir').argv, ['install', '-d', '-m', '0755', '/var/cache/pilot']);
    assert.ok(ids.indexOf('cache-dir') < ids.indexOf('install-hbbs-fetch'));
    assert.ok(ids.indexOf('cache-dir') < ids.indexOf('fetch-api'));
});

test('sha256 is set on exactly the download steps and matches ostarget.js pinned digests', () => {
    const plan = P.build(detFresh(), choices({ installHbbs: true }));
    const withSum = plan.steps.filter((s) => s.sha256 !== null).map((s) => s.id);
    assert.deepEqual(withSum, ['install-hbbs-fetch', 'fetch-api']);
    assert.equal(byId(plan, 'install-hbbs-fetch').sha256, OsTarget.serverAsset('x86_64').sha256);
    assert.equal(byId(plan, 'fetch-api').sha256, OsTarget.apiAsset('x86_64').sha256);
    for (const s of plan.steps) {
        if (s.sha256 === null) continue;
        assert.ok(/^[0-9a-f]{64}$/.test(s.sha256), s.id);
        assert.equal(s.argv[s.argv.length - 2], '-o', 'sha256 belongs to the -o path: ' + s.id);
    }
});

test('per-component arch mapping uses the differing archive names (from ostarget.js, not a local table)', () => {
    for (const arch of ['x86_64', 'aarch64', 'armv7l']) {
        const plan = P.build(detFresh({ arch: arch }), choices({ installHbbs: true }));
        const server = OsTarget.serverAsset(arch);
        const api = OsTarget.apiAsset(arch);
        assert.equal(plan.arch, server.arch, arch);
        assert.ok(byId(plan, 'install-hbbs-fetch').argv[2].endsWith('/' + server.name), arch);
        assert.ok(byId(plan, 'fetch-api').argv[2].endsWith('/' + api.name), arch);
    }
});

test('i686/i386 fails explicitly rather than half-installing: no 32-bit API server build exists', () => {
    for (const a of ['i686', 'i386']) {
        throwsKind(() => P.build(detFresh({ arch: a }), choices({ installHbbs: true })), 'ARCH_UNSUPPORTED');
    }
});

test('unrecognised arch strings are rejected as ARCH_UNSUPPORTED', () => {
    // ostarget.js's normalizeArch() deliberately TOLERATES the case and stray
    // whitespace a real `uname -m` can produce (e.g. "AMD64", "x86_64\n") — that
    // is real upstream behaviour reused here, not a hostile-input gap.
    for (const a of ['', '   ', 'ppc64le', 'x86\x0064', 'x86_64; rm -rf /', null, 42, {}]) {
        throwsKind(() => P.build(detFresh({ arch: a }), choices({ installHbbs: true })), 'ARCH_UNSUPPORTED');
    }
    assert.equal(P.build(detFresh({ arch: 'AMD64' }), choices({ installHbbs: true })).arch, 'amd64');
    assert.equal(P.build(detFresh({ arch: 'x86_64\n' }), choices({ installHbbs: true })).arch, 'amd64');
});

// ------------------------------------------------------------- C17 facts

test('C17: the tarball is unpacked with --strip-components=2', () => {
    // CORRECTED from 1, against the real v2.7 assets (both arm64 and amd64).
    // Every member is named "./release/<x>" -- TWO leading components, not one.
    // Verified by extracting the actual releases:
    //   --strip-components=1 -> /opt/rustdesk-api/release/apimain
    //   --strip-components=2 -> /opt/rustdesk-api/apimain
    // The unit's ExecStart is /opt/rustdesk-api/apimain, so stripping one left
    // it pointing at nothing: systemd crash-looped with status=203/EXEC while
    // `systemctl enable --now` still exited 0, and the failure surfaced ten
    // steps later as `verify` refusing to connect to 21114.
    const plan = P.build(detAdopt(), choices());
    assert.deepEqual(byId(plan, 'install').argv,
        ['tar', 'xzf', '/var/cache/pilot/linux-amd64.tar.gz', '-C', '/opt/rustdesk-api', '--strip-components=2']);
});

test('the unpack step and the unit must agree on where the binary lands', () => {
    // The defect was not the number 1 by itself -- it was that TWO steps
    // disagreed about one path and nothing compared them. This is that
    // comparison, so the pair cannot drift apart again silently.
    const plan = P.build(detAdopt(), choices());
    const unit = byId(plan, 'unit').write.content;
    const execStart = /\nExecStart=(\S+)\n/.exec(unit);
    assert.ok(execStart, 'the unit must have an ExecStart');
    const binary = execStart[1];

    // A verification STEP, not a `check`: `check` is a pre-condition idempotency
    // guard (satisfied means SKIP), so it can never verify what a step produced.
    const verify = byId(plan, 'install-verify');
    assert.ok(verify, 'the unpack must be followed by a step that proves it worked');
    assert.equal(verify.mutating, false);
    assert.deepEqual(verify.argv, ['test', '-x', binary],
        'the verification must test the EXACT path the unit will exec, or a layout ' +
        'change becomes a mystery connection failure ten steps later');
    // And it must come after the unpack, or it proves nothing.
    const ids = plan.steps.map((x) => x.id);
    assert.ok(ids.indexOf('install') < ids.indexOf('install-verify'));
    assert.ok(ids.indexOf('install-verify') < ids.indexOf('unit-enable'),
        'catching it before the service is started is the whole point');

    // And the binary must sit directly in the working directory the unit pins,
    // because config.yaml, resources/ and data/ are all resolved relative to it.
    const wd = /\nWorkingDirectory=(\S+)\n/.exec(unit);
    assert.ok(wd);
    assert.equal(binary, wd[1] + '/apimain');
});

test('the unpack must come BEFORE the config write, because the tarball ships one too', () => {
    // --strip-components=2 lands the archive's own ./release/conf/config.yaml at
    // exactly the path Pilot writes: /opt/rustdesk-api/conf/config.yaml. With
    // strip=1 it landed under release/ and could never collide, so this ordering
    // was free before and is load-bearing now. If `configure` ever moved above
    // `install`, the archive's stock config (show-swagger: 0, no hbbs wiring)
    // would silently replace Pilot's -- and the `verify` step, which fetches
    // /admin/swagger/doc.json and only works because Pilot writes
    // show-swagger: 1, would 404 with nothing explaining why.
    const ids = P.build(detAdopt(), choices()).steps.map((x) => x.id);
    assert.ok(ids.indexOf('install') < ids.indexOf('configure'),
        'the config write must come after the unpack that would otherwise overwrite it');
    assert.ok(ids.indexOf('configure') < ids.indexOf('verify'),
        'and before the step that depends on what it configured');
});

test('the config Pilot writes is what makes the verify step possible', () => {
    // verify fetches /admin/swagger/doc.json. VERIFIED against the real v2.7
    // server: that path 404s with show-swagger: 0 (the archive's default) and
    // returns 200 with show-swagger: 1. The two are one fact, in two files.
    const plan = P.build(detAdopt(), choices());
    const cfg = byId(plan, 'configure').write.content;
    assert.match(cfg, /\n  show-swagger: 1\n/,
        'without this the verify step below cannot succeed');
    assert.ok(byId(plan, 'verify').argv.some((a) => /\/admin\/swagger\/doc\.json$/.test(a)),
        'verify must probe the document show-swagger enables');
});

test('enable --now is not trusted on its own: the service must really be active', () => {
    // `systemctl enable --now` exits 0 for a unit that started and immediately
    // died -- with Restart=on-failure it sits in "activating (auto-restart)",
    // which systemd reports as a successful start. A crash-looping service was
    // therefore recorded as "ok exit=0".
    const plan = P.build(detAdopt(), choices());
    const enable = byId(plan, 'unit-enable');
    assert.deepEqual(enable.argv, ['systemctl', 'enable', '--now', 'rustdesk-api.service']);
    const active = byId(plan, 'unit-active');
    assert.ok(active, 'starting a service and never asking whether it runs is not a check');
    assert.equal(active.mutating, false);
    assert.deepEqual(active.argv, ['systemctl', 'is-active', '--quiet', 'rustdesk-api.service']);
    const ids = plan.steps.map((x) => x.id);
    assert.ok(ids.indexOf('unit-enable') < ids.indexOf('unit-active'));
});

test('C17: the generated unit sets WorkingDirectory=/opt/rustdesk-api', () => {
    const plan = P.build(detAdopt(), choices({ tlsTier: 'own', domain: 'rd.example.com' }));
    const w = byId(plan, 'unit').write;
    assert.equal(w.path, '/etc/systemd/system/rustdesk-api.service');
    assert.equal(w.mode, '0644');
    assert.equal(w.owner, 'root:root');
    assert.ok(w.content.indexOf('\nWorkingDirectory=/opt/rustdesk-api\n') !== -1);
    assert.equal(w.content, golden('plan-rustdesk-api.service'));
});

test('C17: config.yaml always turns swagger on', () => {
    for (const tier of ['none', 'own']) {
        const plan = P.build(detAdopt(), choices({ tlsTier: tier, domain: tier === 'own' ? 'rd.example.com' : null }));
        assert.ok(byId(plan, 'configure').write.content.indexOf('\n  show-swagger: 1\n') !== -1, tier);
    }
});

test('C17: api-server is https://<domain> with TLS and plain http without', () => {
    const tls = P.build(detAdopt(), choices({ tlsTier: 'own', domain: 'rd.example.com' }));
    assert.ok(byId(tls, 'configure').write.content.indexOf('\n  api-server: https://rd.example.com\n') !== -1);
    const plain = P.build(detAdopt(), choices());
    assert.ok(byId(plain, 'configure').write.content.indexOf('\n  api-server: http://203.0.113.10:21114\n') !== -1);
});

test('config.yaml golden: adopted key with TLS, generated key without', () => {
    const tls = P.build(detAdopt(), choices({ tlsTier: 'own', domain: 'rd.example.com' }));
    assert.equal(byId(tls, 'configure').write.content, golden('plan-config-adopt-tls.yaml'));
    const fresh = P.build(detFresh(), choices({ installHbbs: true }));
    assert.equal(byId(fresh, 'configure').write.content, golden('plan-config-install-notls.yaml'));
    // Installing means the key does not exist yet, so the file must reference it.
    assert.ok(byId(fresh, 'configure').write.content.indexOf('key-file:') !== -1);
    assert.ok(byId(tls, 'configure').write.content.indexOf('key: "AbCdEf0123456789+/="') !== -1);
});

// ------------------------------------------------------- TLS: RULE 1 (reuse)

test('RULE 1: the Caddyfile write step is exactly PilotTls.caddyfile(), never a local generator', () => {
    const plan = P.build(detAdopt(), choices({ tlsTier: 'own', domain: 'rd.example.com' }));
    const w = byId(plan, 'tls-caddyfile').write;
    assert.equal(w.path, Tls.CADDYFILE_PATH);
    assert.equal(w.mode, Tls.CADDYFILE_MODE);
    assert.equal(w.owner, Tls.CADDYFILE_OWNER);
    assert.equal(w.content, Tls.caddyfile({ tier: 'own', host: 'rd.example.com', apiPort: 21114 }));
    assert.equal(w.content, golden('plan-caddyfile-own'));
    // Same fixture PilotTls's own suite goldens against — proving one generator.
    assert.equal(w.content, golden('Caddyfile-own'));
});

test('every TLS tier produces a Caddyfile identical to calling PilotTls.caddyfile() directly', () => {
    const cases = [
        ['own', 'rd.example.com', { domain: 'rd.example.com' }],
        ['sslip', '203.0.113.10.sslip.io', {}],
        ['duckdns', 'pilotdemo.duckdns.org', { duckdns: { subdomain: 'pilotdemo', token: 'a1b2c3d4e5f6a7b8' } }]
    ];
    for (const [tier, host, extra] of cases) {
        const plan = P.build(detAdopt(), choices(Object.assign({ tlsTier: tier }, extra)));
        assert.equal(byId(plan, 'tls-caddyfile').write.content,
            Tls.caddyfile({ tier: tier, host: host, apiPort: 21114 }), tier);
    }
});

// ------------------------------------------------------------- TLS tiers

test('sslip derives the sslip.io hostname from the detected public IP (tls.js: dotted, not dashed)', () => {
    const plan = P.build(detAdopt(), choices({ tlsTier: 'sslip' }));
    assert.ok(byId(plan, 'tls-caddyfile').write.content.indexOf('https://203.0.113.10.sslip.io {') !== -1);
    assert.ok(plan.warnings.some((w) => w.indexOf('rate-limit') !== -1));
});

test('RULE 2: sslip is gated on validate().ok, not on hostFor() emptiness', () => {
    // hostFor() returns '' for both a bad public IP and tier:'none' — the two
    // must not be confused. A bad IP must fail with TLS_DNS_MISMATCH, not
    // silently produce a plan with no TLS steps and no error.
    throwsKind(() => P.build(detAdopt({ public_ip: null }), choices({ tlsTier: 'sslip' })), 'TLS_DNS_MISMATCH');
    throwsKind(() => P.build(detAdopt({ public_ip: '999.1.1.1' }), choices({ tlsTier: 'sslip' })), 'TLS_DNS_MISMATCH');
    throwsKind(() => P.build(detAdopt({ public_ip: '192.168.1.10' }), choices({ tlsTier: 'sslip' })), 'TLS_DNS_MISMATCH');
});

test('the DuckDNS token is in NO argv of any step — only in a 0600 root:root secret write', () => {
    // /proc/<pid>/cmdline is world-readable, and the remote command line ssh
    // builds is visible in `ps` on the target, so a token in argv is a leak on
    // both transports. It travels in a secret write step's content instead —
    // the same channel libexec/pilot-exec seeds its redactor from, so the bare
    // token is also masked out of every transcript line.
    const TOKEN = 'a1b2c3d4e5f6a7b8';
    const plan = P.build(detAdopt(), choices({ tlsTier: 'duckdns',
        duckdns: { subdomain: 'pilotdemo', token: TOKEN } }));

    const staged = byId(plan, 'tls-duckdns-token');
    assert.ok(staged, 'the token must be staged by its own step');
    assert.equal(staged.secret, true, 'the staging step must be marked secret');
    assert.equal(staged.write.mode, '0600');
    assert.equal(staged.write.owner, 'root:root');
    assert.equal(staged.write.content, TOKEN + '\n',
        'the content is the bare token, so pilot-exec redacts the token itself, not a longer line');
    assert.deepEqual(staged.argv, [], 'a write step carries no argv at all');

    for (const s of plan.steps) {
        for (const a of s.argv)
            assert.equal(String(a).indexOf(TOKEN), -1, 'token leaked into ' + s.id + "'s argv");
        if (s.id === 'tls-duckdns-token') continue;
        assert.equal(JSON.stringify(s).indexOf(TOKEN), -1, 'token leaked into ' + s.id);
    }

    // The update step itself carries the subdomain and nothing secret, and
    // deletes the staged token on every exit path.
    const s = byId(plan, 'tls-duckdns');
    assert.equal(s.secret, false, 'with no credential in its argv this step has nothing to suppress');
    assert.equal(s.sha256, null, 'not a download, so no checksum');
    assert.ok(s.argv.indexOf('pilotdemo') !== -1, 'the (non-secret) subdomain is a plain argument');
    assert.ok(s.argv.join(' ').indexOf('-K') !== -1,
        'curl must read the URL from a config file, never from its own argv');
    assert.ok(s.argv.join(' ').indexOf('rm -f') !== -1, 'the staged token is removed again');
    assert.ok(P.stepIds(plan).indexOf('tls-duckdns-token') < P.stepIds(plan).indexOf('tls-duckdns'),
        'the token must be staged before the step that consumes it');

    assert.ok(byId(plan, 'tls-caddyfile').write.content.indexOf('https://pilotdemo.duckdns.org {') !== -1);
});

test('tlsTier none emits no tls steps and warns about the plaintext downgrade', () => {
    const plan = P.build(detAdopt(), choices());
    for (const id of P.stepIds(plan)) assert.ok(id.indexOf('tls-') !== 0, id);
    assert.ok(plan.warnings.some((w) => w.indexOf('ws://') !== -1), plan.warnings.join('|'));
});

test('hostile domains are rejected for the own-domain tier (delegated to PilotTls.validate)', () => {
    // 'example.com.' is deliberately absent: tls.js's normalizeDomain() treats a
    // single trailing dot as the FQDN form and accepts it, and provision-plan
    // reuses that validation rather than a second, stricter one.
    const bad = ['', ' ', 'example.com ', ' example.com', 'localhost', 'exa mple.com', 'ex\x0bample.com',
        'a.com\nb.com', 'exämple.com', '../../etc/passwd', 'http://example.com', 'example.com/', '-lead.com',
        '.example.com', 'a'.repeat(300) + '.com', null, 42, {}, ['example.com']];
    for (const d of bad) throwsKind(() => P.build(detAdopt(), choices({ tlsTier: 'own', domain: d })), 'GENERIC');
    assert.equal(P.build(detAdopt(), choices({ tlsTier: 'own', domain: 'rd.example.com' })).warnings.length, 1);
    // The FQDN form is valid and normalised exactly as tls.js normalises it.
    const dotted = P.build(detAdopt(), choices({ tlsTier: 'own', domain: 'example.com.' }));
    assert.ok(byId(dotted, 'tls-caddyfile').write.content.indexOf('https://example.com {') !== -1);
});

test('hostile duckdns input is rejected (delegated to PilotTls.validate)', () => {
    const t = 'a1b2c3d4e5f6a7b8';
    // 'A-Upper' is deliberately absent: duckdnsHost() lowercases before
    // validating (DNS names are case-insensitive), so it is a valid subdomain,
    // not a hostile one — reused here rather than re-validated more strictly.
    const bad = [null, {}, { subdomain: '', token: t },
        { subdomain: 'sub.domain', token: t }, { subdomain: 'ok\x00', token: t },
        { subdomain: 'ok', token: '' }, { subdomain: 'ok', token: 'short' },
        { subdomain: 'ok', token: 'tok en with space' }, { subdomain: 'ok', token: 'a\nb1234567' }];
    for (const d of bad) throwsKind(() => P.build(detAdopt(), choices({ tlsTier: 'duckdns', duckdns: d })), 'GENERIC');
});

// ---------------------------------------------------------- ports/firewall

test('RULE 1: firewall steps are spliced verbatim from PilotFirewall.steps(), never re-derived', () => {
    for (const backend of ['firewalld', 'ufw', 'nftables']) {
        const det = detAdopt({ firewall: backend });
        const ch = choices({ openFirewall: true });
        const plan = P.build(det, ch);
        const reqs = Ports.required(ch);
        const expected = Firewall.steps(backend, reqs);
        const got = expected.map((e) => byId(plan, e.id));
        for (let i = 0; i < expected.length; i++) {
            assert.ok(got[i], backend + '/' + expected[i].id + ' missing from the plan');
            assert.deepEqual(got[i], expected[i], backend + '/' + expected[i].id);
        }
        // And nothing else in the plan looks like a firewall step for another backend.
        for (const id of P.stepIds(plan)) {
            if (id.indexOf('fw-') === 0) assert.ok(expected.some((e) => e.id === id), backend + ': stray ' + id);
        }
    }
});

test('firewalld opens the always-on ports plus the plaintext set, then reloads', () => {
    const plan = P.build(detAdopt({ firewall: 'firewalld' }), choices({ openFirewall: true }));
    const ids = P.stepIds(plan).filter((i) => i.indexOf('fw-') === 0);
    assert.deepEqual(ids, ['fw-firewalld-21114-tcp', 'fw-firewalld-21115-tcp', 'fw-firewalld-21116-tcp',
        'fw-firewalld-21116-udp', 'fw-firewalld-21117-tcp', 'fw-firewalld-21118-tcp',
        'fw-firewalld-21119-tcp', 'fw-firewalld-reload']);
    assert.deepEqual(byId(plan, 'fw-firewalld-reload').argv, ['firewall-cmd', '--reload']);
});

test('with TLS the websocket ports are proxy-restricted and 80/443 open instead of the API port', () => {
    const plan = P.build(detAdopt({ firewall: 'firewalld' }),
        choices({ openFirewall: true, tlsTier: 'own', domain: 'rd.example.com' }));
    const ids = P.stepIds(plan).filter((i) => i.indexOf('fw-') === 0);
    assert.deepEqual(ids, ['fw-firewalld-80-tcp', 'fw-firewalld-443-tcp', 'fw-firewalld-21115-tcp',
        'fw-firewalld-21116-tcp', 'fw-firewalld-21116-udp', 'fw-firewalld-21117-tcp',
        'fw-firewalld-21118-tcp-proxy', 'fw-firewalld-21119-tcp-proxy', 'fw-firewalld-reload']);
    assert.equal(ids.indexOf('fw-firewalld-21114-tcp'), -1, 'the API port must not be exposed when TLS is on');
});

test('21116 is opened on both tcp and udp on every backend', () => {
    const uf = P.build(detAdopt({ firewall: 'ufw' }), choices({ openFirewall: true }));
    assert.deepEqual(byId(uf, 'fw-ufw-21116-tcp').argv, ['ufw', 'allow', '21116/tcp']);
    assert.deepEqual(byId(uf, 'fw-ufw-21116-udp').argv, ['ufw', 'allow', '21116/udp']);
    const nf = P.build(detAdopt({ firewall: 'nftables' }), choices({ openFirewall: true }));
    assert.ok(byId(nf, 'fw-nft-write').write.content.indexOf('tcp dport 21116 accept') !== -1);
    assert.ok(byId(nf, 'fw-nft-write').write.content.indexOf('udp dport 21116 accept') !== -1);
    assert.deepEqual(byId(nf, 'fw-nft-apply').argv, ['nft', '-f', '/etc/nftables.d/pilot.nft']);
});

test('a custom apiPort is what gets opened (no TLS) and probed', () => {
    const plan = P.build(detAdopt({ firewall: 'ufw' }), choices({ openFirewall: true, apiPort: 28114 }));
    assert.deepEqual(byId(plan, 'fw-ufw-28114-tcp').argv, ['ufw', 'allow', '28114/tcp']);
    assert.ok(byId(plan, 'verify').argv.join(' ').indexOf('127.0.0.1:28114') !== -1);
});

test('no recognised backend, or openFirewall off, emits no rules but says so', () => {
    const none = P.build(detAdopt({ firewall: 'none' }), choices({ openFirewall: true }));
    for (const id of P.stepIds(none)) assert.ok(id.indexOf('fw-') !== 0, id);
    assert.ok(none.warnings.some((w) => w.indexOf('FIREWALL_UNSUPPORTED') === 0));
    const off = P.build(detAdopt({ firewall: 'firewalld' }), choices({ openFirewall: false }));
    for (const id of P.stepIds(off)) assert.ok(id.indexOf('fw-') !== 0, id);
    assert.ok(off.warnings.some((w) => w.indexOf('openFirewall is off') !== -1));
});

test('RULE 3: provision-plan never passes a proxySource to PilotFirewall', () => {
    // There is no choices/detection field that could reach opts.proxySource, and
    // the module reads no such field — this test pins that by construction: a
    // proxy-restricted rule must always name the loopback default.
    const plan = P.build(detAdopt({ firewall: 'firewalld' }),
        choices({ openFirewall: true, tlsTier: 'own', domain: 'rd.example.com' }));
    const proxied = byId(plan, 'fw-firewalld-21118-tcp-proxy');
    assert.ok(proxied.argv.join(' ').indexOf('source address="' + Firewall.DEFAULT_PROXY + '"') !== -1);
});

// ------------------------------------------------------------ diagnostics

test('non-systemd still yields a plan (manual mode needs one) with a warning', () => {
    const plan = P.build(detAdopt({ init: 'sysvinit' }), choices());
    assert.ok(plan.steps.length > 0);
    assert.ok(plan.warnings.some((w) => w.indexOf('NO_SYSTEMD') === 0), plan.warnings.join('|'));
});

test('missing egress and low disk are warnings, not silent success', () => {
    const plan = P.build(detAdopt({ egress: false, disk_free_mb: 12 }), choices());
    assert.ok(plan.warnings.some((w) => w.indexOf('NO_EGRESS') === 0));
    assert.ok(plan.warnings.some((w) => w.indexOf('disk') !== -1));
});

test('read-only steps are the ones a preview run may execute', () => {
    const plan = P.build(detAdopt(), choices());
    assert.equal(byId(plan, 'reachability').mutating, false);
    assert.equal(byId(plan, 'verify').mutating, false);
    assert.equal(byId(plan, 'verify-admin').secret, true);
    assert.equal(byId(plan, 'cache-dir').mutating, true);
});

test('the user creation step is idempotent through its check probe', () => {
    const plan = P.build(detAdopt(), choices());
    assert.deepEqual(byId(plan, 'install-user').check, { argv: ['id', '-u', 'rustdesk-api'], expect: 'zero' });
});

// ------------------------------------------------------- hostile detection

test('detection and choices must be plain objects', () => {
    for (const bad of [null, undefined, 0, '', 'x', [], [1], true]) {
        throwsKind(() => P.build(bad, choices()), 'GENERIC');
        throwsKind(() => P.build(detAdopt(), bad), 'GENERIC');
    }
});

test('choices keys are validated one by one', () => {
    throwsKind(() => P.build(detAdopt(), choices({ target: 'LOCAL' })), 'GENERIC');
    throwsKind(() => P.build(detAdopt(), choices({ target: 'ssh\n' })), 'GENERIC');
    throwsKind(() => P.build(detAdopt(), choices({ installHbbs: 'false' })), 'GENERIC');
    throwsKind(() => P.build(detAdopt(), choices({ openFirewall: 1 })), 'GENERIC');
    throwsKind(() => P.build(detAdopt(), choices({ tlsTier: 'skip' })), 'GENERIC');
    for (const p of [0, -1, 65536, 1.5, '21114', NaN, Infinity, null, '21114\n']) {
        throwsKind(() => P.build(detAdopt(), choices({ apiPort: p })), 'GENERIC');
        throwsKind(() => P.build(detAdopt(), choices({ sshPort: p })), 'GENERIC');
    }
});

test('an empty hbbs data_dir falls back to the default instead of producing //', () => {
    const plan = P.build(detAdopt({ hbbs: { version: '1.1.16', install: 'unknown', ports: [],
        pubkey: 'K', data_dir: '' } }), choices());
    assert.deepEqual(byId(plan, 'adopt-hbbs').argv, ['cat', '/var/lib/rustdesk-server/id_ed25519.pub']);
});

test('a traversing or relative hbbs data_dir is rejected', () => {
    for (const p of ['../../etc', '/var/lib/../../etc/shadow', 'var/lib/rustdesk-server', '/var/lib\x00/x']) {
        throwsKind(() => P.build(detAdopt({ hbbs: { version: '1', install: 'deb', ports: [],
            pubkey: 'K', data_dir: p } }), choices()), 'GENERIC');
    }
});

test('detection.api has no dir field: an invented dir is silently ignored, never read', () => {
    // Pinned shape is exactly {version, port, install} (task-13-brief.md:95) —
    // there is nowhere left in this module for a `dir` key to reach, since
    // adopt-api's install-pipeline is skipped entirely and no other step reads
    // detection.api.dir. A stray dir must not cause a path-traversal rejection
    // (there is nothing to validate) and must not appear anywhere in the plan.
    const plan = P.build(detAdopt({ api: { version: '2.7', port: 21114, install: 'binary',
        dir: '../../etc/shadow' } }), choices());
    assert.ok(P.stepIds(plan).indexOf('adopt-api') !== -1);
    for (const s of plan.steps) assert.equal(JSON.stringify(s).indexOf('etc/shadow'), -1, s.id);
});

test('detection.api.install is constrained to the pinned enum: only "binary" survives, else "unknown"', () => {
    for (const bad of ['docker', 'deb', 'rpm', '', null, 42, {}]) {
        const plan = P.build(detAdopt({ api: { version: '2.7', port: 21114, install: bad } }), choices());
        assert.deepEqual(byId(plan, 'adopt-api').argv, ['pgrep', '-f', 'apimain'], JSON.stringify(bad));
    }
});

test('detection.api.port falls back to the same default the detect script uses when unusable', () => {
    for (const bad of [0, -1, 65536, 1.5, 'not-a-number', null, undefined, NaN]) {
        const plan = P.build(detAdopt({ api: { version: '2.7', port: bad, install: 'binary' } }), choices());
        assert.ok(byId(plan, 'verify').argv.join(' ').indexOf('127.0.0.1:21114') !== -1, JSON.stringify(bad));
    }
});

test('detection.hbbs.install is constrained to the pinned enum: "deb"/"binary" survive, else "unknown"', () => {
    // Confirms provision-plan reads only the pinned hbbs fields (version, install,
    // ports, pubkey, data_dir) and enforces the same install enum the --detect
    // task's own parser does, rather than passing an arbitrary string through.
    for (const good of ['deb', 'binary']) {
        const plan = P.build(detAdopt({ hbbs: { version: '1.1.16', install: good, ports: [],
            pubkey: 'K', data_dir: '/var/lib/rustdesk-server' } }), choices());
        assert.ok(plan.steps.length > 0, good);
    }
    // 'unknown' install is not otherwise observable from provision-plan's output
    // (adopt-hbbs's argv does not depend on it), so this only pins that a bogus
    // value does not throw or otherwise break the plan.
    const plan = P.build(detAdopt({ hbbs: { version: '1', install: 'rpm', ports: [],
        pubkey: 'K', data_dir: '/var/lib/rustdesk-server' } }), choices());
    assert.ok(P.stepIds(plan).indexOf('adopt-hbbs') !== -1);
});

// -------------------------------------------------------------- toEnvelope

const CTX_LOCAL = { run_id: '20260803T204500Z', ssh: null, credentials: null };

test('toEnvelope produces the exact C2 envelope for a local plan', () => {
    const plan = P.build(detAdopt(), choices());
    const env = P.toEnvelope(plan, CTX_LOCAL);
    assert.deepEqual(Object.keys(env).sort(), ['credentials', 'run_id', 'ssh', 'steps', 'transport', 'version']);
    assert.equal(env.version, 1);
    assert.equal(env.transport, 'local');
    assert.equal(env.run_id, '20260803T204500Z');
    assert.equal(env.ssh, null);
    assert.equal(env.credentials, null);
    assert.deepEqual(env.steps, plan.steps);
});

test('toEnvelope deep-copies the steps so the envelope cannot alias the plan', () => {
    const plan = P.build(detAdopt(), choices());
    const env = P.toEnvelope(plan, CTX_LOCAL);
    env.steps[0].argv.push('--injected');
    env.steps[0].id = 'tampered';
    assert.equal(plan.steps[0].id, 'cache-dir');
    assert.deepEqual(plan.steps[0].argv, ['install', '-d', '-m', '0755', '/var/cache/pilot']);
});

test('toEnvelope builds the ssh block and echoes the fingerprint only when confirmed', () => {
    const plan = P.build(detAdopt(), choices({ target: 'ssh', host: '10.0.0.9' }));
    assert.equal(plan.host, '10.0.0.9');
    const fp = 'SHA256:' + 'A'.repeat(43);
    const env = P.toEnvelope(plan, { run_id: '20260803T204500Z',
        ssh: { host: '10.0.0.9', port: 22, user: 'root', auth: 'pem', accept_fingerprint: fp },
        credentials: { password: null, pem: '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n' } });
    assert.equal(env.transport, 'ssh');
    assert.deepEqual(env.ssh, { host: '10.0.0.9', port: 22, user: 'root', auth: 'pem', accept_fingerprint: fp });
    assert.deepEqual(env.credentials, { password: null, pem: '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n' });
    const env2 = P.toEnvelope(plan, { run_id: '20260803T204500Z',
        ssh: { host: '10.0.0.9', port: 22, user: 'root', auth: 'agent' }, credentials: null });
    assert.equal(env2.ssh.accept_fingerprint, null);
});

test('toEnvelope rejects an ssh plan with no ssh block, and a local plan carrying one', () => {
    const ssh = P.build(detAdopt(), choices({ target: 'ssh', host: '10.0.0.9' }));
    throwsKind(() => P.toEnvelope(ssh, { run_id: '20260803T204500Z', ssh: null }), 'GENERIC');
    const local = P.build(detAdopt(), choices());
    throwsKind(() => P.toEnvelope(local, { run_id: '20260803T204500Z',
        ssh: { host: 'h', port: 22, user: 'root', auth: 'agent' } }), 'GENERIC');
});

test('toEnvelope refuses a ctx host that is not the host the plan was built for', () => {
    const plan = P.build(detAdopt(), choices({ target: 'ssh', host: '10.0.0.9' }));
    throwsKind(() => P.toEnvelope(plan, { run_id: '20260803T204500Z',
        ssh: { host: '10.0.0.10', port: 22, user: 'root', auth: 'agent' } }), 'GENERIC');
});

test('run_id must be the pinned timestamp form', () => {
    const plan = P.build(detAdopt(), choices());
    for (const r of ['', '2026-08-03', '20260803T204500', '20260803t204500Z', '20260803T204500Z ',
        '20260803T204500Z\n', '../20260803T204500Z', '2026080\x00T204500Z', null, 20260803, {}]) {
        throwsKind(() => P.toEnvelope(plan, { run_id: r, ssh: null }), 'GENERIC');
    }
});

test('hostile ssh hosts, users, ports and fingerprints are rejected', () => {
    const plan = P.build(detAdopt(), choices({ target: 'ssh' }));
    const base = { host: 'h.example.com', port: 22, user: 'root', auth: 'agent' };
    function ctx(over) { return { run_id: '20260803T204500Z', ssh: Object.assign({}, base, over) }; }
    for (const h of ['', ' ', 'a b', 'host\nname', 'host;rm -rf /', 'hö.st', 'h\x00st', 'a'.repeat(256), null, 22]) {
        throwsKind(() => P.toEnvelope(plan, ctx({ host: h })), 'GENERIC');
    }
    for (const u of ['', 'ro ot', 'root\n', '-root', 'ro;ot', 'ü', 'r'.repeat(33), null, 0]) {
        throwsKind(() => P.toEnvelope(plan, ctx({ user: u })), 'GENERIC');
    }
    for (const p of [0, -22, 65536, 22.5, '22', null, NaN]) {
        throwsKind(() => P.toEnvelope(plan, ctx({ port: p })), 'GENERIC');
    }
    for (const a of ['', 'PASSWORD', 'key', 'agent\n', null, 1]) {
        throwsKind(() => P.toEnvelope(plan, ctx({ auth: a })), 'GENERIC');
    }
    for (const f of ['', 'SHA256:', 'MD5:aa:bb', 'SHA256:' + 'A'.repeat(42), 'SHA256:' + 'A'.repeat(44) + 'B',
        'SHA256:' + 'A'.repeat(42) + '\n', 'sha256:' + 'A'.repeat(43), 42]) {
        throwsKind(() => P.toEnvelope(plan, ctx({ accept_fingerprint: f })), 'SSH_HOSTKEY_UNKNOWN');
    }
    // IPv6 in brackets is a legitimate host and must survive.
    assert.equal(P.toEnvelope(plan, ctx({ host: '[2001:db8::1]' })).ssh.host, '[2001:db8::1]');
});

test('credentials must be strings or null, and default to null', () => {
    const plan = P.build(detAdopt(), choices());
    assert.equal(P.toEnvelope(plan, { run_id: '20260803T204500Z', ssh: null }).credentials, null);
    for (const c of [{ password: 1 }, { pem: [] }, { password: {} }, 'secret', 7]) {
        throwsKind(() => P.toEnvelope(plan, { run_id: '20260803T204500Z', ssh: null, credentials: c }), 'GENERIC');
    }
    const env = P.toEnvelope(plan, { run_id: '20260803T204500Z', ssh: null, credentials: { password: 'p w' } });
    assert.deepEqual(env.credentials, { password: 'p w', pem: null });
});

test('toEnvelope never puts a credential in any step argv', () => {
    const plan = P.build(detAdopt(), choices({ target: 'ssh', host: '10.0.0.9' }));
    const env = P.toEnvelope(plan, { run_id: '20260803T204500Z',
        ssh: { host: '10.0.0.9', port: 22, user: 'root', auth: 'password' },
        credentials: { password: 'S3cr3t-Marker', pem: '-----BEGIN KEY-----MarkerPem-----END KEY-----' } });
    for (const s of env.steps) {
        assert.equal(JSON.stringify(s.argv).indexOf('S3cr3t-Marker'), -1, s.id);
        assert.equal(JSON.stringify(s.argv).indexOf('MarkerPem'), -1, s.id);
    }
});

test('toEnvelope and stepIds reject anything that is not a plan', () => {
    for (const bad of [null, undefined, {}, { steps: 'x' }, [], 'plan', 5]) {
        throwsKind(() => P.toEnvelope(bad, CTX_LOCAL), 'GENERIC');
        throwsKind(() => P.stepIds(bad), 'GENERIC');
    }
    throwsKind(() => P.toEnvelope({ target: 'telnet', steps: [] }, CTX_LOCAL), 'GENERIC');
});

test('stepIds returns the ids in plan order', () => {
    const plan = P.build(detAdopt(), choices());
    assert.deepEqual(P.stepIds(plan), plan.steps.map((s) => s.id));
    assert.equal(P.stepIds(plan)[0], 'cache-dir');
});

test('every error thrown is a PilotErrors object with a remediation', () => {
    assert.throws(() => P.build(detFresh(), choices()), (e) => {
        assert.equal(e.kind, Errors.KIND.HBBS_NOT_FOUND);
        assert.equal(typeof e.remediation, 'string');
        assert.ok(e.remediation.length > 0);
        return true;
    });
});

// ------------------------------------------------------------- index.html

test('index.html loads provision-plan.js after tls.js', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.includes('js/core/provision-plan.js'), 'provision-plan.js is not referenced');
    assert.ok(srcs.indexOf('js/core/tls.js') < srcs.indexOf('js/core/provision-plan.js'),
        'provision-plan.js must load after tls.js');
});

test('the verify step is a health check, not a document download', () => {
    // It printed the whole swagger document: 221 KB, ~6000 lines, which Pilot
    // then truncated at 2000 -- burying every other step in the transcript the
    // operator has to read and paste into bug reports. All the step needs is
    // "did it answer 200".
    const v = byId(P.build(detAdopt(), choices()), 'verify');
    assert.ok(v.argv.indexOf('-o') !== -1, 'the body must be discarded');
    assert.equal(v.argv[v.argv.indexOf('-o') + 1], '/dev/null');
    const w = v.argv.indexOf('-w');
    assert.ok(w !== -1, 'and something must be printed, or the step says nothing at all');
    assert.match(v.argv[w + 1], /%\{http_code\}/);
    // libexec/pilot-exec refuses any argv element containing a control
    // character, so a trailing \n in the -w format is rejected at envelope
    // validation and takes the whole run with it.
    v.argv.forEach((a) => assert.ok(!/[\x00-\x1f\x7f]/.test(a),
        'argv element carries a control character: ' + JSON.stringify(a)));
});
