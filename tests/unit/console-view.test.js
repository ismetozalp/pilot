// tests/unit/console-view.test.js — helpers shared by the Users and Audit surfaces.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../../js/core/errors.js');            // installs globalThis.PilotErrors
const V = require('../../js/core/console-view.js');

test('module loads with no DOM and no cockpit global', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(globalThis.PilotConsoleView, V);
    const src = fs.readFileSync(path.resolve(__dirname, '../../js/core/console-view.js'), 'utf8');
    assert.ok(!/\bcockpit\b/.test(src), 'console-view.js must not touch cockpit');
});

test('text: scalars are coerced, everything else becomes the empty string', () => {
    const pairs = [['ok', 'ok'], [0, '0'], [42, '42'], [true, 'true'], [false, 'false'],
        [null, ''], [undefined, ''], [{}, ''], [[], ''], [['a'], ''], [NaN, ''], [Infinity, '']];
    for (const [input, want] of pairs) assert.equal(V.text(input), want, JSON.stringify(input));
    assert.equal(V.text(() => 'x'), '');
});

test('text: control characters and newlines can never reach the DOM', () => {
    const pairs = [['a\nb', 'a b'], ['a\r\nb', 'a b'], ['a\tb', 'a b'], ['a\x00b', 'a b'],
        ['a\x1bb', 'a b'], ['a\x7fb', 'a b'], ['\x00\x01\x02', ''], ['  padded  ', 'padded']];
    for (const [input, want] of pairs) assert.equal(V.text(input), want, JSON.stringify(input));
});

test('text: unicode survives, oversized input is truncated', () => {
    assert.equal(V.text('ışıl — 日本語'), 'ışıl — 日本語');
    assert.equal(V.text('x'.repeat(5000)).length, V.MAX_TEXT);
    assert.equal(V.text('y'.repeat(V.MAX_TEXT)).length, V.MAX_TEXT);
});

test('hasControl detects control bytes and is not confused by unicode or state', () => {
    for (const v of ['clean', 'ışıl', null, 7, undefined, {}]) assert.equal(V.hasControl(v), false, String(v));
    for (const v of ['a\nb', 'a\x00b', 'a\x7fb']) assert.equal(V.hasControl(v), true, JSON.stringify(v));
    assert.equal(V.hasControl('a\nb'), V.hasControl('a\nb'));   // a /g regex would go stateful
});

test('first returns the first present, non-empty value', () => {
    assert.equal(V.first({ b: 'two' }, ['a', 'b']), 'two');
    assert.equal(V.first({ a: '', b: 'two' }, ['a', 'b']), 'two');
    assert.equal(V.first({ a: null, b: 0 }, ['a', 'b']), 0);
    assert.equal(V.first({ a: false }, ['a']), false);
    for (const bad of [[{}, ['a']], [null, ['a']], ['nope', ['a']], [{ a: 1 }, 'a']])
        assert.equal(V.first(bad[0], bad[1]), null);
});

test('idOf prefers the given keys and sanitises what it finds', () => {
    assert.equal(V.idOf({ id: 'u1' }), 'u1');
    assert.equal(V.idOf({ user_id: 'u2' }), 'u2');
    assert.equal(V.idOf({ id: '', uuid: 'u3' }), 'u3');
    assert.equal(V.idOf({ id: 7 }), '7');
    assert.equal(V.idOf({ id: 'a\nb' }), 'a b');
    assert.equal(V.idOf({ nope: 'x' }), '');
    assert.equal(V.idOf(null), '');
    assert.equal(V.idOf({ id: 'x', gid: 'g1' }, ['gid']), 'g1');
});

test('count accepts non-negative integers only', () => {
    for (const [v, want] of [[0, 0], [12, 12], ['12', 12], [' 12 ', 12], [-1, null], ['-1', null],
        ['12abc', null], ['1e3', null], [null, null], [NaN, null], [true, null]])
        assert.equal(V.count(v), want, JSON.stringify(v));
});

test('clampInt clamps, floors and falls back', () => {
    for (const [v, want] of [[5, 5], ['5', 5], [5.9, 5], [0, 1], [99, 10], ['  ', 3], ['abc', 3],
        [null, 3], [undefined, 3], [true, 3], [Infinity, 3], [-9, 1]])
        assert.equal(V.clampInt(v, 1, 10, 3), want, JSON.stringify(v));
});

