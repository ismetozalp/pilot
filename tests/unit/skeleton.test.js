// Unit tests for the plugin skeleton: the files that every later task extends.
//
// C11: every assertion here is presence/subsequence/contains, NEVER exact equality
// on a set that later tasks legitimately grow. Round 2 died because a deepEqual on
// pkg.scripts and an exact index.html script list turned every later task red.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

// C7, verbatim. Used ONLY as an ordering oracle: a script that is not in this list
// is ignored by the ordering check rather than failing it, so a later section that
// legitimately adds a module cannot be broken by this file.
const C7 = [
    'js/alpine.min.js', 'js/bootstrap.bundle.min.js',
    'js/core/errors.js', 'js/core/semver.js', 'js/core/themes.js', 'js/core/settings.js',
    'js/core/ostarget.js', 'js/core/ports.js', 'js/core/firewall.js', 'js/core/tls.js',
    'js/core/provision-plan.js', 'js/core/redact.js',
    'js/core/servers.js', 'js/core/api-io.js', 'js/core/api-client.js', 'js/core/console-view.js', 'js/core/addressbook.js',
    'js/features/update.js', 'js/features/setup-ui.js',
    'js/features/devices-ui.js', 'js/features/addressbook-ui.js',
    'js/features/users-ui.js', 'js/features/audit-ui.js',
    'js/features/server-ops-ui.js', 'js/features/overview.js',
    'js/app.js', 'js/boot.js'
];

