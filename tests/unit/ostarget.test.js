// Unit tests for js/core/ostarget.js.
//
// This module decides WHICH archive gets downloaded and WHICH checksum is enforced.
// The two upstream projects name their archives differently for the same machine
// (arm64v8 vs arm64, armv7 vs armv7l), so a single shared arch table would silently
// fetch a 404 or, worse, the wrong file. The asymmetry is asserted here explicitly.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const OT = require('../../js/core/ostarget.js');

const FIX = path.join(__dirname, '..', 'fixtures', 'os-release');
const fixture = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');

// --- parseOsRelease -------------------------------------------------------

test('parses a real captured RHEL 10 os-release', () => {
    const r = OT.parseOsRelease(fixture('rhel-10'));
    assert.equal(r.id, 'rhel');
    assert.equal(r.id_like, 'centos fedora');
    assert.equal(r.version_id, '10.2');
    assert.equal(r.pretty_name, 'Red Hat Enterprise Linux 10.2 (Coughlan)');
});

test('parses every shipped distro fixture into the right family', () => {
    const cases = [
        ['rhel-10', 'rhel', 'fedora', '10.2'],
        ['synthetic-fedora-42', 'fedora', 'fedora', '42'],
        ['synthetic-debian-12', 'debian', 'debian', '12'],
        ['synthetic-ubuntu-24.04', 'ubuntu', 'debian', '24.04'],
        ['synthetic-opensuse-leap-15.6', 'opensuse-leap', 'suse', '15.6'],
        ['synthetic-arch', 'arch', 'arch', '']
    ];
    for (const [file, id, fam, ver] of cases) {
        const r = OT.parseOsRelease(fixture(file));
        assert.equal(r.id, id, file + ' id');
        assert.equal(r.version_id, ver, file + ' version_id');
        assert.equal(OT.family(r), fam, file + ' family');
    }
});

test('always returns the four keys as strings, whatever it was given', () => {
    for (const v of ['', null, undefined, 42, {}, [], true, '\n\n\n', '# only a comment']) {
        const r = OT.parseOsRelease(v);
        assert.deepEqual(Object.keys(r).sort(),
            ['id', 'id_like', 'pretty_name', 'version_id'], JSON.stringify(v));
        for (const k of Object.keys(r)) assert.equal(typeof r[k], 'string', k);
    }
});

test('survives the hostile fixture: bad keys skipped, last assignment wins', () => {
    const r = OT.parseOsRelease(fixture('synthetic-hostile'));
    // Shell semantics: the second ID= overrides the first.
    assert.equal(r.id, 'ubuntu');
    // Single quotes are stripped without escape processing, then trimmed.
    assert.equal(r.id_like, 'debian');
    assert.equal(r.version_id, '');
    // Path-traversal text is kept verbatim as a DISPLAY string and never resolved.
    assert.equal(r.pretty_name, 'Debian ../../etc/shadow');
    assert.equal(OT.family(r), 'debian');
});

test('unescapes double-quoted values and leaves single-quoted ones alone', () => {
    const r = OT.parseOsRelease('ID="a\\"b"\nID_LIKE=\'c\\"d\'\nPRETTY_NAME="x\\\\y"\n');
    assert.equal(r.id, 'a"b');
    assert.equal(r.id_like, 'c\\"d');
    assert.equal(r.pretty_name, 'x\\y');
});

test('strips control characters rather than emitting them into the UI', () => {
    const r = OT.parseOsRelease('ID=deb\x07ian\nPRETTY_NAME="a\x00b\x1fc"\n');
    assert.equal(r.id, 'debian');
    assert.equal(r.pretty_name, 'abc');
});

test('an embedded newline cannot smuggle a second assignment into one value', () => {
    // The value ends at the newline; the next line is parsed as its own assignment.
    const r = OT.parseOsRelease('PRETTY_NAME="a\nID=evil\n');
    assert.equal(r.id, 'evil');
    assert.equal(r.pretty_name, '"a');
});

test('oversized input and oversized fields are truncated, not rejected', () => {
    const r = OT.parseOsRelease('ID=fedora\nPRETTY_NAME="' + 'x'.repeat(5000) + '"\n');
    assert.equal(r.id, 'fedora');
    assert.equal(r.pretty_name.length, 256);
    const huge = 'ID=fedora\n' + '# pad\n'.repeat(200000);
    assert.equal(OT.parseOsRelease(huge).id, 'fedora');
});

