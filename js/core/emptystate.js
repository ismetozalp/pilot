// core/emptystate.js — the single home for empty-state copy and destinations
// (spec §7.3, Appendix A8).
//
// The rule this implements: a data-driven control with nothing to choose from is
// NEVER rendered. In its place the UI shows a one-line explanation plus a control
// that takes the user to where the missing thing is created. An empty <select> is
// a dead end — it says something is wrong but not what, and offers no way forward.
// This is product-wide because every list is empty on a fresh install, which is
// exactly when a new user has least idea what to do.
//
// PURE — no cockpit, no DOM, no I/O. Every surface built before this module
// existed (Tasks 20-30) inlined its own empty-state copy behind a
// `typeof PilotEmptyState !== 'undefined'` guard or plain hardcoded markup; this
// module exists so that copy has one source of truth and is testable in one
// place, not so every inline site is forced to match it verbatim — a surface
// whose own copy is more specific (e.g. a filtered-to-nothing state that offers
// to clear the filter, which is a different situation from an unconfigured
// system) keeps its own wording.
'use strict';
(function (root) {

    // Frozen table, keyed by kind. Object.freeze is not enough on its own to stop
    // a caller mutating a RETURNED object — forKind() always hands back a fresh
    // copy (requirement 4) — but freezing the table too means a bug that somehow
    // got a live reference to a table entry (rather than the copy forKind()
    // makes) still can't corrupt it for the next lookup.
    const TABLE = Object.freeze({
        server: Object.freeze({
            message: 'No RustDesk server configured yet.', ctaLabel: 'Run setup', tab: 'setup'
        }),
        addressbook: Object.freeze({
            message: 'No address book yet.', ctaLabel: 'Create one', tab: 'addressbook'
        }),
        tag: Object.freeze({
            message: 'No tags yet.', ctaLabel: 'Add a tag', tab: 'addressbook'
        }),
        // RESERVED (task 33 / GAP D audit): 'group' and 'device-group' are named in
        // the design spec's Appendix A8 table alongside every other kind here, but
        // no task has ever built a "list of groups" or "list of device groups" UI
        // to be the empty state FOR — js/features/users-ui.js's own group handling
        // is a per-account ASSIGNMENT dropdown, a different situation entirely (an
        // unresolved group id on one row, not an empty groups list), and no
        // "device groups" concept exists anywhere else in this codebase.
        // Kept rather than removed because the spec still names them as part of
        // the closed vocabulary; if a future task adds that UI, forKind('group')/
        // forKind('device-group') are already here and already tested. If no such
        // UI is ever planned, removing these two entries (and their spec rows) is
        // the honest fix — not leaving them to keep looking like a wired feature.
        group: Object.freeze({
            message: 'No groups yet.', ctaLabel: 'Create a group', tab: 'users'
        }),
        'device-group': Object.freeze({
            message: 'No device groups yet.', ctaLabel: 'Create a device group', tab: 'devices'
        }),
        device: Object.freeze({
            message: 'No devices have registered yet.', ctaLabel: 'How to connect a device', tab: 'devices'
        }),
        user: Object.freeze({
            message: 'No users yet.', ctaLabel: 'Add a user', tab: 'users'
        })
    });

    // The frozen list of valid kind strings, derived from TABLE rather than
    // hand-duplicated, so the two can never drift apart.
    const KINDS = Object.freeze(Object.keys(TABLE));

    // An own-property check on TABLE — never a plain `TABLE[kind]` — is what
    // keeps '__proto__', 'constructor', 'toString' and 'hasOwnProperty' from
    // resolving through the prototype chain to an inherited, unrelated value.
    // The `typeof kind === 'string'` guard runs first so a Symbol, BigInt, array
    // or function can never even reach the lookup (an own-property check alone
    // would not save us from `TABLE[['server']]` coercing to the string
    // 'server' via Array#toString, for instance).
    function isKnown(kind) {
        return typeof kind === 'string' && kind !== '' &&
            Object.prototype.hasOwnProperty.call(TABLE, kind);
    }

    // Returns a FRESH object every call (never a shared reference into TABLE),
    // so a caller that mutates one result can never affect a later call or the
    // table itself.
    function forKind(kind) {
        if (!isKnown(kind)) return null;
        const entry = TABLE[kind];
        return { message: entry.message, ctaLabel: entry.ctaLabel, tab: entry.tab };
    }

    const PilotEmptyState = { KINDS, forKind, isKnown };
    root.PilotEmptyState = PilotEmptyState;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotEmptyState;
})(typeof window !== 'undefined' ? window : globalThis);