function localScripts() {
    const html = read('index.html');
    return [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
        .map((m) => m[1])
        .filter((s) => !s.startsWith('../'));
}

test('VERSION is a bare semver line', () => {
    const v = read('VERSION');
    assert.match(v, /^[0-9]+\.[0-9]+\.[0-9]+\n$/,
        'VERSION must be exactly one semver line — the Makefile and self-update both read it raw');
});

test('package.json declares the four spec-mandated test scripts with exact commands', () => {
    // C11: check each REQUIRED entry by name and value. Later tasks add more
    // scripts (test:unit, test:live, test:e2e:setup); that must stay legal.
    const pkg = JSON.parse(read('package.json'));
    const required = {
        'test': 'node --test tests/unit/*.test.js',
        'test:integration': 'node --test tests/integration/*.test.js',
        'test:smoke': 'node tests/smoke.mjs',
        'test:e2e': 'E2E=1 node tests/e2e.mjs'
    };
    for (const [k, v] of Object.entries(required)) {
        assert.equal(pkg.scripts[k], v, `scripts["${k}"]`);
    }
    assert.equal(pkg.private, true, 'the dev harness must never be publishable');
});

test('manifest.json parses and pins Pilot into the Cockpit tool list', () => {
    const m = JSON.parse(read('manifest.json'));
    assert.equal(m.name, 'pilot');
    assert.equal(m.tools.index.path, 'index.html');
    assert.equal(m.tools.index.order, 53);
    assert.equal(m.requires.cockpit, '300');
    assert.ok(exists(m.tools.index.path), 'manifest points at a file that exists');
});

test('manifest CSP is self-only: connect-src \'self\', no wildcard, no remote host, no frame-src', () => {
    // The whole control plane depends on this: a browser fetch() to a remote host
    // is blocked, which is WHY api-io goes through the Cockpit bridge (spec §3) and
    // why the update check goes through cockpit.spawn (spec §10.2).
    const csp = JSON.parse(read('manifest.json'))['content-security-policy'];
    assert.equal(typeof csp, 'string');
    const directives = csp.split(';').map((s) => s.trim()).filter(Boolean)
        .map((d) => d.split(/\s+/));
    const connect = directives.find((d) => d[0] === 'connect-src');
    assert.ok(connect, 'CSP has a connect-src directive');
    assert.deepEqual(connect.slice(1), ["'self'"], "connect-src must be exactly 'self'");
    assert.ok(!directives.some((d) => d[0] === 'frame-src'),
        'no frame-src — Pilot links to the web client, it never frames a remote origin');
    const ALLOWED = new Set(["'self'", "'none'", "'unsafe-inline'", "'unsafe-eval'", 'data:', 'blob:']);
    for (const d of directives) {
        for (const tok of d.slice(1)) {
            assert.ok(!tok.includes('*'), `${d[0]} contains a wildcard: ${tok}`);
            assert.ok(ALLOWED.has(tok), `${d[0]} names a non-self source: ${tok}`);
        }
    }
});

test('Makefile emits pilot-<VERSION>.zip with exactly one top-level pilot/ directory', () => {
    // §10.4: Explorer's multi-plugin updater expects <dir>-<version>.zip, tag
    // v<version>, one top-level <dir>/. Getting the layout wrong breaks adoption.
    const mk = read('Makefile');
    assert.match(mk, /^VERSION := \$\(shell cat VERSION\)$/m);
    assert.match(mk, /^TAG := v\$\(VERSION\)$/m);
    assert.match(mk, /^zip:$/m);
    assert.ok(mk.includes('mkdir "$$tmp/pilot"'), 'zip stages into a single pilot/ directory');
    assert.ok(mk.includes('zip -rq "pilot-$(VERSION).zip" pilot'), 'archive is named pilot-<VERSION>.zip');
    for (const t of ['install:', 'uninstall:', 'publish:', 'vendor:', 'clean:', 'version:', 'test:']) {
        assert.ok(mk.includes('\n' + t), `Makefile has a ${t.slice(0, -1)} target`);
    }
});

test('index.html loads cockpit.js and carries both C7 insertion markers', () => {
    const html = read('index.html');
    assert.ok(html.includes('../base1/cockpit.js'), 'index.html loads the Cockpit API');
    assert.ok(html.includes('<!-- pilot:core-scripts -->'),
        'the core-script tail anchor must exist for every later task to insert against');
    assert.ok(html.includes('<!-- pilot:feature-scripts -->'),
        'the feature-script tail anchor must exist for every later task to insert against');
});

test('index.html declares a mount point for every surface in the spec', () => {
    const html = read('index.html');
    for (const id of ['pilot-overview', 'pilot-setup', 'pilot-devices', 'pilot-addressbook',
        'pilot-users', 'pilot-audit', 'pilot-server-ops', 'pilot-partials']) {
        assert.ok(html.includes(`id="${id}"`), `index.html has #${id}`);
    }
});

test('every local script index.html references exists (vendor bundles excepted)', () => {
    const VENDOR = new Set(['js/alpine.min.js', 'js/bootstrap.bundle.min.js']);
    for (const s of localScripts()) {
        if (VENDOR.has(s)) continue;
        assert.ok(exists(s), `index.html references a missing script: ${s}`);
    }
});

test('index.html script order is a subsequence of C7, and boot.js is last', () => {
    // Subsequence, not equality (C11): scripts absent from C7 are ignored, scripts
    // absent from index.html are fine. Only a genuine C7 inversion fails.
    const scripts = localScripts();
    const pos = new Map(C7.map((s, i) => [s, i]));
    const seen = new Set();
    let prev = -1;
    let prevSrc = '';
    for (const s of scripts) {
        assert.ok(!seen.has(s), `index.html loads ${s} more than once`);
        seen.add(s);
        if (!pos.has(s)) continue;
        const i = pos.get(s);
        assert.ok(i > prev, `index.html loads ${s} after ${prevSrc}, but C7 pins ${s} first`);
        prev = i;
        prevSrc = s;
    }
    assert.equal(scripts[scripts.length - 1], 'js/boot.js',
        'js/boot.js must be the last script — it injects partials and only then loads Alpine');
});

test('css/pilot.css declares every --pl-* accent the spec names', () => {
    const css = read('css/pilot.css');
    for (const v of ['--pl-log-bg', '--pl-log-fg', '--pl-step-ok', '--pl-step-fail',
        '--pl-step-running', '--pl-dot-online', '--pl-dot-offline',
        '--pl-progress-fg', '--pl-row-selected-bg']) {
        assert.match(css, new RegExp('^\\s*' + v + '\\s*:', 'm'), `${v} is declared`);
    }
});

test('js/app.js loads under node and exposes the tab model', () => {
    const App = require('../../js/app.js');
    assert.equal(typeof App.pilotApp, 'function');
    assert.ok(Array.isArray(App.TABS) && App.TABS.length >= 7);
    const ids = App.TABS.map((t) => t.id);
    for (const id of ['overview', 'setup', 'devices', 'addressbook', 'users', 'audit', 'server-ops']) {
        assert.ok(ids.includes(id), `tab ${id}`);
    }
    for (const t of App.TABS) {
        assert.equal(typeof t.label, 'string');
        assert.ok(t.label.length > 0);
        // Every tab must name a real mount point in index.html.
        assert.ok(read('index.html').includes(`id="${t.mount}"`), `${t.id} mounts at #${t.mount}`);
    }
});

test('pilotApp() returns a component whose surfaces fail independently', () => {
    // §7.2: "Each surface loads and fails independently ... No global something
    // went wrong." The component therefore carries per-tab error slots, not one.
    const App = require('../../js/app.js');
    const c = App.pilotApp();
    assert.equal(c.tab, 'overview');
    assert.equal(typeof c.errors, 'object');
    for (const t of App.TABS) {
        assert.equal(c.errors[t.id], null, `${t.id} starts with no error`);
    }
    c.failSurface('audit', { kind: 'API_UNREACHABLE', message: 'down' });
    assert.equal(c.errors.audit.kind, 'API_UNREACHABLE');
    assert.equal(c.errors.devices, null, 'a failing audit must not blank out devices');
    c.clearSurface('audit');
    assert.equal(c.errors.audit, null);
});

test('js/boot.js loads under node without touching the DOM, and starts empty', () => {
    const Boot = require('../../js/boot.js');
    // C11 defect fix: the brief's original assertion here was
    // `assert.deepEqual(Boot.PARTIALS, [], ...)`. That pins PARTIALS to an exact
    // empty array, which later tasks legitimately violate the moment they append a
    // modal partial. We assert only the shape (an array) here; membership checks
    // for specific partials belong to the tasks that add them, via `includes`.
    assert.ok(Array.isArray(Boot.PARTIALS));
    assert.equal(typeof Boot.boot, 'function');
    assert.equal(typeof Boot.loadScript, 'function');
    assert.equal(typeof Boot.fetchPartial, 'function');
});

test('app.js and boot.js carry the house dual-export tail', () => {
    for (const f of ['js/app.js', 'js/boot.js']) {
        const t = read(f);
        assert.match(t, /^\s*'use strict';/m, `${f} declares strict mode`);
        assert.match(t, /root\.Pilot[A-Za-z0-9]*\s*=/, `${f} assigns a Pilot* global`);
        assert.match(t, /typeof module !== 'undefined' && module\.exports/, `${f} dual-exports`);
        assert.ok(!/^\s*(import|export)\s/m.test(t), `${f} uses no ES module syntax`);
    }
});