test('id and id_like are lowercased so the family table cannot be case-dodged', () => {
    const r = OT.parseOsRelease('ID=Fedora\nID_LIKE="RHEL Fedora"\n');
    assert.equal(r.id, 'fedora');
    assert.equal(r.id_like, 'rhel fedora');
    assert.equal(OT.family(r), 'fedora');
});

// --- family ---------------------------------------------------------------

test('family falls back to ID_LIKE when ID is unknown', () => {
    assert.equal(OT.family({ id: 'nobara', id_like: 'fedora' }), 'fedora');
    assert.equal(OT.family({ id: 'pop', id_like: 'ubuntu debian' }), 'debian');
    assert.equal(OT.family({ id: 'sles', id_like: '' }), 'suse');
    assert.equal(OT.family({ id: 'endeavouros', id_like: 'arch' }), 'arch');
});

test('family is unknown, never a guess, for anything unrecognised', () => {
    assert.equal(OT.family({ id: 'plan9', id_like: 'inferno' }), 'unknown');
    assert.equal(OT.family({ id: '', id_like: '' }), 'unknown');
    assert.equal(OT.family(null), 'unknown');
    assert.equal(OT.family(undefined), 'unknown');
    assert.equal(OT.family('debian'), 'unknown');   // a string is not an os-release
    assert.equal(OT.family({}), 'unknown');
});

// --- normalizeArch --------------------------------------------------------

test('normalizeArch maps every supported uname -m to a plan arch', () => {
    assert.equal(OT.normalizeArch('x86_64'), 'amd64');
    assert.equal(OT.normalizeArch('amd64'), 'amd64');
    assert.equal(OT.normalizeArch('aarch64'), 'arm64');
    assert.equal(OT.normalizeArch('arm64'), 'arm64');
    assert.equal(OT.normalizeArch('armv7l'), 'armv7l');
    assert.equal(OT.normalizeArch('i686'), 'i386');
    assert.equal(OT.normalizeArch('i386'), 'i386');
    assert.equal(OT.normalizeArch('i586'), 'i386');
});

test('normalizeArch tolerates the whitespace and case a real uname -m produces', () => {
    // These are DOCUMENTED tolerances, not rejections: `uname -m` output arrives
    // with a trailing newline and is upper-cased on nothing we ship, but neither
    // should be a hard failure.
    assert.equal(OT.normalizeArch('x86_64\n'), 'amd64');
    assert.equal(OT.normalizeArch('  aarch64  '), 'arm64');
    assert.equal(OT.normalizeArch('X86_64'), 'amd64');
    assert.equal(OT.normalizeArch('x86_64\x00'), 'amd64');
});

test('normalizeArch returns null for everything else', () => {
    const bad = ['', ' ', 'x86-64', 'x86 64', 'x86_64; rm -rf /', '../../etc',
        'ppc64le', 's390x', 'riscv64', 'mips', 'armv6l', 'sparc64',
        'a'.repeat(64), 'x86_64\x1f64', null, undefined, 42, {}, [], true, NaN];
    for (const v of bad) assert.equal(OT.normalizeArch(v), null, JSON.stringify(v));
});

// --- the per-component asset tables — the point of this module -------------

test('the two projects name the SAME machine differently, and both are honoured', () => {
    assert.equal(OT.serverAsset('aarch64').name, 'rustdesk-server-linux-arm64v8.zip');
    assert.equal(OT.apiAsset('aarch64').name, 'linux-arm64.tar.gz');
    assert.equal(OT.serverAsset('armv7l').name, 'rustdesk-server-linux-armv7.zip');
    assert.equal(OT.apiAsset('armv7l').name, 'linux-armv7l.tar.gz');
    assert.equal(OT.serverAsset('x86_64').name, 'rustdesk-server-linux-amd64.zip');
    assert.equal(OT.apiAsset('x86_64').name, 'linux-amd64.tar.gz');
});

test('server assets carry the pinned 1.1.16 digests verbatim', () => {
    assert.equal(OT.serverAsset('x86_64').sha256,
        '0565c41affe6c3f409b0bddfaf5a24ccbf3f64f5f8e3fec250b69a0d5f6bdbcf');
    assert.equal(OT.serverAsset('aarch64').sha256,
        '6a4ae3c5ca257a4278ded72fd17eb2ca4eeb0356a5425e63a3e7fcb0ec6c155c');
    assert.equal(OT.serverAsset('armv7l').sha256,
        '2e832e901680bc4eb8d5d17df867e2bc9731c0bdf064b27c35084494fc279be2');
    assert.equal(OT.serverAsset('i686').sha256,
        'a10d2db36ceabec730ea2458dc0466b9fb46eda3f2ee90ab29a0bff8f92a7c22');
});

