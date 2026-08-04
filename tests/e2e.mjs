#!/usr/bin/env node
// tests/e2e.mjs — drives index.html in a real browser against a stubbed Cockpit
// bridge, and is also the library every tests/e2e/*.e2e.mjs scenario imports.
//
// What this tier proves: the page loads under the plugin's own CSP, every script
// parses, Alpine initialises and binds, the surfaces really render, and the error
// paths reach the screen. What it does not prove: that pilot-exec provisions a
// host or that the API client matches a real server — tests/integration does that.
//
//   node tests/e2e.mjs                    every scenario, headless
//   node tests/e2e/setup.e2e.mjs          one scenario, standalone
//   HEADED=1 node tests/e2e.mjs           watch it run
//
// playwright is imported lazily so this file can be required by the unit tier
// with no browser installed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2'
};

export function contentType(file) {
    return TYPES[path.extname(String(file || '')).toLowerCase()] || 'application/octet-stream';
}

// Pure: given a root and a raw request URL, which file (if any) may be served.
// Every traversal defence lives here so it can be tested without a socket.
export function resolveRequestPath(root, rawUrl) {
    const base = path.resolve(String(root || ROOT));
    if (typeof rawUrl !== 'string') return { status: 400, file: null };
    if (rawUrl.length > 4096) return { status: 400, file: null };

    let rel = rawUrl.split('?')[0].split('#')[0];
    try {
        rel = decodeURIComponent(rel);
    } catch (e) {
        return { status: 400, file: null };     // %zz and friends
    }
    if (rel.indexOf(' ') >= 0 || rel.indexOf('\0') >= 0) return { status: 400, file: null };
    if (rel === '' || rel === '/') rel = '/index.html';
    if (rel.charAt(0) !== '/') rel = '/' + rel;

    // index.html loads ../base1/cockpit.js, which the browser resolves against
    // the document root. That request is the whole point of this server.
    if (rel === '/base1/cockpit.js') rel = '/tests/e2e/cockpit-stub.js';

    const normalised = path.posix.normalize(rel).replace(/^(\.\.\/)+/, '/');
    const abs = path.resolve(path.join(base, normalised));
    if (abs !== base && !abs.startsWith(base + path.sep)) return { status: 404, file: null };
    return { status: 200, file: abs };
}

// The shipped CSP, applied to the served page. A policy that breaks Alpine or
// blocks a script is a real defect, and this is the only tier that can see it.
export function cspHeader(root) {
    try {
        const m = JSON.parse(fs.readFileSync(path.join(String(root || ROOT), 'manifest.json'), 'utf8'));
        const csp = m && m['content-security-policy'];
        return typeof csp === 'string' && csp.length > 0 ? csp : null;
    } catch (e) {
        return null;
    }
}

let BASE_URL = null;
export function baseUrl() { return BASE_URL; }

export function serve(root) {
    const base = path.resolve(String(root || ROOT));
    const csp = cspHeader(base);
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const r = resolveRequestPath(base, req.url === undefined ? '/' : req.url);
            if (r.status !== 200) {
                res.writeHead(r.status, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(String(r.status));
                return;
            }
            let stat = null;
            try { stat = fs.statSync(r.file); } catch (e) { stat = null; }
            if (!stat || stat.isDirectory()) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('not found');
                return;
            }
            const headers = { 'Content-Type': contentType(r.file), 'Cache-Control': 'no-store' };
            if (csp && r.file.endsWith('.html')) headers['Content-Security-Policy'] = csp;
            res.writeHead(200, headers);
            res.end(fs.readFileSync(r.file));
        });
        server.on('error', reject);
        // Port 0: never collide with a developer's own server or a parallel run.
        server.listen(0, '127.0.0.1', () => {
            BASE_URL = `http://127.0.0.1:${server.address().port}`;
            resolve({
                url: BASE_URL,
                close: () => new Promise((done) => server.close(() => done()))
            });
        });
    });
}

// --- the ledger ----------------------------------------------------------

const RESULTS = [];

export async function check(name, fn) {
    try {
        await fn();
        RESULTS.push({ name, ok: true, error: null });
        console.log(`  ok  ${name}`);
    } catch (e) {
        RESULTS.push({ name, ok: false, error: e });
        console.log(`  FAIL  ${name}\n        ${e && e.message}`);
    }
}

export function results() { return RESULTS.slice(); }
export function failed() { return RESULTS.filter((r) => !r.ok); }
export function resetResults() { RESULTS.length = 0; }

export function report(label) {
    const bad = failed();
    console.log(`\ne2e${label ? ' ' + label : ''}: ${RESULTS.length - bad.length} passed, ${bad.length} failed`);
    for (const f of bad) console.log(`  FAIL  ${f.name}: ${f.error && f.error.message}`);
    return bad.length;
}

export function assertOk(v, msg) {
    if (!v) throw new Error(msg || 'assertion failed');
}

export function assertEqual(a, b, msg) {
    if (a !== b) {
        throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
    }
}

