// Unit tests for js/features/update.js.
//
// The pure half of this module decides whether the plugin will download a remote
// archive and run `make install` on it as root. Every function below is therefore
// tested primarily on the inputs where it must say NO.
//
// The fixture is named synthetic-* per spec 9.3: it is built from GitHub's
// documented release schema, not captured from a live API call.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const U = require('../../js/features/update.js');

const FIXTURE = fs.readFileSync(
    path.join(__dirname, '..', 'fixtures', 'github', 'synthetic-release-latest.json'), 'utf8');

// ---------------------------------------------------------------- releasesApiUrl

test('releasesApiUrl accepts owner/name', () => {
    assert.equal(U.releasesApiUrl('ismetozalp/pilot'),
        'https://api.github.com/repos/ismetozalp/pilot/releases/latest');
});

test('releasesApiUrl accepts a full GitHub URL, a trailing slash and a .git suffix', () => {
    const want = 'https://api.github.com/repos/ismetozalp/pilot/releases/latest';
    assert.equal(U.releasesApiUrl('https://github.com/ismetozalp/pilot'), want);
    assert.equal(U.releasesApiUrl('https://www.github.com/ismetozalp/pilot/'), want);
    assert.equal(U.releasesApiUrl('http://github.com/ismetozalp/pilot.git'), want);
    assert.equal(U.releasesApiUrl('  ismetozalp/pilot  '), want);
});

test('releasesApiUrl rejects empty and non-string input', () => {
    for (const v of ['', '   ', null, undefined, 42, {}, [], true])
        assert.equal(U.releasesApiUrl(v), '', JSON.stringify(v));
});

test('releasesApiUrl rejects anything that is not exactly owner/name', () => {
    const bad = ['pilot', 'ismetozalp/pilot/tree/main', '/pilot', 'ismetozalp/',
        'a/b/c', '//', 'ismetozalp//pilot'];
    for (const v of bad) assert.equal(U.releasesApiUrl(v), '', v);
});

test('releasesApiUrl rejects path traversal that would escape /repos/', () => {
    // '..' passes a naive [A-Za-z0-9._-] test, and ../.. would rewrite the API path.
    for (const v of ['../..', './pilot', 'ismetozalp/..', '../pilot'])
        assert.equal(U.releasesApiUrl(v), '', v);
});

test('releasesApiUrl rejects control characters, spaces and unicode lookalikes', () => {
    const bad = ['ismetozalp/pi\x00lot', 'ismetozalp/pilot\n', 'isme tozalp/pilot',
        'ismetozalp/pil\x1fot', 'ismetozalp/pilot\x7f', 'ismet\u00f6zalp/pilot',
        'ismetozalp/pil\u043et'];
    for (const v of bad) assert.equal(U.releasesApiUrl(v), '', JSON.stringify(v));
});

test('releasesApiUrl rejects an oversized repo string', () => {
    assert.equal(U.releasesApiUrl('a'.repeat(600) + '/b'), '');
});

// ---------------------------------------------------------------- isAllowedAssetUrl

test('isAllowedAssetUrl accepts the GitHub release hosts', () => {
    const good = [
        'https://github.com/ismetozalp/pilot/releases/download/v1.4.0/pilot-1.4.0.zip',
        'https://codeload.github.com/ismetozalp/pilot/zip/refs/tags/v1.4.0',
        'https://objects.githubusercontent.com/github-production-release-asset/1/2?X-Amz-Algorithm=AWS4',
        'https://release-assets.githubusercontent.com/github-production-release-asset/1/2',
        'https://GITHUB.COM/ismetozalp/pilot/releases/download/v1.4.0/pilot.zip'
    ];
    for (const u of good) assert.equal(U.isAllowedAssetUrl(u), true, u);
});

test('isAllowedAssetUrl rejects a wrong host', () => {
    for (const u of ['https://evil.example/pilot.zip',
        'https://gitlab.com/ismetozalp/pilot/pilot.zip',
        'https://api.github.com.evil.example/pilot.zip'])
        assert.equal(U.isAllowedAssetUrl(u), false, u);
});