test('page accepts a bare array, the raw envelope, and an unwrapped payload', () => {
    let p = V.page([{ id: 'a' }, { id: 'b' }]);
    assert.equal(p.list.length, 2); assert.equal(p.total, 2); assert.equal(p.page, 1);
    p = V.page({ code: 0, message: '', data: { list: [{ id: 'a' }], total: 91, page: 3, page_size: 20 } });
    assert.equal(p.list.length, 1); assert.equal(p.total, 91); assert.equal(p.page, 3); assert.equal(p.pageSize, 20);
    p = V.page({ list: [{ id: 'a' }, { id: 'b' }], total: 2, page: 1, page_size: 50 });
    assert.equal(p.list.length, 2); assert.equal(p.pageSize, 50);
    p = V.page({ code: 0, message: '', data: [{ id: 'a' }] });
    assert.equal(p.list.length, 1); assert.equal(p.total, 1);
});

test('page never throws on hostile or truncated payloads', () => {
    for (const bad of [null, undefined, '', 'nope', 0, 42, true, NaN, {}, { data: null },
        { data: 'text' }, { list: 'not-an-array' }, { code: 0, data: { list: null, total: 'many' } }]) {
        const p = V.page(bad);
        assert.ok(Array.isArray(p.list), 'list must always be an array');
        assert.equal(typeof p.total, 'number');
        assert.ok(p.page >= 1);
    }
    assert.deepEqual(V.page({ list: 'not-an-array' }).list, []);
    assert.equal(V.page({ code: 0, data: { list: [1], total: 'many' } }).total, 1);
});

test('page copies the list rather than aliasing the payload', () => {
    const payload = { list: [{ id: 'a' }] };
    V.page(payload).list.push({ id: 'b' });
    assert.equal(payload.list.length, 1);
});

test('errorView maps a typed error to a kind, a message and an action label', () => {
    const v = V.errorView({ kind: 'API_UNREACHABLE', message: 'no route', detail: 'ECONNREFUSED' }, 'Users');
    assert.equal(v.context, 'Users');
    assert.equal(v.kind, 'API_UNREACHABLE');
    assert.equal(v.message, 'no route');
    assert.equal(v.detail, 'ECONNREFUSED');
    assert.equal(v.remediation, globalThis.PilotErrors.remediation('API_UNREACHABLE'));
    assert.equal(typeof v.actionLabel, 'string');
});

test('errorView normalises an unknown or missing kind rather than inventing one', () => {
    for (const bad of [{ kind: 'NOT_A_KIND', message: 'x' }, { message: 'x' }, null, undefined, 'a string'])
        assert.equal(V.errorView(bad, 'Users').kind, 'UNKNOWN', JSON.stringify(bad));
});

test('errorView scrubs hostile message and detail fields', () => {
    const v = V.errorView({ kind: 'GENERIC', message: 'bad\n<script>', detail: 'a\x00b' }, 'Users\n');
    assert.equal(v.message, 'bad <script>');
    assert.equal(v.detail, 'a b');
    assert.equal(v.context, 'Users');
    assert.equal(V.errorView({ kind: 'GENERIC', detail: { nested: true } }, '').detail, '');
    assert.equal(V.errorView({ kind: 'GENERIC', message: 'm'.repeat(4000) }, '').message.length, V.MAX_TEXT);
});

test('errorView falls back to the kind when there is no usable message', () => {
    assert.equal(V.errorView({ kind: 'SSH_UNREACHABLE' }, '').message, 'SSH_UNREACHABLE');
    assert.equal(V.errorView({ kind: 'GENERIC', message: '   ' }, '').message, 'GENERIC');
});

test('every remediation the errors module can return has a label entry', () => {
    for (const r of ['retry', 'reauthorize', 'manual-mode', 'fix-dns', 'open-ports', 'hard-stop', 'none'])
        assert.equal(typeof V.REMEDIATION_LABEL[r], 'string', 'no label for ' + r);
});

function fakeHost() {
    return {
        attrs: {}, html: '',
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
        setAttribute(k, v) { this.attrs[k] = v; },
        insertAdjacentHTML(_p, html) { this.html += html; }
    };
}
function fakeDoc(hosts) {
    return { getElementById(id) { return Object.prototype.hasOwnProperty.call(hosts, id) ? hosts[id] : null; } };
}

test('mountInto injects once and is idempotent', () => {
    const host = fakeHost();
    const doc = fakeDoc({ 'pilot-users': host });
    assert.equal(V.mountInto(doc, 'pilot-users', '<p>hi</p>'), true);
    assert.equal(host.html, '<p>hi</p>');
    assert.equal(V.mountInto(doc, 'pilot-users', '<p>hi</p>'), false);
    assert.equal(host.html, '<p>hi</p>');
});

test('mountInto degrades to false with no document and no host', () => {
    assert.equal(V.mountInto(null, 'pilot-users', '<p>hi</p>'), false);
    assert.equal(V.mountInto({}, 'pilot-users', '<p>hi</p>'), false);
    assert.equal(V.mountInto(fakeDoc({}), 'pilot-users', '<p>hi</p>'), false);
});
