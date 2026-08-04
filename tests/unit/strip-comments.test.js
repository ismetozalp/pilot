// Unit tests for tests/lib/strip-comments.js — the helper tests/smoke.mjs rules 5
// and 6 use so a legitimate mention of "cockpit.http" inside an explanatory comment
// (js/core/servers.js, Task 19) does not trip a rule meant to police real code.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripComments } = require('../lib/strip-comments.js');

const HTTP_USE = /cockpit\s*\.\s*http\b/;

test('a cockpit.http mention inside a // line comment does not survive stripping', () => {
    const src = [
        "// This module deliberately does NOT use cockpit.http() — see spec §7.",
        "'use strict';",
        "function f() { return 1; }"
    ].join('\n');
    assert.match(src, HTTP_USE, 'sanity: the raw source does mention it');
    assert.doesNotMatch(stripComments(src), HTTP_USE);
});

test('a cockpit.http mention inside a /* */ block comment does not survive stripping', () => {
    const src = [
        "/* Why not cockpit.http: the API server needs a bearer token, and the",
        "   bridge HTTP channel cannot carry one (spec §7). */",
        "'use strict';",
        "function f() { return 1; }"
    ].join('\n');
    assert.match(src, HTTP_USE);
    assert.doesNotMatch(stripComments(src), HTTP_USE);
});

test('a real cockpit.http( call in code still matches after stripping', () => {
    const src = [
        "// header comment, no mention here",
        "'use strict';",
        "function f() { return cockpit.http('/api/x'); }"
    ].join('\n');
    assert.match(stripComments(src), HTTP_USE);
});

test('mixed: comment mention is removed, real call in code survives', () => {
    const src = [
        "// this file does NOT use cockpit.http",
        "'use strict';",
        "function f() { return cockpit.http('/api/x'); }"
    ].join('\n');
    const stripped = stripComments(src);
    assert.match(stripped, HTTP_USE, 'the real call must still be visible');
    // Only one match should remain — the comment's mention must be gone.
    assert.equal((stripped.match(new RegExp(HTTP_USE.source, 'g')) || []).length, 1);
});

test('does not corrupt string or template literals containing // or /*', () => {
    const src = "const u = 'http://example.com/*not-a-comment*/';\n// real comment\nconst v = `a // b`;";
    const stripped = stripComments(src);
    assert.ok(stripped.includes("'http://example.com/*not-a-comment*/'"));
    assert.ok(stripped.includes('`a // b`'));
    assert.ok(!stripped.includes('real comment'));
});

test('respects escaped quotes inside strings so the string does not end early', () => {
    const src = "const s = 'it\\'s // not a comment';\n// actually a comment";
    const stripped = stripComments(src);
    assert.ok(stripped.includes("it\\'s // not a comment"));
    assert.ok(!stripped.includes('actually a comment'));
});

// --- regex literals ------------------------------------------------------
//
// CRITICAL regression coverage: a regex literal's escaped slashes (`\/\/`) must
// never be read as the start of a `//` line comment. Getting this wrong silently
// deletes real code — including a genuine `cockpit.http(` call — which is exactly
// how the bug shipped: tls.js, firewall.js, ports.js and redact.js are all
// specified to contain URL/path regexes ahead of real logic on the same line.

test('an escaped-slash regex literal does not start a false line comment, and real ' +
    'code after it on the same line survives', () => {
    const src = "if (/^https:\\/\\//.test(u)) return cockpit.http(u);";
    // Sanity: prove the naive bug this guards against would otherwise strike here.
    const stripped = stripComments(src);
    assert.equal(stripped, src, 'nothing here is a real comment — output must be unchanged');
    assert.match(stripped, HTTP_USE, 'the real cockpit.http( call after the regex must survive');
});

