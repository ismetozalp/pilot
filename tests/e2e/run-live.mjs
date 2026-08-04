#!/usr/bin/env node
// tests/e2e/run-live.mjs — the LIVE end-to-end tier: Playwright driving a real,
// installed Cockpit at https://localhost:9090, not the stubbed harness in
// tests/e2e.mjs.
//
// WHY THIS EXISTS. tests/e2e.mjs serves the plugin from a static file server with
// a fake `cockpit` object. That is fast and deterministic, but the static server
// does not enforce manifest.json's content-security-policy, does not run the real
// base1/cockpit.js bridge, and never prompts for `superuser: 'require'`. Five
// failure classes pass every stubbed test and break only in production: a wrong
// manifest.json (Pilot missing from the nav), a CSP violation, script-order or
// dual-export breakage under the real cockpit.js, a superuser prompt/denial, and
// the plugin simply failing to load. The CSP row is the point: Pilot's entire
// self-update design (js/features/update.js) exists BECAUSE `connect-src 'self'`
// blocks fetch() -- a regression there passes every stubbed test and fails only
// once installed.
//
// GATING. This file does nothing destructive unless PILOT_LIVE=1, and even then
// it only ASSERTS state -- it never runs `sudo`, never installs the plugin, and
// never acquires privilege. A machine with no Cockpit, no credentials, or no
// chromium must still exit 0 with a clear printed reason (PILOT_LIVE_REQUIRE=1
// turns that clean skip into a hard failure -- the escape hatch a CI that is
// SUPPOSED to have a live Cockpit uses to demand a real run).
//
//   PILOT_LIVE=1 node tests/e2e/run-live.mjs      (what `npm run test:live` runs)
//   HEADED=1 PILOT_LIVE=1 node tests/e2e/run-live.mjs   watch it run
//   PILOT_LIVE_REQUIRE=1 PILOT_LIVE=1 node tests/e2e/run-live.mjs   hard-fail on skip
//
// playwright and node:net/fs are all imported lazily where it matters, so the
// pure helpers below (exported as PilotLive) can be unit-tested with no browser
// and no network -- tests/unit/live-runner.test.js injects probes rather than
// hitting the real port/filesystem/chromium.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');

export const BASE_URL = 'https://localhost:9090';
// The system location `sudo make install` uses. Most dev machines have no
// passwordless root, so this is not the ONLY place this tier looks --
// see pluginDirCandidates() below.
export const PLUGIN_DIR = '/usr/share/cockpit/pilot';
const DEFAULT_CRED_FILE = path.join(os.homedir(), '.config', '.claude', 'cockpit-credentials.json');

// Every Playwright call in this file gets an explicit timeout; this is the
// overall bound on the whole run -- an unbounded wait has hung this project's
// suite twice, and a hang here must be a loud non-zero exit, not a clean skip.
const OVERALL_TIMEOUT_MS = Number(process.env.PILOT_LIVE_TIMEOUT_MS) || 120000;
const STEP_TIMEOUT_MS = 15000;

// --- pure / lazily-networked helpers, exported as PilotLive ---------------

// Reads, in order: COCKPIT_USER/COCKPIT_PASSWORD from the environment, then
// ~/.config/.claude/cockpit-credentials.json (key names: user, password --
// aliases username/pass also accepted for a hand-edited file). Returns null if
// neither source yields a non-empty user+password pair. NEVER logs the result;
// callers must not either.
export function credentials(env, credFile) {
    const e = (env && typeof env === 'object') ? env : process.env;
    if (typeof e.COCKPIT_USER === 'string' && e.COCKPIT_USER !== '' &&
        typeof e.COCKPIT_PASSWORD === 'string' && e.COCKPIT_PASSWORD !== '') {
        return { user: e.COCKPIT_USER, password: e.COCKPIT_PASSWORD };
    }
    const file = typeof credFile === 'string' ? credFile : DEFAULT_CRED_FILE;
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        return null;
    }
    let obj;
    try {
        obj = JSON.parse(raw);
    } catch (err) {
        return null;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const user = typeof obj.user === 'string' ? obj.user : obj.username;
    const password = typeof obj.password === 'string' ? obj.password : obj.pass;
    if (typeof user !== 'string' || user === '') return null;
    if (typeof password !== 'string' || password === '') return null;
    return { user, password };
}

