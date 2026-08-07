// features/settings-ui.js — the Settings surface: where the three update
// repositories are configured.
//
// Pilot installs THREE separate things from THREE separate upstreams, and they
// are easy to conflate:
//
//   repo        Pilot itself, this Cockpit plugin.
//   apiRepo     rustdesk-api — the API, admin console and address book.
//   serverRepo  hbbs/hbbr — the ID/rendezvous and relay daemons. Currently a
//               fork (see README, "Why the server is a fork"); having it here
//               makes returning to rustdesk/rustdesk-server a setting rather
//               than a code edit.
//
// Everything above the "cockpit I/O" divider is pure and unit-tested with no DOM
// and no cockpit reference. Only the Alpine component touches PilotSettings, and
// that module owns the file, the validation and the defaults — this file never
// writes ~/.config directly and never re-implements the repo rules.
'use strict';
(function (root) {
    function need(name, path) {
        if (root[name]) return root[name];
        if (typeof require === 'function') {
            try { return require(path); } catch (e) { return null; }
        }
        return null;
    }

    const Settings = need('PilotSettings', '../core/settings.js');
    const Errors = need('PilotErrors', '../core/errors.js');
    const Update = need('PilotUpdate', './update.js');

    const MOUNT_ID = 'pilot-settings';

    function str(v) { return (v === null || v === undefined) ? '' : String(v); }

    function fail(kind, message) {
        if (Errors && typeof Errors.create === 'function') return Errors.create(kind, message, {});
        return { kind: kind, message: message };
    }

    // ================================================================
    // FIELDS — the table that drives the form (pure data).
    // ================================================================
    //
    // `key` is the leaf inside settings.update. `why` is shown under the input,
    // because "API repository" alone does not tell an operator which of the
    // three RustDesk projects it means — and picking the wrong one produces
    // update checks against software they do not run.
    const FIELDS = Object.freeze([
        Object.freeze({
            key: 'repo', label: 'Pilot repository',
            why: 'This Cockpit plugin. Update checks and self-update read releases from here.'
        }),
        Object.freeze({
            key: 'apiRepo', label: 'API server repository',
            why: 'rustdesk-api — the API, the admin console and the address book. ' +
                'This is NOT the same project as hbbs/hbbr below.'
        }),
        Object.freeze({
            key: 'serverRepo', label: 'RustDesk server repository',
            why: 'hbbs and hbbr, the ID/rendezvous and relay daemons. Pilot currently ' +
                'installs a fork because the official server cannot serve a signed-in ' +
                'client 1.4.1 or newer.'
        })
    ]);

    const FIELD_KEYS = FIELDS.map(function (f) { return f.key; });

    // The owner/name a github.com URL points at, so what is stored is always the
    // short form regardless of which the operator pasted.
    function normalizeRepo(raw) {
        const v = str(raw).trim();
        if (v === '') return '';
        const api = (Update && typeof Update.releasesApiUrl === 'function')
            ? Update.releasesApiUrl(v) : '';
        const m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/releases\/latest$/.exec(api);
        return m ? m[1] + '/' + m[2] : v;
    }

    // ================================================================
    // validateRepo — pure.
    // ================================================================
    //
    // Delegates to the two modules that already own these rules rather than
    // spelling a third copy: PilotSettings decides what may be STORED, and
    // PilotUpdate.releasesApiUrl decides what can actually be FETCHED. A value
    // that passes one and fails the other would be saved and then silently never
    // checked, which is the failure mode worth preventing here.
    //
    // Empty is valid and meaningful: it turns checking off for that component.
    function validateRepo(raw) {
        const v = str(raw).trim();
        if (v === '') return { ok: true, value: '', reason: '' };
        // Order matters. PilotUpdate.releasesApiUrl() accepts a github.com URL and
        // owner/name alike; PilotSettings.isSafeRepo() accepts ONLY owner/name,
        // because that is the form the settings file stores. So the input is
        // reduced to what would actually be written FIRST, and the storage rule
        // is applied to that -- otherwise pasting a perfectly good repository URL
        // is rejected, which is exactly what a user does when asked for a repo.
        const api = (Update && typeof Update.releasesApiUrl === 'function')
            ? Update.releasesApiUrl(v) : '';
        if (!api)
            return { ok: false, value: v, reason: 'Use owner/name, or a github.com URL pointing at the repository.' };
        const short = normalizeRepo(v);
        if (Settings && typeof Settings.isSafeRepo === 'function' && !Settings.isSafeRepo(short))
            return { ok: false, value: v, reason: 'This does not resolve to a repository Pilot can store.' };
        return { ok: true, value: short, reason: '' };
    }

    function blankState() {
        return {
            fields: FIELDS,
            values: { repo: '', apiRepo: '', serverRepo: '' },
            checkOnStartup: true,
            errors: { repo: '', apiRepo: '', serverRepo: '' },
            busy: false,
            notice: null,
            error: null
        };
    }

    // ---------------------------------------------------- cockpit I/O

    function settingsUi(deps) {
        const d = (deps && typeof deps === 'object') ? deps : {};
        const injected = d.settings || null;

        function store() { return injected || Settings; }

        return Object.assign(blankState(), {
            async init() { return this.load(); },

            async load() {
                this.error = null;
                const S = store();
                if (!S || typeof S.read !== 'function') {
                    this.error = fail('GENERIC', 'The settings store is not available.');
                    return this;
                }
                try {
                    const doc = await S.read();
                    const u = (doc && doc.update) ? doc.update : {};
                    for (const k of FIELD_KEYS) this.values[k] = str(u[k]);
                    this.checkOnStartup = u.checkOnStartup === true;
                } catch (e) {
                    this.error = e;
                }
                return this;
            },

            fieldError(key) { return this.errors[key] || ''; },

            // Validation runs per field on the way in, so a bad value is reported
            // where it was typed rather than as one message for the whole form.
            validateField(key) {
                const r = validateRepo(this.values[key]);
                this.errors[key] = r.ok ? '' : r.reason;
                return r.ok;
            },

            canSave() {
                for (const k of FIELD_KEYS) if (!validateRepo(this.values[k]).ok) return false;
                return !this.busy;
            },

            async save() {
                this.notice = null;
                this.error = null;
                let allOk = true;
                for (const k of FIELD_KEYS) if (!this.validateField(k)) allOk = false;
                if (!allOk) return false;

                const S = store();
                if (!S || typeof S.write !== 'function') {
                    this.error = fail('GENERIC', 'The settings store is not available.');
                    return false;
                }
                this.busy = true;
                try {
                    // Read-modify-write: this surface owns three leaves, and a
                    // wholesale replacement would erase the theme, which lives in
                    // the same file and is owned by another surface.
                    const doc = (typeof S.read === 'function') ? await S.read() : {};
                    const next = {
                        ui: (doc && doc.ui) ? doc.ui : {},
                        update: Object.assign({}, (doc && doc.update) ? doc.update : {}, {
                            checkOnStartup: this.checkOnStartup === true
                        })
                    };
                    for (const k of FIELD_KEYS) next.update[k] = normalizeRepo(this.values[k]);
                    await S.write(next);
                    for (const k of FIELD_KEYS) this.values[k] = next.update[k];
                    this.notice = 'Saved.';
                    return true;
                } catch (e) {
                    this.error = e;
                    return false;
                } finally {
                    this.busy = false;
                }
            },

            async resetDefaults() {
                const S = store();
                const dflt = (S && S.DEFAULTS && S.DEFAULTS.update) ? S.DEFAULTS.update : {};
                for (const k of FIELD_KEYS) this.values[k] = str(dflt[k]);
                for (const k of FIELD_KEYS) this.errors[k] = '';
                this.notice = null;
                return this.save();
            },

            errorText(e) {
                if (!e) return '';
                return str(e.message) || str(e.kind) || 'Unknown failure';
            }
        });
    }

    // ---------------------------------------------------------- template

    const TEMPLATE = [
        '<div class="pilot-surface" x-data="pilotSettings()" x-init="init()">',
        '  <div class="d-flex justify-content-between align-items-center mb-2">',
        '    <h2 class="h5 mb-0">Settings</h2>',
        '  </div>',
        '',
        '  <template x-if="error">',
        '    <div class="alert alert-danger" role="alert" data-testid="settings-error"',
        '         x-text="errorText(error)"></div>',
        '  </template>',
        '  <template x-if="notice">',
        '    <div class="alert alert-success" role="status" data-testid="settings-notice"',
        '         x-text="notice"></div>',
        '  </template>',
        '',
        '  <div class="card mb-3">',
        '    <div class="card-body">',
        '      <h3 class="h6">Update repositories</h3>',
        '      <p class="text-secondary small">',
        '        Pilot installs three separate projects. Each is updated from its own',
        '        repository. Enter <code>owner/name</code> or a github.com URL. Leave a',
        '        field empty to stop checking that component.',
        '      </p>',
        '      <template x-for="f in fields" :key="f.key">',
        '        <div class="mb-3">',
        '          <label class="form-label" :for="\'pilot-set-\' + f.key" x-text="f.label"></label>',
        '          <input type="text" class="form-control" :id="\'pilot-set-\' + f.key"',
        '                 :data-testid="\'settings-\' + f.key"',
        '                 x-model="values[f.key]" @blur="validateField(f.key)"',
        '                 :class="fieldError(f.key) ? \'is-invalid\' : \'\'"',
        '                 placeholder="owner/name">',
        '          <div class="form-text" x-text="f.why"></div>',
        '          <template x-if="fieldError(f.key)">',
        '            <div class="invalid-feedback d-block" :data-testid="\'settings-\' + f.key + \'-error\'"',
        '                 x-text="fieldError(f.key)"></div>',
        '          </template>',
        '        </div>',
        '      </template>',
        '      <div class="form-check mb-3">',
        '        <input class="form-check-input" type="checkbox" id="pilot-set-startup"',
        '               data-testid="settings-check-startup" x-model="checkOnStartup">',
        '        <label class="form-check-label" for="pilot-set-startup">',
        '          Check for updates when Pilot opens</label>',
        '      </div>',
        '      <button type="button" class="btn btn-primary me-2" data-testid="settings-save"',
        '              @click="save()" :disabled="!canSave()">',
        '        <template x-if="busy">',
        '          <span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>',
        '        </template>',
        '        <span x-text="busy ? \'Saving…\' : \'Save\'"></span>',
        '      </button>',
        '      <button type="button" class="btn btn-outline-secondary" data-testid="settings-reset"',
        '              @click="resetDefaults()" :disabled="busy">Restore defaults</button>',
        '    </div>',
        '  </div>',
        '',
        // These fields say WHERE to look for updates; they do not perform one.
        // Without this the operator is left on a page full of repositories with
        // no way to act on them -- which is exactly what happened: "where is the
        // check for update and update buttons for these 2". Pilot updates itself
        // from the badge in the header; the two server-side components are day-2
        // operations on a remote host, so they live with the other ones.
        '  <div class="card">',
        '    <div class="card-body">',
        '      <h3 class="h6">Applying updates</h3>',
        '      <p class="text-secondary small mb-2">',
        '        These fields choose where Pilot looks. To actually check and install:',
        '      </p>',
        '      <ul class="small mb-3">',
        '        <li><strong>Pilot</strong> updates itself — the version badge in the header',
        '            checks and applies it.</li>',
        '        <li><strong>The API server</strong> and <strong>the RustDesk server</strong> run on',
        '            the target host, so they are updated from Server Ops:',
        '            <em>Check for updates</em>, then <em>Update API server</em> or',
        '            <em>Update RustDesk server</em>.</li>',
        '      </ul>',
        '      <button type="button" class="btn btn-sm btn-outline-primary"',
        '              data-testid="settings-goto-ops"',
        '              @click="$dispatch(\'pilot:open-tab\', { id: \'server-ops\' })">',
        '        Go to Server Ops</button>',
        '    </div>',
        '  </div>',
        '</div>'
    ].join('\n');

    function mount(doc) {
        if (!doc || typeof doc.getElementById !== 'function') return false;
        const host = doc.getElementById(MOUNT_ID);
        if (!host) return false;
        if (host.getAttribute('data-mounted') === 'true') return true;
        // TEMPLATE is a first-party constant in this file: no interpolation, no
        // user data, no server response. Every value the operator types is bound
        // through x-model/x-text, which set textContent -- there is no x-html
        // anywhere in this codebase, and a smoke rule enforces that.
        host.insertAdjacentHTML('beforeend', TEMPLATE);
        host.setAttribute('data-mounted', 'true');
        return true;
    }

    function safeMount() {
        try { return mount(root.document || null); } catch (e) { return false; }
    }

    root.pilotSettings = function () { return settingsUi({}); };

    const PilotSettingsUi = {
        MOUNT_ID, FIELDS, FIELD_KEYS, TEMPLATE,
        validateRepo, normalizeRepo, blankState, settingsUi, mount, safeMount
    };
    root.PilotSettingsUi = PilotSettingsUi;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotSettingsUi;

    if (root.document && typeof root.addEventListener === 'function') {
        if (root.document.readyState === 'loading')
            root.addEventListener('DOMContentLoaded', function () { safeMount(); });
        else safeMount();
    }
})(typeof window !== 'undefined' ? window : globalThis);
