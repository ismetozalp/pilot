// tests/e2e/audit.e2e.mjs -- the Audit surface driven in a real browser.
//
// #pilot-audit sits behind x-show="tab === 'audit'" in the outer shell (same
// shape as tests/e2e/devices.e2e.mjs and tests/e2e/users.e2e.mjs for their own
// surfaces), so every check switches tabs first. Every request is driven
// through ctx.useTransport(), which replaces PilotApi.setTransport wholesale
// (C12/C15) -- this scenario never touches the bridge or builds a URL of its
// own, except for the final multi-server check, which -- like
// tests/e2e/users.e2e.mjs's own -- deliberately drives the REAL
// wireApi()/switchServer() through a scripted files+http stub instead, since
// that is the only way to prove js/app.js's 'pilot:server-changed' dispatch
// actually reaches js/features/audit-ui.js's own listener.
//
// Also proves the spec's independent-failure requirement (§7.2): an audit
// failure must not affect the Users surface, and vice versa.
//
//   node tests/e2e/audit.e2e.mjs
import { isMain, runScenario } from '../e2e.mjs';

export const name = 'audit';

const WAIT = 5000;

const CONN = [
    { id: 'c1', created_at: 1754246400, user: 'ada', from_peer: '111111111', to_peer: '222222222', type: 'remote', ip: '10.0.0.5' },
    { id: 'c2', created_at: 1754250000, user: 'bob', from_peer: '333333333', to_peer: '444444444', type: 'file', ip: '10.0.0.6' }
];
const LOGIN = [{ id: 'l1', created_at: 1754253600, user: 'ada', device_id: 'dev-1', type: 'login', ip: '10.0.0.5' }];
const USERS = [{ id: 'u1', name: 'ada', email: 'ada@example.com', status: 1 }];

// C12: HTTP 200 even on failure, {code,message,data}; paginated data. Matches
// the shape js/core/api-client.js's audit.conn/file/login routes document.
function listOk(list) {
    return { status: 200, body: { code: 0, message: '', data:
        { list, page: 1, total: list.length, page_size: 50 } } };
}
const AUDIT_FAIL = { status: 200, body: { code: 7, message: 'permission denied', data: null } };
const AUTH_FAIL = { status: 401, body: 'unauthorized' };

function baseRoutes(over) {
    return Object.assign({ 'GET /api/admin/audit_conn/list': listOk(CONN) }, over || {});
}

async function openAudit(ctx, routes) {
    const page = await ctx.open(ctx.browser, {});
    page.setDefaultTimeout(WAIT);
    await page.waitForSelector('[data-tab="audit"]', { state: 'attached', timeout: WAIT });
    await page.click('[data-tab="audit"]');
    await page.waitForSelector('#pilot-audit [data-testid="audit-refresh"]', { state: 'attached', timeout: WAIT });
    if (routes) await ctx.useTransport(page, routes);
    return page;
}

function rowCount(page) {
    return page.evaluate(() => document.querySelectorAll('#pilot-audit [data-testid="audit-row"]').length);
}

async function waitRowCount(page, n) {
    try {
        await page.waitForFunction(
            (want) => document.querySelectorAll('#pilot-audit [data-testid="audit-row"]').length === want,
            n, { timeout: WAIT });
    } catch (e) {
        const got = await rowCount(page);
        throw new Error(`expected ${n} audit row(s), still ${got} after ${WAIT}ms (${e.message})`);
    }
}

async function visible(page, selector) {
    try { await page.waitForSelector(selector, { state: 'visible', timeout: WAIT }); return true; }
    catch (e) { return false; }
}

