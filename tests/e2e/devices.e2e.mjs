// tests/e2e/devices.e2e.mjs -- the Devices surface driven in a real browser.
//
// #pilot-devices sits behind x-show="tab === 'devices'" in the outer shell
// (js/app.js's pilotApp() defaults to tab: 'overview'), so every check below
// switches tabs first, exactly like tests/e2e/setup.e2e.mjs does for its own
// surface. Every request is driven through ctx.useTransport(), which replaces
// PilotApi.setTransport wholesale (C12/C15) -- this scenario never touches
// cockpit.http or builds a URL of its own.
//
// Every wait carries an explicit, short timeout: a selector or a row count
// that never appears is a bug to report in seconds, not a hang.
//
//   node tests/e2e/devices.e2e.mjs
import { isMain, runScenario } from '../e2e.mjs';

export const name = 'devices';

const WAIT = 5000;

function device(over) {
    return Object.assign({
        id: '111111111', alias: 'Kitchen Pi', online: true, last_online: 1754222400,
        ip: '10.0.0.7', platform: 'Linux', version: '1.3.7'
    }, over || {});
}

const DEVICES = [
    device({}),
    device({ id: '222222222', alias: undefined, hostname: 'reception', online: false,
        last_online: 1754136000, ip: '10.0.0.9', platform: 'Windows', version: '1.3.6' })
];

// C12: HTTP 200 even on failure, {code,message,data}; paginated data. Matches
// the shape js/core/api-client.js's `devices.list` route documents.
function listOk(list) {
    return { status: 200, body: { code: 0, message: '', data:
        { list, page: 1, total: list.length, page_size: 50 } } };
}

const LIST_FAIL = { status: 200, body: { code: 1, message: 'connection refused', data: null } };

async function openDevices(ctx, routes) {
    const page = await ctx.open(ctx.browser, {});
    page.setDefaultTimeout(WAIT);
    // Every module-owned selector below waits with 'attached' rather than the
    // default (30s) timeout -- #pilot-devices itself is hidden until the tab
    // switch below, so a plain isVisible() would race Alpine's own render tick.
    await page.waitForSelector('[data-tab="devices"]', { state: 'attached', timeout: WAIT });
    await page.click('[data-tab="devices"]');
    await page.waitForSelector('#pilot-devices [data-test="refresh"]', { state: 'attached', timeout: WAIT });
    if (routes) await ctx.useTransport(page, routes);
    return page;
}

function rowCount(page) {
    return page.evaluate(() => document.querySelectorAll('#pilot-devices [data-test="row"]').length);
}

async function waitRowCount(page, n) {
    try {
        await page.waitForFunction(
            (want) => document.querySelectorAll('#pilot-devices [data-test="row"]').length === want,
            n, { timeout: WAIT });
    } catch (e) {
        const got = await rowCount(page);
        throw new Error(`expected ${n} device row(s), still ${got} after ${WAIT}ms (${e.message})`);
    }
}

async function visible(page, selector) {
    try {
        await page.waitForSelector(selector, { state: 'visible', timeout: WAIT });
        return true;
    } catch (e) {
        return false;
    }
}