test('API assets carry the pinned v2.7 digests — never null', () => {
    assert.equal(OT.apiAsset('x86_64').sha256,
        'd0689a353fd756815cfe560ce7cb98f764602de60d0403b51db4e5a9bd84d22a');
    assert.equal(OT.apiAsset('aarch64').sha256,
        '830bbab588c39c7d39130e28fe4aa01f00150ebaa0385a48d1fc664cba33ccfc');
    assert.equal(OT.apiAsset('armv7l').sha256,
        '9e3b520999cc060441c56c0713fc4d49387ec957670ce9a6e8453352882c75f3');
});

test('every asset digest is a lowercase 64-hex string and every URL is https', () => {
    for (const a of ['x86_64', 'aarch64', 'armv7l']) {
        for (const asset of [OT.serverAsset(a), OT.apiAsset(a)]) {
            assert.match(asset.sha256, /^[0-9a-f]{64}$/, a);
            assert.match(asset.url, /^https:\/\/github\.com\//, a);
            assert.ok(asset.url.endsWith('/' + asset.name), a + ' url/name mismatch');
        }
    }
    assert.match(OT.serverAsset('i686').sha256, /^[0-9a-f]{64}$/);
});

test('URLs embed the pinned versions, so a bump cannot be half-applied', () => {
    assert.ok(OT.serverAsset('x86_64').url.includes('/download/1.1.16/'));
    assert.ok(OT.apiAsset('x86_64').url.includes('/download/v2.7/'));
    assert.equal(OT.SERVER_VERSION, '1.1.16');
    assert.equal(OT.API_VERSION, '2.7');
});

// --- i686: the partial case -----------------------------------------------

test('i686 gets a RustDesk server build', () => {
    const a = OT.serverAsset('i686');
    assert.equal(a.arch, 'i386');
    assert.equal(a.name, 'rustdesk-server-linux-i386.zip');
});

test('i686 fails EXPLICITLY at the API server rather than half-installing', () => {
    for (const raw of ['i686', 'i386', 'i586']) {
        assert.throws(() => OT.apiAsset(raw), (e) => {
            assert.equal(e.kind, 'ARCH_UNSUPPORTED');
            assert.match(e.message, /no 32-bit build/i);
            assert.match(e.message, /API server/i);
            return true;
        }, raw);
    }
});

test('an unsupported arch throws ARCH_UNSUPPORTED from BOTH asset functions', () => {
    for (const raw of ['s390x', 'ppc64le', '', null, undefined, {}, 'x86 64']) {
        assert.throws(() => OT.serverAsset(raw), (e) =>
            e.kind === 'ARCH_UNSUPPORTED', JSON.stringify(raw));
        assert.throws(() => OT.apiAsset(raw), (e) =>
            e.kind === 'ARCH_UNSUPPORTED', JSON.stringify(raw));
    }
});

test('the error message renders hostile raw input safely and boundedly', () => {
    try {
        OT.serverAsset('pwn\x00\x1b[31m' + 'z'.repeat(500));
        assert.fail('should have thrown');
    } catch (e) {
        assert.equal(e.kind, 'ARCH_UNSUPPORTED');
        assert.ok(e.message.length < 200, 'message is unbounded: ' + e.message.length);
        assert.equal(/[\x00-\x1f\x7f]/.test(e.message), false, 'control byte in message');
    }
});

// --- initOk ---------------------------------------------------------------

test('initOk is true only for systemd', () => {
    assert.equal(OT.initOk('systemd'), true);
    for (const v of ['other', 'sysvinit', 'openrc', 'SystemD', '', null, undefined, 1, {}])
        assert.equal(OT.initOk(v), false, JSON.stringify(v));
});

// --- evaluate -------------------------------------------------------------

const DETECT_OK = {
    os_release: { id: 'debian', id_like: '', version_id: '12', pretty_name: 'Debian 12' },
    arch: 'x86_64',
    init: 'systemd'
};

test('evaluate on a supported target reports both assets and no errors', () => {
    const e = OT.evaluate(DETECT_OK);
    assert.equal(e.ok, true);
    assert.deepEqual(e.errors, []);
    assert.equal(e.arch, 'amd64');
    assert.equal(e.family, 'debian');
    assert.equal(e.serverAsset.name, 'rustdesk-server-linux-amd64.zip');
    assert.equal(e.apiAsset.name, 'linux-amd64.tar.gz');
});

test('evaluate accepts os_release as a raw file body as well as an object', () => {
    const e = OT.evaluate({ os_release: fixture('rhel-10'), arch: 'aarch64', init: 'systemd' });
    assert.equal(e.ok, true);
    assert.equal(e.osRelease.id, 'rhel');
    assert.equal(e.family, 'fedora');
    assert.equal(e.serverAsset.name, 'rustdesk-server-linux-arm64v8.zip');
    assert.equal(e.apiAsset.name, 'linux-arm64.tar.gz');
});

test('evaluate reports i686 as an ARCH_UNSUPPORTED error while keeping the server asset', () => {
    const e = OT.evaluate({ os_release: { id: 'debian' }, arch: 'i686', init: 'systemd' });
    assert.equal(e.ok, false);
    assert.equal(e.arch, 'i386');
    assert.equal(e.serverAsset.name, 'rustdesk-server-linux-i386.zip');
    assert.equal(e.apiAsset, null);
    assert.deepEqual(e.errors.map((x) => x.kind), ['ARCH_UNSUPPORTED']);
    assert.match(e.errors[0].message, /API server/i);
});

test('evaluate reports NO_SYSTEMD without inventing a systemd unit anyway', () => {
    const e = OT.evaluate({ os_release: { id: 'debian' }, arch: 'x86_64', init: 'other' });
    assert.equal(e.ok, false);
    assert.ok(e.errors.some((x) => x.kind === 'NO_SYSTEMD'));
    assert.equal(e.init, 'other');
    // The assets are still resolved: manual mode still needs the URLs.
    assert.equal(e.serverAsset.name, 'rustdesk-server-linux-amd64.zip');
});

test('evaluate reports OS_UNSUPPORTED when the OS cannot be identified at all', () => {
    const e = OT.evaluate({ os_release: '', arch: 'x86_64', init: 'systemd' });
    assert.ok(e.errors.some((x) => x.kind === 'OS_UNSUPPORTED'));
    assert.equal(e.family, 'unknown');
});

test('an unrecognised but identified distro is a WARNING, not a hard stop', () => {
    const e = OT.evaluate({ os_release: { id: 'voidlinux' }, arch: 'x86_64', init: 'systemd' });
    assert.equal(e.ok, true);
    assert.deepEqual(e.errors, []);
    assert.equal(e.warnings.length, 1);
    assert.match(e.warnings[0], /voidlinux/);
});

test('evaluate never throws, whatever it is handed', () => {
    for (const d of [null, undefined, 42, '', 'nonsense', [], {},
        { os_release: null, arch: null, init: null },
        { os_release: { id: {} }, arch: [], init: [] }]) {
        const e = OT.evaluate(d);
        assert.equal(typeof e.ok, 'boolean', JSON.stringify(d));
        assert.ok(Array.isArray(e.errors));
        assert.ok(Array.isArray(e.warnings));
        assert.equal(e.serverAsset, null);
        assert.equal(e.apiAsset, null);
        assert.ok(e.errors.some((x) => x.kind === 'ARCH_UNSUPPORTED'));
    }
});

test('every evaluate error carries a kind from the C6 list and a remediation slot', () => {
    const KINDS = new Set(['OS_UNSUPPORTED', 'ARCH_UNSUPPORTED', 'NO_SYSTEMD']);
    const e = OT.evaluate({ os_release: '', arch: 'sparc64', init: 'openrc' });
    assert.equal(e.errors.length, 3);
    for (const err of e.errors) {
        assert.ok(KINDS.has(err.kind), err.kind);
        assert.equal(typeof err.message, 'string');
        assert.ok(err.message.length > 0);
        assert.ok(err.remediation === null || typeof err.remediation === 'string');
    }
});

// --- the module must be loadable with no DOM and no cockpit ----------------

test('loads under node with no window and no cockpit', () => {
    assert.equal(typeof globalThis.window, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof OT.evaluate, 'function');
});

test('index.html loads ostarget.js after errors.js', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.includes('js/core/ostarget.js'), 'ostarget.js is not referenced');
    assert.ok(srcs.indexOf('js/core/errors.js') < srcs.indexOf('js/core/ostarget.js'),
        'ostarget.js must load after errors.js');
});
