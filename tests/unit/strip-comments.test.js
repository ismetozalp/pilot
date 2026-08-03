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
