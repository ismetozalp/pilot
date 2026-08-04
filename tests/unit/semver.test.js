// Unit tests for js/core/semver.js.
//
// This module gates a privileged action: answering "newer" makes the UI offer an
// update that runs `make install` as root. So the interesting cases are the ones
// where it must answer NO — garbage, prereleases, equal versions, oversized and
// control-character input.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../js/core/semver.js');

test('parses plain versions', () => {
    assert.deepEqual(S.parse('1.2.3'),
        { major: 1, minor: 2, patch: 3, prerelease: null, build: null });
});

test('tolerates the conventional leading v on GitHub tags and surrounding spaces', () => {
    assert.deepEqual(S.parse('v1.2.3'), S.parse('1.2.3'));
    assert.deepEqual(S.parse('V1.2.3'), S.parse('1.2.3'));
    assert.deepEqual(S.parse('  1.2.3  '), S.parse('1.2.3'));
    assert.deepEqual(S.parse('=1.2.3'), S.parse('1.2.3'));
});

test('fills in omitted minor and patch', () => {
    assert.deepEqual(S.parse('1'), { major: 1, minor: 0, patch: 0, prerelease: null, build: null });
    assert.deepEqual(S.parse('1.2'), { major: 1, minor: 2, patch: 0, prerelease: null, build: null });
});

test('captures prerelease and build metadata separately', () => {
    const p = S.parse('1.2.3-rc.1+build.5');
    assert.equal(p.prerelease, 'rc.1');
    assert.equal(p.build, 'build.5');
});

test('rejects malformed input', () => {
    const bad = ['', ' ', 'x', '1.2.3.4', 'v', 'latest', '1.2.-3', '1.2.3-', 'a.b.c',
        '-1.0.0', '1..2', '1.2.3 4.5.6', '1,2,3', '1.2.3+', 'v v1.2.3'];
    for (const v of bad) assert.equal(S.parse(v), null, JSON.stringify(v));
});

test('rejects non-string input rather than coercing it', () => {
    const bad = [null, undefined, 42, {}, [], true, NaN, Symbol('1.0.0'), () => '1.0.0'];
    for (const v of bad) assert.equal(S.parse(v), null, String(v && v.toString ? v.toString() : v));
});

test('rejects unicode digits that only look numeric', () => {
    // Arabic-Indic and full-width digits: Number() would happily accept these,
    // so a lax implementation silently compares versions nobody typed.
    assert.equal(S.parse('\u0661.\u0662.\u0663'), null);
    assert.equal(S.parse('\uff11.\uff12.\uff13'), null);
});

test('rejects any input carrying a control character', () => {
    // A tag arriving from GitHub as "v\n2.0.0" must NOT parse: a trailing-\s
    // implementation accepts it, and the UI then offers an update for a tag no
    // human wrote. Every literal here is an explicit escape so the intent is
    // visible and survives copy-paste.
    const bad = ['1.2.3\n', '\n1.2.3', 'v\x0a2.0.0', '1.2.3\r', '1\x002.3',
        '1.2.3\x1f', '1.2.3\x7f', '1.2\t.3', 'v\x092.0.0'];
    for (const v of bad) assert.equal(S.parse(v), null, JSON.stringify(v));
});

test('rejects oversized numeric fields instead of overflowing to a float', () => {
    assert.equal(S.parse('1'.repeat(20) + '.0.0'), null);
    assert.equal(S.parse('1.' + '9'.repeat(30) + '.0'), null);
    assert.equal(S.parse('999999999.0.0').major, 999999999);   // 9 digits is the ceiling
});

test('rejects an absurdly long string outright', () => {
    assert.equal(S.parse('1.0.0-' + 'a'.repeat(4096)), null);
});

test('rejects leading zeros, which semver forbids', () => {
    assert.equal(S.parse('01.2.3'), null);
    assert.equal(S.parse('1.02.3'), null);
    assert.equal(S.parse('1.2.03'), null);
    assert.deepEqual(S.parse('0.1.0'),
        { major: 0, minor: 1, patch: 0, prerelease: null, build: null });
});

test('isValid mirrors parse', () => {
    assert.equal(S.isValid('1.0.0'), true);
    assert.equal(S.isValid('nope'), false);
    assert.equal(S.isValid(null), false);
    assert.equal(S.isValid('1.0.0\n'), false);
});

test('compares by major, then minor, then patch', () => {
    assert.equal(S.compare('2.0.0', '1.9.9'), 1);
    assert.equal(S.compare('1.2.0', '1.1.9'), 1);
    assert.equal(S.compare('1.1.2', '1.1.1'), 1);
    assert.equal(S.compare('1.1.1', '1.1.1'), 0);
    assert.equal(S.compare('1.0.0', '2.0.0'), -1);
});