test('isAllowedAssetUrl rejects embedded credentials pointing elsewhere', () => {
    // The classic: everything before '@' is userinfo, so the real host is evil.example.
    for (const u of ['https://github.com@evil.example/pilot.zip',
        'https://user:pass@github.com.evil.example/pilot.zip',
        'https://github.com:token@evil.example/pilot.zip'])
        assert.equal(U.isAllowedAssetUrl(u), false, u);
});

test('isAllowedAssetUrl rejects a protocol downgrade or a non-http scheme', () => {
    for (const u of ['http://github.com/ismetozalp/pilot/pilot.zip',
        'ftp://github.com/pilot.zip', 'file:///etc/shadow',
        'javascript:alert(1)', '//github.com/pilot.zip',
        'HTTPS://github.com/pilot.zip'])
        assert.equal(U.isAllowedAssetUrl(u), false, u);
});

test('isAllowedAssetUrl rejects a data: URL disguised as an asset', () => {
    // Not in the brief's own list of hostile schemes, but the task's constraint
    // list names data: alongside file: and javascript: explicitly.
    for (const u of ['data:text/html,<script>1</script>',
        'data:application/zip;base64,UEsDBA=='])
        assert.equal(U.isAllowedAssetUrl(u), false, u);
});

test('isAllowedAssetUrl rejects lookalike and encoded hosts', () => {
    for (const u of ['https://github.com.evil.example/pilot.zip',
        'https://githubXcom/pilot.zip', 'https://github-com.evil.example/pilot.zip',
        'https://github.com%2eevil.example/pilot.zip',
        'https://g\u0131thub.com/pilot.zip',
        'https://xn--gthub-jua.com/pilot.zip',
        'https://evil.example/https://github.com/pilot.zip'])
        assert.equal(U.isAllowedAssetUrl(u), false, u);
});

test('isAllowedAssetUrl rejects an explicit port, a backslash and any control byte', () => {
    for (const u of ['https://github.com:8080/pilot.zip',
        'https://github.com\\@evil.example/pilot.zip',
        'https://github.com/pilot.zip\n',
        'https://github.com/pilot\x00.zip',
        'https://github.com/pilot .zip',
        'https://github.com/pilot.zip\x7f'])
        assert.equal(U.isAllowedAssetUrl(u), false, JSON.stringify(u));
});

test('isAllowedAssetUrl rejects a bare host with no path, and non-strings', () => {
    assert.equal(U.isAllowedAssetUrl('https://github.com'), false);
    for (const v of ['', null, undefined, 42, {}, [], true])
        assert.equal(U.isAllowedAssetUrl(v), false, JSON.stringify(v));
    assert.equal(U.isAllowedAssetUrl('https://github.com/' + 'a'.repeat(4096)), false);
});

