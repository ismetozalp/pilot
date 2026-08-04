#!/usr/bin/env node
// tests/smoke.mjs — the eight structural invariants of C5.
//
// These are what parallel work breaks most easily: a module added to js/ but never
// referenced from index.html, an ES-module keyword sneaking in (a silent failure
// under Cockpit's plain-script loading), a module that forgets its dual export and
// so becomes untestable, a CSP that stops being self-only, or a core module that
// quietly grows an I/O dependency.
//
// Runs with no browser and no Cockpit — deliberately cheap enough to run constantly.
//
// Rules 7 and 8 are VACUOUSLY SATISFIED until the modules they police exist. That is
// not laziness: the theme registry and libexec/pilot-exec are owned by other tasks,
// and a smoke suite that fails until they land would make CI red from commit one,
// which is precisely what §12 step 1 forbids.
//
// Rules 5 and 6 run over COMMENT-STRIPPED source, not raw source. Applied to raw
// text, /cockpit\s*\.\s*http\b/ also matches inside a comment — and a header
// comment is exactly where a module legitimately explains why it does NOT use
// cockpit.http (js/core/servers.js, Task 19, whose header comment will contain the
// literal text "cockpit.http" while explaining the omission). Stripping comments
// first keeps the rule aimed at real code, not at prose about the API.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
const { stripComments } = require_('./lib/strip-comments.js');
const { checkC7Order } = require_('./lib/order-check.js');

const failures = [];
const notes = [];
const fail = (m) => failures.push(m);
const ok = (m) => notes.push(m);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

// Third-party bundles. Fetched by `make vendor` rather than committed, so their
// absence is not a failure, and they are never scanned as first-party modules.
const VENDOR = new Set([
    'js/alpine.min.js', 'js/bootstrap.bundle.min.js', 'css/bootstrap.min.css'
]);

// C5 rule 6. The three core modules that are ALLOWED to touch cockpit. Round 1
// wrongly banned all cockpit use from js/core, which servers.js must have.
const IO_MODULES = new Set([
    'js/core/api-io.js', 'js/core/servers.js', 'js/core/settings.js'
]);

// C5 rule 5. The bridge HTTP channel belongs to exactly one file.
const HTTP_MODULE = 'js/core/api-io.js';

// C7, verbatim. Used as an ordering ORACLE only: a script absent from this list is
// skipped by the ordering check rather than failing it, so a later section that
// legitimately adds a module cannot be broken by this file (C11).
const C7 = [
    'js/alpine.min.js', 'js/bootstrap.bundle.min.js',
    'js/core/errors.js', 'js/core/semver.js', 'js/core/themes.js', 'js/core/settings.js',
    'js/core/ostarget.js', 'js/core/ports.js', 'js/core/firewall.js', 'js/core/tls.js',
    'js/core/provision-plan.js', 'js/core/redact.js',
    'js/core/servers.js', 'js/core/api-io.js', 'js/core/api-client.js',
    'js/core/console-view.js', 'js/core/addressbook.js', 'js/core/emptystate.js',
    'js/features/update.js', 'js/features/theme-ui.js', 'js/features/setup-ui.js',
    'js/features/devices-ui.js', 'js/features/addressbook-ui.js',
    'js/features/users-ui.js', 'js/features/audit-ui.js',
    'js/features/server-ops-ui.js', 'js/features/overview.js',
    'js/app.js', 'js/boot.js'
];

function walk(dir) {
    const out = [];
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return out;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = dir + '/' + entry.name;
        if (entry.isDirectory()) out.push(...walk(rel));
        else if (entry.name.endsWith('.js')) out.push(rel);
    }
    return out;
}

