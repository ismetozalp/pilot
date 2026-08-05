// tests/e2e/users.e2e.mjs -- the Users & groups surface driven in a real browser.
//
// #pilot-users sits behind x-show="tab === 'users'" in the outer shell (same
// shape as tests/e2e/devices.e2e.mjs for Devices), so every check switches
// tabs first. Every request is driven through ctx.useTransport(), which
// replaces PilotApi.setTransport wholesale (C12/C15) -- this scenario never
// touches cockpit.http or builds a URL of its own.
//
// The password-reset path gets its own dedicated check: a submitted password
// must never end up in a URL, a query string, the DOM outside its own input
// (walking every element's live .value and every attribute -- not just
// innerHTML, which x-model's live DOM property would not show up in), or
// browser storage.
//
//   node tests/e2e/users.e2e.mjs
import { isMain, runScenario } from '../e2e.mjs';

export const name = 'users';

const WAIT = 5000;

const GROUPS = [
    { id: 'g1', name: 'Support', device_count: 4, info: 'Tier-1 desks' },
    { id: 'g2', name: 'Field', device_count: 0 }
];
const USERS = [
    { id: 1, name: 'ada', email: 'ada@example.com', group_id: 'g1', status: 1, is_admin: true },
    { id: 2, name: 'bob', email: 'bob@example.com', group_id: 'g2', status: 0 },
    { id: 3, name: 'cem', email: 'cem@example.com', group_id: '', status: 1 }
];

// C12: HTTP 200 even on failure, {code,message,data}; paginated data. Matches
// the shape js/core/api-client.js's users.list/users.groups routes document.
function listOk(list) {
    return { status: 200, body: { code: 0, message: '', data:
        { list, page: 1, total: list.length, page_size: 50 } } };
}
const LIST_FAIL = { status: 200, body: { code: 1, message: 'permission denied', data: null } };
const AUTH_FAIL = { status: 401, body: 'unauthorized' };

function baseRoutes(over) {
    return Object.assign({
        'GET /api/admin/group/list': listOk(GROUPS),
        'GET /api/admin/user/list': listOk(USERS)
    }, over || {});
}

async function openUsers(ctx, routes) {
    const page = await ctx.open(ctx.browser, {});
    page.setDefaultTimeout(WAIT);
    await page.waitForSelector('[data-tab="users"]', { state: 'attached', timeout: WAIT });
    await page.click('[data-tab="users"]');
    await page.waitForSelector('#pilot-users [data-testid="users-refresh"]', { state: 'attached', timeout: WAIT });
    if (routes) await ctx.useTransport(page, routes);
    return page;
}

function rowCount(page) {
    return page.evaluate(() => document.querySelectorAll('#pilot-users [data-testid="users-row"]').length);
}

async function waitRowCount(page, n) {
    try {
        await page.waitForFunction(
            (want) => document.querySelectorAll('#pilot-users [data-testid="users-row"]').length === want,
            n, { timeout: WAIT });
    } catch (e) {
        const got = await rowCount(page);
        throw new Error(`expected ${n} account row(s), still ${got} after ${WAIT}ms (${e.message})`);
    }
}

async function visible(page, selector) {
    try { await page.waitForSelector(selector, { state: 'visible', timeout: WAIT }); return true; }
    catch (e) { return false; }
}

// Walks EVERY element's live .value property (what x-model actually sets --
// innerHTML alone misses it, the exact gap the brief calls out from Task 16)
// plus every attribute of every element, plus both storages.
function secretLeakScan(needle) {
    const els = [...document.querySelectorAll('*')];
    const valueHit = els.some((el) => 'value' in el && typeof el.value === 'string' && el.value.includes(needle));
    const attrHit = els.some((el) => (el.getAttributeNames ? el.getAttributeNames() : [])
        .some((name) => (el.getAttribute(name) || '').includes(needle)));
    const htmlHit = document.documentElement.outerHTML.includes(needle);
    const storageHit = (JSON.stringify(Object.entries(localStorage)) +
        JSON.stringify(Object.entries(sessionStorage))).includes(needle);
    return { valueHit, attrHit, htmlHit, storageHit };
}

