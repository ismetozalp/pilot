// tests/lib/strip-comments.js — comment stripper used by tests/smoke.mjs rules 5 and 6.
//
// The brief's smoke rules 5 and 6 police API usage by regex over module SOURCE TEXT.
// Applied to raw source, that also matches occurrences inside comments — and a
// header comment is exactly where a module legitimately explains why it does NOT
// use cockpit.http (js/core/servers.js, Task 19) or names "cockpit" for unrelated
// reasons (js/core/errors.js already does, in a comment about a caught problem
// object). Without stripping, correct code would turn `npm run test:smoke` red.
//
// This is a small state machine, not a single regex, because a naive
// s/\/\/.*//; s/\/\*.*?\*\//sg pass would also eat `//` or `/*` that appear inside a
// string or template literal (e.g. a URL). It tracks whether it is inside a
// '/"/` string and, if so, copies characters verbatim (respecting backslash
// escapes) instead of treating them as comment syntax.
//
// Not a js/** module: it is a test-only helper, so the C5 house rules (IIFE,
// Pilot* global, dual export) do not apply to it. A plain CommonJS export is enough
// for both tests/smoke.mjs (via createRequire) and tests/unit/*.test.js (via require).
'use strict';

function stripComments(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        const c2 = i + 1 < n ? src[i + 1] : '';

        if (c === '/' && c2 === '/') {
            i += 2;
            while (i < n && src[i] !== '\n') i++;
            continue;
        }

        if (c === '/' && c2 === '*') {
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
                // Preserve newlines so line numbers in the stripped text still line
                // up with the original — harmless, and useful if a caller ever needs
                // to report a line number against the stripped copy.
                if (src[i] === '\n') out += '\n';
                i++;
            }
            i += 2; // consume the closing */
            continue;
        }

        if (c === '\'' || c === '"' || c === '`') {
            const quote = c;
            out += c;
            i++;
            while (i < n && src[i] !== quote) {
                if (src[i] === '\\' && i + 1 < n) {
                    out += src[i] + src[i + 1];
                    i += 2;
                    continue;
                }
                out += src[i];
                i++;
            }
            if (i < n) { out += src[i]; i++; } // consume the closing quote
            continue;
        }

        out += c;
        i++;
    }
    return out;
}

module.exports = { stripComments };
