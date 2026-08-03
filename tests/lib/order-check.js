// tests/lib/order-check.js — the C7 ordering check for tests/smoke.mjs rule 4,
// pulled out into a small pure function so it can be unit tested against
// synthetic script lists instead of only through the real index.html + filesystem.
//
// C7 is used as a subsequence ORACLE: a script absent from it is skipped rather
// than failing, so a later task's legitimate addition cannot be broken by this
// check (C11). A violation names the C7 NEIGHBOURS of the offending script — the
// immediate predecessor and successor pinned by the canonical list — so a task
// that tail-inserts a new <script> tag out of C7 order (e.g. js/core/themes.js,
// which C7 pins BEFORE js/core/settings.js even though themes lands much later) is
// told exactly where the tag belongs instead of a bare "wrong order" failure.
'use strict';

// Exposed separately so the boundary cases (offending script is first or last in
// C7) can be tested directly — the first-in-C7 case is reachable through
// checkC7Order, but the last-in-C7 case never can be (the last C7 index is the
// maximum possible, so it can never be "less than" a previously seen index).
function c7Neighbors(c7, i) {
    return {
        before: i > 0 ? c7[i - 1] : '(nothing — it is first in C7)',
        after: i + 1 < c7.length ? c7[i + 1] : '(nothing — it is last in C7)'
    };
}

// Returns an array of human-actionable failure strings (empty when `scripts` is
// order-consistent with `c7`). Does not touch the filesystem.
function checkC7Order(scripts, c7) {
    const failures = [];
    const pos = new Map(c7.map((s, idx) => [s, idx]));
    const seen = new Set();
    let prev = -1;
    let prevSrc = '';
    for (const s of scripts) {
        if (seen.has(s)) {
            failures.push(`index.html loads ${s} more than once`);
            continue;
        }
        seen.add(s);
        if (!pos.has(s)) continue; // not pinned by C7 — nothing to order it against
        const i = pos.get(s);
        if (i < prev) {
            const { before, after } = c7Neighbors(c7, i);
            failures.push(
                `index.html loads ${s} after ${prevSrc}, but C7 pins ${s} immediately ` +
                `after ${before} and before ${after} — move its <script> tag there, ` +
                `not after ${prevSrc}`);
        } else {
            prev = i;
            prevSrc = s;
        }
    }
    return failures;
}

module.exports = { checkC7Order, c7Neighbors };