// Pure. Builds the login URL for a base that must be https:// -- Cockpit's own
// scheme, and a plain http base here would mean the test is pointed at the
// wrong thing entirely.
export function loginUrl(base) {
    const b = String(base === undefined || base === null ? '' : base);
    if (!/^https:\/\//i.test(b)) {
        throw new Error(`loginUrl requires an https base, got: ${JSON.stringify(b)}`);
    }
    return b.replace(/\/+$/, '') + '/';
}

// Pure. Real Chromium's CSP console wording, kept as one matcher so both the
// live-csp scenario and the unit tests exercise the exact same regex.
const CSP_RE = /Content Security Policy|Refused to (connect|load|execute|apply)/i;
export function isCspViolation(msg) {
    if (msg === undefined || msg === null) return false;
    const s = String(msg);
    if (s === '') return false;
    return CSP_RE.test(s);
}

// A TCP connect probe with its own bound -- never the network's default, which
// can hang far longer than this whole suite should ever take.
function probePort(host, port, timeoutMs) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
        let socket;
        try {
            socket = net.createConnection({ host: host || 'localhost', port: port || 9090 });
        } catch (e) {
            finish(false);
            return;
        }
        const timer = setTimeout(() => { try { socket.destroy(); } catch (e) { /* ignore */ } finish(false); },
            timeoutMs || 2000);
        socket.once('connect', () => { clearTimeout(timer); try { socket.end(); } catch (e) { /* ignore */ } finish(true); });
        socket.once('error', () => { clearTimeout(timer); finish(false); });
    });
}

// Chromium's own executablePath() is a sync filesystem lookup with no network
// and no browser process, so this is cheap enough to call on every run.
async function probeChromium() {
    try {
        const { chromium } = await import('playwright');
        const exe = chromium.executablePath();
        return typeof exe === 'string' && exe !== '' && fs.existsSync(exe);
    } catch (e) {
        return false;
    }
}

// Cockpit reads plugins from the system location AND, per-user, from
// ~/.local/share/cockpit/<name> -- a first-class Cockpit search path, not a
// hack (this machine already has `~/.local/share/cockpit/hangar` symlinked
// for that sibling project's own dev loop). A machine with no passwordless
// root can still get a genuine, standing live-tier install this way: `ln -s
// $(pwd) ~/.local/share/cockpit/pilot`, no sudo required. PILOT_PLUGIN_DIR
// overrides the search to exactly one directory when set.
function homePluginDir(home) {
    return path.join((home === undefined || home === null) ? os.homedir() : home,
        '.local', 'share', 'cockpit', 'pilot');
}

export function pluginDirCandidates(overrides) {
    const o = (overrides && typeof overrides === 'object') ? overrides : {};
    const env = o.env || process.env;
    if (typeof env.PILOT_PLUGIN_DIR === 'string' && env.PILOT_PLUGIN_DIR !== '') {
        return [env.PILOT_PLUGIN_DIR];
    }
    return [PLUGIN_DIR, homePluginDir(o.home)];
}

// Returns the first candidate directory that really has a manifest.json, or
// null. `overrides.candidates` lets the unit tests supply an explicit list
// (real tmp dirs) instead of touching PILOT_PLUGIN_DIR / the real home dir.
export function findPluginDir(overrides) {
    const o = (overrides && typeof overrides === 'object') ? overrides : {};
    const candidates = Array.isArray(o.candidates) ? o.candidates : pluginDirCandidates(o);
    for (const d of candidates) {
        try {
            if (fs.existsSync(path.join(String(d), 'manifest.json'))) return d;
        } catch (e) {
            // ignore and try the next candidate
        }
    }
    return null;
}

// dir === undefined: search every candidate location (system + per-user, or
// the PILOT_PLUGIN_DIR override). An explicit dir checks only that one path
// -- used directly by callers (and the unit test) that already know where to
// look.
export function pluginInstalled(dir) {
    if (dir !== undefined) {
        try {
            return fs.existsSync(path.join(String(dir), 'manifest.json'));
        } catch (e) {
            return false;
        }
    }
    return findPluginDir() !== null;
}