const modules = walk('js').filter((m) => !VENDOR.has(m));
const indexHtml = exists('index.html') ? read('index.html') : '';
const srcs = [...indexHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
const localSrcs = srcs.filter((s) => !s.startsWith('../'));

// --- rule 1: manifest parses; connect-src 'self'; no wildcard, no remote host,
// --- no frame-src -------------------------------------------------------

// The whole control plane rests on this. A relaxed connect-src would invite a
// browser fetch() straight to the API server, reintroducing CORS, mixed content and
// a token in browser JavaScript — all three of which §3 exists to avoid.
const CSP_ALLOWED = new Set(["'self'", "'none'", "'unsafe-inline'", "'unsafe-eval'", 'data:', 'blob:']);

let manifest = null;
try {
    manifest = JSON.parse(read('manifest.json'));
    ok('rule 1: manifest.json parses');
} catch (e) {
    fail(`rule 1: manifest.json does not parse: ${e.message}`);
}

if (manifest) {
    if (manifest.name !== 'pilot') fail('rule 1: manifest name is not "pilot"');
    if (!manifest.tools?.index?.path) fail('rule 1: manifest has no tools.index.path');
    else if (!exists(manifest.tools.index.path))
        fail(`rule 1: manifest points at a missing file: ${manifest.tools.index.path}`);
    if (!manifest.requires?.cockpit) fail('rule 1: manifest declares no cockpit requirement');

    const csp = manifest['content-security-policy'];
    if (typeof csp !== 'string' || csp === '') {
        fail('rule 1: manifest has no content-security-policy');
    } else {
        const directives = csp.split(';').map((s) => s.trim()).filter(Boolean)
            .map((d) => d.split(/\s+/));
        if (directives.some((d) => d[0] === 'frame-src'))
            fail('rule 1: CSP declares frame-src — Pilot links to the web client in a new ' +
                'tab and never frames a remote origin (spec §7.3)');
        const connect = directives.find((d) => d[0] === 'connect-src');
        if (!connect) fail('rule 1: CSP has no connect-src directive');
        else if (connect.length !== 2 || connect[1] !== "'self'")
            fail(`rule 1: connect-src must be exactly 'self', got: ${connect.slice(1).join(' ')}`);
        for (const d of directives) {
            for (const tok of d.slice(1)) {
                if (tok.includes('*'))
                    fail(`rule 1: CSP directive ${d[0]} contains a wildcard: ${tok}`);
                else if (!CSP_ALLOWED.has(tok))
                    fail(`rule 1: CSP directive ${d[0]} names a non-self source: ${tok}`);
            }
        }
        if (!failures.length) ok("rule 1: CSP is self-only, connect-src 'self', no frame-src");
    }
}

// --- rules 2 and 3: no ES modules; every module dual-exports ------------

for (const m of modules) {
    const text = read(m);

    // Cockpit loads these as plain scripts. An import/export keyword is a silent
    // runtime failure, so it is caught structurally instead.
    if (/^\s*import\s/m.test(text))
        fail(`rule 2: ${m} uses an "import" statement — plugin scripts must be plain scripts`);
    if (/^\s*export\s/m.test(text))
        fail(`rule 2: ${m} uses an "export" statement — plugin scripts must be plain scripts`);

    if (!/^\s*'use strict';/m.test(text))
        fail(`rule 3: ${m} is missing 'use strict'`);
    if (!/root\.Pilot[A-Za-z0-9]*\s*=/.test(text))
        fail(`rule 3: ${m} assigns no Pilot* global — the house pattern is an IIFE over root`);
    if (!/typeof module !== 'undefined' && module\.exports/.test(text))
        fail(`rule 3: ${m} has no dual module.exports — it cannot be unit tested under node`);
}
ok(`rules 2-3: ${modules.length} first-party module(s) are plain scripts with a dual export`);

// --- rule 4: every module is referenced by index.html, in C7 order ------

for (const s of localSrcs) {
    if (VENDOR.has(s)) continue;
    if (!exists(s)) fail(`rule 4: index.html references a missing script: ${s}`);
}
for (const m of modules) {
    if (!localSrcs.includes(m))
        fail(`rule 4: ${m} exists but is not loaded by index.html — the task that creates a ` +
            'module must add its <script> tag in the same task');
}

for (const marker of ['<!-- pilot:core-scripts -->', '<!-- pilot:feature-scripts -->']) {
    if (!indexHtml.includes(marker))
        fail(`rule 4: index.html lost the insertion anchor ${marker} — every later task ` +
            'inserts its script tag against it');
}

for (const msg of checkC7Order(localSrcs, C7)) fail(`rule 4: ${msg}`);

if (localSrcs.length === 0) {
    fail('rule 4: index.html loads no local scripts at all');
} else if (localSrcs[localSrcs.length - 1] !== 'js/boot.js') {
    // boot.js injects the partials and only then loads Alpine, so anything after it
    // would race the DOM it depends on.
    fail('rule 4: js/boot.js must be the last script in index.html — it loads Alpine ' +
        'after injecting the partials');
}

{
    const coreSrcs = localSrcs.filter((s) => s.startsWith('js/core/'));
    if (coreSrcs.length && coreSrcs[0] !== 'js/core/errors.js')
        fail('rule 4: js/core/errors.js must be the first core script — every module depends on it');
}
ok(`rule 4: ${localSrcs.length} local script(s) referenced, in C7 order, boot.js last`);

// --- rule 5: the bridge HTTP channel lives in exactly one file ---------
//
// Comment-stripped: a module may legitimately mention "cockpit.http" in a header
// comment explaining why it does NOT use it (js/core/servers.js, Task 19, whose
// header will contain that literal text), and that must not trip this rule.

const HTTP_USE = /cockpit\s*\.\s*http\b/;
for (const m of modules) {
    if (m === HTTP_MODULE) continue;
    if (HTTP_USE.test(stripComments(read(m))))
        fail(`rule 5: ${m} uses the cockpit HTTP channel — only ${HTTP_MODULE} may (spec §7)`);
}
ok(`rule 5: the cockpit HTTP channel is confined to ${HTTP_MODULE}`);

// --- rule 6: only IO_MODULES may touch cockpit inside js/core ----------
//
// Also comment-stripped, for the same reason: js/core/servers.js's header comment
// (Task 19) will name "cockpit.http" while explaining why it uses cockpit.spawn
// instead, and a module is free to explain in prose why it does or doesn't touch
// cockpit without that prose being mistaken for a real member access.

// `typeof cockpit !== 'undefined'` is the mandatory guard and deliberately does not
// match: this looks for an actual member access.
const COCKPIT_USE = /(^|[^.\w$])cockpit\s*\./;
for (const m of modules.filter((x) => x.startsWith('js/core/'))) {
    if (IO_MODULES.has(m)) continue;
    if (COCKPIT_USE.test(stripComments(read(m))))
        fail(`rule 6: ${m} references cockpit but is not in IO_MODULES — pure core logic ` +
            'must be separable from I/O (spec §3.1)');
}
ok(`rule 6: cockpit access inside js/core is confined to ${[...IO_MODULES].join(', ')}`);

// --- rule 7: every custom theme id has a palette block -----------------

// Vacuous unless BOTH files exist: themes.js and css/themes.css are added
// together, but not necessarily in the same commit within a task, so a partial
// landing (either file present without the other) must report not-applicable
// rather than fail.
if (!exists('js/core/themes.js') || !exists('css/themes.css')) {
    ok('rule 7: not applicable — js/core/themes.js and css/themes.css do not both exist yet');
} else {
    const css = read('css/themes.css');
    // system/light/dark use Bootstrap's built-in modes and intentionally have no block.
    const BUILTIN = new Set(['system', 'light', 'dark']);
    let checked = 0;
    try {
        const Themes = require_(path.join(ROOT, 'js/core/themes.js'));
        for (const t of (Themes.THEMES || [])) {
            if (!t || BUILTIN.has(t.id)) continue;
            checked += 1;
            if (!css.includes(`[data-bs-theme="${t.id}"]`))
                fail(`rule 7: theme "${t.id}" is registered but css/themes.css has no ` +
                    `[data-bs-theme="${t.id}"] block`);
        }
        ok(`rule 7: ${checked} custom theme(s) have a palette block`);
    } catch (e) {
        fail(`rule 7: could not load js/core/themes.js: ${e.message}`);
    }
}

// --- rule 8: the privileged helper is present and executable -----------

if (!exists('libexec/pilot-exec')) {
    // Vacuously satisfied. libexec/pilot-exec is owned by the executor task, and a
    // stub created here would be replaced later, orphaning whatever tested it.
    ok('rule 8: skipped — libexec/pilot-exec does not exist yet');
} else {
    const mode = fs.statSync(path.join(ROOT, 'libexec/pilot-exec')).mode & 0o777;
    if (mode !== 0o755)
        fail(`rule 8: libexec/pilot-exec is mode ${mode.toString(8).padStart(4, '0')}, must be 0755`);
    else
        ok('rule 8: libexec/pilot-exec is present and mode 0755');
}

// --- report -------------------------------------------------------------

for (const n of notes) console.log(`  ok  ${n}`);
if (failures.length) {
    console.error(`\n${failures.length} smoke failure(s):`);
    for (const f of failures) console.error(`  FAIL  ${f}`);
    process.exit(1);
}
console.log('\nsmoke: all structural checks passed');