test('isAllowedAssetUrl.ASSET_HOSTS is the exact closed allow-list used above', () => {
    assert.deepEqual(U.ASSET_HOSTS, ['github.com', 'codeload.github.com',
        'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
});

// ---------------------------------------------------------------- parseRelease

test('parseRelease reduces a real-shaped release document to what the UI needs', () => {
    const r = U.parseRelease(FIXTURE, '1.3.0');
    assert.equal(r.tag, 'v1.4.0');
    assert.equal(r.version, '1.4.0');
    assert.equal(r.available, true);
    assert.equal(r.assetUrl,
        'https://github.com/ismetozalp/pilot/releases/download/v1.4.0/pilot-1.4.0.zip');
    assert.equal(r.prerelease, false);
    assert.match(r.notes, /address book surface/);
});

test('parseRelease reports no update when the installed version is current or newer', () => {
    assert.equal(U.parseRelease(FIXTURE, '1.4.0').available, false);
    assert.equal(U.parseRelease(FIXTURE, '2.0.0').available, false);
});

test('parseRelease falls back to zipball_url when no zip asset is attached', () => {
    const rel = JSON.parse(FIXTURE);
    rel.assets = [{ name: 'SHA256SUMS', browser_download_url: 'https://github.com/x/y/s' }];
    rel.zipball_url = 'https://codeload.github.com/ismetozalp/pilot/zip/refs/tags/v1.4.0';
    assert.equal(U.parseRelease(JSON.stringify(rel), '1.0.0').assetUrl,
        'https://codeload.github.com/ismetozalp/pilot/zip/refs/tags/v1.4.0');
});

test('parseRelease blanks an asset URL pointing at a host we would refuse anyway', () => {
    const rel = JSON.parse(FIXTURE);
    rel.assets = [{ name: 'pilot-1.4.0.zip', browser_download_url: 'https://evil.example/p.zip' }];
    rel.zipball_url = 'https://evil.example/z.zip';
    assert.equal(U.parseRelease(JSON.stringify(rel), '1.0.0').assetUrl, '');
});

test('parseRelease throws GENERIC on anything that is not a JSON object', () => {
    const bad = ['', 'not json at all', '{', '{"tag_name":', '[]', 'null', '"x"', '42',
        '{"tag_name":"v1.0.0"} trailing noise'];
    for (const t of bad) {
        assert.throws(() => U.parseRelease(t, '1.0.0'),
            (e) => e && e.kind === 'GENERIC', JSON.stringify(t));
    }
});

test('parseRelease throws on truncated JSON rather than returning a half release', () => {
    assert.throws(() => U.parseRelease(FIXTURE.slice(0, 120), '1.0.0'),
        (e) => e && e.kind === 'GENERIC');
});

test('parseRelease surfaces GitHub 200-with-message responses as an error', () => {
    // Rate limiting and a missing repository both arrive as HTTP 200 with a
    // "message" field, which would otherwise look like a release with no tag.
    assert.throws(
        () => U.parseRelease('{"message":"API rate limit exceeded"}', '1.0.0'),
        (e) => e && e.kind === 'GENERIC' && /rate limit/.test(e.message));
});

test('parseRelease refuses a release with no usable tag', () => {
    for (const t of ['{}', '{"tag_name":""}', '{"tag_name":null}', '{"tag_name":123}'])
        assert.throws(() => U.parseRelease(t, '1.0.0'), (e) => e && e.kind === 'GENERIC', t);
});

test('parseRelease refuses a tag carrying a control character', () => {
    // "v\n2.0.0" must not become version "2.0.0" and be offered as an upgrade.
    for (const tag of ['v\n2.0.0', 'v2.0.0\x00', 'v\x1f2.0.0'])
        assert.throws(() => U.parseRelease(JSON.stringify({ tag_name: tag }), '1.0.0'),
            (e) => e && e.kind === 'GENERIC', JSON.stringify(tag));
});

test('parseRelease refuses an oversized document and truncates oversized notes', () => {
    assert.throws(() => U.parseRelease('{"tag_name":"v1.0.0","body":"' + 'x'.repeat(600000) + '"}', '1.0.0'),
        (e) => e && e.kind === 'GENERIC');
    const rel = JSON.parse(FIXTURE);
    rel.body = 'y'.repeat(50000);
    assert.equal(U.parseRelease(JSON.stringify(rel), '1.0.0').notes.length, 20000);
});

test('parseRelease survives hostile assets structures', () => {
    const cases = [
        { assets: 'not-an-array' }, { assets: [null] }, { assets: [{ name: 42 }] },
        { assets: [{ name: 'a.zip' }] }, { assets: [{ name: 'a.zip', browser_download_url: null }] }
    ];
    for (const patch of cases) {
        const rel = Object.assign(JSON.parse(FIXTURE), patch, { zipball_url: '' });
        const r = U.parseRelease(JSON.stringify(rel), '1.0.0');
        assert.equal(r.assetUrl, '', JSON.stringify(patch));
        assert.equal(r.version, '1.4.0');
    }
});

test('parseRelease marks a prerelease as such', () => {
    const rel = Object.assign(JSON.parse(FIXTURE), { tag_name: 'v1.5.0-rc.1', prerelease: true });
    const r = U.parseRelease(JSON.stringify(rel), '1.4.0');
    assert.equal(r.prerelease, true);
    assert.equal(r.version, '1.5.0-rc.1');
    assert.equal(r.available, true);
    // …but a prerelease of the installed version is never an upgrade.
    const rc = Object.assign(JSON.parse(FIXTURE), { tag_name: 'v1.4.0-rc.1', prerelease: true });
    assert.equal(U.parseRelease(JSON.stringify(rc), '1.4.0').available, false);
});

// ---------------------------------------------------------------- chooseSourceDir

test('chooseSourceDir picks the single unpacked directory', () => {
    assert.equal(U.chooseSourceDir('/tmp/x', ['update.zip', 'pilot']), '/tmp/x/pilot');
});

test('chooseSourceDir falls back to the temp dir when the layout is unexpected', () => {
    assert.equal(U.chooseSourceDir('/tmp/x', ['update.zip']), '/tmp/x');
    assert.equal(U.chooseSourceDir('/tmp/x', ['update.zip', 'a', 'b']), '/tmp/x');
    assert.equal(U.chooseSourceDir('/tmp/x', []), '/tmp/x');
    assert.equal(U.chooseSourceDir('/tmp/x', null), '/tmp/x');
    assert.equal(U.chooseSourceDir('/tmp/x', undefined), '/tmp/x');
});

test('chooseSourceDir never builds a path out of a traversing or absolute entry', () => {
    // The listing comes from `ls` over attacker-supplied archive contents.
    for (const entries of [['update.zip', '..'], ['update.zip', '../../etc'],
        ['update.zip', '/etc'], ['update.zip', 'a/b'], ['update.zip', '.'],
        ['update.zip', 'p\x00ilot']])
        assert.equal(U.chooseSourceDir('/tmp/x', entries), '/tmp/x', JSON.stringify(entries));
});

// ---------------------------------------------------------------- settings shims

test('readSettings accepts a plain settings object', async () => {
    const s = await U.readSettings({ update: { repo: 'a/b', checkOnStartup: true } });
    assert.equal(s.update.repo, 'a/b');
});

test('readSettings accepts a store exposing read, load or get', async () => {
    const doc = { update: { repo: 'a/b' } };
    for (const name of ['read', 'load', 'get']) {
        const store = { [name]: () => Promise.resolve(doc) };
        const s = await U.readSettings(store);
        assert.equal(s.update.repo, 'a/b', name);
    }
});

test('readSettings degrades to an empty object instead of throwing', async () => {
    const cases = [null, undefined, 42, 'x', [], { read: () => { throw new Error('boom'); } },
        { read: () => Promise.reject(new Error('boom')) }, { read: () => 'not-an-object' }];
    for (const c of cases) assert.deepEqual(await U.readSettings(c), {}, JSON.stringify(c));
});

test('updatePrefs projects the §11.3 settings shape and tolerates anything', () => {
    assert.deepEqual(U.updatePrefs({ update: { repo: 'a/b', checkOnStartup: true } }),
        { repo: 'a/b', checkOnStartup: true });
    for (const s of [{}, null, undefined, { update: null }, { update: 'x' },
        { update: { repo: 42, checkOnStartup: 'yes' } }, []])
        assert.deepEqual(U.updatePrefs(s), { repo: '', checkOnStartup: false }, JSON.stringify(s));
});

// ---------------------------------------------------------------- component

test('blankState is a fresh object every call', () => {
    const a = U.blankState();
    a.error = 'x';
    assert.equal(U.blankState().error, '');
    assert.deepEqual(Object.keys(U.blankState()).sort(),
        ['assetUrl', 'available', 'checking', 'error', 'notes', 'prerelease', 'tag', 'version']);
});

test('PHASE covers the four modal states plus idle', () => {
    assert.deepEqual(U.PHASE,
        { IDLE: 'idle', CONFIRM: 'confirm', RUNNING: 'running', DONE: 'done', ERROR: 'error' });
});

test('checkForUpdate with no repository configured explains itself instead of calling out', async () => {
    const c = U.pilotUpdateUi();
    const s = await c.checkForUpdate(true, { repo: '', checkOnStartup: false });
    assert.equal(s.available, false);
    assert.match(s.error, /repository/i);
});

test('startSelfUpdate refuses a disallowed asset URL before touching the host', async () => {
    const c = U.pilotUpdateUi();
    c.update = Object.assign(U.blankState(), { assetUrl: 'https://evil.example/p.zip' });
    assert.equal(await c.startSelfUpdate(), false);
    assert.equal(c.updatePhase, U.PHASE.ERROR);
    assert.match(c.updateLog.join('\n'), /unexpected host/);
});

test('startSelfUpdate with no asset URL does nothing at all', async () => {
    const c = U.pilotUpdateUi();
    assert.equal(await c.startSelfUpdate(), false);
    assert.equal(c.updatePhase, U.PHASE.IDLE);
});

test('startSelfUpdate reports an error phase when cockpit is absent', async () => {
    // Under node there is no cockpit, which is exactly the "spawn failed" path.
    const c = U.pilotUpdateUi();
    c.update = Object.assign(U.blankState(), {
        assetUrl: 'https://github.com/ismetozalp/pilot/releases/download/v1.4.0/pilot-1.4.0.zip'
    });
    assert.equal(await c.startSelfUpdate(), false);
    assert.equal(c.updatePhase, U.PHASE.ERROR);
    assert.match(c.updateLog.join('\n'), /untouched/);
    assert.equal(c._inFlight, false);
});

test('badge label and title distinguish never-checked, up-to-date, available and failed', () => {
    const c = U.pilotUpdateUi();
    c.installedVersion = '1.3.0';
    assert.equal(c.updateBadgeLabel(), 'v1.3.0');
    c.update.checking = true;
    assert.match(c.updateBadgeLabel(), /Checking/);
    c.update = Object.assign(U.blankState(), { error: 'nope' });
    assert.match(c.updateBadgeLabel(), /failed/i);
    assert.match(c.badgeTitle(), /nope/);
    c.update = Object.assign(U.blankState(), { available: true, version: '1.4.0' });
    assert.match(c.updateBadgeLabel(), /1\.4\.0/);
    assert.equal(c.badgeClass(), 'pl-badge-update available');
    c.update = U.blankState();
    c.checkedAt = Date.now();
    assert.match(c.updateBadgeLabel(), /up to date/);
});

test('the update modal partial exists and binds the component', () => {
    const html = fs.readFileSync(
        path.join(__dirname, '..', '..', 'html', 'modals', 'update.html'), 'utf8');
    assert.match(html, /x-data="pilotUpdateUi\(\)"/);
    assert.match(html, /initUpdate\(window\.PilotSettings\)/);
    assert.match(html, /id="pilot-update"/);
    assert.match(html, /onBadgeClick\(\)/);
    assert.match(html, /startSelfUpdate\(\)/);
});

test('boot.js injects the update partial', () => {
    // Round 2 shipped a sed that never matched, so the modal was never injected and
    // the whole feature was unreachable. This is the regression test for that.
    const boot = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'boot.js'), 'utf8');
    assert.ok(boot.includes('html/modals/update.html'),
        'js/boot.js does not register html/modals/update.html');
});

