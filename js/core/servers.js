// core/servers.js — the multi-server registry, plus the API compatibility probe.
//
// One of the three IO_MODULES (C5 rule 6): it uses cockpit.spawn and cockpit.file,
// never the HTTP transport channel (that belongs to api-io.js alone). Records at
// /etc/pilot/servers/<id>.json carry NO secrets; secrets live beside them as 0600
// root:root files.
//
// probeCompatibility() is the spec's "version compatibility is a tested step, not
// an assumption". It is deliberately not swagger-led: app.show-swagger is 0 on a
// stock install so /admin/swagger/doc.json usually does not exist, and the
// committed doc is partially stale. The doc is therefore advisory; the verdict
// comes from GET-ing the real routes Pilot depends on and treating anything other
// than 404/501 as "the route is there".
'use strict';
(function (root) {
    const Errors = (typeof module !== 'undefined' && module.exports)
        ? require('./errors.js')
        : root.PilotErrors;

    // api-client.js loads AFTER this module in the C7 order, so it cannot be
    // captured at load time — resolved on first use instead.
    function apiClient() {
        if (root.PilotApiClient) return root.PilotApiClient;
        if (typeof module !== 'undefined' && module.exports) return require('./api-client.js');
        return null;
    }

    const CONFIG_DIR = '/etc/pilot';
    const CONFIG_PATH = '/etc/pilot/config.json';
    const SERVER_DIR = '/etc/pilot/servers';
    const JSON_SUFFIX = '.json';
    const SECRET_KINDS = { ssh: '.ssh', token: '.token' };
    const DIR_MODE = '0700';
    const SECRET_MODE = '0600';
    const OWNER = 'root:root';
    const MAX_ID_LEN = 64;
    const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
    const CTRL = /[\x00-\x1f\x7f]/;
    const BAD_HOST = /[\x00-\x1f\x7f\s/\\?#@]/;
    const ABS_PATH = /^\/[A-Za-z0-9._/-]*$/;
    const SWAGGER_PATH = '/admin/swagger/doc.json';
    const DEFAULT_INSTALL_DIR = '/opt/rustdesk-api';
    const MAX_HBBS_PORTS = 8;

    function fail(kind, message, detail) { return Errors.create(kind, message, detail || {}); }
    function str(v) { return v === null || v === undefined ? '' : String(v); }

    function validateId(id) {
        if (typeof id !== 'string') {
            throw fail('GENERIC', 'a server id must be a string', { type: typeof id });
        }
        if (id.length === 0) throw fail('GENERIC', 'a server id must not be empty', {});
        if (id.length > MAX_ID_LEN) {
            throw fail('GENERIC', 'the server id is too long',
                { length: id.length, max: MAX_ID_LEN });
        }
        if (!ID_RE.test(id)) {
            throw fail('GENERIC',
                'a server id may contain only a-z, 0-9 and dashes, and must not start with a dash',
                { serverId: JSON.stringify(id) });
        }
        return id;
    }

    function recordPath(id) { return SERVER_DIR + '/' + validateId(id) + JSON_SUFFIX; }

    function secretPath(id, kind) {
        const key = validateId(id);
        if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(SECRET_KINDS, kind)) {
            throw fail('GENERIC', 'unknown secret kind',
                { kind: typeof kind === 'string' ? JSON.stringify(kind) : typeof kind,
                    known: Object.keys(SECRET_KINDS) });
        }
        return SERVER_DIR + '/' + key + SECRET_KINDS[kind];
    }

    function requiredText(value, field, max, re) {
        if (typeof value !== 'string') {
            throw fail('GENERIC', field + ' must be a string', { field: field, type: typeof value });
        }
        const v = value.trim();
        if (!v) throw fail('GENERIC', field + ' is required', { field: field });
        if (v.length > max) {
            throw fail('GENERIC', field + ' is too long', { field: field, length: v.length, max: max });
        }
        if (re.test(v)) {
            throw fail('GENERIC', field + ' contains a character that is not allowed',
                { field: field, value: JSON.stringify(v) });
        }
        return v;
    }

    function optionalText(value, field, max, re) {
        if (value === null || value === undefined || value === '') return null;
        return requiredText(value, field, max, re);
    }

    function port(value, field, fallback) {
        if (value === null || value === undefined) return fallback;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
            throw fail('GENERIC', field + ' must be an integer between 1 and 65535',
                { field: field, value: typeof value === 'number' ? value : typeof value });
        }
        return value;
    }

    function normalizeRecord(obj) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            throw fail('GENERIC', 'a server record must be an object',
                { type: Array.isArray(obj) ? 'array' : typeof obj });
        }
        const installDir = obj.installDir === null || obj.installDir === undefined
            || obj.installDir === '' ? DEFAULT_INSTALL_DIR : obj.installDir;
        if (typeof installDir !== 'string' || !ABS_PATH.test(installDir)
            || installDir.indexOf('..') >= 0) {
            throw fail('GENERIC', 'installDir must be an absolute path with no ".."',
                { field: 'installDir', value: JSON.stringify(str(installDir)) });
        }
        let hbbsPorts = [];
        if (obj.hbbsPorts !== null && obj.hbbsPorts !== undefined) {
            if (!Array.isArray(obj.hbbsPorts)) {
                throw fail('GENERIC', 'hbbsPorts must be an array', { field: 'hbbsPorts' });
            }
            if (obj.hbbsPorts.length > MAX_HBBS_PORTS) {
                throw fail('GENERIC', 'too many hbbsPorts',
                    { field: 'hbbsPorts', count: obj.hbbsPorts.length, max: MAX_HBBS_PORTS });
            }
            hbbsPorts = obj.hbbsPorts.map(function (p) { return port(p, 'an hbbs port', null); });
        }
        // Built key by key from a fresh object, so a secret in the input cannot
        // reach the file however it is spelled.
        return {
            id: validateId(obj.id),
            host: requiredText(obj.host, 'host', 255, BAD_HOST),
            sshPort: port(obj.sshPort, 'sshPort', 22),
            apiPort: port(obj.apiPort, 'apiPort', 21114),
            tls: obj.tls === true,
            domain: optionalText(obj.domain, 'domain', 253, BAD_HOST),
            hbbsKey: optionalText(obj.hbbsKey, 'hbbsKey', 512, CTRL),
            hbbsPorts: hbbsPorts,
            installDir: installDir,
            createdAt: optionalText(obj.createdAt, 'createdAt', 40, CTRL)
        };
    }

    function parseListing(text) {
        if (typeof text !== 'string') return [];
        const seen = Object.create(null);
        const out = [];
        text.split('\n').forEach(function (raw) {
            const line = raw.replace(/\r$/, '').trim();
            if (!line) return;
            const slash = line.lastIndexOf('/');
            if (slash < 0) return;
            // The directory portion must be the registry itself — otherwise
            // ".../servers/../../etc/shadow.json" would reduce to the id "shadow".
            if (line.slice(0, slash) !== SERVER_DIR) return;
            const base = line.slice(slash + 1);
            if (base.length <= JSON_SUFFIX.length) return;
            if (base.slice(-JSON_SUFFIX.length) !== JSON_SUFFIX) return;
            const id = base.slice(0, base.length - JSON_SUFFIX.length);
            if (id.length > MAX_ID_LEN || !ID_RE.test(id)) return;
            if (seen[id]) return;
            seen[id] = true;
            out.push(id);
        });
        return out.sort();
    }

    function parseJsonObject(text, what) {
        if (typeof text !== 'string' || text.trim() === '') {
            throw fail('GENERIC', what + ' is empty', {});
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            throw fail('GENERIC', what + ' is not valid JSON',
                { snippet: text.slice(0, 200), reason: str(e && e.message) });
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw fail('GENERIC', what + ' is not a JSON object',
                { type: Array.isArray(parsed) ? 'array' : typeof parsed });
        }
        return parsed;
    }

    function parseRecord(text, id) {
        const wanted = validateId(id);
        const parsed = parseJsonObject(text, 'the server record');
        const record = normalizeRecord(parsed);
        if (record.id !== wanted) {
            throw fail('GENERIC',
                'the server record claims id "' + record.id + '" but is stored as "' + wanted + '"',
                { stored: wanted, claimed: record.id });
        }
        return record;
    }

    function parseConfig(text) {
        let parsed = null;
        try {
            parsed = parseJsonObject(text, 'the Pilot config');
        } catch (e) {
            return { activeServer: null };
        }
        const value = parsed.activeServer;
        if (typeof value !== 'string' || value.length > MAX_ID_LEN || !ID_RE.test(value)) {
            return { activeServer: null };
        }
        return { activeServer: value };
    }

    // ------------------------------------------------------------------- I/O ---

    function bridge(op) {
        const ck = typeof cockpit !== 'undefined' ? cockpit : null;
        if (!ck) {
            throw fail('GENERIC', 'the Cockpit bridge is not available', { op: op });
        }
        return ck;
    }

    function guard(op, fn) {
        try {
            return Promise.resolve(fn(bridge(op)));
        } catch (e) {
            if (e && e.name === 'PilotError') return Promise.reject(e);
            return Promise.reject(fail('GENERIC', str(e && e.message) || 'operation failed', { op: op }));
        }
    }

    function typedIo(op, target) {
        return function (e) {
            if (e && e.name === 'PilotError') throw e;
            throw fail('GENERIC', 'could not ' + op + ' ' + target,
                { op: op, path: target, problem: (e && e.problem) || null });
        };
    }

    // Real cockpit.js does NOT hand back a native Promise from cockpit.file()
    // or cockpit.spawn() -- it is a home-grown deferred whose .then() invokes
    // resolve/reject callbacks SYNCHRONOUSLY, straight out of the channel's
    // "close" event dispatch, with no try/catch of its own. A Cockpit session
    // starts in "Limited access" by default (spec-adjacent: every account,
    // including sudoers, until the user explicitly turns on administrative
    // access), so every superuser:'require' handle opened at load — exactly
    // what wireApi() does on first paint — fails this way immediately. If our
    // own reject handler THROWS (as this used to), that throw is not a promise
    // rejection: it is a genuine, uncaught, top-level exception, because it
    // happens deep inside real browser event dispatch, long after any of
    // Pilot's own try/catch blocks are still on the stack. `Promise.resolve()`
    // fixes this by assimilating the raw thenable through the native Promise
    // machinery (a microtask-scheduled job), so cockpit.js only ever calls a
    // native resolver — never our own code — synchronously. Every `.then()`
    // chained after this point is therefore native and safe, all the way up
    // through guard() and every caller's own await/try-catch. See GAP A.
    function readFile(ck, p) {
        const handle = ck.file(p, { superuser: 'require' });
        return Promise.resolve(handle.read()).then(function (content) {
            handle.close();
            return content;
        }, function (e) {
            handle.close();
            throw e;
        });
    }

    function writeFile(ck, p, value) {
        const handle = ck.file(p, { superuser: 'require' });
        return Promise.resolve(handle.replace(value)).then(function () {
            handle.close();
            return p;
        }, function (e) {
            handle.close();
            throw e;
        });
    }

    function run(ck, argv) {
        return Promise.resolve(ck.spawn(argv, { superuser: 'require', err: 'message' }));
    }

    function ensureDir(ck, dir, mode) {
        return run(ck, ['install', '-d', '-m', mode, '-o', 'root', '-g', 'root', dir]);
    }

    function list() {
        return guard('list', function (ck) {
            return run(ck, ['find', SERVER_DIR, '-maxdepth', '1', '-type', 'f', '-name', '*.json'])
                .then(function (out) { return parseListing(str(out)); }, function () { return []; })
                .then(function (ids) {
                    return ids.reduce(function (chain, id) {
                        return chain.then(function (acc) {
                            return read(id).then(function (rec) {
                                acc.push(rec);
                                return acc;
                            }, function () { return acc; });   // one bad record hides no others
                        });
                    }, Promise.resolve([]));
                });
        });
    }

    function read(id) {
        return guard('read', function (ck) {
            const p = recordPath(id);
            return readFile(ck, p).then(function (content) {
                if (content === null || content === undefined) {
                    throw fail('GENERIC', 'there is no server record at ' + p, { op: 'read', path: p });
                }
                return parseRecord(str(content), id);
            }, typedIo('read', p));
        });
    }

    function write(rec) {
        return guard('write', function (ck) {
            const record = normalizeRecord(rec);
            const p = recordPath(record.id);
            return ensureDir(ck, SERVER_DIR, DIR_MODE)
                .then(function () {
                    return writeFile(ck, p, JSON.stringify(record, null, 2) + '\n');
                })
                .then(function () { return record; }, typedIo('write', p));
        });
    }

    function remove(id) {
        return guard('remove', function (ck) {
            const paths = [recordPath(id), secretPath(id, 'ssh'), secretPath(id, 'token')];
            return paths.reduce(function (chain, p) {
                return chain.then(function () { return writeFile(ck, p, null); });
            }, Promise.resolve()).then(function () { return validateId(id); },
                typedIo('remove', paths[0]));
        });
    }

    function readSecret(id, kind) {
        return guard('readSecret', function (ck) {
            const p = secretPath(id, kind);
            return readFile(ck, p).then(function (content) {
                if (content === null || content === undefined) return null;
                return String(content).replace(/\r?\n$/, '');
            }, typedIo('readSecret', p));
        });
    }

    function writeSecret(id, kind, value) {
        return guard('writeSecret', function (ck) {
            const p = secretPath(id, kind);
            if (typeof value !== 'string' || value === '') {
                throw fail('GENERIC', 'a secret must be a non-empty string', { type: typeof value });
            }
            return ensureDir(ck, SERVER_DIR, DIR_MODE)
                .then(function () { return writeFile(ck, p, value); })
                .then(function () { return run(ck, ['chmod', SECRET_MODE, p]); })
                .then(function () { return run(ck, ['chown', OWNER, p]); })
                .then(function () { return p; }, function (e) {
                    // Never let the secret ride out on the failure path.
                    if (e && e.name === 'PilotError') throw e;
                    throw fail('GENERIC', 'could not store the secret at ' + p,
                        { op: 'writeSecret', path: p, problem: (e && e.problem) || null });
                });
        });
    }

    function removeSecret(id, kind) {
        return guard('removeSecret', function (ck) {
            const p = secretPath(id, kind);
            return writeFile(ck, p, null).then(function () { return p; },
                typedIo('removeSecret', p));
        });
    }

    function readConfig(ck) {
        return readFile(ck, CONFIG_PATH).then(function (content) {
            return { raw: content === null || content === undefined ? null : str(content) };
        }, function () { return { raw: null } });
    }

    function active() {
        return guard('active', function (ck) {
            return readConfig(ck).then(function (r) { return parseConfig(r.raw).activeServer; });
        });
    }

    function setActive(id) {
        return guard('setActive', function (ck) {
            const wanted = validateId(id);
            return readConfig(ck).then(function (r) {
                let current = {};
                if (r.raw) {
                    try {
                        const parsed = JSON.parse(r.raw);
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                            current = parsed;
                        }
                    } catch (e) { current = {}; }
                }
                current.activeServer = wanted;
                return ensureDir(ck, CONFIG_DIR, '0755')
                    .then(function () {
                        return writeFile(ck, CONFIG_PATH, JSON.stringify(current, null, 2) + '\n');
                    })
                    .then(function () { return wanted; }, typedIo('setActive', CONFIG_PATH));
            });
        });
    }

    // ------------------------------------------------- compatibility probe ---

    function probeRequest(client, ep) {
        return client.buildRequest({ method: ep.method, path: ep.path, admin: ep.admin });
    }

    function probeOne(send, client, ep) {
        return Promise.resolve(send(probeRequest(client, ep))).then(function (res) {
            const status = res && Number.isInteger(res.status) ? res.status : 0;
            // Anything that is not "no such route" proves the route exists — 401 and
            // 403 are answers from a handler, so they count as present.
            return { id: ep.id, method: ep.method, path: ep.path, status: status,
                present: status !== 404 && status !== 501 };
        });
    }

    function docPaths(body) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
        const paths = body.paths;
        if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return null;
        return Object.keys(paths);
    }

    function probeCompatibility(send) {
        if (typeof send !== 'function') {
            return Promise.reject(fail('GENERIC',
                'probeCompatibility needs the API transport function', { type: typeof send }));
        }
        const client = apiClient();
        if (!client) {
            return Promise.reject(fail('GENERIC', 'PilotApiClient is not loaded', {}));
        }
        const targets = client.probeTargets();
        const report = {
            ok: false, swagger: 'absent', swaggerStatus: 0,
            checked: [], missing: [], notInDoc: []
        };

        // Swagger is OFF by default (app.show-swagger: 0), so its absence is an
        // ordinary outcome and never fails the probe.
        return Promise.resolve(send({
            method: 'GET', path: SWAGGER_PATH, headers: {}, body: null, auth: client.AUTH.admin
        })).then(function (res) {
            report.swaggerStatus = res && Number.isInteger(res.status) ? res.status : 0;
            const keys = report.swaggerStatus === 200 ? docPaths(res.body) : null;
            report.swagger = keys ? 'present' : 'absent';
            return keys;
        }).then(function (keys) {
            return targets.reduce(function (chain, ep) {
                return chain.then(function () {
                    return probeOne(send, client, ep).then(function (row) {
                        report.checked.push(row);
                        if (!row.present) report.missing.push({ id: ep.id, path: ep.path });
                        if (keys) {
                            const bare = ep.path.indexOf('/api/') === 0 ? ep.path.slice(4) : ep.path;
                            if (keys.indexOf(ep.path) === -1 && keys.indexOf(bare) === -1) {
                                report.notInDoc.push(ep.path);   // advisory only: the doc is stale
                            }
                        }
                    });
                });
            }, Promise.resolve());
        }).then(function () {
            if (report.missing.length) {
                throw fail('API_VERSION_MISMATCH',
                    'this API server is missing ' + report.missing.length +
                    ' endpoint(s) Pilot needs: ' +
                    report.missing.map(function (m) { return m.path; }).join(', '),
                    { missing: report.missing, checked: report.checked,
                        swagger: report.swagger, swaggerStatus: report.swaggerStatus });
            }
            report.ok = true;
            return report;
        });
    }

    const PilotServers = {
        CONFIG_DIR: CONFIG_DIR,
        CONFIG_PATH: CONFIG_PATH,
        SERVER_DIR: SERVER_DIR,
        SECRET_KINDS: SECRET_KINDS,
        SWAGGER_PATH: SWAGGER_PATH,
        ID_RE: ID_RE,
        MAX_ID_LEN: MAX_ID_LEN,
        validateId: validateId,
        recordPath: recordPath,
        secretPath: secretPath,
        normalizeRecord: normalizeRecord,
        parseListing: parseListing,
        parseRecord: parseRecord,
        parseConfig: parseConfig,
        list: list,
        read: read,
        write: write,
        remove: remove,
        readSecret: readSecret,
        writeSecret: writeSecret,
        removeSecret: removeSecret,
        active: active,
        setActive: setActive,
        probeCompatibility: probeCompatibility
    };
    root.PilotServers = PilotServers;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotServers;
})(typeof window !== 'undefined' ? window : globalThis);
