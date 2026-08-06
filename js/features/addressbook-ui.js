// features/addressbook-ui.js — the Address Book surface: personal and shared
// books, tag CRUD, bulk tag assignment, CSV import/export.
//
// This file talks to exactly one thing: the PilotApi.addressbook facade (C12). It
// builds no URL, knows no port, and never mentions cockpit — api-client.js owns
// request building and api-io.js owns the transport.
//
// Every data source has its own error slot, because the spec requires each
// surface, and each part of a surface, to fail independently: a tags endpoint
// that 500s must not blank the peer table.
'use strict';
(function (root) {
    const req = (typeof require !== 'undefined' && typeof module !== 'undefined' && module.exports)
        ? require : null;
    const Errors = root.PilotErrors || (req ? req('../core/errors.js') : null);
    const AB = root.PilotAddressBook || (req ? req('../core/addressbook.js') : null);
    // GAP D (task 33): the Tags empty state (below) is EmptyState.forKind('tag')'s
    // one and only consumer anywhere in the repo before this fix.
    const EmptyState = root.PilotEmptyState || (req ? req('../core/emptystate.js') : null);

    // api-client.js loads before this file in the browser (C7). Resolving it
    // lazily keeps the unit tests, which always inject a fake facade, from
    // loading the transport layer at all.
    function apiFacade() {
        if (root.PilotApi && root.PilotApi.addressbook) return root.PilotApi.addressbook;
        if (req) {
            try {
                const A = req('../core/api-client.js');
                if (A && A.PilotApi && A.PilotApi.addressbook) return A.PilotApi.addressbook;
                if (A && A.addressbook) return A.addressbook;
            } catch (e) { /* not loadable outside the plugin — reported as API_UNREACHABLE */ }
        }
        return null;
    }

    function mkErr(kind, message, detail) {
        if (Errors && typeof Errors.create === 'function') return Errors.create(kind, message, detail);
        return { kind, message, detail: detail === undefined ? null : detail };
    }

    function remediationOf(kind) {
        if (Errors && typeof Errors.remediation === 'function') return Errors.remediation(kind);
        return 'none';
    }

    // A short, honest sentence for each of PilotErrors' closed remediation
    // vocabulary (C16) — same wording as js/features/devices-ui.js and
    // js/features/overview.js use, so the same failure reads the same way on
    // every surface. The kind drives what is actually recommended; nothing here
    // is a single hardcoded "Try again" regardless of what went wrong.
    const REMEDIATION_LABEL = {
        retry: 'Recommended: try again.',
        reauthorize: 'Recommended: sign in again on this server.',
        'manual-mode': 'Recommended: follow the manual steps for this target.',
        'fix-dns': 'Recommended: check the DNS record for this server.',
        'open-ports': 'Recommended: open the required ports and try again.',
        'hard-stop': 'This cannot be resolved automatically.',
        none: ''
    };

    function remediationLabel(kind) {
        const r = remediationOf(kind);
        return Object.prototype.hasOwnProperty.call(REMEDIATION_LABEL, r) ? REMEDIATION_LABEL[r] : '';
    }

    function toAlert(e) {
        if (!e) return null;
        const kind = (Errors && typeof Errors.normalize === 'function')
            ? Errors.normalize(e.kind) : (e.kind || 'UNKNOWN');
        const message = (e.message === undefined || e.message === null || e.message === '')
            ? kind : String(e.message);
        return { kind, message, remediation: remediationLabel(kind) };
    }

    const HOST_ID = 'pilot-addressbook';
    const SERVER_CHANGED_EVENT = 'pilot:server-changed';
    // Emitted by js/features/devices-ui.js when it writes to a book. Same
    // literal on both sides, pinned by a unit test — see the note there.
    const AB_CHANGED_EVENT = 'pilot:addressbook-changed';
    const NO_API = 'The address book API is not available.';

    function blankState() {
        return {
            books: [], activeGuid: null, peers: [], tags: [], selected: [],
            filter: '', tagDraft: '', renameFrom: '', renameTo: '',
            bulkTags: '', bulkMode: 'add', busy: false, notice: null, importReport: null,
            error: { books: null, peers: null, tags: null, write: null }
        };
    }

    function activeBookOf(state) {
        const books = (state && Array.isArray(state.books)) ? state.books : [];
        for (const b of books) if (b.guid === state.activeGuid) return b;
        return books.length ? books[0] : null;
    }

    function visiblePeers(state) {
        const peers = (state && Array.isArray(state.peers)) ? state.peers : [];
        const needle = String((state && state.filter) || '').trim().toLowerCase();
        if (!needle) return peers.slice();
        return peers.filter(function (p) {
            const hay = [p.id, p.alias, p.username, p.hostname, p.platform, (p.tags || []).join(' ')]
                .join(' ').toLowerCase();
            return hay.indexOf(needle) !== -1;
        });
    }

    function selectionOf(state) {
        const visible = visiblePeers(state);
        const sel = (state && Array.isArray(state.selected)) ? state.selected : [];
        return visible.map((p) => p.id).filter((id) => sel.indexOf(id) !== -1);
    }

    function canBulkTag(state) {
        return selectionOf(state).length > 0 && AB.normalizeTags(state.bulkTags).length > 0;
    }

    // GAP D (task 33): spec §7.3 forbids an empty data-driven control rendering
    // NOTHING — the chip list at data-pilot="tag" did exactly that with zero
    // tags. EmptyState.forKind('tag').tab is 'addressbook', which is where this
    // surface already lives, so a tab-switch CTA would be a self-referential
    // no-op; focusing the add-tag input is the genuinely useful next action
    // instead. Falls back to plain text if js/core/emptystate.js is ever
    // missing, rather than rendering nothing.
    function tagEmptyState() {
        const entry = (EmptyState && typeof EmptyState.forKind === 'function') ? EmptyState.forKind('tag') : null;
        return entry || { message: 'No tags yet.', ctaLabel: 'Add a tag', tab: 'addressbook' };
    }

    // The bulk-tag control's own empty state. It says something different from
    // the Tags row's: up there "No tags yet." is a neutral observation, but here
    // the operator has selected rows and is trying to act, so it has to explain
    // why the control they expected is missing. Same CTA, so both routes land on
    // the same next action.
    function bulkTagEmptyState() {
        const entry = tagEmptyState();
        return {
            message: 'You have to create a tag first.',
            ctaLabel: entry.ctaLabel || 'Add a tag',
            tab: entry.tab || 'addressbook'
        };
    }

    function csvFilename(book, now) {
        const when = (now instanceof Date && !isNaN(now.getTime())) ? now : new Date();
        const stamp = String(when.getUTCFullYear()) +
            String(when.getUTCMonth() + 1).padStart(2, '0') +
            String(when.getUTCDate()).padStart(2, '0');
        // The personal book is named by the SERVER -- "admin" on a real v2.7,
        // i.e. the account name. That is a poor and slightly leaky filename for
        // an export, and it changes with the account. "personal" is what it is.
        const raw = (book && book.personal) ? 'personal' : String((book && book.name) || '');
        let name = raw.toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
        if (!name) name = 'book';
        return 'pilot-addressbook-' + name.slice(0, 40) + '-' + stamp + '.csv';
    }

    // ---------------------------------------------------------- template
    //
    // Alpine's x-show loses to Bootstrap's !important display utilities, so every
    // conditional block in this template is an x-if template instead, never
    // x-show. Every value a peer or tag can contain is rendered with x-text, never
    // x-html — this is what keeps a hostile alias or tag inert.

    const TEMPLATE = [
        '<div class="pilot-ab" x-data="pilotAddressBookUi()" x-init="init()">',
        '  <div class="row g-2 align-items-end mb-3">',
        '    <div class="col-auto">',
        '      <label class="form-label" for="pilot-ab-book">Address book</label>',
        '      <select id="pilot-ab-book" class="form-select" data-pilot="book"',
        '              x-model="activeGuid" @change="selectBook(activeGuid)">',
        '        <template x-for="b in books" :key="b.guid">',
        '          <option :value="b.guid" x-text="b.name + (b.personal ? \' (personal)\' : \'\')"></option>',
        '        </template>',
        '      </select>',
        '    </div>',
        '    <div class="col-auto">',
        '      <label class="form-label" for="pilot-ab-filter">Filter</label>',
        '      <input id="pilot-ab-filter" type="search" class="form-control" data-pilot="filter"',
        '             x-model="filter" placeholder="id, alias, host or tag">',
        '    </div>',
        '    <div class="col-auto">',
        '      <button type="button" class="btn btn-outline-secondary" data-pilot="reload"',
        '              @click="load()" :disabled="busy">Reload</button>',
        '    </div>',
        '    <div class="col-auto text-secondary small" data-pilot="count"',
        '         x-text="visible().length + \' of \' + peers.length + \' peers\'"></div>',
        '  </div>',
        '',
        '  <div data-pilot="books-error"><template x-if="error.books">',
        '    <div class="alert alert-warning" role="alert">',
        '      <strong x-text="error.books.kind"></strong> <span x-text="error.books.message"></span>',
        '      <span class="text-secondary" x-text="error.books.remediation"></span>',
        '    </div></template></div>',
        '  <div data-pilot="peers-error"><template x-if="error.peers">',
        '    <div class="alert alert-danger" role="alert">',
        '      <strong x-text="error.peers.kind"></strong> <span x-text="error.peers.message"></span>',
        '      <span class="text-secondary" x-text="error.peers.remediation"></span>',
        '    </div></template></div>',
        '  <div data-pilot="tags-error"><template x-if="error.tags">',
        '    <div class="alert alert-warning" role="alert">',
        '      <strong x-text="error.tags.kind"></strong> <span x-text="error.tags.message"></span>',
        '      <span class="text-secondary" x-text="error.tags.remediation"></span>',
        '    </div></template></div>',
        '  <div data-pilot="write-error"><template x-if="error.write">',
        '    <div class="alert alert-danger" role="alert">',
        '      <strong x-text="error.write.kind"></strong> <span x-text="error.write.message"></span>',
        '      <span class="text-secondary" x-text="error.write.remediation"></span>',
        '    </div></template></div>',
        '  <div data-pilot="notice"><template x-if="notice">',
        '    <div class="alert alert-success" role="status" x-text="notice"></div></template></div>',
        '',
        '  <div class="mb-3">',
        '    <span class="me-2 text-secondary small">Tags</span>',
        '    <template x-for="t in tags" :key="t">',
        '      <span class="badge text-bg-secondary me-1" data-pilot="tag">',
        '        <span x-text="t"></span>',
        '        <button type="button" class="btn-close btn-close-white ms-1" aria-label="Delete tag"',
        '                @click="deleteTag(t)"></button>',
        '      </span>',
        '    </template>',
        '    <template x-if="!tags.length">',
        '      <span data-pilot="tags-empty">',
        '        <span class="text-secondary small" x-text="tagEmptyState().message"></span>',
        '        <button type="button" class="btn btn-sm btn-link p-0 ms-1" data-pilot="tags-empty-action"',
        '                @click="focusNewTag()" x-text="tagEmptyState().ctaLabel"></button>',
        '      </span>',
        '    </template>',
        '  </div>',
        '  <div class="row g-2 align-items-end mb-3">',
        '    <div class="col-auto">',
        '      <label class="form-label" for="pilot-ab-newtag">New tag</label>',
        '      <input id="pilot-ab-newtag" type="text" class="form-control" data-pilot="new-tag" x-model="tagDraft">',
        '    </div>',
        '    <div class="col-auto">',
        '      <button type="button" class="btn btn-outline-primary" data-pilot="add-tag" @click="createTag()">Add tag</button>',
        '    </div>',
        '    <div class="col-auto">',
        '      <label class="form-label" for="pilot-ab-renamefrom">Rename</label>',
        // Same reasoning as the bulk-tag control: the tag being renamed must
        // already exist, so typing its name is a chance to get it wrong. A typo
        // here renamed nothing and reported success, because the server has no
        // tag by that name to complain about.
        '      <template x-if="tags.length">',
        '        <select id="pilot-ab-renamefrom" class="form-select" data-pilot="rename-from" x-model="renameFrom">',
        '          <option value="">Choose a tag…</option>',
        '          <template x-for="t in tags" :key="t">',
        '            <option :value="t" x-text="t"></option>',
        '          </template>',
        '        </select>',
        '      </template>',
        '      <template x-if="!tags.length">',
        '        <div data-pilot="rename-from-empty">',
        '          <span class="text-secondary small" x-text="bulkTagEmptyState().message"></span>',
        '          <button type="button" class="btn btn-sm btn-link p-0 ms-1" data-pilot="rename-from-empty-action"',
        '                  @click="focusNewTag()" x-text="bulkTagEmptyState().ctaLabel"></button>',
        '        </div>',
        '      </template>',
        '    </div>',
        '    <div class="col-auto">',
        '      <label class="form-label" for="pilot-ab-renameto">to</label>',
        '      <input id="pilot-ab-renameto" type="text" class="form-control" data-pilot="rename-to" x-model="renameTo">',
        '    </div>',
        '    <div class="col-auto">',
        '      <button type="button" class="btn btn-outline-primary" data-pilot="rename-tag" @click="renameTagAction()">Rename tag</button>',
        '    </div>',
        '  </div>',
        '',
        '  <div class="row g-2 align-items-end mb-3">',
        '    <div class="col-auto">',
        '      <label class="form-label" for="pilot-ab-bulk">Tags for the selection</label>',
        // A free-text box here asked the operator to retype a tag that already
        // exists, and silently created a NEW one on any typo -- the address book
        // grew "laptop" and "Laptop" as separate tags with no way to tell from
        // this row. The only valid values are the tags this book already has, so
        // this is a choice, not a text field.
        '      <template x-if="tags.length">',
        '        <select id="pilot-ab-bulk" class="form-select" data-pilot="bulk-tags" x-model="bulkTags">',
        '          <option value="">Choose a tag…</option>',
        '          <template x-for="t in tags" :key="t">',
        '            <option :value="t" x-text="t"></option>',
        '          </template>',
        '        </select>',
        '      </template>',
        // Spec §7.3: a data-driven control with nothing to choose from is never
        // rendered. An empty dropdown says something is wrong but not what, and
        // offers no way forward -- so say it, and point at the fix.
        '      <template x-if="!tags.length">',
        '        <div data-pilot="bulk-tags-empty">',
        '          <span class="text-secondary small" x-text="bulkTagEmptyState().message"></span>',
        '          <button type="button" class="btn btn-sm btn-link p-0 ms-1" data-pilot="bulk-tags-empty-action"',
        '                  @click="focusNewTag()" x-text="bulkTagEmptyState().ctaLabel"></button>',
        '        </div>',
        '      </template>',
        '    </div>',
        '    <div class="col-auto">',
        '      <label class="form-label" for="pilot-ab-bulkmode">Mode</label>',
        '      <select id="pilot-ab-bulkmode" class="form-select" data-pilot="bulk-mode" x-model="bulkMode">',
        '        <option value="add">add</option>',
        '        <option value="remove">remove</option>',
        '        <option value="set">set</option>',
        '      </select>',
        '    </div>',
        '    <div class="col-auto">',
        '      <button type="button" class="btn btn-primary" data-pilot="bulk-apply"',
        '              @click="applyBulkTags()" :disabled="!canBulkTag()">Apply to selected</button>',
        '    </div>',
        '  </div>',
        '',
        '  <div class="row g-2 align-items-center mb-3">',
        '    <div class="col-auto">',
        '      <button type="button" class="btn btn-outline-secondary" data-pilot="export-csv"',
        '              @click="doExport()">Export CSV</button>',
        '    </div>',
        '    <div class="col-auto">',
        '      <button type="button" class="btn btn-outline-secondary" data-pilot="import-csv"',
        '              @click="$refs.csvFile.click()">Import CSV</button>',
        '      <input type="file" accept=".csv,text/csv" class="visually-hidden" tabindex="-1"',
        '             data-pilot="csv-file" x-ref="csvFile" @change="onFileChosen($event)">',
        '    </div>',
        '  </div>',
        '  <div data-pilot="import-report"><template x-if="importReport">',
        '    <div class="alert alert-info" role="status">',
        '      <div x-text="importReport.added + \' added, \' + importReport.updated + \' updated\' + ',
        '                   (importReport.failed.length ? (\', \' + importReport.failed.length + \' failed\') : \'\')"></div>',
        '      <ul class="mb-0"><template x-for="(p, i) in importReport.problems" :key="i">',
        '        <li data-pilot="import-problem" x-text="p"></li></template></ul>',
        '    </div></template></div>',
        '',
        '  <div data-pilot="peers-empty"><template x-if="peersEmptyKind() === \'no-peers\'">',
        '    <div class="mb-2">',
        '      <p class="mb-2">This address book has no peers yet.</p>',
        '      <button type="button" class="btn btn-sm btn-primary" data-pilot="peers-empty-action"',
        '              @click="$refs.csvFile.click()">Import a CSV to add peers</button>',
        '    </div></template></div>',
        '  <div data-pilot="peers-empty-filtered"><template x-if="peersEmptyKind() === \'no-match\'">',
        '    <div class="mb-2">',
        '      <p class="mb-2">No peer matches this filter.</p>',
        '      <button type="button" class="btn btn-sm btn-outline-secondary" data-pilot="peers-empty-filtered-action"',
        '              @click="clearFilter()">Clear the filter</button>',
        '    </div></template></div>',
        '',
        '  <template x-if="peersEmptyKind() === \'none\'">',
        '  <div class="table-responsive">',
        '    <table class="table table-sm align-middle">',
        '      <thead><tr>',
        '        <th scope="col"><input type="checkbox" class="form-check-input" data-pilot="select-all"',
        '            aria-label="Select all listed peers" @change="$event.target.checked ? selectAllVisible() : clearSelection()"></th>',
        '        <th scope="col">ID</th><th scope="col">Alias</th><th scope="col">Host</th>',
        '        <th scope="col">Platform</th><th scope="col">Tags</th>',
        '      </tr></thead>',
        '      <tbody>',
        '        <template x-for="p in visible()" :key="p.id">',
        '          <tr data-pilot="peer-row" :data-peer-id="p.id">',
        '            <td><input type="checkbox" class="form-check-input" data-pilot="peer-check"',
        '                 :aria-label="\'Select \' + p.id"',
        '                 :checked="selected.includes(p.id)" @change="toggle(p.id)"></td>',
        '            <td x-text="p.id"></td><td x-text="p.alias"></td>',
        '            <td x-text="p.hostname"></td><td x-text="p.platform"></td>',
        '            <td data-pilot="peer-tags" x-text="p.tags.join(\', \')"></td>',
        '          </tr>',
        '        </template>',
        '      </tbody>',
        '    </table>',
        '  </div>',
        '  </template>',
        '</div>'
    ].join('\n');

    function pilotAddressBookUi(deps) {
        const d = deps || {};
        const injected = d.api || null;
        return Object.assign(blankState(), {
            api() { return injected || apiFacade(); },
            doc: d.doc || null,

            init(doc) {
                const target = doc || this.doc || root.document || null;
                const self = this;
                if (target && typeof target.addEventListener === 'function') {
                    target.addEventListener(SERVER_CHANGED_EVENT, function (ev) { self.onServerChanged(ev); });
                    target.addEventListener(AB_CHANGED_EVENT, function (ev) { self.onAddressBookChanged(ev); });
                }
                return this.load();
            },

            // The Devices tab just wrote to a book. Reload the peers -- and ONLY
            // the peers: books and tags did not change, and reloading them would
            // throw away the user's book selection and re-render two more tables
            // for nothing.
            //
            // Reloads whichever book is on screen regardless of which book the
            // event names. Matching on detail.ab would be wrong in the case that
            // matters: the Devices tab writes to ITS selected book, which is
            // routinely not the one this tab is showing, and "the peer list you
            // are looking at may now be stale" is true either way. A reload
            // costs one request; showing a list that silently lies does not
            // announce itself at all.
            onAddressBookChanged() {
                if (!this.activeGuid) return false;
                this.loadPeers();
                return true;
            },

            // Reacts to the SAME event js/app.js dispatches once its real
            // wireApi()/switchServer() has re-wired PilotApi's transport to the
            // newly active server (see js/app.js's notifyServerChanged() and
            // js/features/devices-ui.js's own onServerChanged()). This surface has
            // no per-server cached state to re-key — the books/peers/tags it shows
            // belong to whichever server the transport now points at, so a full
            // reload is both correct and simplest.
            onServerChanged(ev) {
                let id = null;
                try { id = (ev && ev.detail) ? ev.detail.id : null; } catch (x) { id = null; }
                if (typeof id !== 'string' || !id.trim()) return false;
                this.selected = [];
                this.notice = null;
                this.importReport = null;
                this.load();
                return true;
            },

            async load() {
                this.busy = true;
                await this.loadBooks();
                await this.loadPeers();
                await this.loadTags();
                this.busy = false;
                return this;
            },

            async loadBooks() {
                this.error.books = null;
                const api = this.api();
                // No synthetic fallback book. AB.PERSONAL.guid is '', and ''
                // is not a guid this server accepts: /api/ab/peers?ab= is a 400
                // and /api/ab/tags/ a 404. Standing one up when the server told
                // us nothing produced a selector whose only entry could not be
                // used -- the state §7.3 exists to prevent. An empty list is
                // honest, and the empty state below says what to do.
                if (!api) {
                    this.error.books = toAlert(mkErr('API_UNREACHABLE', NO_API, null));
                    this.books = [];
                } else {
                    try {
                        this.books = AB.booksFrom(await api.books());
                    } catch (e) {
                        this.error.books = toAlert(e);
                        this.books = [];
                    }
                }
                // books[0] was read unguarded, which only ever worked because
                // booksFrom() guaranteed a synthetic entry. With none, an empty
                // list threw "Cannot read properties of undefined (reading
                // 'guid')" at load and took the whole surface down.
                if (!this.books.some((b) => b.guid === this.activeGuid))
                    this.activeGuid = this.books.length ? this.books[0].guid : '';
            },

            async loadPeers() {
                this.error.peers = null;
                const api = this.api();
                if (!api) {
                    this.error.peers = toAlert(mkErr('API_UNREACHABLE', NO_API, null));
                    this.peers = [];
                    return;
                }
                try {
                    // Peers are always fetched scoped to exactly one book
                    // (this.activeGuid), so there is nothing to dedupe ACROSS
                    // books here — dedupePeers' byBook option exists for a caller
                    // that merges lists gathered from more than one book, which
                    // this surface never does.
                    this.peers = AB.dedupePeers(AB.peersFrom(await api.peers(this.activeGuid))).peers;
                } catch (e) {
                    this.error.peers = toAlert(e);
                    this.peers = [];
                }
                const live = this.peers.map((p) => p.id);
                this.selected = this.selected.filter((id) => live.indexOf(id) !== -1);
            },

            async loadTags() {
                this.error.tags = null;
                const api = this.api();
                if (!api) {
                    this.error.tags = toAlert(mkErr('API_UNREACHABLE', NO_API, null));
                    this.tags = [];
                    return;
                }
                try {
                    this.tags = AB.tagsFrom(await api.tags(this.activeGuid));
                } catch (e) {
                    this.error.tags = toAlert(e);
                    this.tags = [];
                }
            },

            async selectBook(guid) {
                this.activeGuid = String(guid === undefined || guid === null ? '' : guid);
                this.selected = [];
                this.notice = null;
                this.importReport = null;
                await this.loadPeers();
                await this.loadTags();
            },

            visible() { return visiblePeers(this); },

            // GAP D (task 33): the empty state's own copy, and the action
            // its CTA actually performs. forKind('tag').tab is 'addressbook'
            // — the tab this surface already renders in — so switching tabs
            // would be a self-referential no-op; focusing the add-tag input
            // is the genuinely useful next step instead.
            tagEmptyState() { return tagEmptyState(); },
            bulkTagEmptyState() { return bulkTagEmptyState(); },
            focusNewTag() {
                const d = this.doc || root.document || null;
                if (!d || typeof d.getElementById !== 'function') return false;
                const el = d.getElementById('pilot-ab-newtag');
                if (!el || typeof el.focus !== 'function') return false;
                el.focus();
                return true;
            },

            peersEmptyKind() {
                if (this.busy) return 'none';
                if (this.error.peers) return 'none';
                if (this.peers.length === 0) return 'no-peers';
                if (visiblePeers(this).length === 0) return 'no-match';
                return 'none';
            },

            clearFilter() { this.filter = ''; },

            toggle(id) {
                const at = this.selected.indexOf(id);
                if (at === -1) this.selected = this.selected.concat([id]);
                else this.selected = this.selected.filter((x) => x !== id);
            },

            selectAllVisible() { this.selected = visiblePeers(this).map((p) => p.id); },
            clearSelection() { this.selected = []; },
            canBulkTag() { return canBulkTag(this); },

            async applyBulkTags() {
                this.error.write = null;
                this.notice = null;
                const ids = selectionOf(this);
                const tags = AB.normalizeTags(this.bulkTags);
                if (!ids.length || !tags.length) {
                    this.error.write = toAlert(mkErr('GENERIC',
                        'Select at least one peer and enter at least one usable tag.', null));
                    return { ok: 0, failed: [] };
                }
                const api = this.api();
                if (!api) {
                    this.error.write = toAlert(mkErr('API_UNREACHABLE', NO_API, null));
                    return { ok: 0, failed: [] };
                }
                const next = AB.bulkTag(this.peers, ids, tags, this.bulkMode);
                const byId = new Map(next.map((p) => [p.id, p]));
                const failed = [];
                let ok = 0;
                for (const id of ids) {
                    const peer = byId.get(id);
                    if (!peer) continue;
                    try {
                        await api.updatePeer(this.activeGuid, peer);
                        ok += 1;
                    } catch (e) {
                        const a = toAlert(e);
                        failed.push({ id, kind: a.kind, message: a.message });
                    }
                }
                const bad = new Set(failed.map((f) => f.id));
                this.peers = this.peers.map((p) => (bad.has(p.id) ? p : (byId.get(p.id) || p)));
                if (failed.length)
                    this.error.write = toAlert(mkErr('GENERIC',
                        failed.length + ' of ' + ids.length + ' peers could not be updated.', failed));
                else this.notice = ok + ' peer(s) updated.';
                return { ok, failed };
            },

            async createTag() {
                this.error.write = null;
                this.notice = null;
                const tag = AB.normalizeTag(this.tagDraft);
                if (!tag) {
                    this.error.write = toAlert(mkErr('GENERIC',
                        'A tag must be 1 to 64 characters and may not contain a comma.', null));
                    return false;
                }
                if (this.tags.indexOf(tag) !== -1) {
                    this.error.write = toAlert(mkErr('GENERIC', 'That tag already exists.', null));
                    return false;
                }
                const api = this.api();
                if (!api) {
                    this.error.write = toAlert(mkErr('API_UNREACHABLE', NO_API, null));
                    return false;
                }
                try {
                    await api.addTag(this.activeGuid, tag);
                } catch (e) {
                    this.error.write = toAlert(e);
                    return false;
                }
                this.tags = this.tags.concat([tag]).sort();
                this.tagDraft = '';
                this.notice = 'Tag "' + tag + '" added.';
                return true;
            },

            async renameTagAction() {
                this.error.write = null;
                this.notice = null;
                const from = AB.normalizeTag(this.renameFrom);
                const to = AB.normalizeTag(this.renameTo);
                if (!from || !to || from === to) {
                    this.error.write = toAlert(mkErr('GENERIC',
                        'Enter an existing tag and a different, usable new name.', null));
                    return false;
                }
                if (this.tags.indexOf(from) === -1) {
                    this.error.write = toAlert(mkErr('GENERIC', 'No tag named "' + from + '".', null));
                    return false;
                }
                const api = this.api();
                if (!api) {
                    this.error.write = toAlert(mkErr('API_UNREACHABLE', NO_API, null));
                    return false;
                }
                try {
                    await api.renameTag(this.activeGuid, from, to);
                } catch (e) {
                    this.error.write = toAlert(e);
                    return false;
                }
                this.peers = AB.renameTagIn(this.peers, from, to);
                const kept = this.tags.filter((t) => t !== from);
                this.tags = (kept.indexOf(to) === -1 ? kept.concat([to]) : kept).sort();
                this.renameFrom = '';
                this.renameTo = '';
                this.notice = 'Tag renamed to "' + to + '".';
                return true;
            },

            async deleteTag(tag) {
                this.error.write = null;
                this.notice = null;
                const t = AB.normalizeTag(tag);
                if (!t) {
                    this.error.write = toAlert(mkErr('GENERIC', 'That tag name is not usable.', null));
                    return false;
                }
                const api = this.api();
                if (!api) {
                    this.error.write = toAlert(mkErr('API_UNREACHABLE', NO_API, null));
                    return false;
                }
                try {
                    await api.removeTag(this.activeGuid, t);
                } catch (e) {
                    this.error.write = toAlert(e);
                    return false;
                }
                this.peers = AB.removeTagFrom(this.peers, t);
                this.tags = this.tags.filter((x) => x !== t);
                this.notice = 'Tag "' + t + '" deleted.';
                return true;
            },

            exportCsv() { return AB.toCsv(this.peers); },

            // UI-only glue around exportCsv()/csvFilename(): triggers a real
            // browser download. Returns false (rather than throwing) whenever
            // this environment cannot do that — no DOM, or Blob/URL missing.
            doExport() {
                const text = this.exportCsv();
                const filename = csvFilename(activeBookOf(this), new Date());
                const dd = this.doc || root.document;
                if (!dd || typeof dd.createElement !== 'function' ||
                    typeof root.Blob === 'undefined' ||
                    typeof root.URL === 'undefined' ||
                    typeof root.URL.createObjectURL !== 'function') return false;
                try {
                    const blob = new root.Blob([text], { type: 'text/csv;charset=utf-8' });
                    const url = root.URL.createObjectURL(blob);
                    const a = dd.createElement('a');
                    a.href = url;
                    a.download = filename;
                    const parent = dd.body || dd.documentElement;
                    if (parent && typeof parent.appendChild === 'function') parent.appendChild(a);
                    a.click();
                    if (parent && typeof parent.removeChild === 'function' && a.parentNode === parent)
                        parent.removeChild(a);
                    if (typeof root.URL.revokeObjectURL === 'function') root.URL.revokeObjectURL(url);
                } catch (e) {
                    return false;
                }
                return true;
            },

            async importCsv(text) {
                this.error.write = null;
                this.notice = null;
                this.importReport = null;
                const parsed = AB.fromCsv(text);
                const report = { added: 0, updated: 0, failed: [], problems: parsed.problems.slice() };
                if (!parsed.peers.length) {
                    this.importReport = report;
                    return report;
                }
                const api = this.api();
                if (!api) {
                    this.error.write = toAlert(mkErr('API_UNREACHABLE', NO_API, null));
                    this.importReport = report;
                    return report;
                }
                const known = new Set(this.peers.map((p) => p.id));
                // Applied locally after each write succeeds -- the same pattern
                // applyBulkTags()/renameTagAction()/deleteTag() already use, and for
                // the same reason: the server was just told about this peer, so
                // there is no need to round-trip a full loadPeers() to show it. A
                // write that FAILS is never added here, matching "a failed write
                // must not be shown as applied" everywhere else in this component.
                const applied = [];
                for (const peer of parsed.peers) {
                    try {
                        if (known.has(peer.id)) {
                            await api.updatePeer(this.activeGuid, peer);
                            report.updated += 1;
                        } else {
                            await api.addPeer(this.activeGuid, peer);
                            report.added += 1;
                        }
                        applied.push(peer);
                    } catch (e) {
                        const a = toAlert(e);
                        report.failed.push({ id: peer.id, kind: a.kind, message: a.message });
                    }
                }
                if (applied.length) {
                    const byId = new Map(applied.map((p) => [p.id, p]));
                    const merged = this.peers.map((p) => (byId.has(p.id) ? byId.get(p.id) : p));
                    for (const p of applied) if (!known.has(p.id)) merged.push(p);
                    this.peers = merged;
                }
                this.importReport = report;
                if (report.failed.length)
                    this.error.write = toAlert(mkErr('GENERIC',
                        report.failed.length + ' peer(s) could not be imported.', report.failed));
                else this.notice = report.added + ' added, ' + report.updated + ' updated.';
                return report;
            },

            // Reads the file the hidden <input type="file"> was given and feeds
            // its text through importCsv() — the only DOM-specific step in the
            // whole import path; everything after this is the same pure logic
            // importCsv() already is.
            onFileChosen(ev) {
                const input = ev && ev.target;
                const file = input && input.files && input.files[0];
                if (input) input.value = '';
                if (!file) return Promise.resolve(null);
                const self = this;
                return new Promise(function (resolve) {
                    const reader = new root.FileReader();
                    reader.onload = function () {
                        resolve(self.importCsv(typeof reader.result === 'string' ? reader.result : ''));
                    };
                    reader.onerror = function () {
                        self.error.write = toAlert(mkErr('GENERIC', 'The selected file could not be read.', null));
                        resolve(null);
                    };
                    reader.readAsText(file);
                });
            }
        });
    }

    function mount(doc) {
        const dd = doc || root.document;
        if (!dd || typeof dd.getElementById !== 'function') return false;
        const host = dd.getElementById(HOST_ID);
        if (!host || host.getAttribute('data-pilot-mounted')) return false;
        host.setAttribute('data-pilot-mounted', '1');
        // TEMPLATE is a first-party constant in this file: no interpolation, no
        // user input.
        host.insertAdjacentHTML('beforeend', TEMPLATE);
        return true;
    }

    function safeMount(doc) {
        try { return mount(doc); } catch (e) { return false; }
    }

    if (root.document && typeof root.addEventListener === 'function') {
        if (root.document.readyState === 'loading')
            root.addEventListener('DOMContentLoaded', function () { safeMount(); });
        else safeMount();
    }

    root.pilotAddressBookUi = pilotAddressBookUi;

    const PilotAddressBookUi = {
        HOST_ID, SERVER_CHANGED_EVENT, TEMPLATE, blankState, toAlert, activeBookOf, visiblePeers,
        selectionOf, canBulkTag, csvFilename, tagEmptyState, bulkTagEmptyState, mount, safeMount, pilotAddressBookUi
    };
    root.PilotAddressBookUi = PilotAddressBookUi;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotAddressBookUi;
})(typeof window !== 'undefined' ? window : globalThis);
