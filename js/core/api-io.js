// core/api-io.js — the ONLY module in Pilot that touches cockpit.http.
//
// Everything above it (api-client.js, every surface) is pure and never sees a
// channel. Everything here is either a pure helper or the one thin transport
// function C12's PilotApi.setTransport(fn) expects.
//
// Two deliberate decisions live here:
//  * A non-2xx HTTP response RESOLVES with its real status. The API server answers
//    200 even on failure, so a real 404 means "that route does not exist" — which
//    is exactly what the compatibility probe needs to see. Only channel-level
//    failures (no bridge, no address capability, timeout) reject.
//  * The API token never leaves this file. api-client emits an AuthMarker naming
//    the header and the prefix; this module supplies the value.
'use strict';
(function (root) {
    const Errors = (typeof module !== 'undefined' && module.exports)
        ? require('./errors.js')
        : root.PilotErrors;

    const DEFAULT_TIMEOUT_MS = 20000;
    const MAX_BODY_BYTES = 4 * 1024 * 1024;

    // Escapes only — a literal control byte in a regex is invisible and does not
    // survive copy-paste (C9).
    const CTRL = /[\x00-\x1f\x7f]/;
    const BAD_ADDRESS = /[\x00-\x1f\x7f\s/\\?#@[\]]/;
    const HEADER_NAME = /^[A-Za-z0-9-]+$/;
    const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

    // Cockpit channel problems, mapped to C6 kinds. "not-supported" is what the
    // bridge reports when the http-stream2 channel asks for the "address"
    // capability and the bridge cannot provide it (spec §2.8).
    const PROBLEM_KIND = {
        'not-supported': 'BRIDGE_NO_ADDRESS_CAP',
        'authentication-failed': 'API_AUTH_FAILED',
        'access-denied': 'API_AUTH_FAILED',
        'not-found': 'API_UNREACHABLE',
        'no-host': 'API_UNREACHABLE',
        'unknown-host': 'API_UNREACHABLE',
        'unknown-hostkey': 'API_UNREACHABLE',
        timeout: 'API_UNREACHABLE',
        disconnected: 'API_UNREACHABLE',
        terminated: 'API_UNREACHABLE',
        'protocol-error': 'API_UNREACHABLE',
        'internal-error': 'API_UNREACHABLE'
    };

    function fail(kind, message, detail) {
        return Errors.create(kind, message, detail || {});
    }

    function str(v) { return v === null || v === undefined ? '' : String(v); }

    function httpOptions(conn) {
        const c = conn && typeof conn === 'object' ? conn : {};
        if (typeof c.address !== 'string') {
            throw fail('GENERIC', 'server address must be a string',
                { field: 'address', type: typeof c.address });
        }
        const address = c.address.trim();
        if (!address) throw fail('GENERIC', 'server address is required', { field: 'address' });
        if (address.length > 255) {
            throw fail('GENERIC', 'server address is too long',
                { field: 'address', length: address.length, max: 255 });
        }
        if (BAD_ADDRESS.test(address)) {
            throw fail('GENERIC', 'server address contains a character that is not allowed in a host',
                { field: 'address', address: JSON.stringify(address) });
        }
        const port = c.port;
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
            throw fail('GENERIC', 'server port must be an integer between 1 and 65535',
                { field: 'port', port: typeof port === 'number' ? port : typeof port });
        }
        const opts = { address, port };
        if (c.tls) opts.tls = {};
        return opts;
    }

    function applyAuth(headers, auth, token) {
        if (!auth || typeof auth !== 'object') return headers;
        const name = str(auth.header);
        const value = str(token);
        if (!name || !value) return headers;
        if (!HEADER_NAME.test(name)) {
            throw fail('GENERIC', 'the auth header name is not a valid header name', { header: name });
        }
        if (CTRL.test(value)) {
            throw fail('GENERIC', 'the API token contains a control character', { header: name });
        }
        headers[name] = str(auth.scheme) + value;
        return headers;
    }

    function normalizeWire(req, token) {
        if (!req || typeof req !== 'object' || Array.isArray(req)) {
            throw fail('GENERIC', 'a request must be an object',
                { type: Array.isArray(req) ? 'array' : typeof req });
        }
        const method = (str(req.method) || 'GET').toUpperCase();
        if (METHODS.indexOf(method) === -1) {
            throw fail('GENERIC', 'unsupported HTTP method', { method: JSON.stringify(method) });
        }
        const path = str(req.path);
        if (path.charAt(0) !== '/') {
            throw fail('GENERIC', 'request path must start with "/"', { path: JSON.stringify(path) });
        }
        if (path.charAt(1) === '/') {
            throw fail('GENERIC', 'request path must not be protocol-relative',
                { path: JSON.stringify(path) });
        }
        if (CTRL.test(path)) {
            throw fail('GENERIC', 'request path contains a control character',
                { path: JSON.stringify(path) });
        }
        const headers = { Accept: 'application/json' };
        const given = req.headers && typeof req.headers === 'object' ? req.headers : {};
        Object.keys(given).forEach(function (key) {
            if (!HEADER_NAME.test(key)) throw fail('GENERIC', 'invalid header name', { header: key });
            const value = str(given[key]);
            if (CTRL.test(value)) {
                throw fail('GENERIC', 'header value contains a control character', { header: key });
            }
            headers[key] = value;
        });
        const body = req.body === null || req.body === undefined ? null : str(req.body);
        if (body !== null && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
        applyAuth(headers, req.auth, token);
        return { method: method, path: path, headers: headers, body: body };
    }

    function parseBody(text) {
        if (text === null || text === undefined) return null;
        if (typeof text === 'object') return text;
        const s = String(text);
        if (s.length > MAX_BODY_BYTES) {
            throw fail('GENERIC', 'the API response is too large to parse',
                { bytes: s.length, max: MAX_BODY_BYTES });
        }
        const t = s.trim();
        if (t === '') return null;
        if (t.charAt(0) !== '{' && t.charAt(0) !== '[') return s;
        try {
            return JSON.parse(t);
        } catch (e) {
            throw fail('GENERIC', 'the API returned malformed JSON',
                { snippet: t.slice(0, 200), reason: str(e && e.message) });
        }
    }

    function classify(ex) {
        const problem = str(ex && ex.problem);
        const message = str(ex && ex.message);
        if (problem === 'not-supported' || /capabilit/i.test(message)) return 'BRIDGE_NO_ADDRESS_CAP';
        if (PROBLEM_KIND[problem]) return PROBLEM_KIND[problem];
        if (problem) return 'API_UNREACHABLE';
        return 'GENERIC';
    }

    function messageFor(kind) {
        if (kind === 'BRIDGE_NO_ADDRESS_CAP') {
            return 'this Cockpit bridge cannot connect to another host — it lacks the "address" capability';
        }
        if (kind === 'API_AUTH_FAILED') return 'the API server refused the connection';
        if (kind === 'API_UNREACHABLE') return 'the API server could not be reached';
        return 'the request to the API server failed';
    }

    function available() {
        return typeof cockpit !== 'undefined' && !!cockpit && typeof cockpit.http === 'function';
    }

    function transport(conn) {
        const opts = httpOptions(conn);                  // eager: a bad Conn fails at wiring time
        const token = conn.token === null || conn.token === undefined ? '' : String(conn.token);
        const timeoutMs = Number.isInteger(conn.timeoutMs) && conn.timeoutMs > 0
            ? conn.timeoutMs : DEFAULT_TIMEOUT_MS;

        return function send(req) {
            let wire;
            try {
                wire = normalizeWire(req, token);
            } catch (e) {
                return Promise.reject(e);
            }
            if (!available()) {
                return Promise.reject(fail('API_UNREACHABLE',
                    'the Cockpit bridge is not available',
                    { path: wire.path, reason: 'no-bridge' }));
            }
            return new Promise(function (resolve, reject) {
                let settled = false;
                let status = 0;
                let timer = null;
                function done(fn, value) {
                    if (settled) return;
                    settled = true;
                    if (timer !== null) clearTimeout(timer);
                    fn(value);
                }
                timer = setTimeout(function () {
                    done(reject, fail('API_UNREACHABLE', 'the API server did not answer in time',
                        { path: wire.path, reason: 'timeout', timeoutMs: timeoutMs }));
                }, timeoutMs);

                let request;
                try {
                    request = cockpit.http(opts).request({
                        method: wire.method,
                        path: wire.path,
                        headers: wire.headers,
                        body: wire.body === null ? '' : wire.body
                    });
                } catch (e) {
                    const kind = classify(e);
                    done(reject, fail(kind, messageFor(kind),
                        { path: wire.path, problem: str(e && e.problem) || null }));
                    return;
                }
                if (typeof request.response === 'function') {
                    request.response(function (code) { status = Number(code) || 0; });
                }
                request.then(function (text) {
                    try {
                        done(resolve, { status: status || 200, body: parseBody(text) });
                    } catch (e) {
                        done(reject, e);
                    }
                }, function (ex, data) {
                    // cockpit rejects on any non-2xx; that is a real answer from the
                    // server, not a transport failure, so it resolves with its status.
                    const httpStatus = ex && Number.isInteger(ex.status) && ex.status > 0
                        ? ex.status : (status || 0);
                    if (httpStatus > 0) {
                        try {
                            done(resolve, {
                                status: httpStatus,
                                body: parseBody(data === undefined || data === null
                                    ? (ex ? ex.message : null) : data)
                            });
                        } catch (e) {
                            done(reject, e);
                        }
                        return;
                    }
                    const kind = classify(ex);
                    done(reject, fail(kind, messageFor(kind),
                        { path: wire.path, problem: str(ex && ex.problem) || null }));
                });
            });
        };
    }

    const PilotApiIo = {
        DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
        MAX_BODY_BYTES: MAX_BODY_BYTES,
        PROBLEM_KIND: PROBLEM_KIND,
        METHODS: METHODS,
        httpOptions: httpOptions,
        normalizeWire: normalizeWire,
        applyAuth: applyAuth,
        parseBody: parseBody,
        classify: classify,
        messageFor: messageFor,
        available: available,
        transport: transport
    };
    root.PilotApiIo = PilotApiIo;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotApiIo;
})(typeof window !== 'undefined' ? window : globalThis);