export function assertMatch(value, re, msg) {
    const s = String(value);
    if (!re.test(s)) {
        throw new Error(`${msg || 'no match'}: ${re} against ${JSON.stringify(s.slice(0, 400))}`);
    }
}

// --- the page ------------------------------------------------------------

// Deliberately minimal: defaults that let the page reach a rendered state and
// nothing that encodes another module's data shapes. Scenarios script their own.
export const DEFAULT_STUB = {
    spawn: {
        'install -d': '',
        'id -u': '0',
        'ls -1 /etc/pilot/servers': ''
    },
    files: {
        '/etc/pilot/config.json': '{}',
        '/etc/os-release': 'NAME="Red Hat Enterprise Linux"\nID="rhel"\n' +
            'ID_LIKE="fedora"\nVERSION_ID="10.2"\n' +
            'PRETTY_NAME="Red Hat Enterprise Linux 10.2 (Coughlan)"\n'
    },
    http: {},
    dbus: {}
};

export function mergeStub(stub) {
    const s = (stub && typeof stub === 'object' && !Array.isArray(stub)) ? stub : {};
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    const merged = {
        spawn: Object.assign({}, DEFAULT_STUB.spawn, obj(s.spawn)),
        files: Object.assign({}, DEFAULT_STUB.files, obj(s.files)),
        http: Object.assign({}, DEFAULT_STUB.http, obj(s.http)),
        dbus: Object.assign({}, DEFAULT_STUB.dbus, obj(s.dbus)),
        httpAddressCap: s.httpAddressCap === undefined ? true : !!s.httpAddressCap,
        calls: [],
        errors: []
    };
    // Added ONLY when a scenario supplies a plain object (e.g. { home: '/root' })
    // -- the key is otherwise absent entirely, not present-with-undefined, so
    // the merged shape for every existing scenario is byte-for-byte unchanged.
    // cockpit-stub.js's user() does `Object.assign({name:'root',id:0}, cfg.user || {})`.
    if (s.user && typeof s.user === 'object' && !Array.isArray(s.user)) merged.user = s.user;
    return merged;
}

// C15: open() navigates. A scenario never calls page.goto.
export async function open(browser, stub) {
    if (!BASE_URL) throw new Error('open() was called before serve(): serve(ROOT) first');
    const merged = mergeStub(stub);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();

    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

    await page.addInitScript((s) => { window.__pilotStub = s; }, merged);
    await page.goto(`${BASE_URL}/index.html`, { waitUntil: 'load', timeout: 20000 });
    // Wait for the bridge this harness owns, never for a selector another task
    // owns — a scenario waits for its own markup.
    await page.waitForFunction(
        () => typeof window.cockpit !== 'undefined' && !!window.__pilotStub,
        null, { timeout: 15000 });

    page.ctx = ctx;
    page.consoleErrors = consoleErrors;
    page.stub = merged;
    return page;
}

// C12/C15: the ONE way a scenario feeds a surface. routes are keyed
// "<METHOD> <path>"; a value is {status, body} or a bare body, or
// {reject:true, message, problem, status}. Matching reuses the stub's
// exact-then-longest-substring rule, so there is one matcher, not two.
export async function useTransport(page, routes, opts) {
    await page.waitForFunction(
        () => !!window.PilotApi && typeof window.PilotApi.setTransport === 'function',
        null, { timeout: 15000 });
    await page.evaluate(({ table, fallback }) => {
        window.__pilotTransport = { calls: [], routes: table };
        window.PilotApi.setTransport(function (req) {
            const r = req || {};
            const method = String(r.method || 'GET').toUpperCase();
            const p = String(r.path === undefined ? '/' : r.path);
            window.__pilotTransport.calls.push({
                method: method, path: p,
                query: r.query === undefined ? null : r.query,
                body: r.body === undefined ? null : r.body,
                admin: !!r.admin
            });
            const spec = window.PilotCockpitStub.matchKey(table, method + ' ' + p);
            if (spec === undefined) {
                if (fallback === null) {
                    return Promise.reject(new Error('no route for ' + method + ' ' + p));
                }
                return Promise.resolve({ status: 200, body: fallback });
            }
            if (spec && spec.reject) {
                const e = new Error(spec.message || 'transport failed');
                e.problem = spec.problem === undefined ? null : spec.problem;
                e.status = spec.status === undefined ? 0 : spec.status;
                return Promise.reject(e);
            }
            const status = (spec && spec.status !== undefined) ? spec.status : 200;
            const body = (spec && spec.body !== undefined) ? spec.body : spec;
            return Promise.resolve({ status: status, body: body });
        });
    }, {
        table: routes || {},
        fallback: (opts && opts.fallback !== undefined) ? opts.fallback : null
    });
}

export async function transportCalls(page) {
    return page.evaluate(() =>
        (window.__pilotTransport && window.__pilotTransport.calls) || []);
}

