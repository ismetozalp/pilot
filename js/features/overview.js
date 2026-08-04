// features/overview.js — the landing screen: which server we are looking at, how
// many of its devices are online, and whether the web client can be opened.
//
// The screen is deliberately made of three independent parts. The server list,
// the device summary and the web client link each fail on their own: a registry
// that cannot be read still leaves a usable summary, and an API server that is
// down still leaves a working web client link. No global "something went wrong".
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
    const Devices = need('PilotDevicesUi', './devices-ui.js');
    // js/core/tls.js is THE definition of "is this a certifiable domain" and of
    // how a hostname normalises. This screen used to carry its own second copy
    // of both, which was a live divergence risk the moment the wizard could
    // actually configure TLS (it now can) — the wizard would accept a name this
    // screen then judged unusable, or vice versa.
    const Tls = need('PilotTls', '../core/tls.js');

    const MOUNT_ID = 'pilot-overview';
    const WIZARD_EVENT = 'pilot:open-wizard';
    const SUMMARY_PAGE_SIZE = 200;
    const MAX_FIELD = 200;

    // Escapes only — never a literal control character in a class. The
    // single-shot CONTROL and LABEL_RE that used to sit here belonged to this
    // module's own duplicate domain validator, which now delegates to
    // js/core/tls.js; only the field-cleaning pass still needs a regex.
    const CONTROL_G = /[\x00-\x1f\x7f]/g;

    const TIERS = new Set(['none', 'own', 'sslip', 'duckdns']);

    const REASON = {
        noTls: 'TLS is not configured on this server, so there is no HTTPS address ' +
            'to open the web client at.',
        noDomain: 'This server has no domain name. The web client needs one, because ' +
            'a bare IP address cannot be given a certificate.',
        badDomain: 'The domain recorded for this server is not a usable host name, ' +
            'so no HTTPS address can be formed for the web client.'
    };

    const FALLBACK_SERVER = { id: 'local', name: 'This server', domain: '', tlsTier: 'none' };

    function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
    function str(v) { return typeof v === 'string' ? v : ''; }
    function clean(v) { return str(v).replace(CONTROL_G, ' ').trim().slice(0, MAX_FIELD); }

    function firstStr(obj, keys) {
        if (!obj || typeof obj !== 'object') return '';
        for (const k of keys) {
            if (!has(obj, k)) continue;
            const v = obj[k];
            if (typeof v === 'string' && v.trim()) return v;
        }
        return '';
    }

    // -------------------------------------------------------- web client

    // Both delegate. Kept as named functions (and still exported) only so the
    // call sites below and this module's own tests read the same as before —
    // there is exactly ONE implementation, and it is js/core/tls.js's. With
    // PilotTls somehow absent they fail CLOSED: no domain is valid, so the web
    // client link is disabled with a reason rather than pointing somewhere.
    function validDomain(v) {
        return !!(Tls && typeof Tls.isValidDomain === 'function' && Tls.isValidDomain(v));
    }

    function normDomain(v) {
        return (Tls && typeof Tls.normalizeDomain === 'function') ? Tls.normalizeDomain(v) : '';
    }

    function pickDomain(server) {
        const s = (server && typeof server === 'object') ? server : {};
        const direct = firstStr(s, ['domain', 'fqdn', 'hostname']);
        if (direct) return direct;
        if (s.tls && typeof s.tls === 'object') return firstStr(s.tls, ['domain', 'fqdn']);
        return '';
    }

    function normTier(server) {
        const s = (server && typeof server === 'object') ? server : {};
        let t = null;
        if (typeof s.tlsTier === 'string') t = s.tlsTier;
        else if (typeof s.tls_tier === 'string') t = s.tls_tier;
        else if (s.tls && typeof s.tls === 'object' && typeof s.tls.tier === 'string') t = s.tls.tier;
        else if (typeof s.tls === 'boolean') t = s.tls ? 'own' : 'none';
        const v = str(t).trim().toLowerCase();
        return TIERS.has(v) ? v : 'none';
    }

    // Rendered only when a domain and TLS are both configured. Without them the
    // tab stays visible but disabled, showing the exact reason and a one-click
    // path into the wizard's TLS step (spec 7.3).
    function webClientLink(server) {
        const tier = normTier(server);
        const raw = pickDomain(server);
        if (tier === 'none')
            return { enabled: false, url: null, reason: REASON.noTls, action: 'wizard-tls' };
        // "Nothing was recorded" and "something was recorded but it is not a
        // usable name" are different situations and get different sentences, so
        // emptiness is judged on the RAW value: normDomain() answers '' for a
        // hostile value too, which would otherwise report a recorded-but-broken
        // domain as if no domain had ever been set.
        if (!str(raw).trim())
            return { enabled: false, url: null, reason: REASON.noDomain, action: 'wizard-tls' };
        if (!validDomain(raw))
            return { enabled: false, url: null, reason: REASON.badDomain, action: 'wizard-tls' };
        // No port: Caddy listens on 443 because the client appends none (C17).
        // PilotTls.webClientUrl() IS that rule -- building the string inline
        // here made a third copy of it, which is the same divergence risk that
        // made validDomain/normDomain below delegate. It returns '' for
        // anything it will not vouch for, so an empty answer stays disabled
        // rather than rendering an href to nowhere.
        const url = Tls && typeof Tls.webClientUrl === 'function' ? Tls.webClientUrl(raw) : '';
        if (!url) return { enabled: false, url: null, reason: REASON.badDomain, action: 'wizard-tls' };
        return { enabled: true, url: url, reason: '', action: 'open' };
    }

    // ----------------------------------------------------------- servers

    function serverRow(entry) {
        if (typeof entry === 'string') {
            const id = clean(entry);
            return id ? { id: id, name: id, domain: '', tlsTier: 'none' } : null;
        }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
        const id = clean(firstStr(entry, ['id']));
        if (!id) return null;
        return {
            id: id,
            name: clean(firstStr(entry, ['name', 'label', 'host'])) || id,
            domain: normDomain(pickDomain(entry)),
            tlsTier: normTier(entry)
        };
    }

    function normalizeServers(list) {
        const arr = Array.isArray(list) ? list : [];
        const out = [];
        const seen = Object.create(null);
        for (const e of arr) {
            const r = serverRow(e);
            if (!r || has(seen, r.id)) continue;
            seen[r.id] = true;
            out.push(r);
        }
        return out;
    }

    // ------------------------------------------------------------ wizard

    function wizardDetail(serverId) {
        return { step: 'tls', serverId: clean(serverId) || 'local' };
    }

    function openWizardTls(serverId, target) {
        const t = target || root.document || null;
        if (!t || typeof t.dispatchEvent !== 'function') return false;
        if (typeof root.CustomEvent !== 'function') return false;
        t.dispatchEvent(new root.CustomEvent(WIZARD_EVENT,
            { detail: wizardDetail(serverId), bubbles: true }));
        return true;
    }

    // ------------------------------------------------------------ errors

    function errorMessage(e) {
        if (Devices && typeof Devices.errorMessage === 'function') return Devices.errorMessage(e);
        if (e === null || e === undefined) return '';
        if (typeof e === 'string') return e;
        try { if (typeof e.message === 'string' && e.message) return e.message; } catch (x) { /* ignore */ }
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
    // vocabulary (C16), same shape and same wording as Task 20's
    // devices-ui.js's REMEDIATION_LABEL — the retry button always retries
    // regardless of kind (a generic re-fetch, not a login flow), but the banner
    // text must say what actually went wrong, e.g. "sign in again" for
    // API_AUTH_FAILED rather than one hardcoded "Try again" for every failure.
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

    function emptySummary() { return { total: 0, listed: 0, online: 0, offline: 0 }; }

    // The registry is a seam, not a dependency: whatever provides the server list
    // is duck-typed and entirely optional.
    let REGISTRY = null;
    function setRegistry(reg) { REGISTRY = (reg && typeof reg === 'object') ? reg : null; return REGISTRY; }
    function registry() { return REGISTRY; }

    // --------------------------------------------------------- component

    function pilotOverview(deps) {
        const d = (deps && typeof deps === 'object') ? deps : {};
        const clock = typeof d.now === 'function' ? d.now : function () { return Date.now(); };
        // An explicit `registry` (including explicit null, meaning "really none")
        // is fixed for this component's lifetime, exactly like `api`. But when NO
        // registry is passed at all (the real case: Alpine calls `pilotOverview()`
        // with no arguments from `x-data="pilotOverview()"`), the lookup must stay
        // LIVE rather than snapshotting `REGISTRY`/`root.PilotServers` once at
        // construction — otherwise a `setRegistry()` call that happens after the
        // component has already mounted (the only order possible for anything
        // that wires the registry after the page has loaded) would silently have
        // no effect, and the switcher would be stuck showing a single fallback
        // server forever. `currentRegistry()` below is what stays live.
        const hasExplicitRegistry = has(d, 'registry');
        const explicitRegistry = hasExplicitRegistry ? d.registry : null;

        return {
            api: d.api === null ? null : (d.api || root.PilotApi || null),
            doc: d.doc || null,
            now: clock,
            servers: [],
            activeId: null,
            server: null,
            webClient: { enabled: false, url: null, reason: REASON.noTls, action: 'wizard-tls' },
            summary: emptySummary(),
            cache: Object.create(null),
            loading: false,
            summaryLoading: false,
            summaryError: null,
            registryError: null,
            actionError: null,

            hasApi() {
                return !!(this.api && this.api.devices && typeof this.api.devices.list === 'function');
            },
            errorText(e) { return errorMessage(e); },
            errorRemediation(e) { return remediationOf(e); },
            errorRemediationLabel(e) { return remediationLabel(e); },

            // See the comment above pilotOverview(): only an EXPLICIT registry
            // (passed as a constructor dep, including explicit null) is fixed;
            // otherwise this reads the module-level seam fresh on every call, so
            // a setRegistry() issued after mount is not silently unreachable.
            currentRegistry() {
                if (hasExplicitRegistry) return explicitRegistry;
                return REGISTRY || root.PilotServers || null;
            },

            async loadServers() {
                const reg = this.currentRegistry();
                let list = null;
                if (reg && typeof reg.list === 'function') {
                    try { list = await reg.list(); this.registryError = null; }
                    catch (e) { this.registryError = e; list = null; }
                }
                let rows = normalizeServers(list);
                if (!rows.length) rows = [Object.assign({}, FALLBACK_SERVER)];
                this.servers = rows;

                // The stored active id is consulted only on the first load. After
                // that the user's choice is authoritative, or a refresh would snap
                // the screen back to whatever is on disk.
                if (this.activeId === null) {
                    let active = null;
                    if (reg && typeof reg.active === 'function') {
                        try { active = await reg.active(); } catch (e) { active = null; }
                    }
                    const id = clean(typeof active === 'string'
                        ? active : (active && typeof active === 'object' ? active.id : ''));
                    this.activeId = rows.some((r) => r.id === id) ? id : rows[0].id;
                }
                if (!rows.some((r) => r.id === this.activeId)) this.activeId = rows[0].id;
                this.server = rows.filter((r) => r.id === this.activeId)[0] || rows[0];
                this.webClient = webClientLink(this.server);
                return this.servers;
            },

            async loadSummary(force) {
                const id = this.activeId || 'local';
                // "Last request STARTED wins", not "last request to resolve
                // wins": selectServer()'s own eager fetch and
                // onServerChanged()'s later, corrective fetch (fired once the
                // real transport switch actually completes — see
                // index.html's shell listener) can genuinely overlap, and a
                // slow EARLIER response arriving after a faster LATER one
                // must never be allowed to overwrite it with stale data. This
                // token is the whole fix: any request that is not still the
                // most recent one silently discards its own result instead of
                // writing it into this.summary/this.cache. Claimed BEFORE the
                // cache check, unconditionally — a synchronous cache hit
                // still must invalidate any earlier call's token, or that
                // earlier call's eventual (stale) resolution would wrongly
                // still look "current" and clobber the cache hit's result
                // right after it lands.
                const token = (this.summaryToken = (this.summaryToken || 0) + 1);
                if (!force && has(this.cache, id)) {
                    this.summary = this.cache[id].summary;
                    this.summaryError = this.cache[id].error;
                    return this.summary;
                }
                let summary;
                let summaryError;
                if (!Devices || typeof Devices.deviceRows !== 'function') {
                    summary = emptySummary();
                    summaryError = fail('GENERIC',
                        'The devices module is not loaded, so no device summary is available.');
                } else if (!this.hasApi()) {
                    summary = emptySummary();
                    summaryError = fail('GENERIC',
                        'The API client is not loaded, so no device summary is available.');
                } else {
                    this.summaryLoading = (token === this.summaryToken) ? true : this.summaryLoading;
                    try {
                        const payload = await this.api.devices.list(
                            { page: 1, page_size: SUMMARY_PAGE_SIZE });
                        const rows = Devices.deviceRows(payload, this.now());
                        const online = rows.filter((r) => r.online).length;
                        summary = {
                            total: Devices.normalizeList(payload).total,
                            listed: rows.length,
                            online: online,
                            offline: rows.length - online
                        };
                        summaryError = null;
                    } catch (e) {
                        summary = emptySummary();
                        summaryError = e;
                    } finally {
                        if (token === this.summaryToken) this.summaryLoading = false;
                    }
                }
                if (token !== this.summaryToken) return this.summary;   // superseded — discard
                this.summary = summary;
                this.summaryError = summaryError;
                this.cache[id] = { summary: summary, error: summaryError };
                return this.summary;
            },

            async refresh(force) {
                this.loading = true;
                try {
                    await this.loadServers();
                    await this.loadSummary(!!force);
                } finally {
                    this.loading = false;
                }
                return true;
            },

            async selectServer(id) {
                const next = clean(id);
                if (!next || !this.servers.some((r) => r.id === next)) return false;
                if (next === this.activeId) return true;
                this.activeId = next;
                this.server = this.servers.filter((r) => r.id === next)[0];
                this.webClient = webClientLink(this.server);
                this.actionError = null;
                const reg = this.currentRegistry();
                if (reg && typeof reg.setActive === 'function') {
                    try { await reg.setActive(next); } catch (e) { this.actionError = e; }
                }
                if (Devices && typeof Devices.emitServerChanged === 'function')
                    Devices.emitServerChanged(next, this.doc || root.document || null);
                await this.loadSummary(false);
                return true;
            },

            // Reacts to the SAME event selectServer() dispatches above, once
            // js/app.js's switchServer()/wireApi() has actually re-wired
            // PilotApi's transport to `next` (index.html's shell listens for
            // this event and is what drives that real re-wiring — this
            // component has no reference to switchServer() itself and must
            // stay unit-testable with no DOM at all). Overview's own eager
            // fetch above may have already run against the OLD transport (the
            // real re-wire is asynchronous and can finish after it); `force`
            // guarantees this corrects to the right data rather than trusting
            // whatever that first, possibly-stale, fetch cached.
            onServerChanged(ev) {
                let id = null;
                try { id = (ev && ev.detail) ? ev.detail.id : null; } catch (x) { id = null; }
                const next = clean(id);
                if (!next) return false;
                this.activeId = next;
                const known = this.servers.filter((r) => r.id === next)[0];
                if (known) {
                    this.server = known;
                    this.webClient = webClientLink(known);
                }
                this.loadSummary(true);
                return true;
            },

            openWizardTls() {
                return openWizardTls(this.activeId, this.doc || root.document || null);
            },

            init() {
                const target = this.doc || root.document || null;
                const eventName = (Devices && Devices.SERVER_CHANGED_EVENT) || 'pilot:server-changed';
                if (target && typeof target.addEventListener === 'function') {
                    const self = this;
                    target.addEventListener(eventName, function (ev) { self.onServerChanged(ev); });
                }
                return this.refresh(false);
            }
        };
    }

    // ---------------------------------------------------------- template

    const TEMPLATE = [
        // No x-init: Alpine already calls any x-data object's own init() method
        // automatically (confirmed in Task 20's devices-ui.js) — an explicit
        // x-init="init()" here would fire it a second time on every mount,
        // doubling the registry read and the first devices summary fetch.
        '<div class="pilot-surface" x-data="pilotOverview()">',
        '  <div class="d-flex justify-content-between align-items-center mb-3">',
        '    <h2 class="h5 mb-0">Overview</h2>',
        '    <button type="button" class="btn btn-sm btn-outline-secondary" data-test="refresh"',
        '            @click="refresh(true)" :disabled="loading">Refresh</button>',
        '  </div>',
        '  <label class="form-label" for="pilot-server-switcher">Server</label>',
        '  <select class="form-select form-select-sm mb-3" id="pilot-server-switcher"',
        '          data-test="switcher" @change="selectServer($event.target.value)">',
        '    <template x-for="s in servers" :key="s.id">',
        '      <option :value="s.id" :selected="s.id === activeId" x-text="s.name"></option>',
        '    </template>',
        '  </select>',
        '  <div class="alert alert-warning" data-test="registry-error" x-show="registryError"',
        '       x-text="errorText(registryError)"></div>',
        '  <div class="alert alert-danger" data-test="action-error" x-show="actionError"',
        '       x-text="errorText(actionError)"></div>',
        '  <div class="row g-2 mb-3">',
        '    <div class="col"><div class="card"><div class="card-body py-2">',
        '      <p class="text-secondary small mb-0">Devices</p>',
        '      <p class="h4 mb-0" data-test="total" x-text="summary.total"></p>',
        '    </div></div></div>',
        '    <div class="col"><div class="card"><div class="card-body py-2">',
        '      <p class="text-secondary small mb-0">Online</p>',
        '      <p class="h4 mb-0" data-test="online" x-text="summary.online"></p>',
        '    </div></div></div>',
        '    <div class="col"><div class="card"><div class="card-body py-2">',
        '      <p class="text-secondary small mb-0">Offline</p>',
        '      <p class="h4 mb-0" data-test="offline" x-text="summary.offline"></p>',
        '    </div></div></div>',
        '  </div>',
        // summaryLoading is set/cleared around the device-summary fetch alone
        // (`loading` covers the whole refresh, registry read included), so it is
        // what tells the user the three counters above are mid-flight rather
        // than genuinely zero. It was write-only until now: no indicator rendered.
        '  <p class="text-secondary small" data-test="summary-loading" x-show="summaryLoading">',
        '    Counting devices…</p>',
        '  <div class="alert alert-warning" data-test="summary-error" x-show="summaryError">',
        '    <span x-text="errorText(summaryError)"></span>',
        '    <span class="fw-semibold ms-1" data-test="summary-error-remediation"',
        '          x-text="errorRemediationLabel(summaryError)"></span>',
        '    <button type="button" class="btn btn-sm btn-outline-dark ms-2" data-test="summary-retry"',
        '            @click="refresh(true)">Try again</button>',
        '  </div>',
        '  <div class="card">',
        '    <div class="card-body">',
        '      <h3 class="h6">Web client</h3>',
        '      <p x-show="webClient.enabled">',
        '        <a class="btn btn-sm btn-primary" data-test="web-client-link"',
        '           :href="webClient.url" target="_blank" rel="noopener noreferrer">',
        '          Open the web client</a>',
        '      </p>',
        '      <p x-show="!webClient.enabled">',
        '        <button type="button" class="btn btn-sm btn-primary" disabled',
        '                data-test="web-client-disabled">Open the web client</button>',
        '      </p>',
        '      <p class="text-secondary" data-test="web-client-reason" x-show="!webClient.enabled"',
        '         x-text="webClient.reason"></p>',
        '      <p x-show="!webClient.enabled">',
        '        <button type="button" class="btn btn-sm btn-outline-primary"',
        '                data-test="web-client-fix" @click="openWizardTls()">Set up TLS</button>',
        '      </p>',
        '    </div>',
        '  </div>',
        '</div>'
    ].join('\n');

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

    root.pilotOverview = pilotOverview;

    const PilotOverview = {
        MOUNT_ID, WIZARD_EVENT, TEMPLATE, REASON, FALLBACK_SERVER,
        validDomain, normTier, serverRow, normalizeServers, webClientLink,
        wizardDetail, openWizardTls, emptySummary,
        setRegistry, registry, pilotOverview, mount
    };
    root.PilotOverview = PilotOverview;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotOverview;
})(typeof window !== 'undefined' ? window : globalThis);
