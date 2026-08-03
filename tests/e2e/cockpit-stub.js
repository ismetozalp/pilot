// tests/e2e/cockpit-stub.js — a fake Cockpit bridge for Pilot's browser tests.
//
// Served in place of ../base1/cockpit.js so index.html can be driven in a real
// browser with no Cockpit session, no bridge, no login and no root. Scenarios
// push scripted responses in through window.__pilotStub before the page loads
// and read the call log back out afterwards.
//
// The config crosses into the page as JSON (Playwright serialises it), so a
// scripted response is always data — never a function.
//
// This proves the UI layer wires up, renders and handles responses and errors.
// It does NOT prove Pilot talks to a real API server or to pilot-exec:
// tests/integration does that against the real thing.
'use strict';
(function (root) {

    function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

    function own(map, key) {
        return isObj(map) && Object.prototype.hasOwnProperty.call(map, key)
            ? map[key] : undefined;
    }

    // Exact key first, then the LONGEST substring key. Longest wins because a
    // scenario that scripts both 'pilot-exec' and 'pilot-exec --run' means the
    // more specific one, and key order in an object literal is not a contract.
    function matchKey(map, line) {
        if (!isObj(map)) return undefined;
        const text = (line === undefined || line === null) ? '' : String(line);
        const exact = own(map, text);
        if (exact !== undefined) return exact;
        let best = null;
        for (const k of Object.keys(map)) {
            if (k.length === 0) continue;
            if (text.indexOf(k) < 0) continue;
            if (best === null || k.length > best.length) best = k;
        }
        return best === null ? undefined : map[best];
    }

    // One newline-terminated JSON document per entry — the C4 transcript shape.
    function jsonLines(lines) {
        const out = [];
        const list = Array.isArray(lines) ? lines : [];
        for (const item of list) {
            if (typeof item === 'string') out.push(item.slice(-1) === '\n' ? item : item + '\n');
            else out.push(JSON.stringify(item) + '\n');
        }
        return out;
    }

    // 'line'  one chunk per line (default)
    // 'split' every line arrives in two chunks, so a consumer that does not
    //         buffer sees half a JSON document — which is what a real bridge
    //         does and the defect class this stub exists to catch
    // 'blob'  the whole text in a single chunk
    function chunksOf(text, mode) {
        const s = (text === undefined || text === null) ? '' : String(text);
        if (s === '') return [];
        if (mode === 'blob') return [s];
        const lines = s.split('\n');
        const tail = lines.pop();
        const parts = lines.map(function (l) { return l + '\n'; });
        if (tail !== '') parts.push(tail);
        if (mode !== 'split') return parts;
        const out = [];
        for (const p of parts) {
            if (p.length < 2) { out.push(p); continue; }
            const cut = Math.floor(p.length / 2);
            out.push(p.slice(0, cut));
            out.push(p.slice(cut));
        }
        return out;
    }

    // cockpit.format: $0 / ${0} positional, $name / ${name} from an object arg.
    function format(fmt) {
        const args = Array.prototype.slice.call(arguments, 1);
        const named = isObj(args[0]) ? args[0] : null;
        const src = (fmt === undefined || fmt === null) ? '' : String(fmt);
        return src.replace(/\$\{([^}]*)\}|\$([0-9]+|[A-Za-z_][A-Za-z0-9_]*)/g,
            function (m, braced, bare) {
                const key = braced === undefined ? bare : braced;
                if (/^[0-9]+$/.test(key)) {
                    const v = args[Number(key)];
                    return (v === undefined || v === null) ? '' : String(v);
                }
                const v = own(named, key);
                if (v === undefined) return m;
                return v === null ? '' : String(v);
            });
    }

    function install(target, config) {
        const win = target || root;
        const cfg = config || win.__pilotStub || {};
        win.__pilotStub = cfg;
        if (!Array.isArray(cfg.calls)) cfg.calls = [];
        if (!Array.isArray(cfg.errors)) cfg.errors = [];
        if (!isObj(cfg.spawn)) cfg.spawn = {};
        if (!isObj(cfg.files)) cfg.files = {};
        if (!isObj(cfg.http)) cfg.http = {};
        if (!isObj(cfg.dbus)) cfg.dbus = {};
        if (cfg.httpAddressCap === undefined) cfg.httpAddressCap = true;

        function mkErr(spec, fallback) {
            const s = isObj(spec) ? spec : {};
            const e = new Error(s.message === undefined
                ? String(fallback || 'stub error') : String(s.message));
            e.exit_status = s.exit_status === undefined ? 1 : s.exit_status;
            if (s.problem !== undefined) e.problem = s.problem;
            if (s.status !== undefined) e.status = s.status;
            return e;
        }

        function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

        function spawn(argv, opts) {
            const list = Array.isArray(argv)
                ? argv.map(String)
                : [String(argv === undefined || argv === null ? '' : argv)];
            const line = list.join(' ');
            const call = { kind: 'spawn', argv: list.slice(), opts: opts || {}, input: null };
            cfg.calls.push(call);

            const handlers = [];
            let settle = null;
            let fail = null;
            let closed = null;
            const p = new Promise(function (res, rej) { settle = res; fail = rej; });
            p.stream = function (cb) { if (typeof cb === 'function') handlers.push(cb); return p; };
            p.input = function (data) {
                call.input = (call.input === null ? '' : call.input) +
                    String(data === undefined || data === null ? '' : data);
                return p;
            };
            p.close = function (problem) { closed = problem || 'cancelled'; return p; };

            (async function () {
                await tick();                      // let the caller attach .stream()
                const scripted = matchKey(cfg.spawn, line);
                if (scripted === undefined) {
                    fail(mkErr({ message: 'no stub for: ' + line, problem: 'no-stub' }));
                    return;
                }
                if (isObj(scripted) && scripted.error) { fail(mkErr(scripted, 'spawn failed')); return; }

                let text = '';
                let exit = 0;
                let mode = 'blob';
                if (isObj(scripted)) {
                    text = scripted.lines !== undefined
                        ? jsonLines(scripted.lines).join('')
                        : String(scripted.text === undefined ? '' : scripted.text);
                    if (scripted.trailer !== undefined) text += String(scripted.trailer);
                    exit = scripted.exit_status === undefined ? 0 : scripted.exit_status;
                    mode = scripted.chunk === undefined ? 'line' : scripted.chunk;
                } else {
                    text = String(scripted);
                }

                for (const chunk of chunksOf(text, mode)) {
                    if (closed) break;
                    for (const cb of handlers) cb(chunk);
                    if (handlers.length) await tick();
                }
                if (closed) { fail(mkErr({ message: closed, problem: closed })); return; }
                if (exit !== 0) {
                    const e = mkErr({ message: 'exited ' + exit, exit_status: exit });
                    e.stdout = text;
                    fail(e);
                    return;
                }
                // Real cockpit resolves with no data once a stream handler exists.
                settle(handlers.length ? '' : text);
            })();

            return p;
        }

        function file(p, opts) {
            const key = String(p === undefined || p === null ? '' : p);
            const options = opts || {};
            const api = {
                path: key,
                read: function () {
                    cfg.calls.push({ kind: 'read', path: key });
                    const v = own(cfg.files, key);
                    if (isObj(v) && v.error) return Promise.reject(mkErr(v, 'read failed'));
                    return Promise.resolve(v === undefined ? null : String(v));
                },
                replace: function (content) {
                    const value = (content === null || content === undefined) ? null : String(content);
                    cfg.calls.push({ kind: 'replace', path: key, content: value, opts: options });
                    const v = own(cfg.files, key);
                    if (isObj(v) && v.error) return Promise.reject(mkErr(v, 'write failed'));
                    if (value === null) delete cfg.files[key];
                    else cfg.files[key] = value;
                    return Promise.resolve(value);
                },
                modify: function (fn) {
                    return api.read().then(function (cur) { return api.replace(fn(cur)); });
                },
                watch: function (cb) {
                    if (typeof cb === 'function') setTimeout(function () {
                        const v = own(cfg.files, key);
                        cb((v === undefined || isObj(v)) ? null : String(v), null);
                    }, 0);
                    return { remove: function () {} };
                },
                close: function () {}
            };
            return api;
        }

        function http(options) {
            const opts = isObj(options) ? options : {};

            function request(req) {
                const r = isObj(req) ? req : {};
                const method = String(r.method === undefined ? 'GET' : r.method).toUpperCase();
                const pathStr = String(r.path === undefined ? '/' : r.path);
                const entry = {
                    kind: 'http', method: method, path: pathStr,
                    params: r.params === undefined ? null : r.params,
                    body: r.body === undefined ? null : r.body,
                    headers: r.headers === undefined ? null : r.headers,
                    address: opts.address === undefined ? null : opts.address
                };
                cfg.calls.push(entry);

                const responders = [];
                const streams = [];
                let settle = null;
                let fail = null;
                const p = new Promise(function (res, rej) { settle = res; fail = rej; });
                p.response = function (cb) { if (typeof cb === 'function') responders.push(cb); return p; };
                p.stream = function (cb) { if (typeof cb === 'function') streams.push(cb); return p; };
                p.input = function () { return p; };
                p.close = function () { return p; };

                (async function () {
                    await tick();
                    if (entry.address !== null && cfg.httpAddressCap === false) {
                        fail(mkErr({
                            message: 'this bridge does not support the address capability',
                            problem: 'not-supported', status: 0
                        }));
                        return;
                    }
                    const scripted = matchKey(cfg.http, method + ' ' + pathStr);
                    if (scripted === undefined) {
                        fail(mkErr({
                            message: 'no http stub for: ' + method + ' ' + pathStr,
                            problem: 'no-stub', status: 0
                        }));
                        return;
                    }
                    if (isObj(scripted) && scripted.error) { fail(mkErr(scripted, 'http failed')); return; }

                    const spec = (isObj(scripted) && scripted.body !== undefined) ? scripted : { body: scripted };
                    const status = spec.status === undefined ? 200 : Number(spec.status);
                    const headers = isObj(spec.headers) ? spec.headers : { 'Content-Type': 'application/json' };
                    const body = spec.body === undefined ? ''
                        : (typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body));

                    for (const cb of responders) cb(status, headers);

                    if (status >= 400) {
                        const e = mkErr({ message: body, problem: 'protocol-error', status: status });
                        e.reason = spec.reason === undefined ? 'error' : String(spec.reason);
                        fail(e);
                        return;
                    }
                    for (const chunk of chunksOf(body, spec.chunk === undefined ? 'blob' : spec.chunk)) {
                        for (const cb of streams) cb(chunk);
                        if (streams.length) await tick();
                    }
                    settle(streams.length ? '' : body);
                })();

                return p;
            }

            return {
                request: request,
                get: function (p2, params, headers) {
                    return request({ method: 'GET', path: p2, params: params, headers: headers });
                },
                post: function (p2, body, headers) {
                    return request({ method: 'POST', path: p2, body: body, headers: headers });
                },
                close: function () {}
            };
        }

        function dbus(service, options) {
            const name = String(service === undefined ? '' : service);
            return {
                call: function (objpath, iface, method, args) {
                    cfg.calls.push({
                        kind: 'dbus', service: name, path: objpath, iface: iface,
                        method: method, args: args === undefined ? null : args
                    });
                    const scripted = matchKey(cfg.dbus, name + ':' + String(method));
                    if (scripted === undefined) {
                        return Promise.reject(mkErr({
                            message: 'no dbus stub for ' + name + ':' + method, problem: 'no-stub'
                        }));
                    }
                    if (isObj(scripted) && scripted.error) {
                        return Promise.reject(mkErr({
                            message: scripted.error, problem: scripted.problem
                        }));
                    }
                    return Promise.resolve(scripted);
                },
                subscribe: function () { return { remove: function () {} }; },
                watch: function () { return Promise.resolve(); },
                wait: function () { return Promise.resolve(); },
                addEventListener: function () {},
                removeEventListener: function () {},
                close: function () {},
                options: options || {}
            };
        }

        const cockpit = {
            spawn: spawn,
            file: file,
            http: http,
            dbus: dbus,
            gettext: function (s) { return s === undefined || s === null ? '' : String(s); },
            format: format,
            variant: function (t, v) { return { t: t, v: v }; },
            location: { href: '', path: [], options: {}, go: function () {}, replace: function () {} },
            transport: { host: 'localhost', csrf_token: 'stub-csrf', origin: 'stub' },
            user: function () { return Promise.resolve({ name: 'root', id: 0 }); },
            jump: function () {},
            addEventListener: function () {},
            removeEventListener: function () {}
        };
        win.cockpit = cockpit;

        if (typeof win.addEventListener === 'function') {
            win.addEventListener('error', function (ev) {
                cfg.errors.push(String(ev && ev.message));
            });
            win.addEventListener('unhandledrejection', function (ev) {
                const reason = ev && ev.reason;
                cfg.errors.push('unhandledrejection: ' +
                    String(reason && reason.message ? reason.message : reason));
            });
        }
        return cockpit;
    }

    const PilotCockpitStub = {
        install: install, matchKey: matchKey, jsonLines: jsonLines,
        chunksOf: chunksOf, format: format
    };
    root.PilotCockpitStub = PilotCockpitStub;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotCockpitStub;
    // In a browser this file IS the bridge, so it installs itself. Under node it
    // stays inert and is driven through install(fakeWindow, cfg).
    if (typeof window !== 'undefined') install(window);
})(typeof window !== 'undefined' ? window : globalThis);
