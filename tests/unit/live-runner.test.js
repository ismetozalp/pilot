// Unit tests for tests/e2e/run-live.mjs -- the pure/injectable half of the LIVE
// e2e tier (PilotLive.shouldSkip/credentials/loginUrl/isCspViolation).
//
// This file never touches a real network, a real chromium, or the real
// PILOT_LIVE env var: every precondition shouldSkip() checks is overridable,
// and credentials() is fed an explicit env object and a throwaway file under
// os.tmpdir() -- never the developer's own
// ~/.config/.claude/cockpit-credentials.json. That is the whole point of
// keeping this half pure: the live tier itself needs a real Cockpit to
// exercise, but the decision logic around it does not.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
let Live = null;

before(async () => {
    Live = await import(pathToFileURL(path.join(ROOT, 'tests', 'e2e', 'run-live.mjs')).href);
});

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-live-'));
}

// --- isCspViolation: a pure matcher, no browser required -------------------

test('isCspViolation recognises real Chromium CSP wording', () => {
    const real = "Refused to connect to 'https://api.github.com/repos/x' because it violates " +
        'the following Content Security Policy directive: "connect-src \'self\'".';
    assert.equal(Live.isCspViolation(real), true);
});

test('isCspViolation recognises every Refused-to verb this tier cares about', () => {
    for (const verb of ['connect', 'load', 'execute', 'apply']) {
        assert.equal(Live.isCspViolation(`Refused to ${verb} 'x' because ...`), true, verb);
    }
});

test('isCspViolation is case-insensitive on "content security policy"', () => {
    assert.equal(Live.isCspViolation('violates the content security policy'), true);
});

test('isCspViolation is false for ordinary console noise', () => {
    for (const msg of [
        'Failed to load resource: the server responded with a status of 404',
        'a warning about something unrelated',
        'DevTools failed to parse SourceMap'
    ]) {
        assert.equal(Live.isCspViolation(msg), false, msg);
    }
});

test('isCspViolation is false for empty and nullish input', () => {
    assert.equal(Live.isCspViolation(''), false);
    assert.equal(Live.isCspViolation(null), false);
    assert.equal(Live.isCspViolation(undefined), false);
});

// --- loginUrl ---------------------------------------------------------------

test('loginUrl builds the right URL from a bare https base', () => {
    assert.equal(Live.loginUrl('https://localhost:9090'), 'https://localhost:9090/');
});

test('loginUrl tolerates a trailing slash already present', () => {
    assert.equal(Live.loginUrl('https://localhost:9090/'), 'https://localhost:9090/');
});

test('loginUrl rejects a non-https base', () => {
    assert.throws(() => Live.loginUrl('http://localhost:9090'), /https/);
    assert.throws(() => Live.loginUrl(''), /https/);
    assert.throws(() => Live.loginUrl(undefined), /https/);
});

// --- credentials -------------------------------------------------------------

test('credentials: env takes precedence over the file', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'creds.json');
    fs.writeFileSync(file, JSON.stringify({ user: 'file-user', password: 'file-pass' }));
    const got = Live.credentials({ COCKPIT_USER: 'env-user', COCKPIT_PASSWORD: 'env-pass' }, file);
    assert.deepEqual(got, { user: 'env-user', password: 'env-pass' });
});

test('credentials: falls back to the file when the environment has neither var', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'creds.json');
    fs.writeFileSync(file, JSON.stringify({ user: 'file-user', password: 'file-pass' }));
    const got = Live.credentials({}, file);
    assert.deepEqual(got, { user: 'file-user', password: 'file-pass' });
});

test('credentials: a partial env (user with no password) is ignored, falling back to the file', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'creds.json');
    fs.writeFileSync(file, JSON.stringify({ user: 'file-user', password: 'file-pass' }));
    const got = Live.credentials({ COCKPIT_USER: 'env-user' }, file);
    assert.deepEqual(got, { user: 'file-user', password: 'file-pass' });
});

test('credentials: returns null when the file is missing and env is empty', () => {
    const dir = tmpdir();
    const missing = path.join(dir, 'nope.json');
    assert.equal(Live.credentials({}, missing), null);
});

test('credentials: returns null for malformed JSON', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'creds.json');
    fs.writeFileSync(file, '{ not json');
    assert.equal(Live.credentials({}, file), null);
});

test('credentials: returns null when the file has a user but no password', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'creds.json');
    fs.writeFileSync(file, JSON.stringify({ user: 'ada' }));
    assert.equal(Live.credentials({}, file), null);
});

