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

// --- pluginDirCandidates / findPluginDir: the system-vs-per-user search ----
// (IMPORTANT 2 fix -- a dev machine with no passwordless root can still get a
// standing live install via ~/.local/share/cockpit/pilot, and PILOT_PLUGIN_DIR
// overrides the search to one exact directory.)

test('pluginDirCandidates: defaults to [system, ~/.local/share/cockpit/pilot] for the given home', () => {
    const got = Live.pluginDirCandidates({ env: {}, home: '/home/nobody' });
    assert.deepEqual(got, [
        '/usr/share/cockpit/pilot',
        path.join('/home/nobody', '.local', 'share', 'cockpit', 'pilot')
    ]);
});

test('pluginDirCandidates: PILOT_PLUGIN_DIR overrides the search to exactly one directory', () => {
    const got = Live.pluginDirCandidates({ env: { PILOT_PLUGIN_DIR: '/opt/whatever/pilot' }, home: '/home/nobody' });
    assert.deepEqual(got, ['/opt/whatever/pilot']);
});

test('pluginDirCandidates: an empty-string PILOT_PLUGIN_DIR is treated as unset', () => {
    const got = Live.pluginDirCandidates({ env: { PILOT_PLUGIN_DIR: '' }, home: '/home/nobody' });
    assert.deepEqual(got, [
        '/usr/share/cockpit/pilot',
        path.join('/home/nobody', '.local', 'share', 'cockpit', 'pilot')
    ]);
});

test('findPluginDir: null when none of the candidates has a manifest.json', () => {
    const a = tmpdir();
    const b = tmpdir();
    assert.equal(Live.findPluginDir({ candidates: [a, b] }), null);
});

test('findPluginDir: returns the first candidate (in order) that really has a manifest.json', () => {
    const a = tmpdir();
    const b = tmpdir();
    fs.writeFileSync(path.join(b, 'manifest.json'), '{}');
    assert.equal(Live.findPluginDir({ candidates: [a, b] }), b);
    // Order matters: a system install found first must win over a per-user one.
    fs.writeFileSync(path.join(a, 'manifest.json'), '{}');
    assert.equal(Live.findPluginDir({ candidates: [a, b] }), a);
});

test('findPluginDir: a nonexistent directory in the list is skipped, not thrown on', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
    const missing = path.join(dir, 'does', 'not', 'exist');
    assert.equal(Live.findPluginDir({ candidates: [missing, dir] }), dir);
});

test('pluginInstalled with no argument searches every candidate via findPluginDir', () => {
    // Exercise the real default path (env/home unset) purely as "does not throw
    // and returns a boolean" -- it may legitimately be true or false depending
    // on this machine's actual installs, so nothing about its value is asserted.
    assert.equal(typeof Live.pluginInstalled(), 'boolean');
});

// --- makeCheck: the IMPORTANT-1 regression (check()'s failure path must
// redact the same way every other print site in this file does) -----------

test('makeCheck: a failing check redacts the password from its printed FAIL message', async () => {
    const SECRET = 'do-not-print-me-98765';
    const check = Live.makeCheck(SECRET);
    const originalLog = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(' '));
    try {
        await check('a check whose thrown error happens to contain the password', async () => {
            throw new Error(`login failed for user ada with password ${SECRET}`);
        });
    } finally {
        console.log = originalLog;
    }
    const joined = lines.join('\n');
    assert.equal(joined.includes(SECRET), false, `password leaked through check(): ${joined}`);
    assert.match(joined, /FAIL/);
    assert.match(joined, /\[REDACTED\]/);
});

test('makeCheck: a passing check never prints anything to redact in the first place', async () => {
    const check = Live.makeCheck('irrelevant-password');
    const originalLog = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(' '));
    try {
        await check('a check that passes', async () => {});
    } finally {
        console.log = originalLog;
    }
    assert.match(lines.join('\n'), /ok/);
});

