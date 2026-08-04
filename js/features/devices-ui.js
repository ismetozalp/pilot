// features/devices-ui.js -- the Devices surface: inventory with genuine online
// state, last seen, address, platform and version, plus the three write actions
// the spec names (rename, add to address book, delete).
//
// Everything that decides what the table says is a pure function at the top of
// this file. The Alpine component below only fetches through PilotApi (C12) and
// hands the payload to those functions, which is what makes all of it testable
// under `node --test` with no DOM, no cockpit and no server.
'use strict';
(function (root) {
    function need(name, path) {
        if (root[name]) return root[name];
        if (typeof require === 'function') {
            try { return require(path); } catch (e) { return null; }
        }
        return null;
    }

    const Errors = need('PilotErrors', '../core/errors.js');
    // Task 23 shipped the whole Address Book surface, and this one kept its
    // task-20 "disable until task 21" placeholder: `book` was initialised to ''
    // and never assigned again, so hasBook() was permanently false and the
    // 25-line addToBook() below was unreachable. AB.booksFrom() is the same
    // normaliser js/features/addressbook-ui.js uses — one shape for a book
    // payload, not two.
    const AB = need('PilotAddressBook', '../core/addressbook.js');
    // Spec §7.3: a data-driven control with nothing to choose from is never
    // rendered; the empty state and its next action come from here.
    const EmptyState = need('PilotEmptyState', '../core/emptystate.js');

    const MOUNT_ID = 'pilot-devices';
    const SERVER_CHANGED_EVENT = 'pilot:server-changed';
    const DASH = '\u2014';
    const MAX_NAME = 64;
    const MAX_FIELD = 200;
    const DEFAULT_PAGE_SIZE = 50;

    // Escapes only. A literal control character in a class is invisible in an
    // editor and does not survive copy-paste.
    const CONTROL = /[\x00-\x1f\x7f]/;
    const CONTROL_G = /[\x00-\x1f\x7f]/g;

    const SORT_KEYS = new Set(['id', 'name', 'ip', 'platform', 'version', 'online', 'lastSeenMs']);
    const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on', 'online']);

    function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
    function str(v) { return typeof v === 'string' ? v : ''; }
    function clean(v) { return str(v).replace(CONTROL_G, ' ').trim().slice(0, MAX_FIELD); }

    function pick(obj, keys) {
        if (!obj || typeof obj !== 'object') return null;
        for (const k of keys) if (has(obj, k)) return obj[k];
        return null;
    }

    function firstStr(obj, keys) {
        if (!obj || typeof obj !== 'object') return '';
        for (const k of keys) {
            if (!has(obj, k)) continue;
            const v = obj[k];
            if (typeof v === 'string' && v.trim()) return v;
            if (typeof v === 'number' && isFinite(v)) return String(v);
        }
        return '';
    }

    function numOrNull(v) {
        if (typeof v === 'number' && isFinite(v) && v >= 0) return v;
        if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
        return null;
    }

    function booleanish(v) {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') return v === 1;
        if (typeof v === 'string') return TRUE_WORDS.has(v.trim().toLowerCase());
        return false;
    }

    // ------------------------------------------------------------- time

    function toMillis(v) {
        if (typeof v === 'number') {
            if (!isFinite(v) || v <= 0) return null;
            return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
        }
        if (typeof v !== 'string' || !v) return null;
        // Checked before trimming: "1754222400\n" is not a timestamp, and trimming
        // first would silently accept it.
        if (CONTROL.test(v)) return null;
        const t = v.trim();
        if (!t) return null;
        if (/^\d+$/.test(t)) return toMillis(Number(t));
        const parsed = Date.parse(t);
        return isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    function relativeTime(ms, nowMs) {
        if (typeof ms !== 'number' || !isFinite(ms)) return 'never';
        const now = (typeof nowMs === 'number' && isFinite(nowMs)) ? nowMs : Date.now();
        const secs = Math.round((now - ms) / 1000);
        if (secs < 45) return 'just now';
        const mins = Math.round(secs / 60);
        if (mins < 60) return mins + (mins === 1 ? ' minute ago' : ' minutes ago');
        const hours = Math.round(mins / 60);
        if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
        const days = Math.round(hours / 24);
        return days + (days === 1 ? ' day ago' : ' days ago');
    }

    // ------------------------------------------------------------- parsing

    // api-client may hand back the {code,message,data} envelope, the page inside
    // it, or a bare array. None of those is pinned, so accept all of them rather
    // than guessing one and rendering an empty table when we guessed wrong.
    function unwrap(payload) {
        let p = payload;
        for (let i = 0; i < 4; i++) {
            if (!p || typeof p !== 'object' || Array.isArray(p)) return p;
            if (Array.isArray(p.list)) return p;
            if (has(p, 'data') && p.data && typeof p.data === 'object') { p = p.data; continue; }
            return p;
        }
        return p;
    }

    function normalizeList(payload) {
        const p = unwrap(payload);
        let items = [];
        let meta = {};
        if (Array.isArray(p)) {
            items = p;
        } else if (p && typeof p === 'object') {
            meta = p;
            if (Array.isArray(p.list)) items = p.list;
            else if (Array.isArray(p.peers)) items = p.peers;
            else if (Array.isArray(p.rows)) items = p.rows;
        }
        const kept = items.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
        const total = numOrNull(pick(meta, ['total']));
        const size = numOrNull(pick(meta, ['page_size']));
        return {
            items: kept,
            page: numOrNull(pick(meta, ['page'])),
            total: total === null ? kept.length : total,
            pageSize: size === null ? numOrNull(pick(meta, ['pageSize'])) : size
        };
    }

    function deviceRow(raw, nowMs) {
        const r = (raw && typeof raw === 'object') ? raw : {};
        const id = clean(firstStr(r, ['id', 'device_id', 'deviceId', 'guid', 'rid']));
        const lastSeenMs = toMillis(pick(r, ['last_online', 'lastOnline', 'last_seen',
            'lastSeen', 'updated_at', 'updatedAt']));
        return {
            id: id,
            name: clean(firstStr(r, ['alias', 'name', 'hostname', 'device_name', 'devicename'])) || id,
            // Only what the server told us. Inferring "online" from a recent
            // heartbeat would invent the one fact this surface exists to report.
            online: booleanish(pick(r, ['online', 'is_online', 'isOnline', 'status'])),
            lastSeenMs: lastSeenMs,
            lastSeenText: relativeTime(lastSeenMs, nowMs),
            ip: clean(firstStr(r, ['ip', 'last_ip', 'lastIp', 'remote_ip'])) || DASH,
            platform: clean(firstStr(r, ['platform', 'os', 'osName'])) || DASH,
            version: clean(firstStr(r, ['version', 'client_version', 'clientVersion'])) || DASH
        };
    }

    function deviceRows(payload, nowMs) {
        const now = (typeof nowMs === 'number' && isFinite(nowMs)) ? nowMs : Date.now();
        return normalizeList(payload).items
            .map((x) => deviceRow(x, now))
            .filter((r) => r.id !== '');
    }

    function filterRows(rows, query) {
        const list = Array.isArray(rows) ? rows : [];
        const q = clean(query).toLowerCase();
        if (!q) return list.slice();
        return list.filter((r) => [r.id, r.name, r.ip, r.platform, r.version]
            .some((f) => str(f).toLowerCase().indexOf(q) !== -1));
    }

    function sortRows(rows, key, dir) {
        const list = Array.isArray(rows) ? rows.slice() : [];
        if (typeof key !== 'string' || !SORT_KEYS.has(key)) return list;
        const sign = dir === 'desc' ? -1 : 1;
        return list.sort(function (a, b) {
            let c = 0;
            if (key === 'online') c = (a.online ? 1 : 0) - (b.online ? 1 : 0);
            else if (key === 'lastSeenMs') {
                const av = typeof a.lastSeenMs === 'number' ? a.lastSeenMs : -1;
                const bv = typeof b.lastSeenMs === 'number' ? b.lastSeenMs : -1;
                c = av - bv;
            } else c = String(a[key]).localeCompare(String(b[key]));
            if (c === 0) c = String(a.id).localeCompare(String(b.id));
            return c * sign;
        });
    }

    function validName(name) {
        if (typeof name !== 'string') return { ok: false, reason: 'A device name is required.' };
        if (CONTROL.test(name))
            return { ok: false, reason: 'A device name cannot contain control characters.' };
        const t = name.trim();
        if (!t) return { ok: false, reason: 'A device name is required.' };
        if (Array.from(t).length > MAX_NAME)
            return { ok: false, reason: 'A device name may be at most ' + MAX_NAME + ' characters.' };
        return { ok: true, reason: '', value: t };
    }

    // -------------------------------------------------- per-server state

    function newStore() { return Object.create(null); }
    function asStore(store) { return (store && typeof store === 'object') ? store : newStore(); }

    function newSurfaceState() {
        return {
            query: '', page: 1, pageSize: DEFAULT_PAGE_SIZE,
            sortKey: 'name', sortDir: 'asc',
            rows: null, total: 0, error: null, loadedAt: null
        };
    }

    function stateFor(store, serverId) {
        const s = asStore(store);
        const id = clean(serverId) || 'local';
        if (!has(s, id) || !s[id] || typeof s[id] !== 'object') s[id] = newSurfaceState();
        return s[id];
    }

    function rememberState(store, serverId, patch) {
        const s = asStore(store);
        const st = stateFor(s, serverId);
        const p = (patch && typeof patch === 'object') ? patch : {};
        for (const k of Object.keys(newSurfaceState())) if (has(p, k)) st[k] = p[k];
        return s;
    }

    // ------------------------------------------------------------- errors

    function errorMessage(e) {
        if (e === null || e === undefined) return '';
        if (typeof e === 'string') return e;
        let m = '';
        try { m = e.message; } catch (x) { m = ''; }
        if (typeof m === 'string' && m) return m;
        try { if (typeof e.kind === 'string' && e.kind) return e.kind; } catch (x) { /* ignore */ }
        return 'Unknown error';
    }

    function kindOf(e) {
        let k = null;
        try { if (e && typeof e === 'object') k = e.kind; } catch (x) { k = null; }
        if (Errors && typeof Errors.normalize === 'function') return Errors.normalize(k);
        return (typeof k === 'string' && k) ? k : 'UNKNOWN';
    }

    function remediationOf(e) {
        if (Errors && typeof Errors.remediation === 'function') return Errors.remediation(kindOf(e));
        return 'none';
    }

    // A short, honest sentence for each of PilotErrors' closed remediation
    // vocabulary (C16). The retry button always retries regardless of kind --
    // it is a generic re-fetch, not a login flow -- but the banner must still
    // say what actually went wrong is not "just click retry" for something
    // like an expired token (spec: the kind must drive real remediation, not
    // a single hardcoded "Try again" for every failure).
    const REMEDIATION_LABEL = {
        retry: 'Recommended: try again.',
        reauthorize: 'Recommended: sign in again on this server.',
        'manual-mode': 'Recommended: follow the manual steps for this target.',
        'fix-dns': 'Recommended: check the DNS record for this server.',
        'open-ports': 'Recommended: open the required ports and try again.',
        'hard-stop': 'This cannot be resolved automatically.',
        none: ''
    };

    function remediationLabel(e) {
        const r = remediationOf(e);
        return has(REMEDIATION_LABEL, r) ? REMEDIATION_LABEL[r] : '';
    }

    function fail(kind, message, detail) {
        if (Errors && typeof Errors.create === 'function') return Errors.create(kind, message, detail);
        const e = new Error(message);
        e.kind = kind;
        e.detail = detail === undefined ? null : detail;
        return e;
    }

    // ------------------------------------------------------------- events

    function serverChangedDetail(id) { return { id: clean(id) || 'local' }; }

    function emitServerChanged(id, target) {
        const t = target || root.document || null;
        if (!t || typeof t.dispatchEvent !== 'function') return false;
        if (typeof root.CustomEvent !== 'function') return false;
        t.dispatchEvent(new root.CustomEvent(SERVER_CHANGED_EVENT,
            { detail: serverChangedDetail(id), bubbles: true }));
        return true;
    }

    // ---------------------------------------------------------- component

    function pilotDevices(deps) {
        const d = (deps && typeof deps === 'object') ? deps : {};
        const store = asStore(d.store);
        const startId = clean(d.serverId) || 'local';
        const clock = typeof d.now === 'function' ? d.now : function () { return Date.now(); };

        return {
            api: d.api || root.PilotApi || null,
            store: store,
            doc: d.doc || null,
            now: clock,
            serverId: startId,
            state: stateFor(store, startId),
            rows: [],
            total: 0,
            loading: false,
            error: null,
            actionError: null,
            notice: '',
            busyIds: [],
            editingId: null,
            editName: '',
            confirmingId: null,
            // The address books this server actually has, and which one is
            // selected. `book` is null — NOT '' — until something is chosen,
            // because '' is a real, valid book id: js/core/addressbook.js's
            // PERSONAL.guid is the empty string by design, and api-client.js's
            // fill() deliberately allows it for the `ab` path parameter alone.
            // Treating '' as "nothing selected" would make the personal book —
            // the one book every server has — permanently unusable.
            books: [],
            book: null,
            booksLoaded: false,

            hasApi() {
                return !!(this.api && this.api.devices && typeof this.api.devices.list === 'function');
            },
            hasBooksApi() {
                return !!(this.api && this.api.addressbook &&
                    typeof this.api.addressbook.books === 'function');
            },
            errorText(e) { return errorMessage(e); },
            errorRemediation(e) { return remediationOf(e); },
            errorRemediationLabel(e) { return remediationLabel(e); },
            // True once a real book from THIS server's list is selected. The
            // membership check matters: a stale selection left over from another
            // server must not keep the button enabled against a book that is not
            // there any more.
            hasBook() {
                return typeof this.book === 'string' &&
                    this.books.some((b) => b.guid === this.book);
            },
            // Spec §7.3: with no books to choose from, render the empty state and
            // its route to where one is created — never an empty <select>, which
            // says something is wrong but not what, and offers no way forward.
            bookEmpty() { return this.booksLoaded && this.books.length === 0; },
            bookEmptyState() {
                const e = (EmptyState && typeof EmptyState.forKind === 'function')
                    ? EmptyState.forKind('addressbook') : null;
                return e || { message: 'No address book yet.', ctaLabel: 'Create one', tab: 'addressbook' };
            },
            // Loads this server's address books. A failure is not an error
            // banner of its own: it lands in the same empty state, because from
            // this surface "there is no book to add to" is the same situation
            // either way and the next action is identical.
            async loadBooks() {
                if (!this.hasBooksApi() || !AB || typeof AB.booksFrom !== 'function') {
                    this.books = [];
                    this.book = null;
                    this.booksLoaded = true;
                    return this.books;
                }
                try {
                    this.books = AB.booksFrom(await this.api.addressbook.books());
                } catch (e) {
                    this.books = [];
                }
                this.booksLoaded = true;
                // Default to the first book (the personal one, which
                // booksFrom() guarantees is present whenever the call
                // succeeded) so the action is usable without a second click.
                this.book = this.books.length ? this.books[0].guid : null;
                return this.books;
            },
            selectBook(guid) {
                this.book = typeof guid === 'string' ? guid : null;
                return this.book;
            },
            isBusy(id) { return this.busyIds.indexOf(id) !== -1; },
            setBusy(id, on) {
                const i = this.busyIds.indexOf(id);
                if (on && i === -1) this.busyIds.push(id);
                if (!on && i !== -1) this.busyIds.splice(i, 1);
            },
            setQuery(v) { this.state.query = clean(v); },
            setSort(key) {
                if (typeof key !== 'string' || !SORT_KEYS.has(key)) return false;
                if (this.state.sortKey === key)
                    this.state.sortDir = this.state.sortDir === 'asc' ? 'desc' : 'asc';
                else { this.state.sortKey = key; this.state.sortDir = 'asc'; }
                return true;
            },
            visible() {
                return sortRows(filterRows(this.rows, this.state.query),
                    this.state.sortKey, this.state.sortDir);
            },
            // Two different empty screens (spec §7.3: never a bare empty shell,
            // always a message plus a next action) -- "no devices have EVER
            // registered" needs a different message and action than "the filter
            // matched nothing", which would be actively misleading if the two
            // shared one paragraph (an operator staring at "no devices have
            // connected" while two devices sit one keystroke away, hidden only
            // by their own filter, is worse than no message at all).
            emptyKind() {
                if (this.loading || this.error) return 'none';
                if (this.rows.length === 0) return 'no-devices';
                if (this.visible().length === 0) return 'no-match';
                return 'none';
            },

            async refresh(force) {
                // An explicit Refresh refreshes this surface, which includes the
                // book list -- otherwise a book created on the Address Book tab
                // never appears here without a full reload.
                if (force) this.loadBooks();
                if (!force && Array.isArray(this.state.rows)) {
                    this.rows = this.state.rows.slice();
                    this.total = this.state.total;
                    this.error = this.state.error;
                    return this.rows;
                }
                if (!this.hasApi()) {
                    this.error = fail('GENERIC',
                        'The API client is not loaded, so devices cannot be listed.');
                    this.rows = [];
                    this.total = 0;
                } else {
                    this.loading = true;
                    try {
                        const payload = await this.api.devices.list({
                            page: this.state.page,
                            page_size: this.state.pageSize,
                            q: this.state.query
                        });
                        this.rows = deviceRows(payload, this.now());
                        this.total = normalizeList(payload).total;
                        this.error = null;
                    } catch (e) {
                        this.error = e;
                        this.rows = [];
                        this.total = 0;
                    } finally {
                        this.loading = false;
                    }
                }
                this.state.rows = this.rows.slice();
                this.state.total = this.total;
                this.state.error = this.error;
                this.state.loadedAt = this.now();
                return this.rows;
            },

            async useServer(id) {
                const next = clean(id) || 'local';
                if (next === this.serverId) return this.rows;
                rememberState(this.store, this.serverId, {
                    query: this.state.query, page: this.state.page, pageSize: this.state.pageSize,
                    sortKey: this.state.sortKey, sortDir: this.state.sortDir,
                    rows: this.rows.slice(), total: this.total, error: this.error
                });
                this.serverId = next;
                this.state = stateFor(this.store, next);
                this.editingId = null;
                this.confirmingId = null;
                this.actionError = null;
                this.notice = '';
                // Address books are per server: the selection made against the
                // previous one means nothing here.
                this.books = [];
                this.book = null;
                this.booksLoaded = false;
                this.loadBooks();
                return this.refresh(false);
            },

            onServerChanged(ev) {
                let id = null;
                try { id = (ev && ev.detail) ? ev.detail.id : null; } catch (x) { id = null; }
                if (typeof id !== 'string' || !clean(id)) return false;
                this.useServer(id);
                return true;
            },

            init(doc) {
                const target = doc || this.doc || root.document || null;
                const self = this;
                if (target && typeof target.addEventListener === 'function')
                    target.addEventListener(SERVER_CHANGED_EVENT, function (ev) { self.onServerChanged(ev); });
                // Deliberately not awaited: the device table must not wait on
                // the book list, and loadBooks() records its own outcome.
                this.loadBooks();
                return this.refresh(false);
            },

            startRename(row) {
                if (!row || !row.id) return false;
                this.editingId = row.id;
                this.editName = row.name;
                this.actionError = null;
                return true;
            },
            cancelRename() { this.editingId = null; this.editName = ''; return true; },

            async commitRename() {
                const id = this.editingId;
                const row = this.rows.filter((r) => r.id === id)[0];
                if (!id || !row) { this.cancelRename(); return false; }
                const v = validName(this.editName);
                if (!v.ok) { this.actionError = fail('GENERIC', v.reason); return false; }
                if (!this.hasApi() || typeof this.api.devices.rename !== 'function') {
                    this.actionError = fail('GENERIC', 'The API client cannot rename devices.');
                    return false;
                }
                this.setBusy(id, true);
                try {
                    await this.api.devices.rename(id, v.value);
                    row.name = v.value;
                    this.state.rows = this.rows.slice();
                    this.actionError = null;
                    this.notice = 'Renamed to ' + v.value + '.';
                    this.cancelRename();
                    return true;
                } catch (e) {
                    this.actionError = e;
                    return false;
                } finally {
                    this.setBusy(id, false);
                }
            },

            askDelete(row) {
                this.confirmingId = (row && row.id) ? row.id : null;
                this.actionError = null;
                return this.confirmingId;
            },
            cancelDelete() { this.confirmingId = null; return true; },

            async confirmDelete() {
                const id = this.confirmingId;
                if (!id) return false;
                if (!this.hasApi() || typeof this.api.devices.remove !== 'function') {
                    this.actionError = fail('GENERIC', 'The API client cannot delete devices.');
                    return false;
                }
                this.setBusy(id, true);
                try {
                    await this.api.devices.remove(id);
                    this.rows = this.rows.filter((r) => r.id !== id);
                    this.total = Math.max(0, this.total - 1);
                    this.state.rows = this.rows.slice();
                    this.state.total = this.total;
                    this.confirmingId = null;
                    this.actionError = null;
                    this.notice = 'Device ' + id + ' deleted.';
                    return true;
                } catch (e) {
                    this.actionError = e;
                    return false;
                } finally {
                    this.setBusy(id, false);
                }
            },

            async addToBook(row, book) {
                const id = (row && row.id) ? row.id : '';
                if (!id) return false;
                // '' is a legitimate book id (the personal book), so the guard
                // is "is anything selected", never "is the string non-empty".
                const raw = book === undefined ? this.book : book;
                const ab = typeof raw === 'string' ? clean(raw) : null;
                if (ab === null) {
                    // Caught here, before the API is ever called, so the operator
                    // never sees api-client.js's internal guard string ("a path
                    // parameter must not be empty") as if it were a real answer
                    // from the server -- the button is also disabled for the same
                    // reason (:disabled="!hasBook()"), this is the defence for
                    // anything that can still call the method directly.
                    this.actionError = fail('GENERIC',
                        'No address book is available yet to add this device to.');
                    return false;
                }
                if (!this.hasApi() || typeof this.api.devices.addToAddressBook !== 'function') {
                    this.actionError = fail('GENERIC', 'The API client cannot write to an address book.');
                    return false;
                }
                this.setBusy(id, true);
                try {
                    await this.api.devices.addToAddressBook(id, ab);
                    this.actionError = null;
                    this.notice = id + ' added to the address book.';
                    return true;
                } catch (e) {
                    this.actionError = e;
                    return false;
                } finally {
                    this.setBusy(id, false);
                }
            }
        };
    }

    // ---------------------------------------------------------- template

    const TEMPLATE = [
        '<div class="pilot-surface" x-data="pilotDevices()">',
        '  <div class="d-flex justify-content-between align-items-center mb-2">',
        '    <h2 class="h5 mb-0">Devices</h2>',
        '    <button type="button" class="btn btn-sm btn-outline-secondary" data-test="refresh"',
        '            @click="refresh(true)" :disabled="loading">Refresh</button>',
        '  </div>',
        '  <p class="small text-secondary" data-test="server">Server: <span x-text="serverId"></span></p>',
        '  <input type="search" class="form-control form-control-sm mb-2" data-test="filter"',
        '         aria-label="Filter devices" placeholder="Filter by name, ID, address or platform"',
        '         :value="state.query" @input="setQuery($event.target.value)">',
        // The address book the row actions add to. Rendered only when this
        // server really has one (spec §7.3): with none, the empty state and its
        // route to the Address Book surface take its place -- never an empty
        // <select>, and never a permanently disabled button with no way out.
        '  <div class="mb-2" data-test="book-picker" x-show="books.length > 0">',
        '    <label class="form-label form-label-sm mb-0" for="pilot-devices-book">Address book</label>',
        '    <select class="form-select form-select-sm" id="pilot-devices-book" data-test="book"',
        '            @change="selectBook($event.target.value)">',
        '      <template x-for="b in books" :key="b.guid">',
        '        <option :value="b.guid" :selected="b.guid === book" x-text="b.name"></option>',
        '      </template>',
        '    </select>',
        '  </div>',
        '  <div class="mb-2" data-test="book-empty" x-show="bookEmpty()">',
        '    <span class="text-secondary small me-2" data-test="book-empty-message"',
        '          x-text="bookEmptyState().message"></span>',
        '    <button type="button" class="btn btn-sm btn-outline-primary" data-test="book-empty-action"',
        '            @click="tab = bookEmptyState().tab" x-text="bookEmptyState().ctaLabel"></button>',
        '  </div>',
        '  <div class="alert alert-warning" data-test="error" x-show="error">',
        '    <span x-text="errorText(error)"></span>',
        '    <span class="fw-semibold ms-1" data-test="error-remediation"',
        '          x-text="errorRemediationLabel(error)"></span>',
        '    <button type="button" class="btn btn-sm btn-outline-dark ms-2" data-test="error-retry"',
        '            @click="refresh(true)">Try again</button>',
        '  </div>',
        '  <div class="alert alert-danger" data-test="action-error" x-show="actionError"',
        '       x-text="errorText(actionError)"></div>',
        '  <div class="alert alert-success py-1" data-test="notice" x-show="notice" x-text="notice"></div>',
        '  <p data-test="loading" x-show="loading">Loading devices\u2026</p>',
        '  <div data-test="empty" x-show="emptyKind() === \'no-devices\'">',
        '    <p class="mb-2">No devices have connected to this server yet.</p>',
        '    <button type="button" class="btn btn-sm btn-primary" data-test="empty-action"',
        '            @click="tab = \'setup\'">Go to Setup to add a device</button>',
        '  </div>',
        '  <div data-test="empty-filtered" x-show="emptyKind() === \'no-match\'">',
        '    <p class="mb-2">No device matches this filter.</p>',
        '    <button type="button" class="btn btn-sm btn-outline-secondary" data-test="empty-filtered-action"',
        '            @click="setQuery(\'\')">Clear the filter</button>',
        '  </div>',
        '  <p class="small text-secondary" data-test="pagination" x-show="!loading && !error && rows.length > 0">',
        '    <span x-text="rows.length"></span> of <span x-text="total"></span> device(s) shown',
        '    <span data-test="pagination-truncated" x-show="total > rows.length">',
        '      \u2014 more devices exist than are shown here; narrow the filter to find them.</span>',
        '  </p>',
        '  <table class="table table-sm align-middle" x-show="visible().length > 0">',
        '    <thead><tr>',
        '      <th scope="col"><button type="button" class="btn btn-link btn-sm p-0"',
        '          @click="setSort(\'name\')">Name</button></th>',
        '      <th scope="col">ID</th>',
        '      <th scope="col"><button type="button" class="btn btn-link btn-sm p-0"',
        '          @click="setSort(\'online\')">State</button></th>',
        '      <th scope="col">Last seen</th>',
        '      <th scope="col">Address</th>',
        '      <th scope="col">Platform</th>',
        '      <th scope="col">Version</th>',
        '      <th scope="col">Actions</th>',
        '    </tr></thead>',
        '    <tbody>',
        '      <template x-for="d in visible()" :key="d.id">',
        '        <tr data-test="row" :data-device="d.id">',
        '          <td data-test="name">',
        '            <span x-show="editingId !== d.id" x-text="d.name"></span>',
        '            <span x-show="editingId === d.id">',
        '              <input type="text" class="form-control form-control-sm" data-test="rename-input"',
        '                     aria-label="New device name" :value="editName"',
        '                     @input="editName = $event.target.value">',
        '              <button type="button" class="btn btn-sm btn-primary mt-1" data-test="rename-save"',
        '                      @click="commitRename()">Save</button>',
        '              <button type="button" class="btn btn-sm btn-link mt-1" data-test="rename-cancel"',
        '                      @click="cancelRename()">Cancel</button>',
        '            </span>',
        '          </td>',
        '          <td><code x-text="d.id"></code></td>',
        '          <td data-test="state"><span class="badge"',
        '              :class="d.online ? \'text-bg-success\' : \'text-bg-secondary\'"',
        '              x-text="d.online ? \'Online\' : \'Offline\'"></span></td>',
        '          <td data-test="last-seen" x-text="d.lastSeenText"></td>',
        '          <td data-test="ip" x-text="d.ip"></td>',
        '          <td data-test="platform" x-text="d.platform"></td>',
        '          <td data-test="version" x-text="d.version"></td>',
        '          <td>',
        '            <button type="button" class="btn btn-sm btn-outline-secondary" data-test="rename"',
        '                    @click="startRename(d)" :disabled="isBusy(d.id)">Rename</button>',
        '            <button type="button" class="btn btn-sm btn-outline-secondary" data-test="add-book"',
        '                    @click="addToBook(d)" :disabled="isBusy(d.id) || !hasBook()"',
        '                    :title="hasBook() ? \'\' : bookEmptyState().message">Add to address book</button>',
        '            <span x-show="confirmingId !== d.id">',
        '              <button type="button" class="btn btn-sm btn-outline-danger" data-test="delete"',
        '                      @click="askDelete(d)" :disabled="isBusy(d.id)">Delete</button>',
        '            </span>',
        '            <span x-show="confirmingId === d.id">',
        '              <button type="button" class="btn btn-sm btn-danger" data-test="delete-confirm"',
        '                      @click="confirmDelete()">Really delete</button>',
        '              <button type="button" class="btn btn-sm btn-link" data-test="delete-cancel"',
        '                      @click="cancelDelete()">Keep</button>',
        '            </span>',
        '          </td>',
        '        </tr>',
        '      </template>',
        '    </tbody>',
        '  </table>',
        '</div>'
    ].join('\n');

    // The host is created when the page does not already provide one, so this
    // surface never depends on markup another task owns.
    function mount(doc) {
        if (!doc || typeof doc.getElementById !== 'function') return false;
        let host = doc.getElementById(MOUNT_ID);
        if (!host) {
            if (typeof doc.createElement !== 'function' || !doc.body ||
                typeof doc.body.appendChild !== 'function') return false;
            host = doc.createElement('div');
            host.id = MOUNT_ID;
            doc.body.appendChild(host);
        }
        if (typeof host.getAttribute === 'function' && host.getAttribute('data-pilot-mounted'))
            return false;
        host.innerHTML = TEMPLATE;
        if (typeof host.setAttribute === 'function') host.setAttribute('data-pilot-mounted', '1');
        return true;
    }

    if (root.document && typeof root.document.addEventListener === 'function')
        root.document.addEventListener('alpine:init', function () { mount(root.document); });

    root.pilotDevices = pilotDevices;

    const PilotDevicesUi = {
        MOUNT_ID, SERVER_CHANGED_EVENT, TEMPLATE, DASH, MAX_NAME, SORT_KEYS,
        toMillis, relativeTime, normalizeList, deviceRow, deviceRows,
        filterRows, sortRows, validName,
        newStore, newSurfaceState, stateFor, rememberState,
        serverChangedDetail, emitServerChanged, errorMessage,
        pilotDevices, mount
    };
    root.PilotDevicesUi = PilotDevicesUi;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotDevicesUi;
})(typeof window !== 'undefined' ? window : globalThis);
