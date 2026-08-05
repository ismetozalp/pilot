// tests/e2e/live-api-contract.live.mjs -- does PilotApiClient's route table
// describe a server that actually exists?
//
// This check exists because nothing else could answer that question, and the
// answer was no. Every route in ENDPOINTS was wrong: the admin half omitted the
// /api base path entirely, used REST shapes (/peer, /peer/{id}) against an
// action-style API (/peer/list, /peer/update, /peer/delete), and used PUT and
// DELETE against a surface that has neither. The client half asked for
// /api/currentUser2, which does not exist, and GET on three routes the server
// only serves as POST. Every console tab -- Devices, Address Book, Users, Audit
// -- therefore 404'd against a real rustdesk-api, and had since they were
// written.
//
// The unit tests passed because they assert what the table says. The stubbed
// e2e tier passed because its routes were keyed off that same table: client and
// stub agreed with each other about routes that exist nowhere. Two mirrors are
// not a measurement.
//
// So this asks the SERVER. It reads the shipped ENDPOINTS table -- the same file
// index.html loads, via its dual CommonJS export -- and issues every route
// against a real API server, asserting none answers "no such route". That is the
// one assertion a stub cannot fake.
//
// The requests run from NODE, not from the page: the plugin's CSP is
// `connect-src 'self'`, so the browser is forbidden to reach the API host
// directly (which is the whole reason api-io.js proxies through the Cockpit
// bridge). Running them here keeps the table as the single source of truth
// while letting the request actually leave.
//
// Gated: set PILOT_API_BASE (e.g. http://127.0.0.1:21114, an SSH tunnel is
// fine) and PILOT_API_PASS. Without them it skips cleanly, so the suite stays
// green on a machine with no RustDesk server.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../../js/core/api-client.js');

export const name = 'live-api-contract';

// Placeholders that are syntactically valid but match nothing, so a route that
// EXISTS answers "not found in the database" rather than "no such route". Only
// the latter is asserted on; business outcomes are none of this check's concern.
const PLACEHOLDER = { id: '0', ab: '' };

function fill(path) {
    return path.replace(/\{(\w+)\}/g, (m, k) =>
        encodeURIComponent(Object.prototype.hasOwnProperty.call(PLACEHOLDER, k) ? PLACEHOLDER[k] : '0'));
}

async function postJson(base, path, body, headers) {
    const r = await fetch(base + path, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: JSON.stringify(body)
    });
    let parsed = null;
    try { parsed = await r.json(); } catch (e) { parsed = null; }
    return { status: r.status, body: parsed };
}

// The server answers a missing route two ways: a bare 404, or -- for some
// prefixes -- a 200 whose body is the literal string "404 page not found".
function isMissingRoute(status, text) {
    if (status === 404) return true;
    return status === 200 && /^404 (page )?not found/i.test(String(text || '').trim());
}

export default async function run(ctx) {
    const { check, assertOk } = ctx;

    const base = (process.env.PILOT_API_BASE || '').replace(/\/+$/, '');
    const user = process.env.PILOT_API_USER || 'admin';
    const pass = process.env.PILOT_API_PASS || '';
    if (!base || !pass) {
        console.log('      SKIP: set PILOT_API_BASE and PILOT_API_PASS to check the route table ' +
            'against a real rustdesk-api server');
        return;
    }

    await check('live-api-contract: every route the plugin ships exists on a real server', async () => {
        const endpoints = C.ENDPOINTS;
        assertOk(Array.isArray(endpoints) && endpoints.length > 0, 'ENDPOINTS was not readable');

        // Both halves, because they authenticate differently: the admin surface
        // takes `api-token`, the client surface Bearer. A token that works for
        // one is rejected by the other, so a single login would leave half the
        // table untested behind 401s.
        const adminLogin = await postJson(base, '/api/admin/login', { username: user, password: pass });
        const adminToken = adminLogin.body && adminLogin.body.data && adminLogin.body.data.token;
        assertOk(adminToken, 'admin login failed against ' + base + ': ' +
            JSON.stringify(adminLogin).slice(0, 200));

        const clientLogin = await postJson(base, '/api/login',
            { username: user, password: pass, id: 'pilot-contract', uuid: 'pilot-contract' });
        const bearer = clientLogin.body && clientLogin.body.access_token;
        assertOk(bearer, 'client login failed against ' + base + ': ' +
            JSON.stringify(clientLogin).slice(0, 200));

        const results = [];
        for (const ep of endpoints) {
            if (ep.id === 'admin.login') {
                results.push({ id: ep.id, method: 'POST', path: ep.path, status: 200,
                    text: '(used to authenticate above)' });
                continue;
            }
            const headers = ep.admin
                ? { 'api-token': adminToken }
                : { Authorization: 'Bearer ' + bearer };
            const init = { method: ep.method, headers: Object.assign({}, headers) };
            if (ep.method !== 'GET' && ep.method !== 'HEAD') {
                init.headers['Content-Type'] = 'application/json';
                init.body = '{}';
            }
            const path = fill(ep.path);
            let status = 0, text = '';
            try {
                const r = await fetch(base + path, init);
                status = r.status;
                text = (await r.text()).slice(0, 120);
            } catch (e) {
                status = -1;
                text = String(e && e.message).slice(0, 120);
            }
            results.push({ id: ep.id, method: ep.method, path, status, text });
        }

        for (const r of results)
            console.log(`      ${String(r.status).padStart(3)}  ${r.method.padEnd(6)} ${r.path}`);

        // A route with a {guid} placeholder cannot be distinguished from a
        // missing one when there is no real address book to name: the server
        // 404s an unmatched path segment exactly as it 404s an unknown route.
        // Those are reported as UNVERIFIED and listed, never quietly passed --
        // a check that hides what it could not test is worse than no check.
        const parametrised = new Set(endpoints.filter((e) => /\{/.test(e.path)).map((e) => e.id));
        const missing = results.filter((r) => isMissingRoute(r.status, r.text) && !parametrised.has(r.id));
        const unverified = results.filter((r) => isMissingRoute(r.status, r.text) && parametrised.has(r.id));
        if (unverified.length) {
            console.log('      UNVERIFIED (need a real address book guid to address):');
            for (const r of unverified) console.log(`        ${r.method} ${r.path}`);
        }
        assertOk(missing.length === 0,
            'these routes do not exist on the server:\n        ' +
            missing.map((r) => `${r.id}: ${r.method} ${r.path} -> ${r.status} ${r.text}`).join('\n        '));

        // A transport-level failure means the check never really ran.
        const unreachable = results.filter((r) => r.status === -1);
        assertOk(unreachable.length === 0,
            'could not reach: ' + unreachable.map((r) => r.id + ' (' + r.text + ')').join(', '));
    });
}