export default async function run(ctx) {
    const { check, assertEqual, assertOk, assertMatch, shot, transportCalls } = ctx;

    await check('devices: the inventory renders online state, last seen, IP, platform and version', async () => {
        const page = await openDevices(ctx, { 'GET /api/admin/peer/list': listOk(DEVICES) });
        try {
            await page.click('#pilot-devices [data-test="refresh"]');
            await waitRowCount(page, 2);

            const rows = await page.evaluate(() =>
                [...document.querySelectorAll('#pilot-devices [data-test="row"]')].map((tr) => ({
                    id: tr.getAttribute('data-device'),
                    // [data-test="name"] also contains the (hidden but still-in-DOM)
                    // rename-mode span with its Save/Cancel buttons -- textContent
                    // ignores x-show's display:none, so it would always include
                    // that text too. The x-text span is the one actually showing.
                    name: tr.querySelector('[data-test="name"] span[x-text]').textContent.trim(),
                    state: tr.querySelector('[data-test="state"]').textContent.trim(),
                    ip: tr.querySelector('[data-test="ip"]').textContent.trim(),
                    platform: tr.querySelector('[data-test="platform"]').textContent.trim(),
                    version: tr.querySelector('[data-test="version"]').textContent.trim(),
                    lastSeen: tr.querySelector('[data-test="last-seen"]').textContent.trim()
                })));
            assertEqual(rows.length, 2, 'two devices are listed');
            assertEqual(rows[0].name, 'Kitchen Pi', 'the alias is the name');
            assertEqual(rows[0].state, 'Online', 'heartbeat state is rendered');
            assertEqual(rows[1].state, 'Offline', 'an offline device says so');
            assertEqual(rows[0].ip, '10.0.0.7', 'the address is rendered');
            assertEqual(rows[1].platform, 'Windows', 'the platform is rendered');
            assertEqual(rows[0].version, '1.3.7', 'the client version is rendered');
            assertOk(rows[0].lastSeen.length > 0, 'last seen is rendered');
            await shot(page, 'devices-list');
        } finally {
            await page.ctx.close();
        }
    });

    await check('devices: the filter narrows the table without another request', async () => {
        const page = await openDevices(ctx, { 'GET /api/admin/peer/list': listOk(DEVICES) });
        try {
            await page.click('#pilot-devices [data-test="refresh"]');
            await waitRowCount(page, 2);
            await page.fill('#pilot-devices [data-test="filter"]', 'reception');
            await waitRowCount(page, 1);
            // Device LIST requests specifically: a Refresh also re-fetches the
            // address books, which is a different call and not what this asserts.
            const calls = (await transportCalls(page))
                .filter((c) => c.path.indexOf('/api/admin/peer') === 0);
            assertEqual(calls.length, 1, 'filtering is client-side on the page we already have');
        } finally {
            await page.ctx.close();
        }
    });

    await check('devices: rename writes through PilotApi and updates the row', async () => {
        const page = await openDevices(ctx, {
            'GET /api/admin/peer/list': listOk(DEVICES),
            'POST /api/admin/peer/update': { code: 0, message: '', data: {} }
        });
        try {
            await page.click('#pilot-devices [data-test="refresh"]');
            await waitRowCount(page, 2);
            await page.click('#pilot-devices [data-device="111111111"] [data-test="rename"]');
            await page.waitForSelector('#pilot-devices [data-device="111111111"] [data-test="rename-input"]',
                { state: 'visible', timeout: WAIT });
            await page.fill('#pilot-devices [data-device="111111111"] [data-test="rename-input"]', 'Pantry Pi');
            await page.click('#pilot-devices [data-device="111111111"] [data-test="rename-save"]');
            await page.waitForFunction(() => {
                const el = document.querySelector('#pilot-devices [data-device="111111111"] [data-test="name"]');
                return !!el && /Pantry Pi/.test(el.textContent);
            }, null, { timeout: WAIT });
            const calls = await transportCalls(page);
            // books() is a POST on the real API, so "not a GET" is no longer a
            // synonym for "a write". Filter by the route that was under test.
            const wrote = calls.filter((c) => c.path.indexOf('/api/admin/peer/update') === 0);
            assertOk(wrote.length >= 1, 'the rename went through PilotApi');
            // The real admin API carries the target in the body, not the path.
            assertEqual(wrote[0].path, '/api/admin/peer/update', 'the rename used the real update route');
            assertEqual(JSON.parse(wrote[0].body).id, '111111111', 'and addressed the right device');
            assertEqual(JSON.parse(wrote[0].body).alias, 'Pantry Pi',
                'the server field is `alias`; `name` is not a field it has');
        } finally {
            await page.ctx.close();
        }
    });

    await check('devices: delete asks first, then removes the row', async () => {
        const page = await openDevices(ctx, {
            'GET /api/admin/peer/list': listOk(DEVICES),
            'POST /api/admin/peer/delete': { code: 0, message: '', data: {} }
        });
        try {
            await page.click('#pilot-devices [data-test="refresh"]');
            await waitRowCount(page, 2);
            await page.click('#pilot-devices [data-device="222222222"] [data-test="delete"]');
            await page.waitForSelector('#pilot-devices [data-device="222222222"] [data-test="delete-confirm"]',
                { state: 'visible', timeout: WAIT });
            assertEqual(await rowCount(page), 2, 'nothing is deleted before the confirmation');
            await page.click('#pilot-devices [data-device="222222222"] [data-test="delete-confirm"]');
            await waitRowCount(page, 1);
        } finally {
            await page.ctx.close();
        }
    });

    await check('devices: an API failure states the reason and offers a retry', async () => {
        const page = await openDevices(ctx, { 'GET /api/admin/peer/list': LIST_FAIL });
        try {
            await page.click('#pilot-devices [data-test="refresh"]');
            assertOk(await visible(page, '#pilot-devices [data-test="error"]'), 'the error banner appears');
            const msg = (await page.textContent('#pilot-devices [data-test="error"]')).trim();
            assertMatch(msg, /connection refused/, 'the specific reason is shown, not a generic message');
            assertEqual(await rowCount(page), 0, 'a failed load shows no stale rows');

            // Re-install a working transport, then retry through the SAME page --
            // proves error-retry re-fetches rather than merely hiding the banner.
            await ctx.useTransport(page, { 'GET /api/admin/peer/list': listOk(DEVICES) });
            await page.click('#pilot-devices [data-test="error-retry"]');
            await waitRowCount(page, 2);
            await shot(page, 'devices-error-recovered');
        } finally {
            await page.ctx.close();
        }
    });

    await check('devices: an empty inventory says so, with a real next action, not a blank table (spec 7.3)', async () => {
        const page = await openDevices(ctx, { 'GET /api/admin/peer/list': listOk([]) });
        try {
            await page.click('#pilot-devices [data-test="refresh"]');
            assertOk(await visible(page, '#pilot-devices [data-test="empty"]'), 'the empty state appears');
            assertEqual(await rowCount(page), 0, 'no rows');

            // Not just text: a real, clickable control that does something.
            const action = page.locator('#pilot-devices [data-test="empty-action"]');
            assertOk(await action.isVisible(), 'the empty state offers an actionable control, not just a message');
            assertEqual(await action.evaluate((el) => el.tagName), 'BUTTON', 'the action is a real button');
            await action.click();
            const onSetup = await page.evaluate(() =>
                document.querySelector('[data-tab="setup"]').classList.contains('active'));
            assertOk(onSetup, 'the empty state\'s action genuinely navigates to Setup');
        } finally {
            await page.ctx.close();
        }
    });

    await check('devices: a filter with no matches offers its own next action, distinct from "no devices at all"', async () => {
        const page = await openDevices(ctx, { 'GET /api/admin/peer/list': listOk(DEVICES) });
        try {
            await page.click('#pilot-devices [data-test="refresh"]');
            await waitRowCount(page, 2);
            await page.fill('#pilot-devices [data-test="filter"]', 'nothing-matches-anything');
            assertOk(await visible(page, '#pilot-devices [data-test="empty-filtered"]'),
                'a filtered-to-zero result gets its own message');
            assertOk(!(await page.locator('#pilot-devices [data-test="empty"]').isVisible()),
                '"no devices have connected" must not show when two devices merely do not match the filter');
            await page.click('#pilot-devices [data-test="empty-filtered-action"]');
            await waitRowCount(page, 2);
            assertEqual(await page.inputValue('#pilot-devices [data-test="filter"]'), '',
                'clearing the filter from the empty state actually clears it');
        } finally {
            await page.ctx.close();
        }
    });

    await check('devices: add-to-address-book stays disabled while there is genuinely no book, ' +
        'with the reason on screen rather than only in a tooltip', async () => {
        const page = await openDevices(ctx, { 'GET /api/admin/peer/list': listOk(DEVICES),
            'POST /api/ab/shared/profiles': { reject: true, message: 'no address book service' } });
        try {
            await page.click('#pilot-devices [data-test="refresh"]');
            await waitRowCount(page, 2);
            const btn = page.locator('#pilot-devices [data-device="111111111"] [data-test="add-book"]');
            assertOk(await btn.isDisabled(), 'nothing to add to means the control must not look working');
            assertOk(await page.locator('#pilot-devices [data-test="book-empty-message"]').isVisible(),
                'the reason is visible, not hidden behind a tooltip only');
        } finally {
            await page.ctx.close();
        }
    });

    await check('devices: pagination states the total and says when the page is truncated', async () => {
        const page = await openDevices(ctx, { 'GET /api/admin/peer/list': { status: 200, body:
            { code: 0, message: '', data: { list: DEVICES, page: 1, total: 9, page_size: 2 } } } });
        try {
            await page.click('#pilot-devices [data-test="refresh"]');
            await waitRowCount(page, 2);
            const text = (await page.textContent('#pilot-devices [data-test="pagination"]')).trim();
            assertMatch(text, /2 of 9 device/, 'the shown count and the real total are both stated');
            assertOk(await visible(page, '#pilot-devices [data-test="pagination-truncated"]'),
                'more devices exist than fit on this page -- that must not be silently invisible');
        } finally {
            await page.ctx.close();
        }
    });

    await check('devices: an auth failure recommends signing in again, not a generic "try again"', async () => {
        // A raw HTTP 401 is what api-client.js's errorKindFor() maps to
        // API_AUTH_FAILED -- exercised at the transport level so the real
        // kind mapping runs, not a shortcut straight to a chosen kind.
        const page = await openDevices(ctx, { 'GET /api/admin/peer/list': { status: 401, body: 'unauthorized' } });
        try {
            await page.click('#pilot-devices [data-test="refresh"]');
            assertOk(await visible(page, '#pilot-devices [data-test="error"]'), 'the error banner appears');
            const remediation = (await page.textContent('#pilot-devices [data-test="error-remediation"]')).trim();
            assertMatch(remediation, /sign in again/i,
                'API_AUTH_FAILED\'s remediation is reauthorize, not the generic retry advice');
        } finally {
            await page.ctx.close();
        }
    });

    // --- multi-server: the inventory must survive a real switchServer() ----
    //
    // Deliberately NOT driven through ctx.useTransport(), which replaces
    // PilotApi.setTransport wholesale and would hide the exact defect this
    // guards against: js/app.js's real wireApi()/switchServer() are what must
    // dispatch 'pilot:server-changed' (see js/app.js's notifyServerChanged()),
    // and js/features/devices-ui.js's pilotDevices() must actually be
    // listening for it and re-keying its state by the real active server
    // rather than the constant 'local'. Both files are exercised for real
    // here, exactly like tests/e2e/servers.e2e.mjs proves the transport
    // re-wiring itself.
    const PROBE_OK = { code: 0, message: '', data: {} };

    function serverRec(id, host) {
        return { id, host, sshPort: 22, apiPort: 21114, tls: false,
            domain: null, hbbsKey: null, hbbsPorts: [], installDir: '/opt/rustdesk-api', createdAt: null };
    }

    function multiServerStub(prodDevices) {
        return {
            files: {
                '/etc/pilot/config.json': JSON.stringify({ activeServer: 'prod' }),
                '/etc/pilot/servers/prod.json': JSON.stringify(serverRec('prod', 'prod.example.com')),
                '/etc/pilot/servers/prod.token': 'TOK-PROD',
                '/etc/pilot/servers/staging.json': JSON.stringify(serverRec('staging', 'staging.example.com')),
                '/etc/pilot/servers/staging.token': 'TOK-STAGING'
            },
            http: {
                // The compatibility probe's other targets: stubbed only so
                // wireApi()'s probe does not leave an unrelated console error
                // behind. compatError is caught internally either way and does
                // not gate notifyServerChanged(), which fires before the probe.
                'GET /admin/swagger/doc.json': { status: 404, body: '404 page not found' },
                'GET /api/currentUser': PROBE_OK,
                'POST /api/ab/shared/profiles': PROBE_OK,
                'POST /api/ab/peers': PROBE_OK,
                'GET /api/admin/user/list': PROBE_OK,
                'GET /api/admin/group/list': PROBE_OK,
                'GET /api/admin/audit_conn/list': PROBE_OK,
                'GET /api/admin/audit_file/list': PROBE_OK,
                'GET /api/admin/login_log/list': PROBE_OK,
                'GET /api/admin/peer/list': listOk(prodDevices)
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
            [...document.querySelectorAll('#pilot-devices [data-test="name"] span[x-text]')]
                .map((s) => s.textContent.trim()));
    }

    const PROD_DEVICES = [device({ id: '444444444', alias: 'Prod One' })];
    const STAGING_DEVICES = [
        device({ id: '555555555', alias: 'Staging One' }),
        device({ id: '666666666', alias: 'Staging Two', online: false })
    ];

    await check('devices: switching the active server refreshes the inventory with no manual click', async () => {
        const page = await ctx.open(ctx.browser, multiServerStub(PROD_DEVICES));
        page.setDefaultTimeout(WAIT);
        try {
            await installAlpineHelper(page);
            await waitApiReady(page);
            await page.click('[data-tab="devices"]');

            // No refresh click anywhere in this check: the initial fetch and
            // the one after switching must both happen on their own.
            await waitRowCount(page, PROD_DEVICES.length);
            assertOk((await names(page)).includes('Prod One'),
                'prod\'s devices are shown on load with no manual refresh click');

            // Swapped BEFORE switching so the assertion below can only pass if
            // switchServer() genuinely triggered a NEW fetch that observed the
            // swap -- not a coincidental re-render of data already in memory.
            await page.evaluate((list) => {
                window.__pilotStub.http['GET /api/admin/peer/list'] = { status: 200, body:
                    { code: 0, message: '', data: { list, page: 1, total: list.length, page_size: 50 } } };
            }, STAGING_DEVICES);

            await page.evaluate(() => window.alpineData().switchServer('staging'));
            await page.waitForFunction(
                () => window.alpineData().activeServerId === 'staging', null, { timeout: WAIT });

            await waitRowCount(page, STAGING_DEVICES.length);
            const after = await names(page);
            assertOk(after.includes('Staging One') && after.includes('Staging Two'),
                'switching server replaced the inventory with no Refresh click');
            assertOk(!after.includes('Prod One'), 'the previous server\'s rows are gone, not merely appended to');
            await shot(page, 'devices-server-switch');
        } finally {
            await page.ctx.close();
        }
    });

    await check('devices: a hostile payload cannot inject markup or crash the surface', async () => {
        const hostile = [
            { id: '333333333', alias: '<img src=x onerror="window.__xss=1">', online: 'yes',
              last_online: 'not-a-time', ip: null, platform: 'x'.repeat(4000) },
            { alias: 'no id at all' },
            null
        ];
        const page = await openDevices(ctx, { 'GET /api/admin/peer/list': listOk(hostile) });
        try {
            await page.click('#pilot-devices [data-test="refresh"]');
            await waitRowCount(page, 1);
            const out = await page.evaluate(() => ({
                xss: window.__xss === 1,
                imgs: document.querySelectorAll('#pilot-devices img').length,
                lastSeen: document.querySelector('#pilot-devices [data-test="last-seen"]').textContent.trim(),
                name: document.querySelector('#pilot-devices [data-test="name"] span[x-text]').textContent.trim()
            }));
            assertEqual(out.xss, false, 'the payload is text, never markup');
            assertEqual(out.imgs, 0, 'no element was created from the payload');
            assertEqual(out.lastSeen, 'never', 'an unparseable time is honest');
            assertOk(out.name.includes('<img'), 'the raw text is shown to the operator');
        } finally {
            await page.ctx.close();
        }
    });

    // ============================================== FINAL REVIEW, FINDING 3 ==
    //
    // THE DEFECT: `book` was initialised to '' and never assigned anywhere, and
    // the template had no book selector at all, so "Add to address book" was
    // permanently :disabled with the title "No address book yet" -- factually
    // wrong since task 23 shipped the whole Address Book surface -- and the
    // 25-line addToBook() with its complete error handling was unreachable.
    const BOOKS_OK = { status: 200, body: { code: 0, message: '', data: { profiles: [
        { guid: '', name: 'Personal', personal: true },
        { guid: 'shared-1', name: 'Support team' }
    ] } } };

    await check('FINDING 3: the address book selector is real, and "Add to address book" ' +
        'actually calls the API with the CHOSEN book', async () => {
        const page = await openDevices(ctx, {
            'GET /api/admin/peer/list': listOk(DEVICES),
            'POST /api/ab/shared/profiles': BOOKS_OK,
            'POST /api/ab/peer/add/': { status: 200, body: { code: 0, message: '', data: {} } }
        });
        try {
            await page.click('#pilot-devices [data-test="refresh"]');
            await waitRowCount(page, 2);
            await page.waitForSelector('#pilot-devices [data-test="book"]',
                { state: 'visible', timeout: WAIT });
            const names = await page.$$eval('#pilot-devices [data-test="book"] option',
                (els) => els.map((e) => e.textContent.trim()));
            assertOk(names.includes('Support team'),
                'the selector must list the books the server really has: ' + names.join(','));

            const button = page.locator('#pilot-devices [data-test="add-book"]').first();
            assertOk(!(await button.isDisabled()),
                'with a book available the action must be enabled -- it was permanently disabled before');

            await page.selectOption('#pilot-devices [data-test="book"]', 'shared-1');
            await button.click();
            await page.waitForSelector('#pilot-devices [data-test="notice"]',
                { state: 'visible', timeout: WAIT });
            const calls = (await ctx.transportCalls(page))
                .filter((c) => c.method === 'POST' && c.path.indexOf('/api/ab/peer/add/') === 0);
            assertEqual(calls.length, 1, 'exactly one add request reached the transport');
            assertOk(calls[0].path.endsWith('/shared-1'),
                'and it names the book the operator actually chose: ' + calls[0].path);
            await shot(page, 'devices-add-to-book');
        } finally {
            await page.ctx.close();
        }
    });

    await check('FINDING 3: with no address book at all, §7.3 says render the empty state ' +
        'and its CTA -- never an empty <select>', async () => {
        const page = await openDevices(ctx, {
            'GET /api/admin/peer/list': listOk(DEVICES),
            'POST /api/ab/shared/profiles': { reject: true, message: 'no address book service' }
        });
        try {
            await page.click('#pilot-devices [data-test="refresh"]');
            await waitRowCount(page, 2);
            await page.waitForSelector('#pilot-devices [data-test="book-empty"]',
                { state: 'visible', timeout: WAIT });
            assertOk(!(await page.isVisible('#pilot-devices [data-test="book-picker"]')),
                'an empty <select> is a dead end and must not be rendered');
            const action = page.locator('#pilot-devices [data-test="book-empty-action"]');
            assertEqual(await action.evaluate((el) => el.tagName), 'BUTTON',
                'the empty state offers a real control, not just a sentence');
            await action.click();
            await page.waitForFunction(
                () => document.querySelector('#pilot-addressbook') &&
                    document.querySelector('#pilot-addressbook').offsetParent !== null,
                null, { timeout: WAIT });
            await shot(page, 'devices-no-address-book');
        } finally {
            await page.ctx.close();
        }
    });
}

if (isMain(import.meta.url)) process.exit(await runScenario(run, name) ? 1 : 0);