test('compares numerically, not lexically', () => {
    assert.equal(S.compare('1.10.0', '1.9.0'), 1);
    assert.equal(S.compare('0.19.1', '0.9.0'), 1);
    assert.equal(S.compare('10.0.0', '9.0.0'), 1);
});

test('a release outranks its own prereleases', () => {
    assert.equal(S.compare('1.0.0', '1.0.0-rc.1'), 1);
    assert.equal(S.compare('1.0.0-rc.1', '1.0.0'), -1);
});

test('prerelease identifiers compare per the spec', () => {
    assert.equal(S.compare('1.0.0-alpha', '1.0.0-alpha.1'), -1);
    assert.equal(S.compare('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
    assert.equal(S.compare('1.0.0-alpha.beta', '1.0.0-beta'), -1);
    assert.equal(S.compare('1.0.0-beta', '1.0.0-beta.2'), -1);
    assert.equal(S.compare('1.0.0-beta.2', '1.0.0-beta.11'), -1);
    assert.equal(S.compare('1.0.0-beta.11', '1.0.0-rc.1'), -1);
});

test('build metadata is ignored when comparing', () => {
    assert.equal(S.compare('1.0.0+a', '1.0.0+b'), 0);
    assert.equal(S.eq('1.0.0+a', '1.0.0'), true);
});

test('unparseable input sorts lowest so it can never look like an upgrade', () => {
    assert.equal(S.compare('garbage', '1.0.0'), -1);
    assert.equal(S.compare('1.0.0', 'garbage'), 1);
    assert.equal(S.compare('garbage', 'rubbish'), 0);
    assert.equal(S.compare(null, undefined), 0);
});

test('gt and eq agree with compare', () => {
    assert.equal(S.gt('1.1.0', '1.0.0'), true);
    assert.equal(S.gt('1.0.0', '1.1.0'), false);
    assert.equal(S.gt('1.0.0', '1.0.0'), false);
    assert.equal(S.eq('v1.0.0', '1.0.0'), true);
});

test('isNewer accepts a genuine upgrade', () => {
    assert.equal(S.isNewer('1.1.0', '1.0.0'), true);
    assert.equal(S.isNewer('v2.0.0', '1.9.9'), true);
});

test('isNewer refuses an equal or older version', () => {
    assert.equal(S.isNewer('1.0.0', '1.0.0'), false);
    assert.equal(S.isNewer('0.9.0', '1.0.0'), false);
});

test('isNewer never offers a prerelease over the stable release it precedes', () => {
    assert.equal(S.isNewer('1.0.0-rc.1', '1.0.0'), false);
    assert.equal(S.isNewer('2.0.0-beta.1', '1.0.0'), true);   // still a real upgrade
});

test('isNewer refuses when either side is unparseable', () => {
    // This gates a root `make install`; refusing is always the safe failure.
    assert.equal(S.isNewer('garbage', '1.0.0'), false);
    assert.equal(S.isNewer('2.0.0', 'garbage'), false);
    assert.equal(S.isNewer('', ''), false);
    assert.equal(S.isNewer(null, '1.0.0'), false);
    assert.equal(S.isNewer('2.0.0', undefined), false);
    assert.equal(S.isNewer('2.0.0\n', '1.0.0'), false);
});

test('the shipped VERSION file, when present, is a valid semver', () => {
    // Conditional on purpose: VERSION is created by the skeleton section, and this
    // test must not fail merely because of task ordering. When it exists it is
    // genuinely exercised.
    const fs = require('node:fs');
    const path = require('node:path');
    const p = path.join(__dirname, '..', '..', 'VERSION');
    if (!fs.existsSync(p)) return;
    const current = fs.readFileSync(p, 'utf8').trim();
    assert.equal(S.isValid(current), true, `VERSION is not a valid semver: ${current}`);
    assert.equal(S.isNewer(current, current), false);
    const v = S.parse(current);
    assert.equal(S.isNewer(`${v.major + 1}.0.0`, current), true);
    assert.equal(S.isNewer(`${v.major}.${v.minor}.${v.patch}-rc.1`, current), false);
});

test('format round-trips a parsed version and drops build metadata', () => {
    assert.equal(S.format('v1.2.3'), '1.2.3');
    assert.equal(S.format('1.2'), '1.2.0');
    assert.equal(S.format('1.2.3-rc.1+meta'), '1.2.3-rc.1');
    assert.equal(S.format('garbage'), '');
    assert.equal(S.format(null), '');
    assert.equal(S.format(S.parse('2.0.0')), '2.0.0');
});
