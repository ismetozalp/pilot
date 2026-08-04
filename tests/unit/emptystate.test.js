// Unit tests for js/core/emptystate.js — the single home for empty-state copy and
// destinations (spec §7.3): a data-driven control with nothing to choose from is
// never rendered; instead the UI shows a one-line explanation plus a control that
// takes the user to where the missing thing is created.
//
// This module is PURE — no cockpit, no DOM, no I/O — so it is tested exactly like
// js/core/semver.js: plain node, no fixtures.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ES = require('../../js/core/emptystate.js');

const EXPECTED = {
    server: { message: 'No RustDesk server configured yet.', ctaLabel: 'Run setup', tab: 'setup' },
    addressbook: { message: 'No address book yet.', ctaLabel: 'Create one', tab: 'addressbook' },
    tag: { message: 'No tags yet.', ctaLabel: 'Add a tag', tab: 'addressbook' },
    group: { message: 'No groups yet.', ctaLabel: 'Create a group', tab: 'users' },
    'device-group': { message: 'No device groups yet.', ctaLabel: 'Create a device group', tab: 'devices' },
    device: { message: 'No devices have registered yet.', ctaLabel: 'How to connect a device', tab: 'devices' },
    user: { message: 'No users yet.', ctaLabel: 'Add a user', tab: 'users' }
};

test('module shape', () => {
    assert.equal(typeof ES, 'object');
    assert.equal(typeof ES.forKind, 'function');
    assert.equal(typeof ES.isKnown, 'function');
    assert.ok(Array.isArray(ES.KINDS) || (ES.KINDS && typeof ES.KINDS.length === 'number'));
});

test('KINDS contains exactly the seven documented ids, no more, no fewer', () => {
    const kinds = Array.from(ES.KINDS).slice().sort();
    const expected = Object.keys(EXPECTED).sort();
    assert.deepEqual(kinds, expected);
});

for (const kind of Object.keys(EXPECTED)) {
    test(`forKind('${kind}') returns the exact documented copy`, () => {
        const got = ES.forKind(kind);
        assert.deepEqual(got, EXPECTED[kind]);
    });

    test(`isKnown('${kind}') is true`, () => {
        assert.equal(ES.isKnown(kind), true);
    });
}

test('isKnown is false for an unknown kind', () => {
    assert.equal(ES.isKnown('nope'), false);
    assert.equal(ES.isKnown(''), false);
    assert.equal(ES.isKnown(undefined), false);
    assert.equal(ES.isKnown(null), false);
});

test('forKind is case-sensitive', () => {
    assert.equal(ES.forKind('Server'), null);
    assert.equal(ES.forKind('SERVER'), null);
});

test('forKind does not trim — surrounding whitespace is an unknown kind', () => {
    assert.equal(ES.forKind(' server '), null);
    assert.equal(ES.forKind('server '), null);
    assert.equal(ES.forKind(' server'), null);
});

test('forKind returns null for unknown, empty and nullish input', () => {
    const bad = ['nope', '', undefined, null, 0, false, {}, []];
    for (const v of bad) assert.equal(ES.forKind(v), null, JSON.stringify(v));
});

test('forKind returns null for a Symbol, a BigInt and a function', () => {
    assert.equal(ES.forKind(Symbol('server')), null);
    assert.equal(ES.forKind(10n), null);
    assert.equal(ES.forKind(function server() {}), null);
});

test('forKind is prototype-pollution safe: inherited Object.prototype members are not kinds', () => {
    for (const poison of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'toLocaleString']) {
        assert.equal(ES.forKind(poison), null, poison);
        assert.equal(ES.isKnown(poison), false, poison);
    }
});

test('forKind("__proto__") does not return Object.prototype or pollute future lookups', () => {
    assert.equal(ES.forKind('__proto__'), null);
    // A prototype-pollution bug would make an unrelated kind resolve through the
    // polluted prototype chain instead of failing the own-property check.
    assert.equal(ES.forKind('nope'), null);
});

test('two calls to forKind return independent objects — mutating one leaves the other alone', () => {
    const a = ES.forKind('server');
    const b = ES.forKind('server');
    assert.notEqual(a, b, 'forKind must not return the same shared object reference');
    a.message = 'tampered';
    a.ctaLabel = 'tampered';
    a.tab = 'tampered';
    const c = ES.forKind('server');
    assert.deepEqual(c, EXPECTED.server);
    assert.notEqual(c.message, 'tampered');
});

test('mutating a returned object cannot poison KINDS or a later isKnown() call', () => {
    const r = ES.forKind('user');
    r.tab = 'nope-this-is-not-a-tab';
    assert.equal(ES.isKnown('user'), true);
    assert.deepEqual(ES.forKind('user'), EXPECTED.user);
});

test('every returned tab is a real tab declared in js/app.js', () => {
    const App = require('../../js/app.js');
    const validTabs = App.TABS.map((t) => t.id);
    for (const kind of ES.KINDS) {
        const got = ES.forKind(kind);
        assert.ok(got, 'forKind(' + kind + ') must not be null for a KINDS member');
        assert.ok(validTabs.includes(got.tab),
            'forKind(' + kind + ').tab = "' + got.tab + '" is not a real tab id: ' + validTabs.join(', '));
    }
});

test('is pure — loads under plain node with no cockpit and no DOM', () => {
    // Requiring it at the top of this file already proves this, but assert
    // explicitly that the module did not reach for any global I/O surface.
    assert.equal(typeof cockpit, 'undefined');
});
