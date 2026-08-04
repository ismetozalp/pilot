// features/users-ui.js — Users & groups: accounts, group membership,
// enable/disable, password reset.
//
// Every request goes through the C12 PilotApi.users façade. This file builds no
// URL, names no operation and never touches the bridge directly. It loads and
// fails independently of every other surface: a failure is a named reason
// inside this panel, never a global banner. It also listens for
// 'pilot:server-changed' (js/app.js's notifyServerChanged()) so switching the
// active server refreshes the account list instead of quietly showing stale
// accounts from the previous server.
'use strict';
(function (root) {
    const SERVER_CHANGED_EVENT = 'pilot:server-changed';

    function view() {
        const v = root.PilotConsoleView;
        if (!v) throw new Error('js/core/console-view.js must load before js/features/users-ui.js');
        return v;
    }
    function usersApi() {
        return (root.PilotApi && root.PilotApi.users) ? root.PilotApi.users : null;
    }

    const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    const MIN_PASSWORD = 8;
    const MAX_PASSWORD = 128;
    const MAX_EMAIL = 254;
    const MAX_KEYWORD = 64;

    function blankForm() { return { name: '', email: '', password: '', confirm: '', groupId: '' }; }

    function passwordProblem(pw) {
        if (typeof pw !== 'string' || pw === '') return 'Password is required.';
        if (view().hasControl(pw)) return 'Password must not contain control characters.';
        if (pw.trim() === '') return 'Password must not be only whitespace.';
        if (pw.length < MIN_PASSWORD) return 'Password must be at least ' + MIN_PASSWORD + ' characters.';
        if (pw.length > MAX_PASSWORD) return 'Password must be at most ' + MAX_PASSWORD + ' characters.';
        return '';
    }

    // Validation runs on the RAW field, before any scrubbing: a username with an
    // embedded newline is refused, not silently cleaned into something else.
    function validateNewUser(form) {
        const V = view();
        const f = (form && typeof form === 'object' && !Array.isArray(form)) ? form : {};
        const problems = {};

        const name = typeof f.name === 'string' ? f.name : '';
        if (name === '') problems.name = 'Username is required.';
        else if (V.hasControl(name)) problems.name = 'Username must not contain control characters.';
        else if (name !== name.trim()) problems.name = 'Username must not start or end with a space.';
        else if (name.indexOf('..') !== -1) problems.name = 'Username must not contain "..".';
        else if (!NAME_RE.test(name))
            problems.name = 'Username may use letters, digits and . _ @ + - only, up to 64 characters.';

        const email = typeof f.email === 'string' ? f.email : '';
        if (email !== '') {
            if (V.hasControl(email)) problems.email = 'Email must not contain control characters.';
            else if (email.length > MAX_EMAIL) problems.email = 'Email is too long.';
            else if (!EMAIL_RE.test(email)) problems.email = 'Email address is not valid.';
        }

        const pw = typeof f.password === 'string' ? f.password : '';
        const p = passwordProblem(pw);
        if (p) problems.password = p;
        else if (typeof f.confirm !== 'string') problems.confirm = 'Please confirm the password.';
        else if (f.confirm !== pw) problems.confirm = 'Passwords do not match.';

        return { ok: Object.keys(problems).length === 0, problems: problems };
    }

    function normalizeGroup(row) {
        const V = view();
        const r = (row && typeof row === 'object') ? row : {};
        return {
            id: V.idOf(r, ['id', 'group_id', 'groupId', 'uuid']),
            name: V.text(V.first(r, ['name', 'group_name', 'groupName'])) || '(unnamed)',
            note: V.text(V.first(r, ['info', 'note', 'remark'])),
            deviceCount: V.count(V.first(r, ['device_count', 'deviceCount', 'accessible_count']))
        };
    }

    function normalizeGroups(payload) {
        return view().page(payload).list.map(normalizeGroup).filter(function (g) { return g.id !== ''; });
    }

    function groupLabel(groups, id) {
        const gid = view().text(id);
        if (gid === '') return 'Unassigned';
        if (Array.isArray(groups)) for (const g of groups) if (g && g.id === gid) return g.name;
        return 'Group ' + gid;
    }

    // The server spells "usable" several ways depending on endpoint. An absent
    // flag reads as enabled: the account exists, and the toggle shows the
    // server's truth after the next write.
    function enabledOf(row) {
        if (row.enabled === true || row.enabled === false) return row.enabled;
        if (row.is_enabled === true || row.is_enabled === false) return row.is_enabled;
        const s = row.status;
        if (typeof s === 'number') return s === 1;
        if (typeof s === 'string') {
            const t = s.trim().toLowerCase();
            if (t === '1' || t === 'true' || t === 'enabled' || t === 'active') return true;
            if (t === '0' || t === 'false' || t === 'disabled' || t === 'inactive') return false;
        }
        return true;
    }

    function normalizeUser(row, groups) {
        const V = view();
        const r = (row && typeof row === 'object') ? row : {};
        const gid = V.text(V.first(r, ['group_id', 'groupId', 'gid']));
        const enabled = enabledOf(r);
        return {
            id: V.idOf(r, ['id', 'user_id', 'uuid']),
            name: V.text(V.first(r, ['name', 'username', 'user_name'])),
            email: V.text(r.email),
            groupId: gid,
            groupName: groupLabel(groups, gid),
            isAdmin: r.is_admin === true || r.is_admin === 1 || V.text(r.role).toLowerCase() === 'admin',
            enabled: enabled,
            statusLabel: enabled ? 'Enabled' : 'Disabled',
            busy: ''
        };
    }

    function rowsFrom(payload, groups) {
        const p = view().page(payload);
        const rows = p.list.map(function (r) { return normalizeUser(r, groups); })
            .filter(function (u) { return u.id !== '' || u.name !== ''; });
        return { rows: rows, total: p.total, page: p.page, pageSize: p.pageSize };
    }

    function listQuery(filters) {
        const V = view();
        const f = (filters && typeof filters === 'object') ? filters : {};
        const q = { page: V.clampInt(f.page, 1, 100000, 1), page_size: V.clampInt(f.pageSize, 1, 200, 50) };
        const kw = V.text(f.keyword);
        if (kw !== '') q.keyword = kw.slice(0, MAX_KEYWORD);
        return q;
    }

    function settled(p) {
        return Promise.resolve(p).then(
            function (v) { return { ok: true, value: v }; },
            function (e) { return { ok: false, error: e }; });
    }

    function pilotUsersUi() {
        return {
            loading: false, alert: null, rows: [], groups: [], total: 0,
            keyword: '', pw: {}, form: blankForm(), formProblems: {}, creating: false, seq: 0,

            init: function (doc) {
                const target = doc || root.document || null;
                const self = this;
                if (target && typeof target.addEventListener === 'function') {
                    target.addEventListener(SERVER_CHANGED_EVENT, function (ev) { self.onServerChanged(ev); });
                }
                return this.refresh();
            },

            // Any well-formed event is enough to refresh: the account list has
            // no per-server client-side cache to re-key (unlike Devices), so
            // there is nothing to gain from inspecting ev.detail.id beyond
            // confirming this really is the event we asked for.
            onServerChanged: function (ev) {
                if (!ev || typeof ev !== 'object') return false;
                this.refresh();
                return true;
            },

            fail: function (kind, message, context) {
                this.alert = view().errorView({ kind: kind, message: message }, context);
                return false;
            },

            // Groups and accounts are fetched independently so a groups failure
            // downgrades to a warning instead of blanking the table.
            refresh: function () {
                const self = this;
                const V = view();
                const api = usersApi();
                self.alert = null;
                if (!api) return Promise.resolve(self.fail('API_UNREACHABLE',
                    'The API client is not available yet.', 'Users'));
                const token = ++self.seq;
                self.loading = true;
                const q = listQuery({ keyword: self.keyword });
                return Promise.all([settled(api.groups()), settled(api.list(q))]).then(function (res) {
                    if (token !== self.seq) return false;
                    self.loading = false;
                    const gs = res[0].ok ? normalizeGroups(res[0].value) : [];
                    self.groups = gs;
                    if (!res[1].ok) {
                        self.rows = []; self.total = 0;
                        self.alert = V.errorView(res[1].error, 'Users');
                        return false;
                    }
                    const parsed = rowsFrom(res[1].value, gs);
                    self.rows = parsed.rows;
                    self.total = parsed.total;
                    self.alert = res[0].ok ? null : V.errorView(res[0].error, 'Groups');
                    return true;
                });
            },

            act: function (row, label, fn) {
                const self = this;
                const V = view();
                const api = usersApi();
                if (!api) return Promise.resolve(self.fail('API_UNREACHABLE',
                    'The API client is not available yet.', 'Users'));
                if (!row || !row.id) return Promise.resolve(self.fail('GENERIC',
                    'This account has no id, so it cannot be changed.', 'Users'));
                self.alert = null;
                row.busy = label;
                return Promise.resolve().then(function () { return fn(api); })
                    .then(function () {
                        row.busy = '';
                        return self.refresh().then(function () { return true; });
                    })
                    .catch(function (e) {
                        row.busy = '';
                        self.alert = V.errorView(e, 'Users');
                        return false;
                    });
            },

            toggle: function (row) {
                const want = !(row && row.enabled);
                return this.act(row, want ? 'Enabling…' : 'Disabling…',
                    function (api) { return api.setEnabled(row.id, want); });
            },

            assignGroup: function (row, groupId) {
                const gid = view().text(groupId);
                if (!row || gid === row.groupId) return Promise.resolve(false);
                return this.act(row, 'Moving…', function (api) { return api.setGroup(row.id, gid); });
            },

            resetPassword: function (row) {
                const self = this;
                const id = (row && row.id) ? row.id : '';
                const pw = (id && typeof self.pw[id] === 'string') ? self.pw[id] : '';
                const problem = passwordProblem(pw);
                if (problem) return Promise.resolve(self.fail('GENERIC', problem, 'Users'));
                return self.act(row, 'Resetting password…',
                    function (api) { return api.resetPassword(id, pw); })
                    .then(function (okv) { if (okv) self.pw[id] = ''; return okv; });
            },

            create: function () {
                const self = this;
                const V = view();
                const v = validateNewUser(self.form);
                self.formProblems = v.problems;
                if (!v.ok) return Promise.resolve(false);
                const api = usersApi();
                if (!api) return Promise.resolve(self.fail('API_UNREACHABLE',
                    'The API client is not available yet.', 'Create account'));
                self.alert = null;
                self.creating = true;
                const payload = { name: self.form.name, email: self.form.email, password: self.form.password };
                const gid = V.text(self.form.groupId);
                if (gid !== '') payload.group_id = gid;
                return Promise.resolve().then(function () { return api.create(payload); })
                    .then(function () {
                        self.creating = false;
                        self.form = blankForm();
                        self.formProblems = {};
                        return self.refresh().then(function () { return true; });
                    })
                    .catch(function (e) {
                        self.creating = false;
                        self.alert = V.errorView(e, 'Create account');
                        return false;
                    });
            },

            // Distinct from "no accounts have ever been created": a search
            // narrowed the (server-side, via listQuery's keyword) result to
            // zero. Clearing it and reloading is a different recovery from
            // "go create one".
            clearSearch: function () {
                this.keyword = '';
                return this.refresh();
            }
        };
    }

    const TEMPLATE = [
        '<div x-data="pilotUsersUi()" x-init="init()" data-testid="users-root">',
        '  <div class="d-flex align-items-center gap-2 mb-3">',
        '    <h5 class="mb-0 flex-grow-1">Users &amp; groups</h5>',
        '    <input type="search" class="form-control form-control-sm w-auto" x-model="keyword"',
        '           placeholder="Search accounts" aria-label="Search accounts" data-testid="users-search">',
        '    <button type="button" class="btn btn-sm btn-outline-secondary" @click="refresh()"',
        '            :disabled="loading" data-testid="users-refresh">Refresh</button>',
        '  </div>',
        '  <template x-if="alert">',
        '    <div class="alert alert-danger" role="alert" data-testid="users-alert">',
        '      <strong x-text="alert.context"></strong><div x-text="alert.message"></div>',
        '      <div class="small text-secondary" x-text="alert.kind"></div>',
        '      <pre class="small mb-0" x-show="alert.detail" x-text="alert.detail"></pre>',
        '      <button type="button" class="btn btn-sm btn-primary mt-2" x-show="alert.actionLabel"',
        '              @click="refresh()" x-text="alert.actionLabel" data-testid="users-alert-action"></button>',
        '    </div>',
        '  </template>',
        '  <div x-show="loading" role="status" class="small text-secondary" data-testid="users-loading">Loading…</div>',
        '  <div x-show="!loading &amp;&amp; rows.length === 0 &amp;&amp; !alert &amp;&amp; !keyword.trim()"',
        '       class="text-secondary" data-testid="users-empty">',
        '    <p class="mb-2">No accounts yet.</p>',
        '    <button type="button" class="btn btn-sm btn-primary" data-testid="users-empty-action"',
        '            @click="$refs.newName &amp;&amp; $refs.newName.focus()">Create the first account</button>',
        '  </div>',
        '  <div x-show="!loading &amp;&amp; rows.length === 0 &amp;&amp; !alert &amp;&amp; !!keyword.trim()"',
        '       class="text-secondary" data-testid="users-empty-filtered">',
        '    <p class="mb-2">No accounts match your search.</p>',
        '    <button type="button" class="btn btn-sm btn-outline-secondary" @click="clearSearch()"',
        '            data-testid="users-empty-filtered-action">Clear search</button>',
        '  </div>',
        '  <table class="table table-sm align-middle" x-show="rows.length">',
        '    <thead><tr><th scope="col">Account</th><th scope="col">Email</th><th scope="col">Group</th>',
        '      <th scope="col">Status</th><th scope="col">Actions</th></tr></thead>',
        '    <tbody><template x-for="row in rows" :key="row.id">',
        '      <tr data-testid="users-row" :data-user-id="row.id">',
        '        <td><span x-text="row.name"></span>',
        '          <span class="badge text-bg-secondary ms-1" x-show="row.isAdmin">admin</span></td>',
        '        <td x-text="row.email"></td>',
        '        <td><select class="form-select form-select-sm" data-testid="users-group"',
        '                    :aria-label="\'Group for \' + row.name"',
        '                    @change="assignGroup(row, $event.target.value)">',
        '            <option value="" :selected="row.groupId === \'\'">Unassigned</option>',
        '            <template x-for="g in groups" :key="g.id">',
        '              <option :value="g.id" :selected="g.id === row.groupId" :title="g.note"',
        '                      x-text="g.name + (g.deviceCount === null ? \'\' : \' (\' + g.deviceCount + \' devices)\')">',
        '              </option>',
        '            </template>',
        '            <!-- A row can be assigned to a group id the groups fetch never',
        '                 returned (still loading, or Groups failed independently, see',
        '                 the errorView(...,\'Groups\') alert above) -- without this,',
        '                 a native <select> silently falls back to its first <option>',
        '                 ("Unassigned"), misreporting an assigned account as free. -->',
        '            <template x-if="row.groupId !== \'\' &amp;&amp; !groups.some((g) => g.id === row.groupId)">',
        '              <option :value="row.groupId" selected x-text="row.groupName"',
        '                      data-testid="users-group-unresolved"></option>',
        '            </template></select></td>',
        '        <td><span data-testid="users-status" x-text="row.statusLabel"></span></td>',
        '        <td><div class="d-flex gap-1 align-items-center">',
        '          <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="!!row.busy"',
        '                  @click="toggle(row)" data-testid="users-toggle"',
        '                  :aria-label="(row.enabled ? \'Disable \' : \'Enable \') + row.name"',
        '                  x-text="row.enabled ? \'Disable\' : \'Enable\'"></button>',
        '          <input type="password" class="form-control form-control-sm" style="max-width:12rem"',
        '                 autocomplete="new-password" data-testid="users-password"',
        '                 :aria-label="\'New password for \' + row.name" x-model="pw[row.id]">',
        '          <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="!!row.busy"',
        '                  @click="resetPassword(row)" data-testid="users-reset"',
        '                  :aria-label="\'Reset password for \' + row.name">Reset</button>',
        '          <span class="small text-secondary" x-show="row.busy" x-text="row.busy"></span>',
        '        </div></td>',
        '      </tr>',
        '    </template></tbody>',
        '  </table>',
        '  <p class="small text-secondary" x-show="rows.length"><span x-text="rows.length"></span>',
        '     of <span x-text="total" data-testid="users-total"></span> account(s)</p>',
        '  <form class="row g-2 align-items-end" @submit.prevent="create()" data-testid="users-create">',
        '    <div class="col-auto"><label class="form-label small" for="pilot-new-user">New account</label>',
        '      <input id="pilot-new-user" class="form-control form-control-sm" x-model="form.name"',
        '             x-ref="newName" data-testid="users-new-name"></div>',
        '    <div class="col-auto"><label class="form-label small" for="pilot-new-email">Email</label>',
        '      <input id="pilot-new-email" type="email" class="form-control form-control-sm"',
        '             x-model="form.email" data-testid="users-new-email"></div>',
        '    <div class="col-auto"><label class="form-label small" for="pilot-new-pw">Password</label>',
        '      <input id="pilot-new-pw" type="password" class="form-control form-control-sm"',
        '             autocomplete="new-password" x-model="form.password" data-testid="users-new-password"></div>',
        '    <div class="col-auto"><label class="form-label small" for="pilot-new-pw2">Confirm</label>',
        '      <input id="pilot-new-pw2" type="password" class="form-control form-control-sm"',
        '             autocomplete="new-password" x-model="form.confirm" data-testid="users-new-confirm"></div>',
        '    <div class="col-auto"><button type="submit" class="btn btn-sm btn-primary" :disabled="creating"',
        '            data-testid="users-create-submit">Create</button></div>',
        '    <div class="col-12"><ul class="small text-danger mb-0" data-testid="users-form-problems"',
        '         x-show="Object.keys(formProblems).length">',
        '      <template x-for="p in Object.values(formProblems)" :key="p"><li x-text="p"></li></template>',
        '    </ul></div>',
        '  </form>',
        '</div>'
    ].join('\n');

    function mount(doc) { return view().mountInto(doc || null, 'pilot-users', TEMPLATE); }

    if (root.document && typeof root.document.addEventListener === 'function')
        root.document.addEventListener('alpine:init', function () { mount(root.document); });

    root.pilotUsersUi = pilotUsersUi;

    const PilotUsersUi = {
        TEMPLATE, MIN_PASSWORD, MAX_PASSWORD,
        blankForm, passwordProblem, validateNewUser,
        normalizeGroup, normalizeGroups, groupLabel, normalizeUser, rowsFrom, listQuery,
        mount, pilotUsersUi
    };
    root.PilotUsersUi = PilotUsersUi;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotUsersUi;
})(typeof window !== 'undefined' ? window : globalThis);