export default async function run(ctx) {
    const { check, assertEqual, assertOk, assertMatch, shot, transportCalls } = ctx;

    await check('users: the surface renders into #pilot-users', async () => {
        const page = await openUsers(ctx, baseRoutes());
        try {
            assertEqual(await page.locator('#pilot-users [data-testid="users-root"]').count(), 1,
                'the users surface did not mount');
        } finally { await page.ctx.close(); }
    });

    await check('users: accounts load with group names, device counts and status', async () => {
        const page = await openUsers(ctx, baseRoutes());
        try {
            await page.click('#pilot-users [data-testid="users-refresh"]');
            await waitRowCount(page, 3);
            assertEqual(await page.locator('#pilot-users [data-testid="users-total"]').innerText(), '3',
                'wrong total');
            const first = page.locator('#pilot-users [data-testid="users-row"]').first();
            const txt = await first.innerText();
            assertOk(txt.includes('ada'), 'the first account is not ada');
            assertOk(txt.includes('Enabled'), 'ada should be enabled');
            const groupOpt = await first.locator(
                '[data-testid="users-group"] option[selected]').first().innerText();
            assertMatch(groupOpt, /Support \(4 devices\)/, 'the group name and device count are both shown');
            assertEqual(await page.locator('#pilot-users [data-testid="users-alert"]').count(), 0,
                'a healthy load must not alert');
            await shot(page, 'users-list');
        } finally { await page.ctx.close(); }
    });

    // The fake transport below always answers the SAME GET body (there is no
    // real server remembering the write), so these two checks assert on the
    // request the façade actually issued -- method, path and JSON body (the
    // wire body is a JSON-encoded string, per api-client.js's buildRequest) --
    // rather than on a visual re-render the mock cannot produce.
    function jsonBody(call) {
        if (!call || typeof call.body !== 'string') return null;
        try { return JSON.parse(call.body); } catch (e) { return null; }
    }

    await check('users: Disable calls the façade with the right id and status, then re-reads the list', async () => {
        const page = await openUsers(ctx, baseRoutes({ 'POST /api/admin/user/update': { code: 0, message: '', data: {} } }));
        try {
            await page.click('#pilot-users [data-testid="users-refresh"]');
            await waitRowCount(page, 3);
            await page.evaluate(() => { window.__before = 0; });
            await page.locator('#pilot-users [data-testid="users-row"]').first()
                .locator('[data-testid="users-toggle"]').click();
            await page.waitForFunction(() => (window.__pilotTransport || { calls: [] }).calls
                .some((c) => c.path.indexOf('/api/admin/user/update') === 0), null, { timeout: WAIT });
            const calls = await transportCalls(page);
            const wrote = calls.find((c) => c.path.indexOf('/api/admin/user/update') === 0);
            assertOk(wrote, 'no write request was issued');
            assertEqual(wrote.method, 'POST', 'the admin API has no PUT at all');
            assertEqual(jsonBody(wrote) && jsonBody(wrote).id, 1,
                'the toggle addressed the right account, with the integer id the server types');
            assertEqual(jsonBody(wrote) && jsonBody(wrote).status, 0, 'disabling must send status:0');
            const gets = calls.filter((c) => c.method === 'GET' && c.path.indexOf('/admin/user') !== -1);
            assertOk(gets.length >= 2, 'the list was not re-read after the write');
        } finally { await page.ctx.close(); }
    });

    await check('users: assigning a different group calls setGroup with the right ids', async () => {
        const page = await openUsers(ctx, baseRoutes({ 'POST /api/admin/user/update': { code: 0, message: '', data: {} } }));
        try {
            await page.click('#pilot-users [data-testid="users-refresh"]');
            await waitRowCount(page, 3);
            const row = page.locator('#pilot-users [data-testid="users-row"]').nth(2);
            await row.locator('[data-testid="users-group"]').selectOption('g2');
            await page.waitForFunction(() => (window.__pilotTransport || { calls: [] }).calls
                .some((c) => c.path.indexOf('/api/admin/user/update') === 0), null, { timeout: WAIT });
            const calls = await transportCalls(page);
            const wrote = calls.find((c) => c.path.indexOf('/api/admin/user/update') === 0 &&
                jsonBody(c) && jsonBody(c).id === 3);
            assertOk(wrote, 'setGroup did not reach the façade');
            assertEqual(jsonBody(wrote) && jsonBody(wrote).group_id, 'g2', 'the wrong group id was sent');
        } finally { await page.ctx.close(); }
    });

    await check('users: a row assigned to a group the Groups fetch never returned still shows its true group', async () => {
        // Groups is deliberately empty here, and u1's group_id ('g1') never
        // appears in it -- proves the <select> cannot silently fall back to
        // its default "Unassigned" option for an account that IS assigned.
        const page = await openUsers(ctx, baseRoutes({ 'GET /api/admin/group/list': listOk([]) }));
        try {
            await page.click('#pilot-users [data-testid="users-refresh"]');
            await waitRowCount(page, 3);
            const first = page.locator('#pilot-users [data-testid="users-row"]').first();
            const selected = await first.locator('[data-testid="users-group"] option[selected]').first().innerText();
            assertMatch(selected, /Group g1/, 'an unresolved group id must be shown honestly, not as Unassigned');
        } finally { await page.ctx.close(); }
    });

    await check('users: resetting a password sends it once and it never lands in the DOM, a URL or storage', async () => {
        const SECRET = 'correct horse battery staple 42';
        // A password change is its OWN endpoint now: /user/update has no
        // password field at all, so the old route would have accepted the call
        // and changed nothing.
        const page = await openUsers(ctx, baseRoutes({
            'POST /api/admin/user/changePwd': { code: 0, message: '', data: {} } }));
        try {
            await page.click('#pilot-users [data-testid="users-refresh"]');
            await waitRowCount(page, 3);
            const row = page.locator('#pilot-users [data-testid="users-row"]').nth(1);
            await row.locator('[data-testid="users-password"]').fill(SECRET);

            // Mid-typing: the secret sits only in its own input's live property.
            const mid = await page.evaluate(secretLeakScan, SECRET);
            assertEqual(mid.htmlHit, false, 'a typed password leaked into serialised markup');
            assertEqual(mid.attrHit, false, 'a typed password leaked into an attribute');
            assertEqual(mid.storageHit, false, 'a typed password leaked into browser storage');

            await row.locator('[data-testid="users-reset"]').click();
            await page.waitForFunction(() => {
                const rows = [...document.querySelectorAll('#pilot-users [data-testid="users-row"]')];
                return rows[1] && rows[1].querySelector('[data-testid="users-password"]').value === '';
            }, null, { timeout: WAIT });

            const calls = await transportCalls(page);
            const wrote = calls.find((c) => c.path === '/api/admin/user/changePwd' &&
                jsonBody(c) && jsonBody(c).id === 2);
            assertOk(wrote, 'resetPassword did not reach the façade');
            assertEqual(jsonBody(wrote) && jsonBody(wrote).password, SECRET, 'the password did not reach the API body');
            assertOk(wrote.path.indexOf(SECRET) === -1, 'the password leaked into the request PATH');
            assertOk(!calls.some((c) => JSON.stringify(c.query || {}).includes(SECRET)),
                'the password leaked into a query string');

            // After the reset: forgotten everywhere, including the input itself.
            const after = await page.evaluate(secretLeakScan, SECRET);
            assertEqual(after.valueHit, false, 'the password is still sitting in a DOM element .value');
            assertEqual(after.htmlHit, false, 'the password leaked into serialised markup');
            assertEqual(after.attrHit, false, 'the password leaked into an attribute');
            assertEqual(after.storageHit, false, 'the password leaked into browser storage');
        } finally { await page.ctx.close(); }
    });

    await check('users: an invalid new account never reaches the API', async () => {
        const page = await openUsers(ctx, baseRoutes());
        try {
            await page.click('#pilot-users [data-testid="users-refresh"]');
            await waitRowCount(page, 3);
            await page.fill('#pilot-users [data-testid="users-new-name"]', 'a/b');
            await page.fill('#pilot-users [data-testid="users-new-password"]', 'short');
            await page.fill('#pilot-users [data-testid="users-new-confirm"]', 'other');
            const before = (await transportCalls(page)).length;
            await page.click('#pilot-users [data-testid="users-create-submit"]');
            await page.waitForSelector('#pilot-users [data-testid="users-form-problems"]',
                { state: 'visible', timeout: WAIT });
            const after = await transportCalls(page);
            assertEqual(after.length, before, 'an invalid form must not reach the API');
        } finally { await page.ctx.close(); }
    });

    await check('users: creating a valid account posts once and resets the form', async () => {
        const page = await openUsers(ctx, baseRoutes({ 'POST /api/admin/user/create': { code: 0, message: '', data: {} } }));
        try {
            await page.click('#pilot-users [data-testid="users-refresh"]');
            await waitRowCount(page, 3);
            await page.fill('#pilot-users [data-testid="users-new-name"]', 'newop');
            await page.fill('#pilot-users [data-testid="users-new-password"]', 'a very good password');
            await page.fill('#pilot-users [data-testid="users-new-confirm"]', 'a very good password');
            await page.click('#pilot-users [data-testid="users-create-submit"]');
            await page.waitForFunction(() =>
                document.querySelector('#pilot-users [data-testid="users-new-name"]').value === '',
                null, { timeout: WAIT });
            const calls = await transportCalls(page);
            const posted = calls.filter((c) => c.path === '/api/admin/user/create');
            assertEqual(posted.length, 1, 'exactly one account must be created');
            assertEqual(jsonBody(posted[0]) && jsonBody(posted[0]).name, 'newop', 'the wrong account was created');
        } finally { await page.ctx.close(); }
    });

    await check('users: an empty roster shows a real actionable empty state, not an error', async () => {
        const page = await openUsers(ctx, baseRoutes({ 'GET /api/admin/user/list': listOk([]) }));
        try {
            await page.click('#pilot-users [data-testid="users-refresh"]');
            assertOk(await visible(page, '#pilot-users [data-testid="users-empty"]'), 'the empty state appears');
            assertEqual(await rowCount(page), 0, 'no rows');
            assertEqual(await page.locator('#pilot-users [data-testid="users-alert"]').count(), 0,
                'an empty roster is not an error');
            const action = page.locator('#pilot-users [data-testid="users-empty-action"]');
            assertOk(await action.isVisible(), 'the empty state offers an actionable control');
            assertEqual(await action.evaluate((el) => el.tagName), 'BUTTON', 'the action is a real button');
            await action.click();
            const focused = await page.evaluate(() =>
                document.activeElement && document.activeElement.getAttribute('data-testid'));
            assertEqual(focused, 'users-new-name', 'the empty state action must focus the create-account field');
        } finally { await page.ctx.close(); }
    });

    await check('users: a search with no matches gets its own empty state, distinct from "no accounts at all"', async () => {
        const page = await openUsers(ctx, baseRoutes({ 'GET /api/admin/user/list?keyword=nomatch': listOk([]) }));
        try {
            await page.click('#pilot-users [data-testid="users-refresh"]');
            await waitRowCount(page, 3);
            await page.fill('#pilot-users [data-testid="users-search"]', 'nomatch');
            await page.click('#pilot-users [data-testid="users-refresh"]');
            assertOk(await visible(page, '#pilot-users [data-testid="users-empty-filtered"]'),
                'a filtered-to-zero result gets its own message');
            assertOk(!(await page.locator('#pilot-users [data-testid="users-empty"]').isVisible()),
                '"no accounts at all" must not show when a search merely matched nothing');
            await page.click('#pilot-users [data-testid="users-empty-filtered-action"]');
            await waitRowCount(page, 3);
            assertEqual(await page.inputValue('#pilot-users [data-testid="users-search"]'), '',
                'clearing the search from the empty state actually clears it');
        } finally { await page.ctx.close(); }
    });

    await check('users: a failing list shows a specific reason and no rows', async () => {
        const page = await openUsers(ctx, baseRoutes({ 'GET /api/admin/user/list': LIST_FAIL }));
        try {
            await page.click('#pilot-users [data-testid="users-refresh"]');
            assertOk(await visible(page, '#pilot-users [data-testid="users-alert"]'), 'the error banner appears');
            const alert = (await page.locator('#pilot-users [data-testid="users-alert"]').innerText()).trim();
            assertOk(alert.includes('Users'), 'the alert must say which surface failed');
            assertMatch(alert, /permission denied/, 'the specific reason must be shown, not a generic message');
            assertEqual(await rowCount(page), 0, 'stale rows survived a failure');
        } finally { await page.ctx.close(); }
    });

    await check('users: an auth failure recommends signing in again, not a generic "try again"', async () => {
        const page = await openUsers(ctx, baseRoutes({ 'GET /api/admin/user/list': AUTH_FAIL }));
        try {
            await page.click('#pilot-users [data-testid="users-refresh"]');
            assertOk(await visible(page, '#pilot-users [data-testid="users-alert"]'), 'the error banner appears');
            const action = (await page.locator('#pilot-users [data-testid="users-alert-action"]').innerText()).trim();
            assertMatch(action, /sign in again/i,
                'API_AUTH_FAILED\'s remediation is reauthorize, not the generic retry advice');
        } finally { await page.ctx.close(); }
    });

    await check('users: a groups failure is a warning; the accounts still render', async () => {
        const page = await openUsers(ctx, baseRoutes({ 'GET /api/admin/group/list': { status: 200, body:
            { code: 7, message: 'group service unavailable', data: null } } }));
        try {
            await page.click('#pilot-users [data-testid="users-refresh"]');
            await waitRowCount(page, 3);
            assertOk(await visible(page, '#pilot-users [data-testid="users-alert"]'),
                'a groups failure must still surface as a warning');
            const alert = await page.locator('#pilot-users [data-testid="users-alert"]').innerText();
            assertOk(alert.includes('Groups'), 'the warning must name Groups, not Users');
            const first = page.locator('#pilot-users [data-testid="users-row"]').first();
            const selected = await first.locator('[data-testid="users-group"] option[selected]').first().innerText();
            assertMatch(selected, /Group g1/, 'an unresolved group id must fall back honestly, not disappear');
        } finally { await page.ctx.close(); }
    });

    await check('users: a hostile payload cannot inject markup, execute, or crash the surface', async () => {
        const hostile = [
            { id: '333333333', name: '<img src=x onerror="window.__xss=1">', email: 'x@example.com',
              group_id: 'g1', status: 1 },
            { id: '444444444', name: 'a\x00b\x01c', email: 'y@example.com', status: 1 },
            { id: '555555555', name: 'ışıl ' + '\u202E' + 'evil' + '\u202C', email: 'z@example.com', status: 1 },
            { id: '666666666', name: 'n'.repeat(4000), email: 'w@example.com', status: 1 }
        ];
        const hostileGroups = [{ id: 'g1', name: '<script>window.__xss2=1</script>', device_count: 1 }];
        const page = await openUsers(ctx, baseRoutes({
            'GET /api/admin/user/list': listOk(hostile), 'GET /api/admin/group/list': listOk(hostileGroups)
        }));
        try {
            await page.click('#pilot-users [data-testid="users-refresh"]');
            await waitRowCount(page, 4);
            const out = await page.evaluate(() => ({
                xss: window.__xss === 1, xss2: window.__xss2 === 1,
                imgs: document.querySelectorAll('#pilot-users img').length,
                scripts: [...document.querySelectorAll('#pilot-users script')].length,
                rows: [...document.querySelectorAll('#pilot-users [data-testid="users-row"]')]
                    .map((tr) => tr.innerText)
            }));
            assertEqual(out.xss, false, 'an onerror handler in a name must never execute');
            assertEqual(out.xss2, false, 'a script tag in a group name must never execute');
            assertEqual(out.imgs, 0, 'no <img> may be created from a hostile payload');
            assertEqual(out.scripts, 0, 'no <script> may be created from a hostile payload');
            assertOk(out.rows[0].includes('<img'), 'the raw text must still be shown to the operator, as text');
            assertOk(out.rows[2].includes('evil'), 'unicode/RTL-override input renders instead of crashing');
            const longRow = out.rows[3];
            assertOk(longRow.includes('n'), 'a very long value renders (truncated), not a blank cell');
            await shot(page, 'users-hostile');
        } finally { await page.ctx.close(); }
    });

    // --- multi-server: the roster must survive a real switchServer() --------
    //
    // Deliberately NOT driven through ctx.useTransport(), which replaces
    // PilotApi.setTransport wholesale and would hide the exact defect this
    // guards against: js/app.js's real wireApi()/switchServer() must dispatch
    // 'pilot:server-changed' (js/app.js's notifyServerChanged()), and
    // js/features/users-ui.js's pilotUsersUi() must actually be listening for
    // it and re-fetching -- exactly like tests/e2e/devices.e2e.mjs proves the
    // same wiring for Devices.
    const PROBE_OK = { code: 0, message: '', data: {} };

    function serverRec(id, host) {
        return { id, host, sshPort: 22, apiPort: 21114, tls: false,
            domain: null, hbbsKey: null, hbbsPorts: [], installDir: '/opt/rustdesk-api', createdAt: null };
    }

    function multiServerStub(prodUsers) {
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
                'GET /api/admin/audit_conn/list': PROBE_OK,
                'GET /api/admin/audit_file/list': PROBE_OK,
                'GET /api/admin/login_log/list': PROBE_OK,
                'GET /api/admin/group/list': listOk(GROUPS),
                'GET /api/admin/user/list': listOk(prodUsers)
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

    function names(page) {
        return page.evaluate(() =>
            [...document.querySelectorAll('#pilot-users [data-testid="users-row"] span[x-text]')]
                .map((s) => s.textContent.trim()));
    }

    const PROD_USERS = [{ id: '777', name: 'prodadmin', email: 'p@example.com', status: 1 }];
    const STAGING_USERS = [
        { id: '888', name: 'staginguser1', email: 's1@example.com', status: 1 },
        { id: '999', name: 'staginguser2', email: 's2@example.com', status: 0 }
    ];

    await check('users: switching the active server refreshes the roster with no manual click', async () => {
        const page = await ctx.open(ctx.browser, multiServerStub(PROD_USERS));
        page.setDefaultTimeout(WAIT);
        try {
            await installAlpineHelper(page);
            await waitApiReady(page);
            await page.click('[data-tab="users"]');

            // No refresh click anywhere in this check: the initial fetch and
            // the one after switching must both happen on their own.
            await waitRowCount(page, PROD_USERS.length);
            assertOk((await names(page)).includes('prodadmin'),
                'prod\'s accounts are shown on load with no manual refresh click');

            await page.evaluate((list) => {
                window.__pilotStub.http['GET /api/admin/user/list'] = { status: 200, body:
                    { code: 0, message: '', data: { list, page: 1, total: list.length, page_size: 50 } } };
            }, STAGING_USERS);

            await page.evaluate(() => window.alpineData().switchServer('staging'));
            await page.waitForFunction(
                () => window.alpineData().activeServerId === 'staging', null, { timeout: WAIT });

            await waitRowCount(page, STAGING_USERS.length);
            const after = await names(page);
            assertOk(after.includes('staginguser1') && after.includes('staginguser2'),
                'switching server replaced the roster with no Refresh click');
            assertOk(!after.includes('prodadmin'), 'the previous server\'s rows are gone, not merely appended to');
            await shot(page, 'users-server-switch');
        } finally { await page.ctx.close(); }
    });
}

if (isMain(import.meta.url)) process.exit(await runScenario(run, name) ? 1 : 0);