test('makeCheck: with no password, the message passes through unredacted (nothing to hide)', async () => {
    const check = Live.makeCheck(undefined);
    const originalLog = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(' '));
    try {
        await check('a check that fails with no password in scope', async () => {
            throw new Error('plain failure, no secret involved');
        });
    } finally {
        console.log = originalLog;
    }
    assert.match(lines.join('\n'), /plain failure, no secret involved/);
});

// =================================================== FINAL REVIEW, FINDING 4
//
// The live tier drives the REAL plugin, which really persists the theme to
// ~/.config/cockpit/pilot/settings.json. It had no cleanup of any kind, so the
// theme check wrote theme:"nord" to disk and the NEXT run started already on
// Nord -- the check passed exactly once on a fresh machine and failed forever
// after. Self-poisoning, and it edited the developer's own settings.
//
// Every test below works against a throwaway home under os.tmpdir(); none of
// them can touch the real file.

test('settingsPath points at the file js/core/settings.js actually writes', () => {
    const Settings = require('../../js/core/settings.js');
    assert.equal(Live.PilotLive.settingsPath('/home/x'), '/home/x/' + Settings.REL_PATH,
        'the snapshot must cover the same path the plugin persists to, not a guess');
});

test('snapshot/restore puts an existing settings file back byte for byte', () => {
    const home = tmpdir();
    const file = Live.PilotLive.settingsPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = '{\n  "ui": {\n    "theme": "sepia"\n  }\n}\n';
    fs.writeFileSync(file, original);

    const snap = Live.PilotLive.snapshotSettings(home);
    assert.equal(snap.existed, true);
    // What a real run does: the plugin persists a different theme.
    fs.writeFileSync(file, '{"ui":{"theme":"nord"}}');
    assert.equal(Live.PilotLive.restoreSettings(snap), 'restored');
    assert.equal(fs.readFileSync(file, 'utf8'), original,
        'the developer\'s own settings must survive the run unchanged');
});

test('a settings file the run CREATED is removed again, not left behind', () => {
    const home = tmpdir();
    const file = Live.PilotLive.settingsPath(home);
    const snap = Live.PilotLive.snapshotSettings(home);
    assert.equal(snap.existed, false);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"ui":{"theme":"nord"}}');
    assert.equal(Live.PilotLive.restoreSettings(snap), 'removed');
    assert.equal(fs.existsSync(file), false);
});

test('restore is a no-op when nothing changed, and never throws on a hostile snapshot', () => {
    const home = tmpdir();
    assert.equal(Live.PilotLive.restoreSettings(Live.PilotLive.snapshotSettings(home)), 'unchanged');
    for (const bad of [null, undefined, 42, 'x', {}, { path: 7 }, []])
        assert.equal(Live.PilotLive.restoreSettings(bad), 'skipped', JSON.stringify(bad));
});

test('the live theme check never hardcodes a theme id or label', () => {
    // The other half of the fix: a check that always clicks "Nord" passes only
    // while the machine is not already on Nord -- which the run itself then
    // makes false.
    const src = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'live-smoke.live.mjs'), 'utf8');
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    // 'light' and 'dark' are BASE names as well as theme ids, and the check
    // legitimately reasons about the base of the currently applied theme to
    // pick its opposite -- that is the mechanism, not a hardcoded choice.
    const BASES = new Set(['light', 'dark', 'system']);
    for (const t of require('../../js/core/themes.js').THEMES) {
        assert.equal(code.includes('"' + t.label + '"'), false,
            `live-smoke.live.mjs hardcodes the theme label ${t.label}`);
        if (BASES.has(t.id)) continue;
        assert.equal(code.includes("'" + t.id + "'"), false,
            `live-smoke.live.mjs hardcodes the theme id ${t.id}`);
    }
    assert.equal(/nord/i.test(code), false,
        'the theme this check used to hardcode must not appear at all');
    assert.ok(code.includes('window.PilotThemes'),
        'the theme to switch to must be derived from the registry the page itself offers');
});
