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
        const page = await openDevices(ctx, { 'GET /admin/peer': listOk(DEVICES) });
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
        const page = await openDevices(ctx, { 'GET /admin/peer': listOk(DEVICES) });
        try {
            await page.click('#pilot-devices [data-test="refresh"]');
            await waitRowCount(page, 2);
            await page.fill('#pilot-devices [data-test="filter"]', 'reception');
            await waitRowCount(page, 1);
            const calls = await transportCalls(page);
            assertEqual(calls.length, 1, 'filtering is client-side on the page we already have');
        } finally {
            await page.ctx.close();
        }
    });

    await check('devices: rename writes through PilotApi and updates the row', async () => {
        const page = await openDevices(ctx, {
            'GET /admin/peer': listOk(DEVICES),
            'PUT /admin/peer/111111111': { code: 0, message: '', data: {} }
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
            const wrote = calls.filter((c) => c.method !== 'GET');
            assertOk(wrote.length >= 1, 'the rename went through PilotApi');
            assertEqual(wrote[0].path, '/admin/peer/111111111', 'the rename addressed the right device');
        } finally {
            await page.ctx.close();
        }
    });

    await check('devices: delete asks first, then removes the row', async () => {
        const page = await openDevices(ctx, {
            'GET /admin/peer': listOk(DEVICES),
            'DELETE /admin/peer/222222222': { code: 0, message: '', data: {} }
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
        const page = await openDevices(ctx, { 'GET /admin/peer': LIST_FAIL });
        try {
            await page.click('#pilot-devices [data-test="refresh"]');
            assertOk(await visible(page, '#pilot-devices [data-test="error"]'), 'the error banner appears');
            const msg = (await page.textContent('#pilot-devices [data-test="error"]')).trim();
            assertMatch(msg, /connection refused/, 'the specific reason is shown, not a generic message');
            assertEqual(await rowCount(page), 0, 'a failed load shows no stale rows');

            // Re-install a working transport, then retry through the SAME page --
            // proves error-retry re-fetches rather than merely hiding the banner.
            await ctx.useTransport(page, { 'GET /admin/peer': listOk(DEVICES) });
            await page.click('#pilot-devices [data-test="error-retry"]');
            await waitRowCount(page, 2);
            await shot(page, 'devices-error-recovered');
        } finally {
            await page.ctx.close();
        }
    });

    await check('devices: an empty inventory says so instead of showing a blank table', async () => {
        const page = await openDevices(ctx, { 'GET /admin/peer': listOk([]) });
        try {
            await page.click('#pilot-devices [data-test="refresh"]');
            assertOk(await visible(page, '#pilot-devices [data-test="empty"]'), 'the empty state appears');
            assertEqual(await rowCount(page), 0, 'no rows');
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
        const page = await openDevices(ctx, { 'GET /admin/peer': listOk(hostile) });
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
}

if (isMain(import.meta.url)) process.exit(await runScenario(run, name) ? 1 : 0);