test('a `/` inside a character class does not end the regex literal early', () => {
    const src = "const RE = /[a-z/]+/;\nfunction f() { return cockpit.http(x); }";
    const stripped = stripComments(src);
    assert.ok(stripped.includes('/[a-z/]+/'), 'the character class slash must be preserved');
    assert.match(stripped, HTTP_USE, 'real code on the following line must survive untouched');
});

test('division is not mistaken for a regex literal', () => {
    const src = "const r = a / b; // c\nfunction f() { return cockpit.http(x); }";
    const stripped = stripComments(src);
    assert.ok(stripped.includes('const r = a / b;'), 'the division must survive as division');
    assert.ok(!stripped.includes('// c'), 'the real trailing comment must still be stripped');
    assert.match(stripped, HTTP_USE, 'real code on the following line must survive');
});

test('a regex literal that looks like a block comment does not swallow following code', () => {
    const src = "const RE = /\\/\\*/;\nfunction f() { return cockpit.http(x); }";
    const stripped = stripComments(src);
    assert.ok(stripped.includes('/\\/\\*/'), 'the regex must be preserved verbatim');
    assert.match(stripped, HTTP_USE, 'real code on the following line must survive');
});

test('a regex literal immediately followed by .test(...) is handled, and the real ' +
    'call it guards still matches', () => {
    const src = "if (/^\\d+$/.test(x)) { return cockpit.http(x); }";
    const stripped = stripComments(src);
    assert.equal(stripped, src);
    assert.match(stripped, HTTP_USE);
});

// --- keyword lookback -----------------------------------------------------
//
// A handful of keywords end in an identifier character ('n' in "return", 'f' in
// "typeof", ...) yet still grammatically expect an expression next, so a `/`
// right after one of them opens a regex literal, not division. Missing this is
// the same class of bug as the escaped-slash case above: an unrecognised regex
// literal's `/` pair can eat the rest of the line and hide a real cockpit.http(
// call from smoke rule 5.

test('return /regex/ opens a regex literal, and a real cockpit.http( call ' +
    'chained after it with && still survives and is still detected', () => {
    const src = "function f(u) { return /^https:\\/\\//.test(u) && cockpit.http(u); }";
    const stripped = stripComments(src);
    assert.equal(stripped, src, 'nothing here is a real comment — output must be unchanged');
    assert.match(stripped, HTTP_USE, 'the real cockpit.http( call must survive');
});

test('typeof /regex/ opens a regex literal, not division', () => {
    const src = "if (typeof /x/.test(y) === 'boolean') { return cockpit.http(y); }";
    const stripped = stripComments(src);
    assert.equal(stripped, src);
    assert.match(stripped, HTTP_USE);
});

test('case /regex/: opens a regex literal, not division', () => {
    const src = [
        "switch (path) {",
        "    case /a\\/b/:",
        "        return cockpit.http(path);",
        "}"
    ].join('\n');
    const stripped = stripComments(src);
    assert.equal(stripped, src);
    assert.match(stripped, HTTP_USE);
});

test('genuine division right after an identifier is still division, and a real ' +
    'trailing comment after it is still stripped', () => {
    const src = "const ratio = total / count; // note\nfunction f() { return cockpit.http(x); }";
    const stripped = stripComments(src);
    assert.ok(stripped.includes('const ratio = total / count;'), 'division must survive as division');
    assert.ok(!stripped.includes('// note'), 'the real trailing comment must still be stripped');
    assert.match(stripped, HTTP_USE, 'code on the following line must survive');
});

test('an identifier that merely STARTS WITH a keyword is not treated as one — ' +
    'returnValue / 2 remains division', () => {
    const src = "const half = returnValue / 2; // note\nfunction f() { return cockpit.http(x); }";
    const stripped = stripComments(src);
    assert.ok(stripped.includes('const half = returnValue / 2;'), 'must remain division');
    assert.ok(!stripped.includes('// note'), 'the real trailing comment must still be stripped');
    assert.match(stripped, HTTP_USE);
});
