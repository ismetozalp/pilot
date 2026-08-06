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
    // CORRECTED WHOLESALE against the two swagger documents the server itself
    // ships and serves -- /opt/rustdesk-api/docs/admin/admin_swagger.json and
    // docs/api/api_swagger.json, both declaring basePath: /api -- and then
    // checked by HTTP against a live v2.7 instance.
    //
    // Every route in this table was previously wrong, in three independent
    // ways, and EVERY console surface 404'd against a real server:
    //   1. the /api base path was missing entirely from the admin half;
    //   2. the admin API is action-style (/peer/list, /peer/update,
    //      /peer/delete), not REST-style (/peer, /peer/{id});
    //   3. its mutations are all POST -- there is no PUT or DELETE anywhere in
    //      the admin surface.
    // The client half had its own errors: currentUser2 does not exist (it is
    // currentUser), and shared/profiles, peers and tags/{guid} are POST, not
    // GET. Measured directly:
    //   404 /admin/peer   404 /api/admin/peer   200 /api/admin/peer/list
    //   404 /api/currentUser2                   200 /api/currentUser
    // Nothing caught it because the e2e stub was written to serve whatever this
    // table asked for, so client and stub agreed on routes that exist nowhere.
    const ENDPOINTS = [
        // The client-surface probe. NOT /api/currentUser: the shipped
        // api_swagger.json declares it, but v2.7 does not route it -- measured
        // 404 with a valid Bearer while /api/peers answered 200 on the same
        // token. The swagger documents are a starting point, not the contract;
        // the running server is the contract, which is what
        // tests/e2e/live-api-contract.live.mjs exists to check.
        { id: 'session.current', method: 'GET', path: '/api/peers', admin: false, probe: true },
        { id: 'devices.list', method: 'GET', path: '/api/admin/peer/list', admin: true, probe: true },
        { id: 'devices.rename', method: 'POST', path: '/api/admin/peer/update', admin: true, probe: false },
        { id: 'devices.remove', method: 'POST', path: '/api/admin/peer/delete', admin: true, probe: false },
        // The personal address book has a REAL guid ("1-1-0" on the reference
        // server), and this is the only route that reveals it.
        // js/core/addressbook.js hardcodes PERSONAL.guid = '', so every
        // personal-book call went to /api/ab/peers?ab= and /api/ab/tags/ --
        // answered 400 and 404. The surface was unusable end to end.
        { id: 'ab.personal', method: 'POST', path: '/api/ab/personal', admin: false, probe: false },
        { id: 'ab.books', method: 'POST', path: '/api/ab/shared/profiles', admin: false, probe: false },
        { id: 'ab.peers', method: 'POST', path: '/api/ab/peers', admin: false, probe: false },
        { id: 'ab.addPeer', method: 'POST', path: '/api/ab/peer/add/{ab}', admin: false, probe: false },
        { id: 'ab.updatePeer', method: 'PUT', path: '/api/ab/peer/update/{ab}', admin: false, probe: false },
        // api_swagger.json declares DELETE at .../peer/add/{guid}. The running
        // server 404s that and routes it at .../peer/{guid} -- measured, both
        // ways. Same lesson as /admin/user/updatePassword and /api/currentUser:
        // the shipped swagger over-declares, and the server is the contract.
        { id: 'ab.removePeer', method: 'DELETE', path: '/api/ab/peer/{ab}', admin: false, probe: false },
        { id: 'ab.tags', method: 'POST', path: '/api/ab/tags/{ab}', admin: false, probe: false },
        { id: 'ab.addTag', method: 'POST', path: '/api/ab/tag/add/{ab}', admin: false, probe: false },
        { id: 'ab.renameTag', method: 'PUT', path: '/api/ab/tag/rename/{ab}', admin: false, probe: false },
        { id: 'ab.removeTag', method: 'DELETE', path: '/api/ab/tag/{ab}', admin: false, probe: false },
        { id: 'users.list', method: 'GET', path: '/api/admin/user/list', admin: true, probe: true },
        { id: 'users.create', method: 'POST', path: '/api/admin/user/create', admin: true, probe: false },
        { id: 'users.update', method: 'POST', path: '/api/admin/user/update', admin: true, probe: false },
        // Also NOT what admin_swagger.json says: it declares
        // /admin/user/updatePassword, which 404s. The routes v2.7 actually
        // serves are changePwd (an admin setting any user's password, by id)
        // and changeCurPwd (the caller's own, requiring the old one). changePwd
        // is the one both callers need -- the Users surface resetting someone
        // else's, and the setup wizard setting the admin's own straight after
        // logging in with the generated one.
        { id: 'users.password', method: 'POST', path: '/api/admin/user/changePwd', admin: true, probe: false },
        { id: 'users.groups', method: 'GET', path: '/api/admin/group/list', admin: true, probe: true },
        { id: 'audit.conn', method: 'GET', path: '/api/admin/audit_conn/list', admin: true, probe: true },
        { id: 'audit.file', method: 'GET', path: '/api/admin/audit_file/list', admin: true, probe: true },
        { id: 'audit.login', method: 'GET', path: '/api/admin/login_log/list', admin: true, probe: true },
        // The handover step's password change: log in with the generated
        // password to obtain an admin token, then set the chosen one.
        { id: 'admin.login', method: 'POST', path: '/api/admin/login', admin: false, probe: false }
    ].map(Object.freeze);

    const EP = {};
    ENDPOINTS.forEach(function (ep) { EP[ep.id] = ep; });

    function fail(kind, message, detail) { return Errors.create(kind, message, detail || {}); }
    function str(v) { return v === null || v === undefined ? '' : String(v); }

    // admin.UserForm and admin.UserPasswordForm both type `id` as an INTEGER.
    // Sending "1" where 1 is expected is rejected by the server's binder, so a
    // string id from the DOM is converted once, here, rather than at each site.
    function numId(v) {
        const n = typeof v === 'number' ? v : parseInt(str(v), 10);
        if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n)
            throw fail('GENERIC', 'a user id must be a non-negative integer', { value: str(v) });
        return n;
    }

    function probeTargets() { return ENDPOINTS.filter(function (ep) { return ep.probe; }); }

    function seg(value, opts) {
        let v = value;
        if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
        if (typeof v !== 'string') {
            throw fail('GENERIC', 'a path parameter must be a string or a finite number',
                { type: typeof value });
        }
        const allowEmpty = !!(opts && opts.allowEmpty);
        if (v === '' && !allowEmpty) throw fail('GENERIC', 'a path parameter must not be empty', {});
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
            // The address book id is the one path parameter that may legitimately
            // be '' -- js/core/addressbook.js's AB.PERSONAL.guid is '' by design,
            // meaning "the caller's own personal book" rather than "no book was
            // given". Every OTHER path parameter (a device, user or peer id) keeps
            // the strict "must not be empty" rule; only 'ab' is relaxed here.
            return seg(params[name], { allowEmpty: name === 'ab' });
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

    // Like text(), but for the address book id specifically: '' is a real value
    // (the personal book, AB.PERSONAL.guid === '' from js/core/addressbook.js),
    // not a missing one, so the non-empty check text() enforces for every OTHER
    // string parameter does not apply here.
    function abText(value) {
        if (typeof value !== 'string') {
            throw fail('GENERIC', 'an address book id must be a string', { type: typeof value });
        }
        if (CTRL.test(value)) {
            throw fail('GENERIC', 'an address book id contains a control character', {});
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
            // The admin API carries the target in the BODY, not the path -- it
            // has no /{id} routes and no PUT/DELETE at all. The device's own
            // name field is `alias` (admin.PeerForm); `name` is not a field the
            // server knows, so renaming used to write nothing even if the path
            // had existed.
            rename: function (id, name) {
                return guarded(function () {
                    return call('devices.rename', {
                        body: {
                            id: text(String(id === null || id === undefined ? '' : id), 'a device id'),
                            alias: text(name, 'a device name')
                        }
                    });
                });
            },
            remove: function (id) {
                return guarded(function () {
                    return call('devices.remove', {
                        body: { id: text(String(id === null || id === undefined ? '' : id), 'a device id') }
                    });
                });
            },
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
            // books()/peers()/tags() resolve to the RAW unwrapped `data` (e.g.
            // {profiles:[...]}, {peers:[...]}, {tags:[...]}) rather than being run
            // through asList()/listCall()+paginate(). Those two helpers assume the
            // {list, page, total, page_size} pagination envelope that devices.list/
            // users.list/users.groups/audit.* genuinely use -- but rustdesk's own
            // address book API answers with the differently-named keys above, no
            // pagination fields at all. Forcing that shape through paginate() silently
            // discarded every real payload (paginate() only ever looks at `.list`),
            // which nothing caught before Task 23 because this façade had no tests of
            // its own for the addressbook methods and every existing addressbook-ui
            // test drives a fully fake facade. js/core/addressbook.js's booksFrom/
            // peersFrom/tagsFrom are already built to dig through whichever of these
            // keys (or a bare array, or one more level of {data:...}) is actually
            // there, which is exactly why the interface here is documented as
            // "-> Promise<any>" rather than a pinned shape.
            personal: function () { return call('ab.personal'); },
            // The personal book is NOT in shared/profiles -- it is a separate
            // call -- so "the books you can use" is the union of the two. One
            // failing must not lose the other: a server with no shared books
            // still has a personal one, and vice versa.
            books: function () {
                return Promise.all([
                    call('ab.personal').then(function (v) { return v; }, function () { return null; }),
                    call('ab.books').then(function (v) { return v; }, function () { return null; })
                ]).then(function (pair) {
                    const profiles = [];
                    const mine = pair[0];
                    if (mine && typeof mine === 'object' && str(mine.guid) !== '') {
                        profiles.push({ guid: str(mine.guid),
                            name: str(mine.name) || 'Personal', personal: true });
                    }
                    const shared = pair[1];
                    const rest = (shared && typeof shared === 'object' && Array.isArray(shared.data))
                        ? shared.data : (Array.isArray(shared) ? shared : []);
                    rest.forEach(function (b) { if (b) profiles.push(b); });
                    return { profiles: profiles };
                });
            },
            peers: function (ab) {
                return guarded(function () {
                    return call('ab.peers', { query: { ab: abText(ab) } });
                });
            },
            // A SINGLE peer object, not an array. The server answers an array
            // with 400 "cannot unmarshal array into Go value of type
            // api.PeerForm" -- which is what "Add to address book" reported.
            addPeer: function (ab, peer) {
                return guarded(function () {
                    return call('ab.addPeer', { params: { ab: ab }, body: plain(peer, 'a peer') });
                });
            },
            updatePeer: function (ab, peer) {
                return guarded(function () {
                    // Single object, like addPeer -- an array is a 400.
                    return call('ab.updatePeer', { params: { ab: ab }, body: plain(peer, 'a peer') });
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
            tags: function (ab) { return call('ab.tags', { params: { ab: ab } }); },
            addTag: function (ab, tag) {
                return guarded(function () {
                    // {name}, not an array and not a bare string: the server
                    // rejects both with "cannot unmarshal ... into Go value".
                    return call('ab.addTag', { params: { ab: ab }, body: { name: text(tag, 'a tag') } });
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
                    return call('users.update', { body: plain(u, 'a user') });
                });
            },
            // guarded(): numId() throws while BUILDING the body, before call()
            // is ever entered, so its own try/catch cannot see it. Without this
            // an empty id would be an uncaught synchronous exception out of a
            // click handler rather than a typed rejection the surface renders.
            setEnabled: function (id, on) {
                return guarded(function () {
                    return call('users.update', { body: { id: numId(id), status: on ? 1 : 0 } });
                });
            },
            // A DEDICATED endpoint: /admin/user/update has no password field at
            // all (admin.UserForm), so sending one there changed nothing and
            // reported success. /admin/user/updatePassword is the only route
            // that sets a password, and its id is an integer, not a string.
            resetPassword: function (id, pw) {
                return guarded(function () {
                    return call('users.password',
                        { body: { id: numId(id), password: text(pw, 'a password') } });
                });
            },
            groups: function () { return call('users.groups').then(asList); },
            // group_id is a uint in admin.UserForm. Sending the string a
            // <select> yields is rejected outright: "cannot unmarshal string
            // into Go struct field UserForm.group_id of type uint". '' means
            // "no group", which the server spells 0.
            setGroup: function (id, gid) {
                return guarded(function () {
                    const g = (gid === '' || gid === null || gid === undefined) ? 0 : numId(gid);
                    return call('users.update', { body: { id: numId(id), group_id: g } });
                });
            },
            // Obtain an admin token from a username/password. Used by the setup
            // wizard's handover step, which has no token yet: the server it just
            // installed generated its own admin password and nothing has been
            // configured.
            login: function (username, password) {
                return guarded(function () {
                    return call('admin.login', {
                        body: {
                            username: text(username, 'a username'),
                            password: text(password, 'a password')
                        }
                    });
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