// Returns a reason string when a precondition is unmet, or null when every
// precondition holds. Every check is overridable so the unit tests inject
// probes instead of hitting PILOT_LIVE / the filesystem / port 9090 / a real
// chromium binary -- only the exported defaults below touch anything real.
export async function shouldSkip(overrides) {
    const o = (overrides && typeof overrides === 'object') ? overrides : {};
    const env = o.env || process.env;
    if (env.PILOT_LIVE !== '1') {
        return 'PILOT_LIVE is not set to 1 (this tier is opt-in; run `npm run test:live`)';
    }
    const creds = o.credentials !== undefined ? o.credentials : credentials(env);
    if (!creds) {
        return 'no Cockpit credentials found (set COCKPIT_USER/COCKPIT_PASSWORD, or create ' +
            '~/.config/.claude/cockpit-credentials.json with {"user":..,"password":..})';
    }
    const portOpen = o.portOpen !== undefined
        ? await o.portOpen()
        : await probePort('localhost', 9090, 2000);
    if (!portOpen) {
        return 'Cockpit is not listening on localhost:9090 (is cockpit.socket active?)';
    }
    const chromiumOk = o.chromiumAvailable !== undefined
        ? await o.chromiumAvailable()
        : await probeChromium();
    if (!chromiumOk) {
        return 'Playwright chromium is not installed (run: npx playwright install chromium)';
    }
    return null;
}

export function requireLive() {
    return process.env.PILOT_LIVE_REQUIRE === '1';
}

// --- the developer's own settings file ------------------------------------
//
// This tier drives the REAL plugin, and js/core/settings.js persists the theme
// to ~/.config/cockpit/pilot/settings.json for real. Until the final review the
// live tier had no cleanup of any kind: the theme check clicked "Nord", the run
// wrote theme:"nord" to disk, and the NEXT run started already on Nord — so the
// check ("a theme switch must change a real computed style") passed exactly once
// on a fresh machine and failed forever after. That is a self-poisoning test AND
// a test that quietly edits the developer's settings.
//
// Both halves are fixed: the scenario now picks a theme different from whatever
// is currently applied (see live-smoke.live.mjs), and the file is snapshotted
// here and put back in a finally.
export function settingsPath(home) {
    return path.join((home === undefined || home === null) ? os.homedir() : home,
        '.config', 'cockpit', 'pilot', 'settings.json');
}

// { path, existed, content }. Never throws: a snapshot that could not be taken
// simply records existed:false with a null content, and restore() then only
// removes a file THIS run created.
export function snapshotSettings(home) {
    const file = settingsPath(home);
    try {
        return { path: file, existed: true, content: fs.readFileSync(file, 'utf8') };
    } catch (e) {
        return { path: file, existed: false, content: null };
    }
}

// Puts back exactly what was there, or removes the file if there was none.
// Returns what it did, so the runner can print it.
export function restoreSettings(snap) {
    if (!snap || typeof snap !== 'object' || typeof snap.path !== 'string') return 'skipped';
    try {
        if (snap.existed) {
            const current = (() => { try { return fs.readFileSync(snap.path, 'utf8'); } catch (e) { return null; } })();
            if (current === snap.content) return 'unchanged';
            fs.mkdirSync(path.dirname(snap.path), { recursive: true });
            fs.writeFileSync(snap.path, snap.content);
            return 'restored';
        }
        if (!fs.existsSync(snap.path)) return 'unchanged';
        fs.unlinkSync(snap.path);
        return 'removed';
    } catch (e) {
        return 'failed: ' + (e && e.message);
    }
}

// --- the browser side: only reached once shouldSkip() returns null --------

function isMain(metaUrl) {
    if (!process.argv[1]) return false;
    return pathToFileURL(path.resolve(process.argv[1])).href === metaUrl;
}

function liveScenarioFiles() {
    let entries = [];
    try {
        entries = fs.readdirSync(path.join(ROOT, 'tests', 'e2e'), { withFileTypes: true });
    } catch (e) {
        return [];
    }
    return entries
        .filter((e) => e.isFile() && e.name.endsWith('.live.mjs'))
        .map((e) => e.name)
        .sort()
        .map((n) => path.join(ROOT, 'tests', 'e2e', n));
}

// The one place a password could leak into an error: strip it out of any
// string before it is ever thrown, logged, or screenshotted.
function redact(text, password) {
    if (!password) return text;
    return String(text).split(password).join('[REDACTED]');
}