// ---------------------------------------------------------------- CSP / no-fetch guarantee
//
// The whole design rests on this file never reaching for fetch() or
// XMLHttpRequest — connect-src 'self' blocks a browser fetch() to api.github.com
// outright, and reaching for either API here is the single most likely way this
// feature gets reimplemented wrong by a future maintainer "cleaning up" the
// cockpit.spawn(curl) calls. Checked over comment-stripped source so a comment
// that merely mentions "fetch(" while explaining the omission (as this file's own
// header does) cannot trip the rule.

function stripJsComments(text) {
    // Small and local on purpose: this file does not need the shared
    // tests/lib/strip-comments.js helper, and duplicating three lines here keeps
    // this test independent of that helper's own correctness.
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('js/features/update.js never calls fetch() or XMLHttpRequest', () => {
    const src = stripJsComments(
        fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'features', 'update.js'), 'utf8'));
    assert.ok(!/\bfetch\s*\(/.test(src), 'update.js must not call fetch(); use cockpit.spawn/cockpit.file');
    assert.ok(!/XMLHttpRequest/.test(src), 'update.js must not use XMLHttpRequest');
});

// ---------------------------------------------------------------- startSelfUpdate happy path

test('startSelfUpdate runs the full install sequence and streams make output live', async (t) => {
    const calls = [];
    const fakeSpawn = (argv, opts) => {
        calls.push({ argv, opts });
        if (argv[0] === 'mktemp') return Promise.resolve('/tmp/pilot-update-x\n');
        if (argv[0] === 'ls') return Promise.resolve('update.zip\npilot\n');
        if (argv[0] === 'make') return Promise.resolve('Installed pilot 1.4.0\n');
        return Promise.resolve('');
    };
    global.cockpit = { spawn: fakeSpawn };
    t.after(() => { delete global.cockpit; });

    const c = U.pilotUpdateUi();
    c.update = Object.assign(U.blankState(), {
        assetUrl: 'https://github.com/ismetozalp/pilot/releases/download/v1.4.0/pilot-1.4.0.zip'
    });
    const ok = await c.startSelfUpdate();
    assert.equal(ok, true);
    assert.equal(c.updatePhase, U.PHASE.DONE);
    assert.equal(c._inFlight, false);
    assert.match(c.updateLog.join('\n'), /Installed pilot 1\.4\.0/);

    const make = calls.find((x) => x.argv[0] === 'make');
    assert.deepEqual(make.argv, ['make', '-C', '/tmp/pilot-update-x/pilot', 'install']);
    assert.equal(make.opts.superuser, 'require', 'make install must run as root');

    const restart = calls.find((x) => x.argv[0] === 'systemd-run');
    assert.deepEqual(restart.argv,
        ['systemd-run', '--no-block', '--', 'systemctl', 'try-restart', 'cockpit']);
    assert.equal(restart.opts.superuser, 'require', 'the restart must run as root too');

    const download = calls.find((x) => x.argv[0] === 'curl');
    // '--' terminates option parsing before the remote-controlled URL.
    assert.equal(download.argv[download.argv.length - 2], '--');
    assert.equal(download.argv[download.argv.length - 1], c.update.assetUrl);

    assert.ok(calls.some((x) => x.argv[0] === 'rm' && x.argv.includes('/tmp/pilot-update-x')),
        'the temp directory is cleaned up afterwards');
});

