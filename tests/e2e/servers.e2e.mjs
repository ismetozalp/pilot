// tests/e2e/servers.e2e.mjs — Task 19's control-plane wiring, proved LIVE.
//
// tests/unit/app-wiring.test.js calls wireApi()/init()/switchServer() directly
// on the plain object pilotApp() returns — it proves the functions work, never
// that Alpine actually invokes them on a real page. That gap is exactly the
// shape that let Task 16 ship a dead remote-SSH flow behind hundreds of green
// unit tests: logic downstream of a trigger nobody fired.
//
// index.html used to carry BOTH `x-data="pilotApp()"` and `x-init="init()"`
// on .pilot-shell. Alpine documents that any x-data object with an init()
// method has it called automatically — confirmed here by mutation-testing
// this very scenario: removing x-init left every check green, and a probe of
// window.__pilotStub.calls showed wireApi() actually firing TWICE per load
// (once via Alpine's own convention, once via the redundant x-init). That
// double-fire — a real bug, doubling every registry read and the compat
// probe on every page load — is what x-init="init()" was silently doing;
// it has been removed from index.html as part of this task. The genuinely
// load-bearing trigger is `x-data="pilotApp()"` itself: remove THAT and
// Alpine never creates the component at all, which is what this file's
// mutation test now exercises (see the task report for the transcript).
//
// This scenario drives the real page instead: no ctx.useTransport() (which
// replaces PilotApi.setTransport wholesale and would hide the very defect
// this guards against — a broken trigger would look identical to a working
// one once useTransport overwrites the transport regardless of what actually
// wired it). It scripts the Cockpit file/http stubs so the REAL wiring path
// runs end to end, then reads window.__pilotStub.calls — the stub's own call
// log — to see which address the transport genuinely dialled, both at
// startup and after switching the active server through the component's real
// switchServer() method (there is no server-picker UI yet; that is a later
// task's surface, so this reaches the same method a future button would call).
//
//   node tests/e2e/servers.e2e.mjs
import { isMain, runScenario } from '../e2e.mjs';

export const name = 'servers';

const WAIT = 5000;

function rec(id, host) {
    return {
        id, host, sshPort: 22, apiPort: 21114, tls: false,
        domain: null, hbbsKey: null, hbbsPorts: [], installDir: '/opt/rustdesk-api', createdAt: null
    };
}

// Every probe target api-client.js's probeTargets() lists, answered as an
// ordinary success — the point of this scenario is the transport wiring, not
// the compatibility probe (servers.test.js already covers that exhaustively),
// so nothing here should fail or need retrying.
const PROBE_OK = { code: 0, message: '', data: {} };

const STUB = {
    files: {
        '/etc/pilot/config.json': JSON.stringify({ activeServer: 'prod' }),
        '/etc/pilot/servers/prod.json': JSON.stringify(rec('prod', 'prod.example.com')),
        '/etc/pilot/servers/prod.token': 'TOK-PROD',
        '/etc/pilot/servers/staging.json': JSON.stringify(rec('staging', 'staging.example.com')),
        '/etc/pilot/servers/staging.token': 'TOK-STAGING'
    },
    http: {
        // show-swagger is 0 on a stock install (C17) — absent is the expected,
        // ordinary case, not an error.
        'GET /admin/swagger/doc.json': { status: 404, body: '404 page not found' },
        'GET /api/currentUser2': PROBE_OK,
        'GET /admin/peer': { code: 0, message: '', data: { list: [], page: 1, total: 0, page_size: 0 } },
        'GET /api/ab/shared/profiles': PROBE_OK,
        'GET /api/ab/peers': PROBE_OK,
        'GET /admin/user': PROBE_OK,
        'GET /admin/group': PROBE_OK,
        'GET /admin/audit_conn': PROBE_OK,
        'GET /admin/audit_file': PROBE_OK,
        'GET /admin/login_log': PROBE_OK
    }
};

// Injected into the PAGE (not run in node) — Alpine's own public accessor for
// a component's reactive data is the ONLY way to reach the real pilotApp()
// instance from outside; a scenario must observe what app.js actually did,
// never re-implement its logic.
async function installHelpers(page) {
    await page.evaluate(() => {
        window.alpineData = function () {
            const el = document.querySelector('.pilot-shell');
            if (!el || !window.Alpine) return null;
            return window.Alpine.$data(el);
        };
    });
}

async function waitApiReady(page) {
    try {
        await page.waitForFunction(
            () => { const d = window.alpineData(); return !!d && d.apiReady === true; },
            null, { timeout: WAIT });
    } catch (e) {
        throw new Error('apiReady never became true — is .pilot-shell still x-data="pilotApp()", ' +
            `and does init() still call wireApi()? (${e && e.message})`);
    }
}

async function lastHttpAddress(page, path) {
    const calls = await page.evaluate(() => window.__pilotStub.calls);
    const hits = calls.filter((c) => c.kind === 'http' && c.path === path);
    return hits.length ? hits[hits.length - 1].address : undefined;
}

export default async function run(ctx) {
    const { check, assertEqual, assertOk } = ctx;
    const page = await ctx.open(ctx.browser, STUB);
    page.setDefaultTimeout(WAIT);
    await installHelpers(page);
    try {
        await check('startup wiring: init() really runs wireApi() — apiReady flips true on its own', async () => {
            await waitApiReady(page);
            assertOk(page.consoleErrors.length === 0,
                'wiring at startup produced console errors: ' + page.consoleErrors.join('; '));
        });

        await check("startup wiring: a real PilotApi call reaches the stub with prod's address", async () => {
            const result = await page.evaluate(() => window.PilotApi.devices.list());
            assertOk(result, 'devices.list() produced no result — the transport is not really wired');
            const address = await lastHttpAddress(page, '/admin/peer');
            assertEqual(address, 'prod.example.com',
                'the transport PilotApi actually used did not carry the active server\'s address');
        });

        await check('switchServer: re-wires the transport to the newly active server, live', async () => {
            await page.evaluate(() => window.alpineData().switchServer('staging'));
            await page.waitForFunction(
                () => window.alpineData().activeServerId === 'staging', null, { timeout: WAIT });

            const result = await page.evaluate(() => window.PilotApi.devices.list());
            assertOk(result, 'devices.list() produced no result after switching server');
            const address = await lastHttpAddress(page, '/admin/peer');
            assertEqual(address, 'staging.example.com',
                'switchServer() did not really re-wire the transport to the new server');
        });
    } finally {
        await page.ctx.close();
    }
}

if (isMain(import.meta.url)) process.exit(await runScenario(run, name) ? 1 : 0);
