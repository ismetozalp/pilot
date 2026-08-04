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
    const TABS = [
        { id: 'overview',    label: 'Overview',     mount: 'pilot-overview' },
        { id: 'setup',       label: 'Setup',        mount: 'pilot-setup' },
        { id: 'devices',     label: 'Devices',      mount: 'pilot-devices' },
        { id: 'addressbook', label: 'Address Book', mount: 'pilot-addressbook' },
        { id: 'users',       label: 'Users',        mount: 'pilot-users' },
        { id: 'audit',       label: 'Audit',        mount: 'pilot-audit' },
        { id: 'server-ops',  label: 'Server Ops',   mount: 'pilot-server-ops' }
    ];

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
            activeServerId: null,
            apiReady: false,
            compatError: null,
            // Set only when the SECRET FILE ITSELF could not be read (e.g. a
            // permissions problem on the 0600 file) — never for the ordinary
            // case of no token configured, which PilotServers.readSecret()
            // already reports as a plain `null`, not a rejection. Wiring still
            // fails safe to an anonymous request either way; this is what lets
            // that be told apart from "no token was ever set" after the fact.
            tokenError: null,

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
                    const rec = await Servers.read(id);
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
                    const conn = { address: rec.host, port: rec.apiPort, tls: rec.tls, token: token };
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
            async switchServer(id) {
                const Servers = root.PilotServers;
                if (Servers && typeof Servers.setActive === 'function') {
                    await Servers.setActive(id);
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

    const PilotApp = { TABS, pilotApp };
    root.PilotApp = PilotApp;
    // Alpine's x-data="pilotApp()" resolves against the global scope.
    root.pilotApp = pilotApp;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotApp;
})(typeof window !== 'undefined' ? window : globalThis);