export function shotPath(name) {
    const safe = String(name === undefined || name === null ? '' : name)
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    return path.join(ROOT, 'tests', `e2e-${safe || 'shot'}.png`);
}

export async function shot(page, name) {
    const file = shotPath(name);
    await page.screenshot({ path: file, fullPage: true });
    return file;
}

// --- discovery and the runner --------------------------------------------

export function scenarioFiles(dir) {
    const abs = path.resolve(String(dir || path.join(ROOT, 'tests', 'e2e')));
    let entries = [];
    try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
        return [];
    }
    return entries
        .filter((e) => e.isFile() && e.name.endsWith('.e2e.mjs'))
        .map((e) => e.name)
        .sort()
        .map((n) => path.join(abs, n));
}

export async function launch() {
    const { chromium } = await import('playwright');
    return chromium.launch({ headless: !process.env.HEADED, timeout: 30000 });
}

// True when PILOT_E2E_REQUIRE=1 turns a missing/broken browser into a hard
// failure instead of a clean skip — the escape hatch CI uses to demand a
// real run on a machine that is supposed to have a working browser.
export function requireBrowser() {
    return process.env.PILOT_E2E_REQUIRE === '1';
}

function scenarioContext(browser, url) {
    return {
        browser, url, open, check, assertEqual, assertOk, assertMatch, shot,
        useTransport, transportCalls
    };
}

export function isMain(metaUrl) {
    if (!process.argv[1]) return false;
    return pathToFileURL(path.resolve(process.argv[1])).href === metaUrl;
}

// Standalone mode: one scenario file run on its own (C15).
export async function runScenario(fn, name) {
    const server = await serve(ROOT);
    let browser;
    try {
        browser = await launch();
    } catch (e) {
        await server.close();
        if (requireBrowser()) {
            console.error(`e2e: ${name} — PILOT_E2E_REQUIRE=1 but chromium is unavailable: ${e && e.message}`);
            return 1;
        }
        console.log(`e2e: ${name} — skipped, chromium unavailable: ${e && e.message}`);
        return 0;
    }
    console.log(`e2e: ${name} — serving ${ROOT} at ${server.url}\n`);
    resetResults();
    try {
        await fn(scenarioContext(browser, server.url));
    } catch (e) {
        RESULTS.push({ name: `${name} (threw)`, ok: false, error: e });
        console.log(`  FAIL  ${name} threw: ${e && e.message}`);
    } finally {
        await browser.close();
        await server.close();
    }
    return report(name);
}

async function main() {
    const files = scenarioFiles(path.join(ROOT, 'tests', 'e2e'));
    if (files.length === 0) {
        console.error('e2e: no tests/e2e/*.e2e.mjs scenarios found');
        process.exitCode = 1;
        return;
    }
    const server = await serve(ROOT);
    let browser;
    try {
        browser = await launch();
    } catch (e) {
        await server.close();
        if (requireBrowser()) {
            console.error(`e2e: PILOT_E2E_REQUIRE=1 but chromium is unavailable: ${e && e.message}`);
            process.exitCode = 1;
            return;
        }
        console.log(`e2e: skipped — chromium unavailable: ${e && e.message}`);
        process.exitCode = 0;
        return;
    }
    console.log(`e2e: serving ${ROOT} at ${server.url}`);
    let failures = 0;
    try {
        for (const file of files) {
            const label = path.basename(file).replace(/\.e2e\.mjs$/, '');
            console.log(`\n--- ${label}`);
            resetResults();
            const mod = await import(pathToFileURL(file).href);
            if (typeof mod.default !== 'function') {
                console.log(`  FAIL  ${label}: no default-exported scenario function`);
                failures += 1;
                continue;
            }
            try {
                await mod.default(scenarioContext(browser, server.url));
            } catch (e) {
                RESULTS.push({ name: `${label} (threw)`, ok: false, error: e });
                console.log(`  FAIL  ${label} threw: ${e && e.message}`);
            }
            failures += report(label);
        }
    } finally {
        await browser.close();
        await server.close();
    }
    console.log(`\ne2e: ${files.length} scenario(s), ${failures} failed check(s)`);
    if (failures) process.exitCode = 1;
}

// main() is deliberately NOT top-level-awaited: tests/e2e.mjs is the entry
// point AND a module every scenario file statically imports (`../e2e.mjs`)
// for isMain/runScenario. main() dynamically imports those same scenario
// files. If this module's own top-level evaluation were suspended on
// `await main()`, that dynamic import could never finish linking — it needs
// this module fully evaluated, which is exactly what the pending top-level
// await is blocking on. That is a real ECMAScript module deadlock (Node
// reports it as "Detected unsettled top-level await"), not a slow test.
// Calling main() without awaiting it at the top level lets this module's
// evaluation complete immediately, so the circular import resolves fine.
if (isMain(import.meta.url)) {
    main().catch((e) => {
        console.error(`e2e: fatal: ${(e && e.stack) || e}`);
        process.exitCode = 1;
    });
}
