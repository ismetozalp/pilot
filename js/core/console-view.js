// core/console-view.js — presentation helpers shared by the read-only console
// surfaces (Users & groups, Audit): turning an arbitrary API value into
// something safe to render, finding a row id across the key spellings the API
// server uses, unwrapping a paginated payload, turning a rejected promise into
// a screen alert, and injecting a template into its host element.
//
// Pure except mountInto, which touches only a caller-supplied document and
// degrades to false when there is none. No bridge reference of any kind.
'use strict';
(function (root) {
    const CONTROL_G = /[\x00-\x1f\x7f]/g;
    const CONTROL_ONE = /[\x00-\x1f\x7f]/;
    const MAX_TEXT = 512;
    const ID_KEYS = ['id', 'uuid', 'guid', 'user_id', 'device_id', 'peer_id'];

    // Any API value becomes a single-line, control-character-free, length-bounded
    // string, or nothing. Objects become '' rather than "[object Object]".
    function text(value) {
        let s;
        if (typeof value === 'string') s = value;
        else if (typeof value === 'number') s = isFinite(value) ? String(value) : '';
        else if (typeof value === 'boolean') s = value ? 'true' : 'false';
        else return '';
        const flat = s.replace(CONTROL_G, ' ').replace(/\s+/g, ' ').trim();
        return flat.length > MAX_TEXT ? flat.slice(0, MAX_TEXT) : flat;
    }

    function hasControl(value) {
        return typeof value === 'string' && CONTROL_ONE.test(value);
    }

    function first(obj, keys) {
        if (!obj || typeof obj !== 'object' || !Array.isArray(keys)) return null;
        for (const k of keys) {
            const v = obj[k];
            if (v !== undefined && v !== null && v !== '') return v;
        }
        return null;
    }

    function idOf(row, keys) {
        if (!row || typeof row !== 'object') return '';
        const list = Array.isArray(keys) && keys.length ? keys : ID_KEYS;
        for (const k of list) {
            const v = text(row[k]);
            if (v !== '') return v;
        }
        return '';
    }

    function count(value) {
        let n = NaN;
        if (typeof value === 'number') n = value;
        else if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) n = Number(value.trim());
        return (isFinite(n) && n >= 0) ? Math.floor(n) : null;
    }

    function clampInt(value, min, max, fallback) {
        let n = NaN;
        if (typeof value === 'number') n = value;
        else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
        if (!isFinite(n)) return fallback;
        const i = Math.floor(n);
        if (i < min) return min;
        if (i > max) return max;
        return i;
    }

    // C12 pins that the server answers 200 with {code,message,data} and that a
    // paginated payload is {list,page,total,page_size}, but not whether
    // PilotApi.request hands back `data` or the whole document. Accept both, plus
    // a bare array, so this helper cannot go out of step with the façade.
    function page(payload) {
        const empty = { list: [], page: 1, total: 0, pageSize: 0 };
        if (Array.isArray(payload))
            return { list: payload.slice(), page: 1, total: payload.length, pageSize: payload.length };
        if (!payload || typeof payload !== 'object') return empty;
        const body = (payload.data && typeof payload.data === 'object') ? payload.data : payload;
        if (Array.isArray(body))
            return { list: body.slice(), page: 1, total: body.length, pageSize: body.length };
        const list = Array.isArray(body.list) ? body.list.slice()
            : (Array.isArray(body.rows) ? body.rows.slice() : []);
        const size = body.page_size === undefined ? body.pageSize : body.page_size;
        return {
            list: list,
            page: clampInt(body.page, 1, 1000000, 1),
            total: clampInt(body.total, 0, 100000000, list.length),
            pageSize: clampInt(size, 0, 100000, list.length)
        };
    }

    // The button a typed error earns. '' means "nothing the screen can honour".
    const REMEDIATION_LABEL = {
        retry: 'Try again',
        reauthorize: 'Sign in again',
        'manual-mode': 'Show manual steps',
        'fix-dns': 'Fix DNS',
        'open-ports': 'Open ports',
        'hard-stop': '',
        none: ''
    };

    function errorView(err, context) {
        const Errors = root.PilotErrors || null;
        const raw = (err && typeof err === 'object') ? err.kind : null;
        const kind = (Errors && typeof Errors.normalize === 'function')
            ? Errors.normalize(raw) : (text(raw) || 'UNKNOWN');
        const remediation = (Errors && typeof Errors.remediation === 'function')
            ? Errors.remediation(kind) : 'none';
        return {
            context: text(context),
            kind: kind,
            message: text(err && err.message) || kind,
            detail: text(err && err.detail),
            remediation: remediation,
            actionLabel: REMEDIATION_LABEL[remediation] || ''
        };
    }

    // index.html ships empty host divs; each surface injects its own markup
    // before boot.js loads Alpine. `html` is always a module constant.
    function mountInto(doc, hostId, html) {
        const d = doc || root.document || null;
        if (!d || typeof d.getElementById !== 'function') return false;
        const host = d.getElementById(hostId);
        if (!host || host.getAttribute('data-pilot-mounted')) return false;
        host.setAttribute('data-pilot-mounted', '1');
        host.insertAdjacentHTML('beforeend', html);
        return true;
    }

    const PilotConsoleView = {
        MAX_TEXT, REMEDIATION_LABEL,
        text, hasControl, first, idOf, count, clampInt, page, errorView, mountInto
    };
    root.PilotConsoleView = PilotConsoleView;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotConsoleView;
})(typeof window !== 'undefined' ? window : globalThis);
