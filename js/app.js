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
                    return null;
                }

                try {
                    const rec = await Servers.read(id);
                    let token = null;
                    try {
                        token = await Servers.readSecret(id, 'token');
                    } catch (e) {
                        token = null;
                    }
                    const conn = { address: rec.host, port: rec.apiPort, tls: rec.tls, token: token };
                    const send = Io.transport(conn);
                    Api.setTransport(send);
                    this.activeServerId = id;
                    this.apiReady = true;

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
