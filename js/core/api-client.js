// core/api-client.js — the one API façade every surface uses (C12).
//
// Entirely pure: no bridge access, no token, no URL knowledge beyond the route table.
// PilotApi.setTransport(fn) is given PilotApiIo.transport(conn) at wiring time;
// under test it is given a recorder. Surfaces call PilotApi.* and nothing else.
//
// The route table below is the SINGLE place any path lives. The compatibility
// probe in servers.js walks probeTargets() from this same table, so a route Pilot
// depends on cannot silently diverge from the route the probe checks.
'use strict';
(function (root) {
    const Errors = (typeof module !== 'undefined' && module.exports)
        ? require('./errors.js')
        : root.PilotErrors;

    const CTRL = /[\x00-\x1f\x7f]/;
    const QUERY_NAME = /^[A-Za-z0-9_.-]+$/;
    const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
    const MAX_PATH_LEN = 2048;
    const MAX_SEG_LEN = 256;

    // api-client decides WHICH header carries the credential; api-io supplies the
    // value. Verified against rustdesk-api v2.7: admin uses api-token with no
    // Bearer prefix (C12).
    const AUTH = {
        admin: Object.freeze({ header: 'api-token', scheme: '' }),
        user: Object.freeze({ header: 'Authorization', scheme: 'Bearer ' })
    };

    // probe: true means "GET it during the compatibility probe". Only parameterless
    // GETs qualify — the probe must never mutate anything.
    const ENDPOINTS = [
        { id: 'session.current', method: 'GET', path: '/api/currentUser2', admin: false, probe: true },
        { id: 'devices.list', method: 'GET', path: '/admin/peer', admin: true, probe: true },
        { id: 'devices.rename', method: 'PUT', path: '/admin/peer/{id}', admin: true, probe: false },
        { id: 'devices.remove', method: 'DELETE', path: '/admin/peer/{id}', admin: true, probe: false },
        { id: 'ab.books', method: 'GET', path: '/api/ab/shared/profiles', admin: false, probe: true },
        { id: 'ab.peers', method: 'GET', path: '/api/ab/peers', admin: false, probe: true },
        { id: 'ab.addPeer', method: 'POST', path: '/api/ab/peer/add/{ab}', admin: false, probe: false },
        { id: 'ab.updatePeer', method: 'PUT', path: '/api/ab/peer/update/{ab}', admin: false, probe: false },
        { id: 'ab.removePeer', method: 'DELETE', path: '/api/ab/peer/{ab}', admin: false, probe: false },
        { id: 'ab.tags', method: 'GET', path: '/api/ab/tags/{ab}', admin: false, probe: false },
        { id: 'ab.addTag', method: 'POST', path: '/api/ab/tag/add/{ab}', admin: false, probe: false },
        { id: 'ab.renameTag', method: 'PUT', path: '/api/ab/tag/rename/{ab}', admin: false, probe: false },
        { id: 'ab.removeTag', method: 'DELETE', path: '/api/ab/tag/{ab}', admin: false, probe: false },
        { id: 'users.list', method: 'GET', path: '/admin/user', admin: true, probe: true },
        { id: 'users.create', method: 'POST', path: '/admin/user', admin: true, probe: false },
        { id: 'users.update', method: 'PUT', path: '/admin/user/{id}', admin: true, probe: false },
        { id: 'users.groups', method: 'GET', path: '/admin/group', admin: true, probe: true },
        { id: 'audit.conn', method: 'GET', path: '/admin/audit_conn', admin: true, probe: true },
        { id: 'audit.file', method: 'GET', path: '/admin/audit_file', admin: true, probe: true },
        { id: 'audit.login', method: 'GET', path: '/admin/login_log', admin: true, probe: true }
    ].map(Object.freeze);

    const EP = {};
    ENDPOINTS.forEach(function (ep) { EP[ep.id] = ep; });

    function fail(kind, message, detail) { return Errors.create(kind, message, detail || {}); }
    function str(v) { return v === null || v === undefined ? '' : String(v); }

    function probeTargets() { return ENDPOINTS.filter(function (ep) { return ep.probe; }); }

    function seg(value) {
        let v = value;
        if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
        if (typeof v !== 'string') {
            throw fail('GENERIC', 'a path parameter must be a string or a finite number',
                { type: typeof value });
        }
        if (v === '') throw fail('GENERIC', 'a path parameter must not be empty', {});
        if (v.length > MAX_SEG_LEN) {
            throw fail('GENERIC', 'a path parameter is too long',
                { length: v.length, max: MAX_SEG_LEN });
        }
        if (CTRL.test(v)) {
            throw fail('GENERIC', 'a path parameter contains a control character',
                { value: JSON.stringify(v) });
        }
        return encodeURIComponent(v);
    }

    function encodeQuery(q) {
        if (q === null || q === undefined) return '';
        if (typeof q !== 'object' || Array.isArray(q)) {
            throw fail('GENERIC', 'a query must be a plain object',
                { type: Array.isArray(q) ? 'array' : typeof q });
        }
        const parts = [];
        Object.keys(q).sort().forEach(function (name) {
            if (!QUERY_NAME.test(name)) {
                throw fail('GENERIC', 'invalid query parameter name', { name: JSON.stringify(name) });
            }
            const value = q[name];
            if (value === null || value === undefined) return;
            (Array.isArray(value) ? value : [value]).forEach(function (one) {
                const t = typeof one;
                if (t !== 'string' && t !== 'number' && t !== 'boolean') {
                    throw fail('GENERIC', 'a query value must be a string, number or boolean',
                        { name: name, type: t });
                }
                if (t === 'number' && !Number.isFinite(one)) {
                    throw fail('GENERIC', 'a query value must be a finite number', { name: name });
                }
                parts.push(encodeURIComponent(name) + '=' + encodeURIComponent(String(one)));
            });
        });
        return parts.length ? '?' + parts.join('&') : '';
    }

    function buildRequest(req) {
        const r = req && typeof req === 'object' && !Array.isArray(req) ? req : null;
        if (!r) {
            throw fail('GENERIC', 'a request must be an object',
                { type: Array.isArray(req) ? 'array' : typeof req });
        }
        const method = (str(r.method) || 'GET').toUpperCase();
        if (METHODS.indexOf(method) === -1) {
            throw fail('GENERIC', 'unsupported HTTP method', { method: JSON.stringify(method) });
        }
        const path = str(r.path);
        if (path.charAt(0) !== '/') {
            throw fail('GENERIC', 'request path must start with "/"', { path: JSON.stringify(path) });
        }
        if (CTRL.test(path)) {
            throw fail('GENERIC', 'request path contains a control character',
                { path: JSON.stringify(path) });
        }
        // A route-templated path never contains a literal ".." segment of its own;
        // a hostile id can only ever appear percent-encoded (seg() escapes "/"), so
        // checking whole segments — not a bare substring search — cannot be fooled
        // by an encoded value that merely contains two dots (e.g. "..%2Fetc").
        if (path.split('/').indexOf('..') !== -1) {
            throw fail('GENERIC', 'request path must not contain a ".." segment', { path: path });
        }
        if (path.length > MAX_PATH_LEN) {
            throw fail('GENERIC', 'request path is too long',
                { length: path.length, max: MAX_PATH_LEN });
        }
        const wire = {
            method: method,
            path: path + encodeQuery(r.query),
            headers: {},
            body: null,
            auth: r.admin === true ? AUTH.admin : AUTH.user
        };
        if (r.body !== undefined && r.body !== null) {
            let text;
            try {
                text = JSON.stringify(r.body);
            } catch (e) {
                throw fail('GENERIC', 'the request body cannot be serialised as JSON',
                    { reason: str(e && e.message) });
            }
            if (text === undefined) {
                throw fail('GENERIC', 'the request body cannot be serialised as JSON',
                    { reason: 'value is not representable' });
            }
            wire.body = text;
            wire.headers['Content-Type'] = 'application/json';
        }
        return wire;
    }

    // The server answers HTTP 200 even on failure, with {code, message, data};
    // code !== 0 is an error (C12). A real non-2xx therefore means something
    // structural: 404 is a missing route, i.e. a version mismatch.
    function numeric(code) {
        if (typeof code === 'number') return Number.isFinite(code) ? code : NaN;
        if (typeof code === 'string' && /^-?\d+$/.test(code)) return Number(code);
        return NaN;
    }

    function errorKindFor(status, code, message) {
        const s = Number.isFinite(Number(status)) ? Number(status) : 0;
        if (s === 401 || s === 403) return 'API_AUTH_FAILED';
        if (s === 404 || s === 501) return 'API_VERSION_MISMATCH';
        if (s === 0 || s >= 500) return 'API_UNREACHABLE';
        if (s < 200 || s >= 300) return 'GENERIC';
        if (code === null || code === undefined) return 'OK';
        const n = numeric(code);
        if (n === 0) return 'OK';
        const m = str(message).toLowerCase();
        if (/token|unauthor|login|permission|forbidden|expired|credential/.test(m)) {
            return 'API_AUTH_FAILED';
        }
        return 'GENERIC';
    }

    function unwrap(res, path) {
        if (!res || typeof res !== 'object' || Array.isArray(res)) {
            throw fail('GENERIC', 'the API returned no usable response',
                { path: path || null, type: Array.isArray(res) ? 'array' : typeof res });
        }
        const status = Number.isInteger(res.status) ? res.status : 0;
        const body = res.body;
        const envelope = !!body && typeof body === 'object' && !Array.isArray(body);
        const code = envelope && 'code' in body ? body.code : null;
        const message = envelope ? str(body.message) : '';
        const kind = errorKindFor(status, code, message);
        if (kind === 'OK') {
            if (body === null || body === undefined || body === '') return null;
            if (typeof body === 'string') {
                throw fail('GENERIC', 'the API returned a non-JSON response for ' + (path || 'the request'),
                    { path: path || null, status: status, snippet: body.slice(0, 200) });
            }
            return envelope && 'data' in body ? body.data : body;
        }
        const detail = {
            path: path || null,
            status: status,
            code: code === null || code === undefined ? null : code,
            snippet: typeof body === 'string' ? body.slice(0, 200) : null
        };
        const text = message || (kind === 'API_VERSION_MISMATCH'
            ? 'the API server has no endpoint ' + (path || '')
            : 'the API request failed');
        return (function () {
            throw fail(kind, text + ' (' + (path || '?') + ')', detail);
        })();
    }

    function intOr(value, fallback) {
        const n = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return fallback;
        return Math.floor(n);
    }

    function paginate(data) {
        const d = data && typeof data === 'object' ? data : {};
        const list = Array.isArray(d.list) ? d.list : (Array.isArray(data) ? data : []);
        return {
            list: list,
            page: intOr(d.page, 1),
            total: intOr(d.total, list.length),
            pageSize: intOr(d.page_size, list.length)
        };
    }

    // ------------------------------------------------------------- the façade ---

    let transportFn = null;

    function typedError(e) {
        if (e && typeof e.kind === 'string' && Errors.KIND[e.kind]) return e;
        return fail('GENERIC', str(e && e.message) || 'the API request failed', {});
    }

    function setTransport(fn) {
        if (fn === null || fn === undefined) { transportFn = null; return; }
        if (typeof fn !== 'function') {
            throw fail('GENERIC', 'a transport must be a function', { type: typeof fn });
        }
        transportFn = fn;
    }

    function request(req) {
        let wire;
        try {
            wire = buildRequest(req);
        } catch (e) {
            return Promise.reject(typedError(e));
        }
        if (typeof transportFn !== 'function') {
            return Promise.reject(fail('API_UNREACHABLE', 'no API transport is configured',
                { path: wire.path }));
        }
        let pending;
        try {
            pending = transportFn(wire);
        } catch (e) {
            return Promise.reject(typedError(e));
        }
        return Promise.resolve(pending).then(function (res) {
            return unwrap(res, wire.path);
        }, function (e) {
            throw typedError(e);
        });
    }

    function fill(ep, params) {
        return ep.path.replace(/\{(\w+)\}/g, function (whole, name) {
            if (!params || !(name in params)) {
                throw fail('GENERIC', 'missing path parameter "' + name + '"', { endpoint: ep.id });
            }
            return seg(params[name]);
        });
    }

    function call(id, options) {
        const ep = EP[id];
        const o = options || {};
        let path;
        try {
            path = fill(ep, o.params);
        } catch (e) {
            return Promise.reject(typedError(e));
        }
        return request({ method: ep.method, path: path, query: o.query, body: o.body, admin: ep.admin });
    }

    // The surfaces speak camelCase; the server speaks page_size.
    function normQuery(q) {
        if (q === null || q === undefined) return null;
        if (typeof q !== 'object' || Array.isArray(q)) {
            throw fail('GENERIC', 'a query must be a plain object',
                { type: Array.isArray(q) ? 'array' : typeof q });
        }
        const out = {};
        Object.keys(q).forEach(function (k) { out[k === 'pageSize' ? 'page_size' : k] = q[k]; });
        return out;
    }

    function listCall(id, q, params) {
        let query;
        try {
            query = normQuery(q);
        } catch (e) {
            return Promise.reject(typedError(e));
        }
        return call(id, { query: query, params: params }).then(paginate);
    }

    function asList(data) {
        if (Array.isArray(data)) return data;
        return paginate(data).list;
    }

    function plain(value, what) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw fail('GENERIC', what + ' must be an object',
                { type: Array.isArray(value) ? 'array' : typeof value });
        }
        return value;
    }

    function text(value, what) {
        if (typeof value !== 'string' || value === '') {
            throw fail('GENERIC', what + ' must be a non-empty string', { type: typeof value });
        }
        if (CTRL.test(value)) {
            throw fail('GENERIC', what + ' contains a control character', {});
        }
        return value;
    }

    function guarded(fn) {
        try {
            return fn();
        } catch (e) {
            return Promise.reject(typedError(e));
        }
    }

    const PilotApi = {
        setTransport: setTransport,
        request: request,
        devices: {
            list: function (q) { return listCall('devices.list', q); },
            rename: function (id, name) {
                return guarded(function () {
                    return call('devices.rename', {
                        params: { id: id },
                        body: { id: text(String(id === null || id === undefined ? '' : id), 'a device id'), name: text(name, 'a device name') }
                    });
                });
            },
            remove: function (id) { return call('devices.remove', { params: { id: id } }); },
            addToAddressBook: function (id, ab) {
                return guarded(function () {
                    return call('ab.addPeer', {
                        params: { ab: ab },
                        body: [{ id: text(String(id === null || id === undefined ? '' : id), 'a device id') }]
                    });
                });
            }
        },
        addressbook: {
            books: function () { return call('ab.books').then(asList); },
            peers: function (ab) {
                return guarded(function () {
                    return listCall('ab.peers', { ab: text(ab, 'an address book id') });
                });
            },
            addPeer: function (ab, peer) {
                return guarded(function () {
                    return call('ab.addPeer', { params: { ab: ab }, body: [plain(peer, 'a peer')] });
                });
            },
            updatePeer: function (ab, peer) {
                return guarded(function () {
                    return call('ab.updatePeer', { params: { ab: ab }, body: [plain(peer, 'a peer')] });
                });
            },
            removePeer: function (ab, id) {
                return guarded(function () {
                    return call('ab.removePeer', {
                        params: { ab: ab },
                        body: [text(String(id === null || id === undefined ? '' : id), 'a peer id')]
                    });
                });
            },
            tags: function (ab) { return call('ab.tags', { params: { ab: ab } }).then(asList); },
            addTag: function (ab, tag) {
                return guarded(function () {
                    return call('ab.addTag', { params: { ab: ab }, body: [text(tag, 'a tag')] });
                });
            },
            renameTag: function (ab, from, to) {
                return guarded(function () {
                    return call('ab.renameTag', {
                        params: { ab: ab },
                        body: { old: text(from, 'the old tag'), new: text(to, 'the new tag') }
                    });
                });
            },
            removeTag: function (ab, tag) {
                return guarded(function () {
                    return call('ab.removeTag', { params: { ab: ab }, body: [text(tag, 'a tag')] });
                });
            }
        },
        users: {
            list: function (q) { return listCall('users.list', q); },
            create: function (u) {
                return guarded(function () {
                    return call('users.create', { body: plain(u, 'a user') });
                });
            },
            update: function (u) {
                return guarded(function () {
                    const user = plain(u, 'a user');
                    return call('users.update', { params: { id: user.id }, body: user });
                });
            },
            setEnabled: function (id, on) {
                return call('users.update', {
                    params: { id: id },
                    body: { id: str(id), status: on ? 1 : 0 }
                });
            },
            resetPassword: function (id, pw) {
                return guarded(function () {
                    return call('users.update', {
                        params: { id: id },
                        body: { id: str(id), password: text(pw, 'a password') }
                    });
                });
            },
            groups: function () { return call('users.groups').then(asList); },
            setGroup: function (id, gid) {
                return call('users.update', {
                    params: { id: id },
                    body: { id: str(id), group_id: gid }
                });
            }
        },
        audit: {
            conn: function (q) { return listCall('audit.conn', q); },
            file: function (q) { return listCall('audit.file', q); },
            login: function (q) { return listCall('audit.login', q); }
        }
    };

    const PilotApiClient = {
        AUTH: AUTH,
        ENDPOINTS: ENDPOINTS,
        EP: EP,
        probeTargets: probeTargets,
        seg: seg,
        encodeQuery: encodeQuery,
        buildRequest: buildRequest,
        errorKindFor: errorKindFor,
        unwrap: unwrap,
        paginate: paginate,
        PilotApi: PilotApi
    };
    root.PilotApiClient = PilotApiClient;
    root.PilotApi = PilotApi;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotApiClient;
})(typeof window !== 'undefined' ? window : globalThis);