async function newLivePage(browser, password) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    const consoleMessages = [];
    const pageErrors = [];
    page.on('console', (m) => consoleMessages.push(redact(m.text(), password)));
    page.on('pageerror', (e) => pageErrors.push(redact(String(e && e.message), password)));
    page.ctx = ctx;
    page.consoleMessages = consoleMessages;
    page.pageErrors = pageErrors;
    return page;
}

// Logs in at BASE_URL and waits for the shell (the nav) to render. Selectors
// are Cockpit's own (#login-user-input / #login-password-input / #login-button,
// then #host-apps once the shell replaces the login form) -- verified against
// this machine's real Cockpit, not guessed.
async function login(page, creds) {
    await page.goto(loginUrl(BASE_URL), { waitUntil: 'load', timeout: STEP_TIMEOUT_MS });
    await page.waitForSelector('#login-user-input', { state: 'visible', timeout: STEP_TIMEOUT_MS });
    await page.fill('#login-user-input', creds.user, { timeout: STEP_TIMEOUT_MS });
    await page.fill('#login-password-input', creds.password, { timeout: STEP_TIMEOUT_MS });
    await page.click('#login-button', { timeout: STEP_TIMEOUT_MS });
    await page.waitForSelector('#host-apps', { state: 'attached', timeout: STEP_TIMEOUT_MS });
}

// Cockpit loads every component into its own named iframe --
// name="cockpit1:<host>/<component>" -- verified against this machine's real
// shell (Explorer/Hangar/etc. all follow the pattern). A scenario needs a real
// Frame (not a FrameLocator) so it can evaluate() window.PilotApp.TABS, so this
// polls page.frame({name}) rather than using frameLocator, bounded by
// STEP_TIMEOUT_MS -- never an unbounded wait.
async function waitForNamedFrame(page, name, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const frame = page.frame({ name });
        if (frame) return frame;
        if (Date.now() >= deadline) {
            throw new Error(`frame named ${JSON.stringify(name)} did not appear within ${timeoutMs}ms`);
        }
        await new Promise((r) => setTimeout(r, 100));
    }
}

// Clicks Pilot's own nav entry (manifest.json's tools.index.label, "Pilot") and
// returns the real Frame for the plugin's iframe.
async function openPilot(page) {
    const navLink = page.locator('#host-apps a[href="/pilot"]');
    await navLink.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await navLink.click({ timeout: STEP_TIMEOUT_MS });
    const frame = await waitForNamedFrame(page, 'cockpit1:localhost/pilot', STEP_TIMEOUT_MS);
    await frame.waitForSelector('body', { state: 'attached', timeout: STEP_TIMEOUT_MS });
    return frame;
}

function shotPath(name) {
    const safe = String(name === undefined || name === null ? '' : name)
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    return path.join(ROOT, 'tests', `e2e-live-${safe || 'shot'}.png`);
}

async function shot(page, name) {
    const file = shotPath(name);
    await page.screenshot({ path: file, fullPage: true, timeout: STEP_TIMEOUT_MS });
    return file;
}

// --- the tiny ledger, mirroring tests/e2e.mjs's check()/report() shape ----

