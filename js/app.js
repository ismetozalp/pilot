// app.js — the Alpine root component.
//
// Deliberately thin: it owns tab state and the per-surface error slots, and
// delegates everything else to the feature modules. Anything that knows about
// RustDesk, SSH or systemd belongs in js/core or js/features, not here.
//
// Declares exactly three names: TABS, pilotApp, PilotApp. A later task extends the
// component by adding a property to the object literal pilotApp() returns; it must
// not re-declare any of the three.
'use strict';
(function (root) {

    // mount is the id of the div in index.html this surface renders into. Keeping
    // it in the tab record means the skeleton test can prove every tab has somewhere
    // to render, rather than discovering it as an empty screen at runtime.
    // Long enough for a slow registry read, short enough that a wedged channel
    // does not leave the button spinning with no explanation.
    const RECONNECT_TIMEOUT_MS = 15000;
    // Exported so a test can prove the bound without waiting 15 seconds for it.

    const TABS = [
        { id: 'overview',    label: 'Overview',     mount: 'pilot-overview' },
        { id: 'setup',       label: 'Setup',        mount: 'pilot-setup' },
        { id: 'devices',     label: 'Devices',      mount: 'pilot-devices' },
        { id: 'addressbook', label: 'Address Book', mount: 'pilot-addressbook' },
        { id: 'users',       label: 'Users',        mount: 'pilot-users' },
        { id: 'audit',       label: 'Audit',        mount: 'pilot-audit' },
        { id: 'server-ops',  label: 'Server Ops',   mount: 'pilot-server-ops' },
        { id: 'settings',    label: 'Settings',     mount: 'pilot-settings' }
    ];

    // app.js has no string coercion of its own; the TLS endpoint decision below
    // needs one, and a record field can legitimately be null.
    function str(v) { return v === null || v === undefined ? '' : String(v); }

    function blankErrors() {
        const out = {};
        for (const t of TABS) out[t.id] = null;
        return out;
    }

    // Every feature surface (js/features/devices-ui.js and, later, its siblings)
    // listens for this on document so it learns which server is actually active
    // without polling PilotServers itself — both at startup (a surface can mount
    // before wireApi() resolves) and on every switchServer(). Not exported: this
    // is shell-internal plumbing, the same way blankErrors() is. Mirrors the
    // shape of js/features/devices-ui.js's own emitServerChanged/serverChangedDetail
    // so every listener agrees on the event name and detail shape without the
    // shell depending on any one feature module to define them.
    function notifyServerChanged(id, target) {
        const t = target || root.document || null;
        if (!t || typeof t.dispatchEvent !== 'function') return false;
        if (typeof root.CustomEvent !== 'function') return false;
        const value = (typeof id === 'string' && id.trim()) ? id.trim() : 'local';
        t.dispatchEvent(new root.CustomEvent('pilot:server-changed',
            { detail: { id: value }, bubbles: true }));
        return true;
    }

    function pilotApp() {
        return {
            tabs: TABS,
            tab: 'overview',
            settings: null,
            // Spec §7.2: every surface fails independently. One shared error slot
            // would turn a broken Audit endpoint into "Pilot is down".
            errors: blankErrors(),

            // Control-plane wiring state (Task 19). Nothing before this task ever
            // called PilotApi.setTransport(...), so every surface built on top of
            // it rendered against an unset transport — the console was wired to
            // nothing. activeServerId/apiReady let the shell show which server is
            // live; compatError carries a failed probeCompatibility() without
            // undoing a transport that was already wired successfully.
            // All four of these are RENDERED by index.html's .pilot-status
            // strip. They were write-only until the final review: a token file
            // that existed but could not be read, a version probe that never
            // answered and an active-server choice that could not be persisted
            // were each recorded here and shown to nobody. They are deliberately
            // NOT the "global something went wrong" banner spec §7.2 forbids —
            // each is a fact about the shell's own control-plane wiring, which
            // no per-surface alert reports (a surface only ever sees its own
            // fetch failing, if it fails at all).
            activeServerId: null,
            apiReady: false,
            reconnecting: false,
            reconnectError: null,
            // Overridable so a test can prove the bound without waiting for it.
            reconnectTimeoutMs: RECONNECT_TIMEOUT_MS,
            compatError: null,
            // Set only when the SECRET FILE ITSELF could not be read (e.g. a
            // permissions problem on the 0600 file) — never for the ordinary
            // case of no token configured, which PilotServers.readSecret()
            // already reports as a plain `null`, not a rejection. Wiring still
            // fails safe to an anonymous request either way; this is what lets
            // that be told apart from "no token was ever set" after the fact.
            tokenError: null,
            // Task 34: set only when switchServer()'s own PilotServers.setActive()
            // call rejects (e.g. /etc/pilot is not yet writable in this
            // session) — never thrown, and never blocks the wireApi() retry
            // that follows it. null on every ordinary, successful switch.
            switchError: null,

            // GAP B (task 33): js/features/server-ops-ui.js's "Run setup" and
            // js/features/overview.js's "Set up TLS" both dispatch
            // 'pilot:open-wizard' ({} and {step:'tls', serverId} respectively)
            // but nothing outside a test harness ever listened, so both
            // buttons were dead — #pilot-setup stayed hidden and the tab
            // never changed. index.html wires this exactly like its existing
            // 'pilot:server-changed' listener: @pilot:open-wizard.document=
            // "openWizard($event.detail)" on .pilot-shell. Unlike that
            // listener (whose wireApi() -> notifyServerChanged() ->
            // switchServer() cycle needs the "already active" re-entrancy
            // guard), this one never dispatches 'pilot:open-wizard' itself,
            // so there is no loop to guard against — it only ever changes
            // `tab`. Taking the wizard to a SPECIFIC step (detail.step) is
            // handled independently by js/features/setup-ui.js's own
            // onOpenWizard() listener on #pilot-setup, a separate x-data
            // scope this component cannot reach into directly.
            openWizard(detail) {
                this.tab = 'setup';
                return this.tab;
            },

            failSurface(id, err) {
                if (!Object.prototype.hasOwnProperty.call(this.errors, id)) return null;
                this.errors[id] = err || null;
                return this.errors[id];
            },

            clearSurface(id) {
                if (!Object.prototype.hasOwnProperty.call(this.errors, id)) return null;
                this.errors[id] = null;
                return null;
            },

            // Resolve the active server from the registry (C19), build its
            // transport (C17's PilotApiIo.transport), and hand it to the one API
            // façade every surface calls through (C12's PilotApi.setTransport).
            // Runs at startup and again whenever the user switches server —
            // switchServer() below is the only other caller.
            async wireApi() {
                const Servers = root.PilotServers;
                const Io = root.PilotApiIo;
                const Api = root.PilotApi;
                if (!Servers || !Io || !Api) return null;

                let id = null;
                try {
                    id = await Servers.active();
                } catch (e) {
                    id = null;
                }
                if (!id) {
                    this.activeServerId = null;
                    this.apiReady = false;
                    notifyServerChanged(null);
                    return null;
                }

                try {
                    // read() THROWS for a missing record ("there is no server
                    // record at ..."), it does not resolve null -- so the
                    // recovery below has to catch, not test for falsy.
                    let rec = null;
                    let readError = null;
                    try { rec = await Servers.read(id); } catch (e) { readError = e; }
                    // The active id can name a server that is not registered.
                    // It happened for real: a bug in notifyServerChanged's
                    // arguments dispatched the literal 'local', switchServer()
                    // persisted it, and config.json then pointed at a record
                    // that had never existed. wireApi() looked it up, failed,
                    // and every surface reported "no API transport is
                    // configured" -- with a perfectly good server registered
                    // beside it, and no reload or reconnect able to help.
                    //
                    // A dangling pointer with exactly one real server is not
                    // ambiguous. Adopt it, persist the correction so the next
                    // load is clean, and say so rather than fixing it silently.
                    if (!rec) {
                        const all = await Servers.list().catch(function () { return []; });
                        const rows = Array.isArray(all) ? all.filter(function (r) { return r && r.id; }) : [];
                        if (rows.length === 1) {
                            rec = rows[0];
                            id = rec.id;
                            this.switchError = null;
                            try { await Servers.setActive(id); } catch (e) { this.switchError = e; }
                        } else if (rows.length > 1) {
                            this.switchError = { message: 'The selected server "' + id +
                                '" is not registered. Choose one from the switcher.' };
                        }
                    }
                    if (!rec) {
                        this.activeServerId = null;
                        this.apiReady = false;
                        // Recorded where it always was: the surfaces read
                        // compatError, and moving it would drop the message
                        // rather than relocate it.
                        if (readError) this.compatError = readError;
                        return null;
                    }
                    // readSecret() resolving to null means "no token file" — an
                    // ordinary, expected case (anonymous request). A REJECTION
                    // means the file exists but could not be read (e.g. a
                    // permissions problem on the 0600 file); that must not look
                    // identical to "no token was ever set", so it is recorded in
                    // tokenError even though wiring still proceeds anonymously
                    // rather than blocking the whole server on it.
                    let token = null;
                    try {
                        token = await Servers.readSecret(id, 'token');
                        this.tokenError = null;
                    } catch (e) {
                        token = null;
                        this.tokenError = e;
                    }
                    // Io.connFor() is the single place that decides the
                    // endpoint. Building it here by hand is what produced the
                    // "could not be reached" bug: with TLS the API is behind
                    // Caddy on the DOMAIN at 443, not at host:apiPort.
                    const conn = Io.connFor(rec, token);
                    const send = Io.transport(conn);
                    Api.setTransport(send);
                    this.activeServerId = id;
                    this.apiReady = true;
                    // Notified as soon as the transport is actually wired — every
                    // surface listening re-keys its state to the real server and
                    // (if it has not seen this server before) refetches. This must
                    // not wait on the compatibility probe below, which is advisory
                    // and can take a full round trip of its own.
                    notifyServerChanged(id);

                    // A version mismatch (or an unreachable server) is surfaced,
                    // never thrown away — but it must not undo a transport that
                    // is already correctly wired; the UI decides what to do with
                    // compatError, e.g. warn without blocking navigation.
                    try {
                        await Servers.probeCompatibility(send);
                        this.compatError = null;
                    } catch (e) {
                        this.compatError = e;
                    }
                    return send;
                } catch (e) {
                    this.apiReady = false;
                    this.compatError = e;
                    return null;
                }
            },

            // Called when the user picks a different server in the shell: persist
            // the choice, then re-wire exactly like startup does.
            // switchServer() deliberately no-ops when the id is unchanged (see
            // its re-entrancy guard). Signing in changes the CREDENTIAL, not the
            // server -- so a token stored for the already-active server was
            // written, read back, and never used: every tab went on saying
            // "Please log in first" with a perfectly good token on disk. This is
            // the signal for "same server, new credential".
            async reloadCredentials() {
                return this.wireApi();
            },

            // Cockpit starts EVERY session unelevated, and /etc/pilot is
            // root-owned 0700. Pilot wired the API once, at load: a user who
            // turned on administrative access afterwards was left with
            // "no API transport is configured" on every surface, permanently,
            // and Refresh did not help because the surfaces refetch through a
            // transport that was never built. Measured: apiReady stayed false
            // through elevation AND through Refresh.
            //
            // cockpit.superuser is a shell API and is not exposed to plugin
            // frames -- verified in the running page -- so there is no event to
            // listen for. Re-attempting on a tab change is the cheap, obvious
            // recovery: it costs one read of the registry, only while
            // disconnected, and it means clicking anything at all fixes it.
            selectTab(id) {
                this.tab = id;
                if (!this.apiReady) this.wireApi();
                return this.tab;
            },

            // wireApi() reads the registry over Cockpit channels, and a channel
            // that never opens also never errors -- so this button could sit on
            // "Reconnecting…" forever with nothing in the console, which is
            // exactly what a user reported. A page whose session was elevated
            // after it loaded can hold exactly that kind of wedged channel.
            //
            // Bounded, therefore: if it has not resolved in RECONNECT_TIMEOUT_MS
            // the button comes back and says what to do instead. The wireApi()
            // call is not cancelled -- Cockpit channels have no cancel -- so if
            // it does eventually land, its own assignments still take effect.
            async reconnect() {
                const self = this;
                this.reconnecting = true;
                this.reconnectError = null;
                let timer = null;
                try {
                    const timeout = new Promise(function (resolve) {
                        timer = setTimeout(function () { resolve('timeout'); }, self.reconnectTimeoutMs);
                    });
                    const result = await Promise.race([this.wireApi().then(function (v) { return v; },
                        function () { return null; }), timeout]);
                    if (result === 'timeout' && !this.apiReady) {
                        this.reconnectError = 'Pilot could not reach the system in ' +
                            Math.round(self.reconnectTimeoutMs / 1000) + ' seconds. This usually means the ' +
                            'page was open before administrative access was turned on — reload it ' +
                            '(Ctrl+Shift+R) to start a fresh session.';
                    }
                    return this.apiReady ? result : null;
                } finally {
                    if (timer !== null) clearTimeout(timer);
                    this.reconnecting = false;
                }
            },

            async switchServer(id) {
                // Re-entrancy guard: index.html's shell listens for the very
                // 'pilot:server-changed' event wireApi() dispatches below and
                // calls switchServer() again with that same id (this is what
                // lets js/features/overview.js's own switcher — which only
                // dispatches 'pilot:server-changed', never calls switchServer()
                // directly — actually re-wire PilotApi's transport). Without
                // this guard that would be an infinite loop: switchServer() ->
                // wireApi() -> notifyServerChanged() -> the shell listener ->
                // switchServer() -> ... A request for the server that is
                // ALREADY active is a no-op.
                //
                // Task 34: compares against activeServerId DIRECTLY — no
                // `|| 'local'` fallback on THIS side any more. That fallback
                // used to make "nothing is configured yet" and "local is
                // genuinely active" look identical, so the FIRST real
                // registration of a local server (this task's whole point)
                // could never actually get wired: wireApi()'s very first,
                // no-active-server dispatch already carries the fallback id
                // 'local' (notifyServerChanged(null), just below), so
                // switchServer('local') looked like a no-op from the moment
                // the page loaded — before js/features/setup-ui.js's
                // registerServer() ever got a chance to create a real
                // /etc/pilot/servers/local.json for it to read. Proven by a
                // real browser: tests/e2e/setup.e2e.mjs's own TASK 34
                // scenario went red against the OLD guard (activeServerId/
                // apiReady never flipped after a successful local install)
                // and green against this one. No infinite-loop risk: the
                // request this guard is FOR (wireApi() re-notifying the id it
                // just wired) always finds `requested === this.activeServerId`
                // true by then, because wireApi() sets activeServerId BEFORE
                // calling notifyServerChanged() — see below.
                const requested = (typeof id === 'string' && id.trim()) ? id.trim() : 'local';
                if (requested === this.activeServerId) return this;
                const Servers = root.PilotServers;
                if (Servers && typeof Servers.setActive === 'function') {
                    // A hostile/malformed id is still a hard, LOUD rejection
                    // — validated eagerly (outside the try/catch below) so it
                    // throws exactly like it always did, before this call
                    // ever reaches the transport.
                    if (typeof Servers.validateId === 'function') Servers.validateId(id);
                    // Task 34: this call is no longer reached only from a
                    // deliberate user action (the old guard made every
                    // "nothing configured, id is local" case a no-op before
                    // this line). A REAL live Cockpit session caught this
                    // uncaught: PilotServers.setActive() rejects when
                    // /etc/pilot is not yet writable (e.g. superuser access
                    // has not been elevated in this session), and — with no
                    // try/catch here — that rejection was an unhandled
                    // exception on every ordinary page load with no active
                    // server, not merely a failed switch. Recorded so the
                    // shell can see it, but never blocks the wireApi() retry
                    // below: a stale/absent config.json is exactly what
                    // wireApi() already fails safe against on its own.
                    try { await Servers.setActive(id); this.switchError = null; }
                    catch (e) { this.switchError = e; }
                }
                return this.wireApi();
            },

            async init() {
                // Settings are per-user and optional: a first run with no file must
                // still render. PilotSettings.read() already falls back to defaults.
                if (root.PilotSettings && typeof root.PilotSettings.read === 'function') {
                    try {
                        this.settings = await root.PilotSettings.read();
                    } catch (e) {
                        this.settings = null;
                    }
                }
                // Without this the console is dead on arrival: every surface calls
                // through PilotApi, and nothing else ever sets its transport.
                try {
                    await this.wireApi();
                } catch (e) {
                    this.apiReady = false;
                    this.compatError = e;
                }
                return this;
            }
        };
    }

    const PilotApp = { TABS, RECONNECT_TIMEOUT_MS, pilotApp };
    root.PilotApp = PilotApp;
    // Alpine's x-data="pilotApp()" resolves against the global scope.
    root.pilotApp = pilotApp;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotApp;
})(typeof window !== 'undefined' ? window : globalThis);