export default async function run(ctx) {
    const { check, assertEqual, assertOk, assertMatch, shot, transportCalls } = ctx;

    await check('audit: the surface renders into #pilot-audit with all three tabs', async () => {
        const page = await openAudit(ctx, baseRoutes());
        try {
            assertEqual(await page.locator('#pilot-audit [data-testid="audit-root"]').count(), 1,
                'the audit surface did not mount');
            assertEqual(await page.locator('#pilot-audit [data-testid="audit-tab-conn"]').count(), 1);
            assertEqual(await page.locator('#pilot-audit [data-testid="audit-tab-file"]').count(), 1);
            assertEqual(await page.locator('#pilot-audit [data-testid="audit-tab-login"]').count(), 1);
        } finally { await page.ctx.close(); }
    });

    await check('audit: connections render with UTC-formatted times', async () => {
        const page = await openAudit(ctx, baseRoutes());
        try {
            await page.click('#pilot-audit [data-testid="audit-refresh"]');
            await waitRowCount(page, 2);
            assertEqual(await page.locator('#pilot-audit [data-testid="audit-total"]').innerText(), '2',
                'wrong total');
            const when = await page.locator('#pilot-audit [data-testid="audit-when"]').first().innerText();
            assertMatch(when, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/, 'time not rendered as UTC: ' + when);
            assertOk((await page.locator('#pilot-audit [data-testid="audit-row"]').first().innerText()).includes('ada'));
            assertEqual(await page.locator('#pilot-audit [data-testid="audit-alert"]').count(), 0,
                'a healthy load must not alert');
            await shot(page, 'audit-list');
        } finally { await page.ctx.close(); }
    });

    await check('audit: switching to logins issues a new request and re-renders', async () => {
        const page = await openAudit(ctx, baseRoutes({ 'GET /api/admin/login_log/list': listOk(LOGIN) }));
        try {
            await page.click('#pilot-audit [data-testid="audit-refresh"]');
            await waitRowCount(page, 2);
            await page.click('#pilot-audit [data-testid="audit-tab-login"]');
            await waitRowCount(page, 1);
            assertOk((await page.locator('#pilot-audit [data-testid="audit-row"]').first().innerText()).includes('dev-1'),
                'the login record did not render');
            const calls = await transportCalls(page);
            assertOk(calls.some((c) => c.path.indexOf('/api/admin/login_log') === 0),
                'switching tabs must issue a request to the login log');
        } finally { await page.ctx.close(); }
    });

    await check('audit: filtering by user and device sends both to the server', async () => {
        const page = await openAudit(ctx, baseRoutes());
        try {
            await page.fill('#pilot-audit [data-testid="audit-user"]', 'ada');
            await page.fill('#pilot-audit [data-testid="audit-device"]', '111111111');
            await page.click('#pilot-audit [data-testid="audit-refresh"]');
            await waitRowCount(page, 2);
            const calls = await transportCalls(page);
            const last = calls.filter((c) => c.path.indexOf('/api/admin/audit_conn') === 0).pop();
            assertOk(last, 'no request reached audit_conn');
            assertOk(last.path.indexOf('user=ada') !== -1, 'the user filter did not reach the request: ' + last.path);
            assertOk(last.path.indexOf('device=111111111') !== -1,
                'the device filter did not reach the request: ' + last.path);
        } finally { await page.ctx.close(); }
    });

    await check('audit: an invalid date range is refused before any request', async () => {
        const page = await openAudit(ctx, baseRoutes());
        try {
            await page.fill('#pilot-audit [data-testid="audit-from"]', '2026-02-30');
            const before = (await transportCalls(page)).length;
            await page.click('#pilot-audit [data-testid="audit-refresh"]');
            assertOk(await visible(page, '#pilot-audit [data-testid="audit-problem"]'),
                'the range problem must be shown');
            const after = await transportCalls(page);
            assertEqual(after.length, before, 'an invalid range must not reach the API');
        } finally { await page.ctx.close(); }
    });

    await check('audit: a valid date range is sent as epoch seconds', async () => {
        const page = await openAudit(ctx, baseRoutes());
        try {
            await page.fill('#pilot-audit [data-testid="audit-from"]', '2026-08-01');
            await page.fill('#pilot-audit [data-testid="audit-to"]', '2026-08-03');
            await page.click('#pilot-audit [data-testid="audit-refresh"]');
            await waitRowCount(page, 2);
            const calls = await transportCalls(page);
            const last = calls.filter((c) => c.path.indexOf('/api/admin/audit_conn') === 0).pop();
            assertOk(last.path.indexOf('from=' + Math.floor(Date.UTC(2026, 7, 1) / 1000)) !== -1,
                'from was not converted to epoch seconds: ' + last.path);
            assertOk(last.path.indexOf('to=' + Math.floor(Date.UTC(2026, 7, 3, 23, 59, 59) / 1000)) !== -1,
                'to was not converted to end-of-day epoch seconds: ' + last.path);
        } finally { await page.ctx.close(); }
    });

    await check('audit: an unconfigured system and a filtered-to-nothing result get different empty states', async () => {
        const page = await openAudit(ctx, baseRoutes({ 'GET /api/admin/audit_conn/list': listOk([]) }));
        try {
            await page.click('#pilot-audit [data-testid="audit-refresh"]');
            assertOk(await visible(page, '#pilot-audit [data-testid="audit-empty"]'),
                'the unconfigured empty state must appear when nothing has ever been logged');
            assertEqual(await rowCount(page), 0, 'rows leaked');
            assertEqual(await page.locator('#pilot-audit [data-testid="audit-alert"]').count(), 0,
                'empty is not an error');
            const action = page.locator('#pilot-audit [data-testid="audit-empty-action"]');
            assertOk(await action.isVisible(), 'the unconfigured empty state offers a next action');
            assertEqual(await action.evaluate((el) => el.tagName), 'BUTTON');
            await ctx.useTransport(page, baseRoutes());
            const before = (await transportCalls(page)).length;
            await action.click();
            await waitRowCount(page, 2);
            const afterClick = await transportCalls(page);
            assertOk(afterClick.length > before, 'the unconfigured empty state\'s action must re-check for activity');

            // Now filter that real result down to nothing. The fake transport
            // does no server-side filtering of its own (that the user/device
            // filter actually reaches the request is proven by the earlier
            // "filtering by user and device" check) -- this simulates what a
            // real server answers once a filter matches no records.
            await ctx.useTransport(page, baseRoutes({ 'GET /api/admin/audit_conn/list': listOk([]) }));
            await page.fill('#pilot-audit [data-testid="audit-user"]', 'nobody-such-user');
            await page.click('#pilot-audit [data-testid="audit-refresh"]');
            await waitRowCount(page, 0);
            assertOk(await visible(page, '#pilot-audit [data-testid="audit-empty-filtered"]'),
                'a filtered-to-zero result must get its own message');
            assertOk(!(await page.locator('#pilot-audit [data-testid="audit-empty"]').isVisible()),
                'the unconfigured message must not show once a filter is the reason for zero rows');
            await ctx.useTransport(page, baseRoutes());
            await page.click('#pilot-audit [data-testid="audit-empty-filtered-action"]');
            await waitRowCount(page, 2);
            assertEqual(await page.inputValue('#pilot-audit [data-testid="audit-user"]'), '',
                'clearing filters from the empty state actually clears them');
        } finally { await page.ctx.close(); }
    });

    await check('audit: a failing log names the reason and an auth failure recommends signing in again', async () => {
        const page = await openAudit(ctx, baseRoutes({ 'GET /api/admin/audit_conn/list': AUDIT_FAIL }));
        try {
            await page.click('#pilot-audit [data-testid="audit-refresh"]');
            assertOk(await visible(page, '#pilot-audit [data-testid="audit-alert"]'), 'the error banner appears');
            const alert = (await page.locator('#pilot-audit [data-testid="audit-alert"]').innerText()).trim();
            assertOk(alert.includes('Audit'), 'the alert must say which surface failed');
            assertMatch(alert, /permission denied/, 'the specific reason must be shown, not a generic message');
            assertEqual(await rowCount(page), 0, 'stale rows survived a failure');

            await ctx.useTransport(page, baseRoutes({ 'GET /api/admin/audit_conn/list': AUTH_FAIL }));
            await page.click('#pilot-audit [data-testid="audit-refresh"]');
            await page.waitForFunction(() => {
                const el = document.querySelector('#pilot-audit [data-testid="audit-alert-action"]');
                return el && el.textContent.trim().length > 0;
            }, null, { timeout: WAIT });
            const action = (await page.locator('#pilot-audit [data-testid="audit-alert-action"]').innerText()).trim();
            assertMatch(action, /sign in again/i,
                'API_AUTH_FAILED\'s remediation is reauthorize, not the generic retry advice');
        } finally { await page.ctx.close(); }
    });

    await check('audit: a hostile payload cannot inject markup, execute, or crash the surface', async () => {
        const hostile = [
            { id: 'x1', created_at: 'not a date', user: '<img src=x onerror="window.__xss=1">',
              from_peer: '<script>window.__xss2=1</script>', to_peer: 'p'.repeat(600),
              type: 'a\x00b', ip: '../../etc/shadow', note: 'isil ' + '\u202Eevil\u202C' }
        ];
        const page = await openAudit(ctx, baseRoutes({ 'GET /api/admin/audit_conn/list': listOk(hostile) }));
        try {
            await page.click('#pilot-audit [data-testid="audit-refresh"]');
            await waitRowCount(page, 1);
            const out = await page.evaluate(() => ({
                xss: window.__xss === 1, xss2: window.__xss2 === 1,
                imgs: document.querySelectorAll('#pilot-audit img').length,
                scripts: [...document.querySelectorAll('#pilot-audit script')].length,
                when: document.querySelector('#pilot-audit [data-testid="audit-when"]').textContent.trim(),
                row: document.querySelector('#pilot-audit [data-testid="audit-row"]').innerText
            }));
            assertEqual(out.xss, false, 'an onerror handler must never execute');
            assertEqual(out.xss2, false, 'a script tag in a device field must never execute');
            assertEqual(out.imgs, 0, 'no <img> may be created from a hostile payload');
            assertEqual(out.scripts, 0, 'no <script> may be created from a hostile payload');
            assertEqual(out.when, '—', 'an unparseable time renders the dash, not a lie');
            assertOk(out.row.includes('<script>'), 'the raw text must still be shown to the operator, as text');
            assertOk(out.row.includes('evil'), 'unicode/RTL-override input renders instead of crashing');
            assertOk(out.row.includes('p'.repeat(200)), 'a very long value renders (truncated), not a blank cell');
            await shot(page, 'audit-hostile');
        } finally { await page.ctx.close(); }
    });

    await check('audit: a failing audit leaves the Users surface working, and vice versa', async () => {
        const page = await ctx.open(ctx.browser, {});
        try {
            await page.waitForSelector('[data-tab="users"]', { state: 'attached', timeout: WAIT });
            await ctx.useTransport(page, {
                'GET /api/admin/audit_conn/list': AUDIT_FAIL,
                'GET /api/admin/user/list': listOk(USERS),
                'GET /api/admin/group/list': listOk([])
            });
            await page.click('[data-tab="audit"]');
            await page.waitForSelector('#pilot-audit [data-testid="audit-refresh"]', { state: 'attached', timeout: WAIT });
            await page.click('#pilot-audit [data-testid="audit-refresh"]');
            await page.click('[data-tab="users"]');
            await page.waitForSelector('#pilot-users [data-testid="users-refresh"]', { state: 'attached', timeout: WAIT });
            await page.click('#pilot-users [data-testid="users-refresh"]');
            await page.waitForFunction(
                () => document.querySelectorAll('#pilot-users [data-testid="users-row"]').length === 1,
                null, { timeout: WAIT });
            // #pilot-audit sits behind x-show="tab === 'audit'": its alert is
            // already set (Alpine component state survives a hidden tab), but
            // "visible" only becomes true once the audit tab is shown again.
            await page.click('[data-tab="audit"]');
            await page.waitForSelector('#pilot-audit [data-testid="audit-alert"]', { state: 'visible', timeout: WAIT });
            const alert = (await page.locator('#pilot-audit [data-testid="audit-alert"]').innerText()).trim();
            assertOk(alert.length > 0, 'the audit alert must name a reason');
            assertOk(alert.includes('Audit'), 'the alert must say which surface failed');
            assertEqual(await rowCount(page), 0, 'stale audit rows survived');
            assertEqual(await page.locator('#pilot-users [data-testid="users-alert"]').count(), 0,
                'the Users surface must not be affected by an audit failure');
        } finally { await page.ctx.close(); }
    });

    // --- multi-server: the log must survive a real switchServer() -----------
    //
    // Deliberately NOT driven through ctx.useTransport(), which replaces
    // PilotApi.setTransport wholesale and would hide the exact defect this
    // guards against: js/app.js's real wireApi()/switchServer() must dispatch
    // 'pilot:server-changed' (js/app.js's notifyServerChanged()), and
    // js/features/audit-ui.js's pilotAuditUi() must actually be listening for
    // it and re-fetching -- exactly like tests/e2e/users.e2e.mjs proves the
    // same wiring for Users, and the mutation-verify in the task report proves
    // for real by deleting the listener and watching the unit test go red.
    const PROBE_OK = { code: 0, message: '', data: {} };

    function serverRec(id, host) {
        return { id, host, sshPort: 22, apiPort: 21114, tls: false,
            domain: null, hbbsKey: null, hbbsPorts: [], installDir: '/opt/rustdesk-api', createdAt: null };
    }

    function multiServerStub(prodConn) {
        return {
            files: {
                '/etc/pilot/config.json': JSON.stringify({ activeServer: 'prod' }),
                '/etc/pilot/servers/prod.json': JSON.stringify(serverRec('prod', 'prod.example.com')),
                '/etc/pilot/servers/prod.token': 'TOK-PROD',
                '/etc/pilot/servers/staging.json': JSON.stringify(serverRec('staging', 'staging.example.com')),
                '/etc/pilot/servers/staging.token': 'TOK-STAGING'
            },
            http: {
                'GET /admin/swagger/doc.json': { status: 404, body: '404 page not found' },
                'GET /api/currentUser': PROBE_OK,
                'POST /api/ab/shared/profiles': PROBE_OK,
                'POST /api/ab/peers': PROBE_OK,
                'GET /api/admin/peer/list': PROBE_OK,
                'GET /api/admin/group/list': PROBE_OK,
                'GET /api/admin/user/list': PROBE_OK,
                'GET /api/admin/audit_file/list': PROBE_OK,
                'GET /api/admin/login_log/list': PROBE_OK,
                'GET /api/admin/audit_conn/list': listOk(prodConn)
            }
        };
    }

    async function installAlpineHelper(page) {
        await page.evaluate(() => {
            window.alpineData = function () {
                const el = document.querySelector('.pilot-shell');
                if (!el || !window.Alpine) return null;
                return window.Alpine.$data(el);
            };
        });
    }

    async function waitApiReady(page) {
        await page.waitForFunction(
            () => { const d = window.alpineData(); return !!d && d.apiReady === true; },
            null, { timeout: WAIT });
    }

    const PROD_CONN = [{ id: 'p1', created_at: 1754246400, user: 'prodop', from_peer: '111111111', type: 'remote' }];
    const STAGING_CONN = [
        { id: 's1', created_at: 1754246400, user: 'stageop1', from_peer: '222222222', type: 'remote' },
        { id: 's2', created_at: 1754250000, user: 'stageop2', from_peer: '333333333', type: 'file' }
    ];

    await check('audit: switching the active server refreshes the log with no manual click', async () => {
        const page = await ctx.open(ctx.browser, multiServerStub(PROD_CONN));
        page.setDefaultTimeout(WAIT);
        try {
            await installAlpineHelper(page);
            await waitApiReady(page);
            await page.click('[data-tab="audit"]');

            // No refresh click anywhere in this check: the initial fetch and
            // the one after switching must both happen on their own.
            await waitRowCount(page, PROD_CONN.length);
            assertOk((await page.locator('#pilot-audit [data-testid="audit-row"]').first().innerText()).includes('prodop'),
                'prod\'s connection log is shown on load with no manual refresh click');

            await page.evaluate((list) => {
                window.__pilotStub.http['GET /api/admin/audit_conn/list'] = { status: 200, body:
                    { code: 0, message: '', data: { list, page: 1, total: list.length, page_size: 50 } } };
            }, STAGING_CONN);

            await page.evaluate(() => window.alpineData().switchServer('staging'));
            await page.waitForFunction(
                () => window.alpineData().activeServerId === 'staging', null, { timeout: WAIT });

            await waitRowCount(page, STAGING_CONN.length);
            const after = await page.evaluate(() =>
                [...document.querySelectorAll('#pilot-audit [data-testid="audit-row"]')].map((tr) => tr.innerText));
            assertOk(after.some((t) => t.includes('stageop1')) && after.some((t) => t.includes('stageop2')),
                'switching server replaced the log with no Refresh click');
            assertOk(!after.some((t) => t.includes('prodop')), 'the previous server\'s rows are gone, not merely appended to');
            await shot(page, 'audit-server-switch');
        } finally { await page.ctx.close(); }
    });
}

if (isMain(import.meta.url)) process.exit(await runScenario(run, name) ? 1 : 0);
