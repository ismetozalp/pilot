// boot.js — inject the modal partials into #pilot-partials, THEN load Alpine so it
// walks a complete DOM. Order is the whole trick (see hangar/js/boot.js).
//
// Declares exactly five names: PARTIALS, loadScript, fetchPartial, boot, PilotBoot.
// A later task adds a modal by inserting a string into the PARTIALS array literal
// after the comment inside it — never by re-declaring PARTIALS.
'use strict';
(function (root) {

    var PARTIALS = [
        'html/modals/update.html',
        // Modal partials are appended here as feature tasks create them.
    ];

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = src;
            s.onload = function () { resolve(); };
            s.onerror = function () { reject(new Error('failed to load ' + src)); };
            document.head.appendChild(s);
        });
    }

    function fetchPartial(p) {
        return fetch(p, { cache: 'no-cache' }).then(function (r) {
            if (!r.ok) throw new Error(p + ' -> HTTP ' + r.status);
            return r.text();
        });
    }

    function boot(doc) {
        var host = doc.getElementById('pilot-partials');
        return Promise.allSettled(PARTIALS.map(fetchPartial)).then(function (results) {
            var html = results.map(function (res, i) {
                if (res.status === 'fulfilled') return res.value;
                // A missing partial must not stop the plugin loading — the affected
                // modal simply will not open, and the console says which one.
                console.error('[pilot] partial failed:', PARTIALS[i], res.reason);
                return '';
            }).join('\n');
            // Trusted first-party templates only, same-origin under strict CSP.
            if (host) host.insertAdjacentHTML('beforeend', html);
        }).catch(function (e) {
            console.error('[pilot] partial injection error:', e);
        }).then(function () {
            return loadScript('js/alpine.min.js');
        }).catch(function (e) {
            console.error('[pilot] Alpine failed to start:', e);
        });
    }

    var PilotBoot = { PARTIALS: PARTIALS, loadScript: loadScript, fetchPartial: fetchPartial, boot: boot };
    root.PilotBoot = PilotBoot;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotBoot;

    // Guarded so `require('js/boot.js')` under node is inert and testable.
    if (typeof document !== 'undefined' && typeof fetch === 'function') boot(document);
})(typeof window !== 'undefined' ? window : globalThis);