test('startSelfUpdate leaves the previous install untouched when make install fails', async (t) => {
    const fakeSpawn = (argv) => {
        if (argv[0] === 'mktemp') return Promise.resolve('/tmp/pilot-update-y\n');
        if (argv[0] === 'ls') return Promise.resolve('pilot\n');
        if (argv[0] === 'make') return Promise.reject(new Error('make: *** [install] Error 1'));
        return Promise.resolve('');
    };
    global.cockpit = { spawn: fakeSpawn };
    t.after(() => { delete global.cockpit; });

    const c = U.pilotUpdateUi();
    c.update = Object.assign(U.blankState(), {
        assetUrl: 'https://github.com/ismetozalp/pilot/releases/download/v1.4.0/pilot-1.4.0.zip'
    });
    const ok = await c.startSelfUpdate();
    assert.equal(ok, false);
    assert.equal(c.updatePhase, U.PHASE.ERROR);
    assert.match(c.updateLog.join('\n'), /Error 1/);
    assert.match(c.updateLog.join('\n'), /untouched/);
});

// ---------------------------------------------------------------- readInstalledVersion

test('readInstalledVersion reads the stamp make install writes, and degrades to empty', async (t) => {
    global.cockpit = {
        file: (p) => ({
            read: () => p === '/etc/pilot/installed-version'
                ? Promise.resolve('1.3.0\n')
                : Promise.reject(new Error('wrong path'))
        })
    };
    t.after(() => { delete global.cockpit; });
    const c = U.pilotUpdateUi();
    assert.equal(await c.readInstalledVersion(), '1.3.0');
});

test('readInstalledVersion never throws when the file is missing or cockpit is absent', async (t) => {
    const c = U.pilotUpdateUi();
    assert.equal(await c.readInstalledVersion(), '');

    global.cockpit = { file: () => ({ read: () => Promise.reject(new Error('ENOENT')) }) };
    t.after(() => { delete global.cockpit; });
    assert.equal(await c.readInstalledVersion(), '');
});
