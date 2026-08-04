// Unit tests for tests/lib/order-check.js — the C7 subsequence check behind
// tests/smoke.mjs rule 4, tested directly against synthetic script lists so the
// failure MESSAGE (which must name the offending script's C7 neighbours) can be
// pinned without touching the real index.html or filesystem.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkC7Order, c7Neighbors } = require('../lib/order-check.js');

test('an in-order subsequence produces no failures', () => {
    const c7 = ['a', 'b', 'c', 'd'];
    assert.deepEqual(checkC7Order(['a', 'c', 'd'], c7), []);
    // Scripts absent from C7 are skipped entirely — nothing to order them against.
    assert.deepEqual(checkC7Order(['x', 'a', 'y', 'd'], c7), []);
});

test('a duplicate load is reported by name', () => {
    const out = checkC7Order(['a', 'b', 'a'], ['a', 'b']);
    assert.equal(out.length, 1);
    assert.match(out[0], /loads a more than once/);
});

test('an out-of-order script names its real C7 predecessor and successor — the ' +
    'exact scenario that motivated this check: C7 pins js/core/themes.js BEFORE ' +
    'js/core/settings.js, but a later task tail-inserting themes.js would load it ' +
    'after settings.js', () => {
    const c7 = ['js/core/errors.js', 'js/core/semver.js', 'js/core/themes.js', 'js/core/settings.js'];
    const out = checkC7Order(
        ['js/core/errors.js', 'js/core/settings.js', 'js/core/themes.js'], c7);
    assert.equal(out.length, 1, JSON.stringify(out));
    assert.match(out[0], /loads js\/core\/themes\.js after js\/core\/settings\.js/);
    assert.match(out[0], /immediately after js\/core\/semver\.js/);
    assert.match(out[0], /before js\/core\/settings\.js/);
});

test('c7Neighbors names "(nothing ...)" for a script pinned first in C7', () => {
    const n = c7Neighbors(['a', 'b', 'c'], 0);
    assert.match(n.before, /nothing.*first in C7/);
    assert.equal(n.after, 'b');
});

test('c7Neighbors names "(nothing ...)" for a script pinned last in C7', () => {
    const n = c7Neighbors(['a', 'b', 'c'], 2);
    assert.equal(n.before, 'b');
    assert.match(n.after, /nothing.*last in C7/);
});

test('a violation whose offender is first in C7 surfaces that in the message', () => {
    const c7 = ['a', 'b', 'c'];
    const out = checkC7Order(['b', 'a'], c7);
    assert.equal(out.length, 1);
    assert.match(out[0], /loads a after b/);
    assert.match(out[0], /immediately after \(nothing.*first in C7\)/);
    assert.match(out[0], /before b/);
});
