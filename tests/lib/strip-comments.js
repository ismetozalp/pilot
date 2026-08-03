// tests/lib/strip-comments.js — comment stripper used by tests/smoke.mjs rules 5 and 6.
//
// The brief's smoke rules 5 and 6 police API usage by regex over module SOURCE TEXT.
// Applied to raw source, that also matches occurrences inside comments — and a
// header comment is exactly where a module legitimately explains why it does NOT
// use cockpit.http (js/core/servers.js, Task 19, will contain the literal text
// "cockpit.http" in its header comment explaining the omission). Without stripping,
// that correct code would turn `npm run test:smoke` red.
//
// This is a small state machine, not a single regex, because a naive
// s/\/\/.*//; s/\/\*.*?\*\//sg pass would also eat `//` or `/*` that appear inside a
// string, a template literal, or a REGEX LITERAL (e.g. `/^https:\/\//`, a pattern
// several core modules legitimately need — tls.js, firewall.js, ports.js and
// redact.js are all specified to contain URL/path regexes). So this tracks three
// kinds of "verbatim" spans and copies their contents through untouched instead of
// scanning them for comment syntax:
//   - '/"/` strings, honouring backslash escapes;
//   - regex literals, honouring backslash escapes AND `[...]` character classes
//     (a `/` inside a class does not end the literal);
// and it resolves the classic regex-vs-divide ambiguity the same way a real
// tokenizer does: after an identifier, a number, `)`, `]`, or `++`/`--`, a `/` is
// division; otherwise it opens a regex literal — EXCEPT that a handful of
// keywords end in an identifier character yet still grammatically expect an
// expression next, so `return /re/`, `typeof /re/`, `case /re/:` and similarly
// shaped code must still open a regex, not divide. REGEX_KEYWORDS is exactly that
// exception list, matched as a WHOLE identifier (so `returnValue / 2` is still
// division — the check is on the complete preceding word, never a prefix of it).
//
// Not a js/** module: it is a test-only helper, so the C5 house rules (IIFE,
// Pilot* global, dual export) do not apply to it. A plain CommonJS export is enough
// for both tests/smoke.mjs (via createRequire) and tests/unit/*.test.js (via require).
'use strict';

const IDENT_CHAR = /[A-Za-z0-9_$]/;

// Keywords/operators after which a `/` is grammatically a regex literal, never
// division, because the language does not permit an operand immediately before
// them. Missing one here reproduces the exact class of bug this file exists to
// prevent: an unrecognised regex literal's `/` pair can eat the rest of the
// line, hiding a real `cockpit.http` call from smoke rule 5.
const REGEX_KEYWORDS = new Set([
    'return', 'typeof', 'instanceof', 'case', 'in', 'of', 'new', 'delete',
    'void', 'do', 'else', 'yield', 'await', 'throw'
]);

function stripComments(src) {
    let out = '';
    let i = 0;
    const n = src.length;

    // Whether the next '/' should be read as opening a regex literal (true) or as
    // a division/operator (false). Updated after every character that is not part
    // of a comment, string, or regex literal.
    let regexAllowed = true;

    while (i < n) {
        const c = src[i];
        const c2 = i + 1 < n ? src[i + 1] : '';

        // A bare `//` or `/*` is ALWAYS a comment start in real JavaScript,
        // regardless of regex-vs-divide context — a regex cannot begin with `*`,
        // and two adjacent `/` are never a valid expression on their own. So these
        // two checks intentionally do not consult `regexAllowed`.
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
            regexAllowed = false; // a string is a complete operand, like an identifier
            continue;
        }

        if (c === '/' && regexAllowed) {
            // A regex literal, not division: copy it through verbatim (escapes and
            // character classes included) so that neither an escaped `\/` nor a
            // `/` inside `[...]` is mistaken for the closing delimiter, and so that
            // a pattern like `/\/\*/` is never mistaken for a block comment.
            out += c;
            i++;
            let inClass = false;
            while (i < n) {
                const rc = src[i];
                if (rc === '\\' && i + 1 < n) { out += rc + src[i + 1]; i += 2; continue; }
                if (rc === '\n') break; // unterminated on this line — bail defensively
                if (rc === '[') inClass = true;
                else if (rc === ']') inClass = false;
                out += rc;
                i++;
                if (rc === '/' && !inClass) break; // closing delimiter
            }
            regexAllowed = false; // the regex literal is a complete operand
            continue;
        }

        if (IDENT_CHAR.test(c)) {
            // Consume the WHOLE word at once (not one character at a time) so the
            // keyword check below is against the complete identifier, never a
            // prefix of it — otherwise "returnValue" would be mistaken for "return".
            const start = i;
            while (i < n && IDENT_CHAR.test(src[i])) i++;
            const word = src.slice(start, i);
            out += word;
            // A number is never in REGEX_KEYWORDS, so this also keeps the existing
            // "after a number, '/' divides" behaviour unchanged.
            regexAllowed = REGEX_KEYWORDS.has(word);
            continue;
        }

        if (c === ')' || c === ']') {
            out += c;
            i++;
            regexAllowed = false; // a closed group/index is a complete operand
            continue;
        }

        if ((c === '+' && out.endsWith('+')) || (c === '-' && out.endsWith('-'))) {
            // The second half of `++` / `--`: still a complete operand afterwards.
            out += c;
            i++;
            regexAllowed = false;
            continue;
        }

        if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') {
            // Any other operator/punctuation (`(`, `,`, `=`, `:`, `;`, `{`, `[`,
            // `!`, `+`, `-`, `*`, `%`, `<`, `>`, `&`, `|`, `^`, `~`, `?`, ...) means
            // an expression is expected next, so a following `/` opens a regex.
            regexAllowed = true;
        }
        out += c;
        i++;
    }
    return out;
}

module.exports = { stripComments };
