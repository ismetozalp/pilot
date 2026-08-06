// core/addressbook.js — peer and tag models, dedupe, validation, CSV round-trips.
//
// Pure: no cockpit reference, no fetch, no DOM. Everything a user can type or
// paste enters through here, so every function either returns a normalised value
// or names its problems; only a programming error (an unknown tag mode, an
// unusable tag name passed to a rename) throws.
//
// The CSV format is the one Pilot both writes and reads, so the two halves are
// defined together: CRLF records, RFC 4180 quoting, a reversible guard against
// spreadsheet formula injection, and a comma-joined `tags` column — which is safe
// precisely because normalizeTag() refuses a tag containing a comma.
'use strict';
(function (root) {
    const req = (typeof require !== 'undefined' && typeof module !== 'undefined' && module.exports)
        ? require : null;
    const Errors = root.PilotErrors || (req ? req('./errors.js') : null);

    function err(kind, message, detail) {
        if (Errors && typeof Errors.create === 'function') return Errors.create(kind, message, detail);
        const e = new Error(message);
        e.kind = kind;
        e.detail = detail === undefined ? null : detail;
        return e;
    }

    const LIMITS = {
        id: 128, alias: 128, username: 128, hostname: 253, platform: 32,
        note: 1024, tag: 64, tagsPerPeer: 64, csvBytes: 1048576, csvRows: 10000
    };
    const COLUMNS = ['id', 'alias', 'username', 'hostname', 'platform', 'tags', 'note'];
    const MODES = ['add', 'remove', 'set'];
    const PERSONAL = { guid: '', name: 'Personal', personal: true, owner: '', note: '' };

    // Escapes only — a literal control byte in a source file is invisible and does
    // not survive copy-paste.
    const CTRL = /[\x00-\x1f\x7f]/;
    // note is the one field allowed to contain \n (folded from \r\n/\r), but every
    // OTHER control byte is still forbidden in it -- including a literal tab
    // (\x09), which is deliberate: a tab inside note has no legitimate rendering
    // in a single-line CSV cell or a form field, so it is rejected everywhere, not
    // just here. Nothing upstream of this file spells that out, so this comment is
    // the pinned decision Task 23 should rely on.
    const CTRL_NO_LF = /[\x00-\x09\x0b-\x1f\x7f]/;
    const ID_RE = /^[A-Za-z0-9_-]+$/;
    const TEXT_FIELDS = ['alias', 'username', 'hostname', 'platform'];

    // Objects and arrays become '' rather than '[object Object]': a caller that
    // hands us a nested structure made a mistake, and an empty field reports it as
    // "id is required" instead of inventing a peer named after a JS internal.
    function str(v) {
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        return '';
    }

    function foldNewlines(s) { return s.replace(/\r\n?/g, '\n'); }

    function normalizeTag(raw) {
        const t = foldNewlines(str(raw)).trim();
        if (!t) return null;
        if (t.length > LIMITS.tag) return null;
        if (CTRL.test(t)) return null;
        if (t.indexOf(',') !== -1) return null;
        return t;
    }

    function rawTagList(raw) {
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') return raw.split(',');
        return [];
    }

    function normalizeTags(raw) {
        const out = [];
        for (const item of rawTagList(raw)) {
            const t = normalizeTag(item);
            if (t === null) continue;
            if (out.indexOf(t) === -1) out.push(t);
            if (out.length >= LIMITS.tagsPerPeer) break;
        }
        return out;
    }

    function normalizePeer(raw) {
        const src = (raw && typeof raw === 'object') ? raw : {};
        return {
            id: str(src.id).trim(),
            alias: str(src.alias).trim(),
            username: str(src.username).trim(),
            hostname: str(src.hostname).trim(),
            platform: str(src.platform).trim(),
            tags: normalizeTags(src.tags),
            note: foldNewlines(str(src.note))
        };
    }

    function validatePeer(raw) {
        const peer = normalizePeer(raw);
        const problems = [];
        if (!peer.id) problems.push('id is required');
        else if (peer.id.length > LIMITS.id) problems.push('id is longer than ' + LIMITS.id + ' characters');
        else if (!ID_RE.test(peer.id)) problems.push('id may only contain letters, digits, "-" and "_"');
        for (const f of TEXT_FIELDS) {
            if (peer[f].length > LIMITS[f]) problems.push(f + ' is longer than ' + LIMITS[f] + ' characters');
            else if (CTRL.test(peer[f])) problems.push(f + ' contains a control character');
        }
        if (peer.note.length > LIMITS.note) problems.push('note is longer than ' + LIMITS.note + ' characters');
        else if (CTRL_NO_LF.test(peer.note)) problems.push('note contains a control character');
        let dropped = 0;
        for (const t of rawTagList(raw && typeof raw === 'object' ? raw.tags : null))
            if (str(t).trim() && normalizeTag(t) === null) dropped += 1;
        if (dropped) problems.push(dropped + ' tag(s) were rejected');
        return { ok: problems.length === 0, peer, problems };
    }

    // Identity is id ALONE unless the caller opts into book-scoping. Peer itself
    // carries no book/guid field (that lives on Book, a separate record), so a raw
    // input item may carry an extra `book` key purely for THIS function's benefit;
    // normalizePeer never reads it and it never appears on the returned Peer.
    //
    // opts.byBook: true makes the merge key (id, book) instead of id alone, so two
    // items with the same id but a different `book` stay separate records --
    // exactly the enforcement a caller merging peers gathered from more than one
    // address book needs, instead of an unenforced "partition your list first"
    // convention. Leave it unset (the default) for the common case of deduping
    // within a single already-known book (e.g. one CSV import): every same-id
    // item merges, as before.
    //
    // Either way, fusion is never silent: `merged` reports EVERY id that absorbed
    // a duplicate, each tagged `exact` -- true only when the duplicate contributed
    // literally nothing not already present (a genuine re-statement of the same
    // record), false the instant it contributed anything new: a filled-in field, a
    // conflicting field, or even just a tag the kept record didn't have yet. A
    // caller can read `merged` alone -- `merged.some(m => !m.exact)` -- and know
    // real fusion happened without ever looking at `conflicts`. `conflicts` stays
    // as the finer-grained record of specifically which non-empty field values
    // disagreed and were discarded; it can be empty even when a fusion was real
    // (two peers whose only difference was their tags, say), which is exactly why
    // `merged` no longer defers to it.
    function dedupePeers(list, opts) {
        const byBook = !!(opts && opts.byBook === true);
        function bookKey(raw) {
            return byBook ? str(raw && typeof raw === 'object' ? raw.book : '').trim() : '';
        }
        const byKey = new Map();
        const keyOrder = [];
        const mergedByKey = new Map();
        const conflicts = [];
        for (const raw of (Array.isArray(list) ? list : [])) {
            const peer = normalizePeer(raw);
            if (!peer.id) continue;
            const key = byBook ? (peer.id + '#' + bookKey(raw)) : peer.id;
            if (!byKey.has(key)) { byKey.set(key, peer); keyOrder.push(key); continue; }

            const kept = byKey.get(key);
            let addsInfo = false;
            for (const f of TEXT_FIELDS.concat(['note']))
                if (peer[f] && peer[f] !== kept[f]) addsInfo = true;
            for (const t of peer.tags)
                if (kept.tags.indexOf(t) === -1) addsInfo = true;

            for (const f of TEXT_FIELDS.concat(['note'])) {
                if (!kept[f] && peer[f]) { kept[f] = peer[f]; continue; }
                if (kept[f] && peer[f] && kept[f] !== peer[f])
                    conflicts.push({ id: peer.id, field: f, kept: kept[f], discarded: peer[f] });
            }
            for (const t of peer.tags)
                if (kept.tags.indexOf(t) === -1 && kept.tags.length < LIMITS.tagsPerPeer) kept.tags.push(t);

            const entry = mergedByKey.get(key);
            if (!entry) mergedByKey.set(key, { id: peer.id, exact: !addsInfo });
            else if (addsInfo) entry.exact = false;
        }
        const merged = [];
        mergedByKey.forEach((v) => merged.push(v));
        return { peers: keyOrder.map((k) => byKey.get(k)), merged, conflicts };
    }

    function withTags(peer, tags, mode) {
        if (MODES.indexOf(mode) === -1) throw err('GENERIC', 'unknown tag mode: ' + str(mode), null);
        const p = normalizePeer(peer);
        const want = normalizeTags(tags);
        if (mode === 'set') { p.tags = want.slice(0, LIMITS.tagsPerPeer); return p; }
        if (mode === 'remove') { p.tags = p.tags.filter((t) => want.indexOf(t) === -1); return p; }
        for (const t of want)
            if (p.tags.indexOf(t) === -1 && p.tags.length < LIMITS.tagsPerPeer) p.tags.push(t);
        return p;
    }

    function bulkTag(peers, ids, tags, mode) {
        if (MODES.indexOf(mode) === -1) throw err('GENERIC', 'unknown tag mode: ' + str(mode), null);
        const want = new Set((Array.isArray(ids) ? ids : []).map((x) => str(x).trim()).filter(Boolean));
        return (Array.isArray(peers) ? peers : []).map((raw) => {
            const p = normalizePeer(raw);
            return want.has(p.id) ? withTags(p, tags, mode) : p;
        });
    }

    function tagCounts(peers) {
        const counts = new Map();
        for (const raw of (Array.isArray(peers) ? peers : []))
            for (const t of normalizePeer(raw).tags) counts.set(t, (counts.get(t) || 0) + 1);
        const out = [];
        counts.forEach((count, tag) => out.push({ tag, count }));
        out.sort((a, b) => (b.count - a.count) || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
        return out;
    }

    function renameTagIn(peers, from, to) {
        const a = normalizeTag(from);
        const b = normalizeTag(to);
        if (!a || !b) throw err('GENERIC', 'both tag names must be usable', null);
        return (Array.isArray(peers) ? peers : []).map((raw) => {
            const p = normalizePeer(raw);
            if (p.tags.indexOf(a) === -1) return p;
            const next = [];
            for (const t of p.tags) {
                const v = (t === a) ? b : t;
                if (next.indexOf(v) === -1) next.push(v);
            }
            p.tags = next;
            return p;
        });
    }

    function removeTagFrom(peers, tag) {
        const a = normalizeTag(tag);
        if (!a) throw err('GENERIC', 'tag name is not usable', null);
        return (Array.isArray(peers) ? peers : []).map((raw) => {
            const p = normalizePeer(raw);
            p.tags = p.tags.filter((t) => t !== a);
            return p;
        });
    }

    function normalizeBook(raw) {
        const src = (raw && typeof raw === 'object') ? raw : {};
        let guid = str(src.guid).trim();
        if (!guid) guid = str(src.id).trim();
        const personal = src.personal === true || src.personal === 1;
        let name = str(src.name).trim();
        if (!name) name = personal ? PERSONAL.name : (guid || 'Shared');
        return { guid, name, personal, owner: str(src.owner).trim(), note: foldNewlines(str(src.note)) };
    }

    // Depth-bounded so a self-referential payload cannot hang the UI thread.
    function listFrom(payload, keys) {
        let node = payload;
        for (let depth = 0; depth < 3; depth++) {
            if (Array.isArray(node)) return node;
            if (!node || typeof node !== 'object') return [];
            for (const k of keys) if (Array.isArray(node[k])) return node[k];
            node = node.data;
        }
        return [];
    }

    function booksFrom(payload) {
        const seen = new Set();
        const out = [];
        for (const raw of listFrom(payload, ['profiles', 'books', 'list'])) {
            const b = normalizeBook(raw);
            if (seen.has(b.guid)) continue;
            seen.add(b.guid);
            out.push(b);
        }
        // No synthetic personal book. It used to be prepended with
        // PERSONAL.guid = '' whenever the payload named none -- and '' is not a
        // guid the server accepts: /api/ab/peers?ab= is a 400 and /api/ab/tags/
        // a 404. Inventing an entry that cannot be used is worse than showing
        // none, because §7.3's empty state at least tells the user what to do.
        // PilotApi.addressbook.books() now asks /api/ab/personal for the real
        // guid, so a server that HAS a personal book always reports one.
        return out;
    }

    // v2.7 answers /api/ab/peers with {data:[...], licensed_devices, total}.
    // No key needed for it: listFrom() already descends through .data at every
    // level, which a mutation test confirmed -- adding 'data' to the key list
    // here changed nothing, so it is not here.
    function peersFrom(payload) {
        return listFrom(payload, ['peers', 'list']).map(normalizePeer).filter((p) => p.id);
    }

    function tagsFrom(payload) {
        const out = [];
        for (const raw of listFrom(payload, ['tags', 'list'])) {
            const t = normalizeTag(typeof raw === 'string' ? raw : (raw && raw.name));
            if (t !== null && out.indexOf(t) === -1) out.push(t);
        }
        return out;
    }

    // A field a spreadsheet would evaluate gets one apostrophe in front. The
    // apostrophe itself is in the trigger set, so guarding is injective and
    // unguardFormula() restores the original for EVERY string, including "'=x".
    //
    // The trigger check looks PAST a run of known zero-width/invisible characters
    // (zero-width space/non-joiner/joiner, BOM, word joiner) rather than only the
    // literal first byte: a field that is invisible-char + "=1+1" would render in
    // Excel/LibreOffice exactly like "=1+1" once the invisible run is skipped, so
    // testing only charAt(0) would let a disguised formula through unguarded.
    const FORMULA = /^[=+\-@\t\r']/;
    const INVISIBLE_LEAD = /^[\u200b\u200c\u200d\u2060\ufeff]+/;
    function triggersFormula(s) { return FORMULA.test(s.replace(INVISIBLE_LEAD, '')); }
    function guardFormula(v) { const s = str(v); return triggersFormula(s) ? "'" + s : s; }
    function unguardFormula(v) {
        const s = str(v);
        return (s.charAt(0) === "'" && triggersFormula(s.slice(1))) ? s.slice(1) : s;
    }

    function csvEscape(v) {
        const s = str(v);
        if (s === '') return '';
        if (/[",\r\n]/.test(s) || /^\s/.test(s) || /\s$/.test(s))
            return '"' + s.replace(/"/g, '""') + '"';
        return s;
    }

    function parseCsv(text) {
        const problems = [];
        let s = str(text);
        if (s.charAt(0) === '\uFEFF') s = s.slice(1);
        const rows = [];
        let row = [];
        let field = '';
        let rowHadQuotes = false;
        let inQuotes = false;
        let i = 0;

        function pushField() { row.push(field); field = ''; }
        function pushRow() {
            pushField();
            const blank = row.length === 1 && row[0] === '' && !rowHadQuotes;
            if (!blank) rows.push(row);
            row = [];
            rowHadQuotes = false;
        }

        while (i < s.length) {
            const ch = s.charAt(i);
            if (inQuotes) {
                if (ch === '"') {
                    if (s.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
                    inQuotes = false; i += 1; continue;
                }
                if (ch === '\r') {
                    field += '\n';
                    i += (s.charAt(i + 1) === '\n') ? 2 : 1;
                    continue;
                }
                field += ch; i += 1; continue;
            }
            if (ch === '"') {
                if (field === '') { inQuotes = true; rowHadQuotes = true; i += 1; continue; }
                problems.push('row ' + (rows.length + 1) + ': quote inside an unquoted field');
                field += ch; i += 1; continue;
            }
            if (ch === ',') { pushField(); i += 1; continue; }
            if (ch === '\r') { i += (s.charAt(i + 1) === '\n') ? 2 : 1; pushRow(); continue; }
            if (ch === '\n') { i += 1; pushRow(); continue; }
            field += ch; i += 1;
        }
        if (inQuotes) problems.push('unterminated quoted field');
        if (field !== '' || row.length > 0 || rowHadQuotes) pushRow();
        return { rows, problems };
    }

    function toCsv(peers) {
        const list = (Array.isArray(peers) ? peers : []).map(normalizePeer);
        const lines = [COLUMNS.join(',')];
        for (const p of list)
            lines.push(COLUMNS.map(function (c) {
                return csvEscape(guardFormula(c === 'tags' ? p.tags.join(',') : p[c]));
            }).join(','));
        return lines.join('\r\n') + '\r\n';
    }

    function byteLength(s) {
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
        if (typeof Buffer !== 'undefined') return Buffer.byteLength(s, 'utf8');
        return s.length;
    }

    function fromCsv(text) {
        const s = str(text);
        if (byteLength(s) > LIMITS.csvBytes)
            return { peers: [], problems: ['CSV is larger than ' + LIMITS.csvBytes + ' bytes'] };
        const parsed = parseCsv(s);
        const problems = parsed.problems.slice();
        const rows = parsed.rows;
        if (!rows.length) { problems.push('CSV has no header row'); return { peers: [], problems }; }
        if (rows.length - 1 > LIMITS.csvRows) {
            problems.push('CSV has more than ' + LIMITS.csvRows + ' data rows');
            return { peers: [], problems };
        }
        const header = rows[0].map((h) => unguardFormula(h).trim().toLowerCase());
        // A duplicated header (two "id" columns, say from a hand-merged
        // spreadsheet) must not silently discard a whole column of data: the
        // first occurrence still wins, but which columns were dropped is now
        // named in `problems` instead of vanishing without a trace.
        const index = {};
        for (const c of COLUMNS) {
            const positions = [];
            for (let h = 0; h < header.length; h++) if (header[h] === c) positions.push(h);
            index[c] = positions.length ? positions[0] : -1;
            if (positions.length > 1)
                problems.push('duplicate column header: ' + c + ' (columns ' +
                    positions.map((p) => p + 1).join(', ') + ') — only column ' +
                    (positions[0] + 1) + ' is used, the rest are ignored');
        }
        if (index.id === -1) { problems.push('CSV has no "id" column'); return { peers: [], problems }; }

        const candidates = [];
        for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
            const cell = function (c) {
                const at = index[c];
                return (at >= 0 && at < row.length) ? unguardFormula(row[at]) : '';
            };
            const v = validatePeer({
                id: cell('id'), alias: cell('alias'), username: cell('username'),
                hostname: cell('hostname'), platform: cell('platform'),
                tags: cell('tags'), note: cell('note')
            });
            if (!v.ok) { problems.push('row ' + (r + 1) + ': ' + v.problems.join('; ')); continue; }
            candidates.push(v.peer);
        }
        const d = dedupePeers(candidates);
        for (const m of d.merged)
            problems.push(m.exact
                ? 'duplicate id restated: ' + m.id + ' (identical rows, nothing lost)'
                : 'duplicate id merged: ' + m.id);
        for (const c of d.conflicts)
            problems.push('duplicate id ' + c.id + ': ' + c.field + ' "' + c.discarded +
                '" was discarded in favor of "' + c.kept + '"');
        return { peers: d.peers, problems };
    }

    const PilotAddressBook = {
        LIMITS, COLUMNS, MODES, PERSONAL,
        str, normalizeTag, normalizeTags, normalizePeer, validatePeer, dedupePeers,
        withTags, bulkTag, tagCounts, renameTagIn, removeTagFrom,
        normalizeBook, listFrom, booksFrom, peersFrom, tagsFrom,
        guardFormula, unguardFormula, csvEscape, parseCsv, toCsv, fromCsv
    };
    root.PilotAddressBook = PilotAddressBook;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotAddressBook;
})(typeof window !== 'undefined' ? window : globalThis);
