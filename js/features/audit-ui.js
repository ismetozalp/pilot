// features/audit-ui.js — Audit: connection, file-transfer and login logs,
// filterable by user, device and date.
//
// Reads through the C12 PilotApi.audit façade only. It builds no URL, names no
// operation and never touches the bridge. It loads and fails independently of
// the other surfaces: an audit failure is a named reason inside this panel,
// and Users, Devices and the Address Book keep working. It also listens for
// 'pilot:server-changed' (js/app.js's notifyServerChanged()) so switching the
// active server refreshes the log instead of quietly showing stale rows from
// the previous server — the same wiring js/features/users-ui.js uses, and for
// the same reason: a surface can mount before wireApi()'s async chain installs
// the transport, so the listener is load-bearing at cold boot too, not merely
// when the user later switches servers.
'use strict';
(function (root) {
    const SERVER_CHANGED_EVENT = 'pilot:server-changed';

    function view() {
        const v = root.PilotConsoleView;
        if (!v) throw new Error('js/core/console-view.js must load before js/features/audit-ui.js');
        return v;
    }
    function auditApi() {
        return (root.PilotApi && root.PilotApi.audit) ? root.PilotApi.audit : null;
    }

    const DASH = '—';
    const KINDS = ['conn', 'file', 'login'];
    const TABS = [
        { id: 'conn', label: 'Connections' },
        { id: 'file', label: 'File transfers' },
        { id: 'login', label: 'Logins' }
    ];
    const CONTROL_ONE = /[\x00-\x1f\x7f]/;
    const DIGITS_RE = /^[0-9]+$/;
    const DAY_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
    const MIN_MS = Date.UTC(2000, 0, 1);
    const MAX_MS = Date.UTC(2100, 0, 1);
    const MAX_FILTER = 64;

    function fail(kind, message) {
        const E = root.PilotErrors;
        if (E && typeof E.create === 'function') return E.create(kind, message, null);
        const e = new Error(message);
        e.kind = kind;
        return e;
    }

    function assertKind(kind) {
        if (KINDS.indexOf(kind) === -1)
            throw fail('GENERIC', 'Unknown audit log: ' + view().text(kind));
        return kind;
    }

    // Below 1e11 a positive number is unix seconds; at or above it, milliseconds.
    function scale(n) {
        if (!(n > 0)) return null;
        return n < 1e11 ? n * 1000 : n;
    }

    // Control characters are rejected on the RAW value, before any trimming, so a
    // timestamp carrying an embedded newline is refused rather than quietly
    // accepted after the newline is stripped.
    function parseWhen(value) {
        let ms = null;
        if (typeof value === 'number') {
            if (!isFinite(value)) return null;
            ms = scale(value);
        } else if (typeof value === 'string') {
            if (value === '' || CONTROL_ONE.test(value)) return null;
            const s = value.trim();
            if (s === '') return null;
            if (DIGITS_RE.test(s)) {
                if (s.length > 15) return null;
                ms = scale(Number(s));
            } else {
                const t = Date.parse(s);
                ms = isFinite(t) ? t : null;
            }
        } else return null;
        if (ms === null || !isFinite(ms)) return null;
        ms = Math.floor(ms);
        return (ms < MIN_MS || ms >= MAX_MS) ? null : ms;
    }

    function pad(n, w) {
        let s = String(n);
        while (s.length < w) s = '0' + s;
        return s;
    }

    function formatWhen(ms) {
        if (typeof ms !== 'number' || !isFinite(ms)) return DASH;
        const d = new Date(ms);
        if (isNaN(d.getTime())) return DASH;
        return pad(d.getUTCFullYear(), 4) + '-' + pad(d.getUTCMonth() + 1, 2) + '-' + pad(d.getUTCDate(), 2) +
            ' ' + pad(d.getUTCHours(), 2) + ':' + pad(d.getUTCMinutes(), 2) + ':' + pad(d.getUTCSeconds(), 2) + 'Z';
    }

    function parseDay(value, endOfDay) {
        if (typeof value !== 'string' || CONTROL_ONE.test(value)) return null;
        const m = DAY_RE.exec(value.trim());
        if (!m) return null;
        const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
        if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
        const ms = endOfDay ? Date.UTC(y, mo - 1, d, 23, 59, 59) : Date.UTC(y, mo - 1, d, 0, 0, 0);
        const back = new Date(ms);
        if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
        return (ms < MIN_MS || ms >= MAX_MS) ? null : ms;
    }

    function rangeProblem(from, to) {
        const f = typeof from === 'string' ? from.trim() : '';
        const t = typeof to === 'string' ? to.trim() : '';
        const fMs = f === '' ? null : parseDay(from, false);
        if (f !== '' && fMs === null) return 'From date must be a real day, written YYYY-MM-DD.';
        const tMs = t === '' ? null : parseDay(to, true);
        if (t !== '' && tMs === null) return 'To date must be a real day, written YYYY-MM-DD.';
        if (fMs !== null && tMs !== null && fMs > tMs) return 'The from date is after the to date.';
        return '';
    }

    // The filter document handed to PilotApi.audit.<kind>(q). from/to are epoch
    // seconds, matching the timestamps the log records carry.
    function auditQuery(kind, filters) {
        assertKind(kind);
        const V = view();
        const f = (filters && typeof filters === 'object') ? filters : {};
        const q = { page: V.clampInt(f.page, 1, 100000, 1), page_size: V.clampInt(f.pageSize, 1, 200, 50) };
        const user = V.text(f.user).slice(0, MAX_FILTER);
        const device = V.text(f.device).slice(0, MAX_FILTER);
        if (user !== '') q.user = user;
        if (device !== '') q.device = device;
        const from = parseDay(f.from, false);
        const to = parseDay(f.to, true);
        if (from !== null) q.from = Math.floor(from / 1000);
        if (to !== null) q.to = Math.floor(to / 1000);
        return q;
    }

    const ACTION_KEYS = {
        conn: ['type', 'conn_type', 'action'],
        file: ['type', 'action', 'operation'],
        login: ['type', 'action', 'status', 'result']
    };
    // 'id' is deliberately NOT a fallback here: the record's own row id is not
    // the device, and treating it as one would render a device value for a
    // row that plainly has none (e.g. { id: 'c9' } with no from_peer/device_id
    // must still render the DASH placeholder, not 'c9').
    const DEVICE_KEYS = {
        conn: ['from_peer', 'device', 'device_id', 'peer_id'],
        file: ['from_peer', 'device', 'device_id', 'peer_id'],
        login: ['device_id', 'device', 'uuid', 'from_peer']
    };
    const PEER_KEYS = {
        conn: ['to_peer', 'peer', 'peer_id', 'remote_id'],
        file: ['to_peer', 'peer', 'peer_id', 'remote_id'],
        login: ['peer', 'peer_id', 'remote_id']
    };
    const NOTE_KEYS = ['note', 'info', 'remark', 'path', 'filename', 'file_name'];
    const TIME_KEYS = ['created_at', 'time', 'timestamp', 'datetime', 'ts'];

    function normalizeRow(kind, row) {
        assertKind(kind);
        const V = view();
        const r = (row && typeof row === 'object') ? row : {};
        const whenMs = parseWhen(V.first(r, TIME_KEYS));
        const device = V.text(V.first(r, DEVICE_KEYS[kind]));
        const peer = V.text(V.first(r, PEER_KEYS[kind]));
        const id = V.idOf(r, ['id', 'uuid', 'log_id']) ||
            (kind + ':' + (whenMs === null ? '0' : String(whenMs)) + ':' + device + ':' + peer);
        return {
            id: id,
            kind: kind,
            whenMs: whenMs,
            when: formatWhen(whenMs),
            user: V.text(V.first(r, ['user', 'username', 'user_name', 'from_name'])) || DASH,
            device: device || DASH,
            peer: peer || DASH,
            action: V.text(V.first(r, ACTION_KEYS[kind])) || DASH,
            ip: V.text(V.first(r, ['ip', 'remote_ip', 'client_ip'])) || DASH,
            note: V.text(V.first(r, NOTE_KEYS))
        };
    }

    // Alpine keys must be unique even when the server sends no id and two records
    // are otherwise identical, so a repeat gets its index appended.
    function rowsFrom(kind, payload) {
        assertKind(kind);
        const p = view().page(payload);
        const seen = Object.create(null);
        const rows = p.list.map(function (r, i) {
            const row = normalizeRow(kind, r);
            if (seen[row.id]) row.id = row.id + '#' + i;
            seen[row.id] = true;
            return row;
        });
        return { rows: rows, total: p.total, page: p.page, pageSize: p.pageSize };
    }

    function pilotAuditUi() {
        return {
            TABS: TABS,
            tab: 'conn', loading: false, alert: null, problem: '',
            rows: [], total: 0, seq: 0,
            filters: { user: '', device: '', from: '', to: '' },

            init: function (doc) {
                const target = doc || root.document || null;
                const self = this;
                if (target && typeof target.addEventListener === 'function') {
                    target.addEventListener(SERVER_CHANGED_EVENT, function (ev) { self.onServerChanged(ev); });
                }
                return this.refresh();
            },

            // Any well-formed event is enough to refresh: like Users & groups, the
            // audit log has no per-server client-side cache to re-key (unlike
            // Devices), so there is nothing to gain from inspecting ev.detail.id
            // beyond confirming this really is the event we asked for.
            onServerChanged: function (ev) {
                if (!ev || typeof ev !== 'object') return false;
                this.refresh();
                return true;
            },

            fail: function (kind, message) {
                this.alert = view().errorView({ kind: kind, message: message }, 'Audit');
                return false;
            },

            select: function (kind) {
                if (KINDS.indexOf(kind) === -1)
                    return Promise.resolve(this.fail('GENERIC', 'Unknown audit log.'));
                this.tab = kind;
                return this.refresh();
            },

            refresh: function () {
                const self = this;
                const V = view();
                self.alert = null;
                self.problem = rangeProblem(self.filters.from, self.filters.to);
                if (self.problem) return Promise.resolve(false);
                const api = auditApi();
                if (!api) return Promise.resolve(self.fail('API_UNREACHABLE',
                    'The API client is not available yet.'));
                const kind = self.tab;
                if (typeof api[kind] !== 'function')
                    return Promise.resolve(self.fail('API_VERSION_MISMATCH',
                        'This API server does not serve the ' + kind + ' log.'));
                let q;
                try { q = auditQuery(kind, self.filters); }
                catch (e) { self.alert = V.errorView(e, 'Audit'); return Promise.resolve(false); }
                const token = ++self.seq;
                self.loading = true;
                return Promise.resolve().then(function () { return api[kind](q); })
                    .then(function (payload) {
                        if (token !== self.seq) return false;
                        self.loading = false;
                        const parsed = rowsFrom(kind, payload);
                        self.rows = parsed.rows;
                        self.total = parsed.total;
                        return true;
                    })
                    .catch(function (e) {
                        if (token !== self.seq) return false;
                        self.loading = false;
                        self.rows = [];
                        self.total = 0;
                        self.alert = V.errorView(e, 'Audit');
                        return false;
                    });
            },

            // Distinct from "nothing has ever been logged": a filter narrowed the
            // (server-side) result to zero. Clearing the filters and reloading is a
            // different recovery from "there is nothing configured yet" (spec §7.3).
            clearFilters: function () {
                this.filters = { user: '', device: '', from: '', to: '' };
                return this.refresh();
            }
        };
    }

    const TEMPLATE = [
        '<div x-data="pilotAuditUi()" x-init="init()" data-testid="audit-root">',
        '  <div class="d-flex align-items-center gap-2 mb-3">',
        '    <h5 class="mb-0 flex-grow-1">Audit</h5>',
        '    <div class="btn-group btn-group-sm" role="group" aria-label="Audit log">',
        '      <template x-for="t in TABS" :key="t.id">',
        '        <button type="button" class="btn" @click="select(t.id)" x-text="t.label"',
        '                :class="tab === t.id ? \'btn-primary\' : \'btn-outline-secondary\'"',
        '                :aria-pressed="tab === t.id ? \'true\' : \'false\'"',
        '                :data-testid="\'audit-tab-\' + t.id"></button>',
        '      </template>',
        '    </div>',
        '  </div>',
        '  <form class="row g-2 align-items-end mb-3" @submit.prevent="refresh()">',
        '    <div class="col-auto"><label class="form-label small" for="pilot-audit-user">User</label>',
        '      <input id="pilot-audit-user" class="form-control form-control-sm" x-model="filters.user"',
        '             data-testid="audit-user"></div>',
        '    <div class="col-auto"><label class="form-label small" for="pilot-audit-device">Device</label>',
        '      <input id="pilot-audit-device" class="form-control form-control-sm" x-model="filters.device"',
        '             data-testid="audit-device"></div>',
        '    <div class="col-auto"><label class="form-label small" for="pilot-audit-from">From (UTC)</label>',
        '      <input id="pilot-audit-from" class="form-control form-control-sm" placeholder="YYYY-MM-DD"',
        '             x-model="filters.from" data-testid="audit-from"></div>',
        '    <div class="col-auto"><label class="form-label small" for="pilot-audit-to">To (UTC)</label>',
        '      <input id="pilot-audit-to" class="form-control form-control-sm" placeholder="YYYY-MM-DD"',
        '             x-model="filters.to" data-testid="audit-to"></div>',
        '    <div class="col-auto"><button type="submit" class="btn btn-sm btn-outline-secondary"',
        '            :disabled="loading" data-testid="audit-refresh">Apply</button></div>',
        '  </form>',
        '  <div class="alert alert-warning" role="alert" x-show="problem" x-text="problem"',
        '       data-testid="audit-problem"></div>',
        '  <template x-if="alert">',
        '    <div class="alert alert-danger" role="alert" data-testid="audit-alert">',
        '      <strong x-text="alert.context"></strong><div x-text="alert.message"></div>',
        '      <div class="small text-secondary" x-text="alert.kind"></div>',
        '      <button type="button" class="btn btn-sm btn-primary mt-2" x-show="alert.actionLabel"',
        '              @click="refresh()" x-text="alert.actionLabel" data-testid="audit-alert-action"></button>',
        '    </div>',
        '  </template>',
        '  <div x-show="loading" role="status" class="small text-secondary" data-testid="audit-loading">Loading…</div>',
        '  <div x-show="!loading &amp;&amp; rows.length === 0 &amp;&amp; !alert &amp;&amp; !problem &amp;&amp;',
        '              !filters.user.trim() &amp;&amp; !filters.device.trim() &amp;&amp; !filters.from &amp;&amp; !filters.to"',
        '       class="text-secondary" data-testid="audit-empty">',
        '    <p class="mb-2">Nothing logged here yet. Records appear once devices connect,',
        '       transfer files, or accounts sign in.</p>',
        '    <button type="button" class="btn btn-sm btn-primary" @click="refresh()"',
        '            data-testid="audit-empty-action">Check again</button>',
        '  </div>',
        '  <div x-show="!loading &amp;&amp; rows.length === 0 &amp;&amp; !alert &amp;&amp; !problem &amp;&amp;',
        '              (!!filters.user.trim() || !!filters.device.trim() || !!filters.from || !!filters.to)"',
        '       class="text-secondary" data-testid="audit-empty-filtered">',
        '    <p class="mb-2">No records match this filter.</p>',
        '    <button type="button" class="btn btn-sm btn-outline-secondary" @click="clearFilters()"',
        '            data-testid="audit-empty-filtered-action">Clear filters</button>',
        '  </div>',
        '  <table class="table table-sm" x-show="rows.length">',
        '    <thead><tr><th scope="col">When (UTC)</th><th scope="col">User</th><th scope="col">Device</th>',
        '      <th scope="col">Peer</th><th scope="col">Action</th><th scope="col">IP</th>',
        '      <th scope="col">Detail</th></tr></thead>',
        '    <tbody><template x-for="row in rows" :key="row.id">',
        '      <tr data-testid="audit-row">',
        '        <td data-testid="audit-when" x-text="row.when"></td>',
        '        <td x-text="row.user"></td><td x-text="row.device"></td><td x-text="row.peer"></td>',
        '        <td x-text="row.action"></td><td x-text="row.ip"></td><td x-text="row.note"></td>',
        '      </tr>',
        '    </template></tbody>',
        '  </table>',
        '  <p class="small text-secondary" x-show="rows.length"><span x-text="rows.length"></span>',
        '     of <span x-text="total" data-testid="audit-total"></span> record(s)</p>',
        '</div>'
    ].join('\n');

    function mount(doc) { return view().mountInto(doc || null, 'pilot-audit', TEMPLATE); }

    if (root.document && typeof root.document.addEventListener === 'function')
        root.document.addEventListener('alpine:init', function () { mount(root.document); });

    root.pilotAuditUi = pilotAuditUi;

    const PilotAuditUi = {
        TEMPLATE, KINDS, TABS, DASH,
        parseWhen, formatWhen, parseDay, rangeProblem, auditQuery, normalizeRow, rowsFrom,
        mount, pilotAuditUi
    };
    root.PilotAuditUi = PilotAuditUi;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotAuditUi;
})(typeof window !== 'undefined' ? window : globalThis);