let RESULTS = [];
// A factory, not a bare function: the failure branch must redact the same way
// newLivePage()'s console/pageerror listeners and runScenarios()'s own catch
// already do, and that requires the scenario's password in scope. Nothing
// interpolates the password into a check() message today, but this is the
// most-exercised print path in the file (every `await check(...)` in both
// scenarios) and is handed to future scenario authors via ctx.check, so it
// gets the same guarantee as every other print site rather than being the one
// gap in an otherwise-held invariant.
export function makeCheck(password) {
    return async function check(name, fn) {
        try {
            await fn();
            RESULTS.push({ name, ok: true, error: null });
            console.log(`  ok  ${name}`);
        } catch (e) {
            const msg = redact(String(e && e.message), password);
            RESULTS.push({ name, ok: false, error: e });
            console.log(`  FAIL  ${name}\n        ${msg}`);
        }
    };
}
function assertOk(v, msg) { if (!v) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

function scenarioContext(browser, creds) {
    return {
        browser, creds, base: BASE_URL,
        newPage: (b) => newLivePage(b, creds.password),
        login, openPilot, shot, check: makeCheck(creds.password), assertOk, assertEqual, isCspViolation
    };
}

async function runScenarios(browser, creds) {
    const files = liveScenarioFiles();
    if (files.length === 0) {
        console.log('test:live: no tests/e2e/*.live.mjs scenarios found');
        return 1;
    }
    let failures = 0;
    for (const file of files) {
        const label = path.basename(file).replace(/\.live\.mjs$/, '');
        console.log(`\n--- ${label}`);
        RESULTS = [];
        let mod;
        try {
            mod = await import(pathToFileURL(file).href);
        } catch (e) {
            console.log(`  FAIL  ${label}: failed to import: ${e && e.message}`);
            failures += 1;
            continue;
        }
        if (typeof mod.default !== 'function') {
            console.log(`  FAIL  ${label}: no default-exported scenario function`);
            failures += 1;
            continue;
        }
        try {
            await mod.default(scenarioContext(browser, creds));
        } catch (e) {
            RESULTS.push({ name: `${label} (threw)`, ok: false, error: e });
            console.log(`  FAIL  ${label} threw: ${redact(String(e && e.message), creds.password)}`);
        }
        const bad = RESULTS.filter((r) => !r.ok);
        console.log(`${label}: ${RESULTS.length - bad.length} passed, ${bad.length} failed`);
        failures += bad.length;
    }
    return failures;
}

async function main() {
    // Hoisted so the watchdog can reach into an in-flight run and actually
    // close the browser it launched, instead of merely setting exitCode while
    // a chromium process keeps running in the background.
    let liveBrowser = null;
    let watchdogTimer = null;
    const watchdog = new Promise((_, reject) => {
        watchdogTimer = setTimeout(() => {
            (async () => {
                if (liveBrowser) {
                    try { await liveBrowser.close(); } catch (e) { /* best effort */ }
                }
            })().finally(() => {
                reject(new Error(`test:live: overall time budget of ${OVERALL_TIMEOUT_MS}ms exceeded -- ` +
                    'treating this as a hang, not a slow pass'));
            });
        }, OVERALL_TIMEOUT_MS);
    });

    async function body() {
        const reason = await shouldSkip();
        if (reason) {
            console.log(`test:live: skipped -- ${reason}`);
            if (requireLive()) {
                console.error('test:live: PILOT_LIVE_REQUIRE=1 but a precondition failed -- treating the skip as a failure');
                return 1;
            }
            return 0;
        }

        const installedAt = findPluginDir();
        if (!installedAt) {
            const candidates = pluginDirCandidates();
            console.log(`test:live: skipped -- Pilot is not installed at any of: ${candidates.join(', ')}`);
            console.log('test:live: install system-wide with `sudo make install` (then ' +
                '`systemctl try-restart cockpit`), or per-user with no root at all via ' +
                `\`ln -s ${ROOT} ${homePluginDir()}\` (or set PILOT_PLUGIN_DIR), then re-run ` +
                '`npm run test:live`.');
            if (requireLive()) {
                console.error('test:live: PILOT_LIVE_REQUIRE=1 but Pilot is not installed -- treating the skip as a failure');
                return 1;
            }
            return 0;
        }
        console.log(`test:live: Pilot found installed at ${installedAt}`);

        const creds = credentials();
        // Taken BEFORE the browser is even launched, and put back no matter how
        // this run ends: driving the real plugin really writes this file, and a
        // test tier has no business editing the developer's settings.
        const settings = snapshotSettings();
        const { chromium } = await import('playwright');
        liveBrowser = await chromium.launch({ headless: !process.env.HEADED, timeout: 30000 });
        console.log(`test:live: chromium launched, driving ${BASE_URL}`);
        try {
            return await runScenarios(liveBrowser, creds);
        } finally {
            await liveBrowser.close();
            liveBrowser = null;
            console.log(`test:live: ${settings.path}: ${restoreSettings(settings)}`);
        }
    }

    try {
        const failures = await Promise.race([body(), watchdog]);
        console.log(`\ntest:live: ${failures} failed check(s)`);
        process.exitCode = failures ? 1 : 0;
    } catch (e) {
        console.error(e && e.message ? e.message : String(e));
        process.exitCode = 1;
    } finally {
        clearTimeout(watchdogTimer);
    }
}

export const PilotLive = {
    credentials, shouldSkip, loginUrl, isCspViolation, requireLive,
    pluginInstalled, pluginDirCandidates, findPluginDir, makeCheck,
    settingsPath, snapshotSettings, restoreSettings
};

if (isMain(import.meta.url)) {
    main();
}