test('credentials: returns null for a JSON array or a non-object document', () => {
    const dir = tmpdir();
    const arrFile = path.join(dir, 'arr.json');
    fs.writeFileSync(arrFile, '[1,2,3]');
    assert.equal(Live.credentials({}, arrFile), null);
    const strFile = path.join(dir, 'str.json');
    fs.writeFileSync(strFile, '"just a string"');
    assert.equal(Live.credentials({}, strFile), null);
});

test('credentials: accepts username/pass as aliases for a hand-edited file', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'creds.json');
    fs.writeFileSync(file, JSON.stringify({ username: 'ada', pass: 'hunter2' }));
    assert.deepEqual(Live.credentials({}, file), { user: 'ada', password: 'hunter2' });
});

test('credentials: the returned object is never logged by credentials() itself', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'creds.json');
    const SECRET = 'do-not-print-me-12345';
    fs.writeFileSync(file, JSON.stringify({ user: 'ada', password: SECRET }));

    const originalLog = console.log;
    const originalErr = console.error;
    const seen = [];
    console.log = (...args) => seen.push(args.join(' '));
    console.error = (...args) => seen.push(args.join(' '));
    let got;
    try {
        got = Live.credentials({}, file);
    } finally {
        console.log = originalLog;
        console.error = originalErr;
    }
    assert.deepEqual(got, { user: 'ada', password: SECRET });
    assert.equal(seen.length, 0, 'credentials() must not write to console.log/console.error');
    for (const line of seen) assert.equal(line.includes(SECRET), false);
});

// --- shouldSkip: every precondition is injected, never the real network ----

function allGoodProbes(overrides) {
    return Object.assign({
        env: { PILOT_LIVE: '1' },
        credentials: { user: 'ada', password: 'hunter2' },
        portOpen: async () => true,
        chromiumAvailable: async () => true
    }, overrides || {});
}

test('shouldSkip: returns a reason when PILOT_LIVE is unset', async () => {
    const reason = await Live.shouldSkip(allGoodProbes({ env: {} }));
    assert.equal(typeof reason, 'string');
    assert.match(reason, /PILOT_LIVE/);
});

test('shouldSkip: returns a reason when PILOT_LIVE is set to something other than "1"', async () => {
    const reason = await Live.shouldSkip(allGoodProbes({ env: { PILOT_LIVE: 'true' } }));
    assert.match(reason, /PILOT_LIVE/);
});

test('shouldSkip: returns a reason when no credentials exist', async () => {
    const reason = await Live.shouldSkip(allGoodProbes({ credentials: null }));
    assert.match(reason, /credentials/i);
});

test('shouldSkip: returns a reason when the port is closed', async () => {
    const reason = await Live.shouldSkip(allGoodProbes({ portOpen: async () => false }));
    assert.match(reason, /9090/);
});

test('shouldSkip: returns a reason when chromium is unavailable', async () => {
    const reason = await Live.shouldSkip(allGoodProbes({ chromiumAvailable: async () => false }));
    assert.match(reason, /chromium/i);
});

test('shouldSkip: returns null when every precondition holds', async () => {
    const reason = await Live.shouldSkip(allGoodProbes());
    assert.equal(reason, null);
});

test('shouldSkip: checks are short-circuited in order (PILOT_LIVE before a network probe)', async () => {
    let called = false;
    await Live.shouldSkip(allGoodProbes({
        env: {},
        portOpen: async () => { called = true; return true; }
    }));
    assert.equal(called, false, 'a closed PILOT_LIVE gate must never reach the port probe');
});

// --- requireLive / pluginInstalled: small env/fs helpers -------------------

test('requireLive reflects PILOT_LIVE_REQUIRE=1 exactly', () => {
    const saved = process.env.PILOT_LIVE_REQUIRE;
    try {
        delete process.env.PILOT_LIVE_REQUIRE;
        assert.equal(Live.requireLive(), false);
        process.env.PILOT_LIVE_REQUIRE = '1';
        assert.equal(Live.requireLive(), true);
        process.env.PILOT_LIVE_REQUIRE = 'yes';
        assert.equal(Live.requireLive(), false);
    } finally {
        if (saved === undefined) delete process.env.PILOT_LIVE_REQUIRE;
        else process.env.PILOT_LIVE_REQUIRE = saved;
    }
});

test('pluginInstalled is true only when manifest.json exists under the given dir', () => {
    const dir = tmpdir();
    assert.equal(Live.pluginInstalled(dir), false);
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
    assert.equal(Live.pluginInstalled(dir), true);
});
