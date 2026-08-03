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
