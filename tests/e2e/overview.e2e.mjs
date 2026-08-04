// tests/e2e/overview.e2e.mjs -- the Overview surface driven in a real browser:
// the server switcher, the per-server device summary, and the web client link.
//
// NOTE on the harness contract: an earlier draft of this file (embedded in this
// task's brief) was written against a `run(browser)` / hand-rolled `H.open()` /
// `H.launch()` shape that predates the harness Task 4 actually shipped. The real,
// published contract (see task-4-report.md's "published scenario contract") is
// `export default async function run(ctx)` with `ctx.open(ctx.browser, stub)`,
// `ctx.check`, `ctx.assertEqual`/`ctx.assertOk`, `ctx.shot`. Task 20 hit and
// documented this exact same mismatch for tests/e2e/devices.e2e.mjs and fixed it
// the same way: written against the real contract, not the brief's stale draft.
//
// #pilot-overview is NOT behind a tab click -- js/app.js's pilotApp() defaults
// to tab: 'overview', so the surface is visible from the very first paint. Every
// request is driven through a hand-rolled PilotApi.setTransport (not
// ctx.useTransport(), because this scenario also needs to install a fake
// registry via PilotOverview.setRegistry(), which useTransport() knows nothing
// about) plus PilotOverview.setRegistry() itself (C21's own optional seam).
//
// Every wait carries an explicit, short timeout: a selector or a value that
// never appears is a bug to report in seconds, not a hang.
//
//   node tests/e2e/overview.e2e.mjs
import { isMain, runScenario } from '../e2e.mjs';

export const name = 'overview';

const WAIT = 5000;

const SERVERS = [
    { id: 'alpha', name: 'Head office', domain: 'rd.example.com', tlsTier: 'own' },
    { id: 'beta', name: 'Lab', domain: '', tlsTier: 'none' }
];

const ALPHA_DEVICES = [
    { id: '1', alias: 'a', online: true, last_online: 1754222400 },
    { id: '2', alias: 'b', online: false, last_online: 1754136000 },
    { id: '3', alias: 'c', online: true, last_online: 1754222401 }
];
const BETA_DEVICES = [{ id: '9', alias: 'lab-1', online: false, last_online: 1754136000 }];

function listOk(list) {
    return { status: 200, body: { code: 0, message: '', data:
        { list, page: 1, total: list.length, page_size: 50 } } };
}

async function openOverview(ctx) {
    const page = await ctx.open(ctx.browser, {});
    page.setDefaultTimeout(WAIT);
    await page.waitForSelector('#pilot-overview [data-test="refresh"]',
        { state: 'attached', timeout: WAIT });
    await page.waitForFunction(
        () => !!window.PilotApi && typeof window.PilotApi.setTransport === 'function' &&
            !!window.PilotOverview && typeof window.PilotOverview.setRegistry === 'function',
        null, { timeout: WAIT });
    return page;
}

// Two servers with different inventories. The transport answers according to
// whichever server the page last asked about, and counts every call so a check
// can prove a switch back is served from per-server state, not refetched.
async function installFixtures(page, servers, inventory) {
    await page.evaluate(({ list, inv }) => {
        window.__calls = [];
        window.__wizard = [];
        window.__server = 'alpha';
        window.__inventory = inv;
        document.addEventListener('pilot:open-wizard', (ev) => { window.__wizard.push(ev.detail); });
        document.addEventListener('pilot:server-changed', (ev) => { window.__server = ev.detail.id; });
        window.PilotApi.setTransport(async (req) => {
            // api-client.js's buildRequest() folds `query` into the path's own
            // query string (path + encodeQuery(query)) before the transport ever
            // sees it -- there is no separate req.query field to read.
            const path = (req && req.path) || '';
            // The Devices surface (js/features/devices-ui.js) ALSO listens for
            // pilot:server-changed and independently refetches its own inventory
            // on every switch -- that is correct, expected cross-surface
            // behaviour (Task 20), not a defect. Overview's own summary request
            // is distinguished by its fixed page_size (SUMMARY_PAGE_SIZE=200,
            // never overridden) and by never sending a `q` filter, so a check
            // that cares only about Overview's own fetch count can filter this
            // shared call log down to just its own requests.
            const isOverview = /(^|[?&])page_size=200(&|$)/.test(path) && !/(^|[?&])q=/.test(path);
            window.__calls.push({
                server: window.__server, path: path,
                surface: isOverview ? 'overview' : 'other'
            });
            const rows = window.__inventory[window.__server] || [];
            return { status: 200, body: { code: 0, message: '', data:
                { list: rows, page: 1, total: rows.length, page_size: 50 } } };
        });
        window.PilotOverview.setRegistry({
            list: async () => list,
            active: async () => 'alpha',
            setActive: async (id) => { window.__setActive = id; }
        });
    }, { list: servers, inv: inventory });
}

function summary(page) {
    return page.evaluate(() => {
        const el = (t) => document.querySelector('#pilot-overview [data-test="' + t + '"]');
        return {
            total: el('total') && el('total').textContent.trim(),
            online: el('online') && el('online').textContent.trim(),
            offline: el('offline') && el('offline').textContent.trim()
        };
    });
}

async function waitTotal(page, want, label) {
    try {
        await page.waitForFunction(
            (n) => {
                const el = document.querySelector('#pilot-overview [data-test="total"]');
                return !!el && el.textContent.trim() === n;
            }, want, { timeout: WAIT });
    } catch (e) {
        const got = await summary(page);
        throw new Error(`expected total=${want} (${label}), got ${JSON.stringify(got)} after ${WAIT}ms`);
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

// Waits for the SPECIFIC text, not merely for the element to become visible —
// the summary-error banner can already be visible (e.g. from the automatic
// first load racing js/app.js's own async wireApi()) before the check's own
// fixture takes effect, so "visible" alone would read stale content.
async function waitText(page, selector, re, label) {
    try {
        await page.waitForFunction(
            ({ sel, pattern }) => {
                const el = document.querySelector(sel);
                return !!el && el.offsetParent !== null && new RegExp(pattern).test(el.textContent);
            }, { sel: selector, pattern: re.source }, { timeout: WAIT });
    } catch (e) {
        const got = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            return el ? el.textContent.trim() : '(missing)';
        }, selector);
        throw new Error(`expected ${selector} to match ${re} (${label}), still "${got}" after ${WAIT}ms`);
    }
}

export default async function run(ctx) {
    const { check, assertEqual, assertOk, assertMatch, shot } = ctx;

    await check('overview: the switcher lists every server and summarises the active one', async () => {
        const page = await openOverview(ctx);
        try {
            await installFixtures(page, SERVERS, { alpha: ALPHA_DEVICES, beta: BETA_DEVICES });
            await page.click('#pilot-overview [data-test="refresh"]');
            await waitTotal(page, '3', 'alpha');

            const opts = await page.evaluate(() =>
                [...document.querySelectorAll('#pilot-overview [data-test="switcher"] option')]
                    .map((o) => o.value));
            assertEqual(opts.join(','), 'alpha,beta', 'both servers are switchable');
            const s = await summary(page);
            assertEqual(s.online, '2', 'two devices are online');
            assertEqual(s.offline, '1', 'one is offline');
            await shot(page, 'overview-alpha');
        } finally {
            await page.ctx.close();
        }
    });

    await check('overview: the web client opens in a new tab when TLS is configured, and is never framed', async () => {
        const page = await openOverview(ctx);
        try {
            await installFixtures(page, SERVERS, { alpha: ALPHA_DEVICES, beta: BETA_DEVICES });
            await page.click('#pilot-overview [data-test="refresh"]');
            assertOk(await visible(page, '#pilot-overview [data-test="web-client-link"]'),
                'the enabled web client link appears');

            const link = await page.evaluate(() => {
                const a = document.querySelector('#pilot-overview [data-test="web-client-link"]');
                return { href: a.getAttribute('href'), target: a.getAttribute('target'),
                    rel: a.getAttribute('rel') };
            });
            assertEqual(link.href, 'https://rd.example.com/', 'the port-less https address');
            assertEqual(link.target, '_blank', 'a new tab, never the plugin frame');
            assertOk(/noopener/.test(link.rel) && /noreferrer/.test(link.rel), 'the tab is isolated');

            // Spec: framing would require CSP frame-src to a remote origin, which
            // manifest.json deliberately does not grant -- asserted against the
            // WHOLE page, not just this surface's own subtree.
            const frames = await page.evaluate(() => document.querySelectorAll('iframe').length);
            assertEqual(frames, 0, 'the web client is never iframed, anywhere on the page');
        } finally {
            await page.ctx.close();
        }
    });

    await check('overview: without TLS the link is disabled, states why, and leads to the wizard', async () => {
        const page = await openOverview(ctx);
        try {
            await installFixtures(page, SERVERS, { alpha: ALPHA_DEVICES, beta: BETA_DEVICES });
            await page.click('#pilot-overview [data-test="refresh"]');
            await waitTotal(page, '3', 'alpha');

            await page.selectOption('#pilot-overview [data-test="switcher"]', 'beta');
            await waitTotal(page, '1', 'beta');

            const state = await page.evaluate(() => {
                const a = document.querySelector('#pilot-overview [data-test="web-client-link"]');
                const r = document.querySelector('#pilot-overview [data-test="web-client-reason"]');
                const f = document.querySelector('#pilot-overview [data-test="web-client-fix"]');
                return {
                    linkVisible: !!(a && a.offsetParent !== null),
                    reason: r && r.offsetParent !== null ? r.textContent.trim() : '',
                    fixVisible: !!(f && f.offsetParent !== null)
                };
            });
            assertEqual(state.linkVisible, false, 'no openable link without TLS');
            assertOk(state.reason.length > 20, 'the exact reason is shown, not a shrug');
            assertEqual(state.fixVisible, true, 'the route into the wizard is offered');

            await page.click('#pilot-overview [data-test="web-client-fix"]');
            await page.waitForFunction(() => window.__wizard.length === 1, null, { timeout: WAIT });
            const detail = await page.evaluate(() => window.__wizard[0]);
            assertEqual(detail.step, 'tls', 'it opens the TLS step');
            assertEqual(detail.serverId, 'beta', 'for the server the user is looking at');
            await shot(page, 'overview-no-tls');
        } finally {
            await page.ctx.close();
        }
    });

    await check('overview: switching back restores the first server\'s state without refetching', async () => {
        const page = await openOverview(ctx);
        try {
            await installFixtures(page, SERVERS, { alpha: ALPHA_DEVICES, beta: BETA_DEVICES });
            await page.click('#pilot-overview [data-test="refresh"]');
            await waitTotal(page, '3', 'alpha');

            await page.selectOption('#pilot-overview [data-test="switcher"]', 'beta');
            await waitTotal(page, '1', 'beta');
            await page.selectOption('#pilot-overview [data-test="switcher"]', 'alpha');
            await waitTotal(page, '3', 'alpha again');

            const out = await page.evaluate(() => {
                const own = window.__calls.filter((c) => c.surface === 'overview');
                return {
                    calls: own.length,
                    servers: own.map((c) => c.server).join(','),
                    online: document.querySelector('#pilot-overview [data-test="online"]').textContent.trim(),
                    offline: document.querySelector('#pilot-overview [data-test="offline"]').textContent.trim(),
                    setActive: window.__setActive
                };
            });
            assertEqual(out.calls, 2,
                'one Overview summary request per server -- the third view came from cached state');
            assertEqual(out.servers, 'alpha,beta', 'each server was fetched exactly once');
            assertEqual(out.online, '2', 'alpha\'s online count came back');
            assertEqual(out.offline, '1', 'and its offline count');
            assertEqual(out.setActive, 'alpha', 'the registry was told about the switch back');
        } finally {
            await page.ctx.close();
        }
    });

    await check('overview: an API failure keeps the server identity and the web client link', async () => {
        const page = await openOverview(ctx);
        try {
            await installFixtures(page, SERVERS, { alpha: ALPHA_DEVICES, beta: BETA_DEVICES });
            await page.evaluate(() => {
                window.PilotApi.setTransport(async () => {
                    throw window.PilotErrors.create('API_UNREACHABLE', 'connection refused');
                });
            });
            await page.click('#pilot-overview [data-test="refresh"]');
            await waitText(page, '#pilot-overview [data-test="summary-error"]',
                /connection refused/, 'the specific reason');

            const out = await page.evaluate(() => ({
                link: !!document.querySelector('#pilot-overview [data-test="web-client-link"]'),
                switcher: document.querySelectorAll('#pilot-overview [data-test="switcher"] option').length
            }));
            assertEqual(out.link, true, 'the web client link does not depend on the device listing');
            assertEqual(out.switcher, 2, 'the switcher survives a failed summary');
        } finally {
            await page.ctx.close();
        }
    });

    await check('overview: an auth failure recommends signing in again, not a generic retry', async () => {
        const page = await openOverview(ctx);
        try {
            await installFixtures(page, SERVERS, { alpha: ALPHA_DEVICES, beta: BETA_DEVICES });
            await page.evaluate(() => {
                window.PilotApi.setTransport(async () => {
                    throw window.PilotErrors.create('API_AUTH_FAILED', 'token rejected');
                });
            });
            await page.click('#pilot-overview [data-test="refresh"]');
            await waitText(page, '#pilot-overview [data-test="summary-error"]',
                /token rejected/, 'the specific reason');
            const remediation = (await page.textContent(
                '#pilot-overview [data-test="summary-error-remediation"]')).trim();
            assertMatch(remediation, /sign in again/i,
                'API_AUTH_FAILED\'s remediation is shown ON SCREEN as reauthorize, not a generic retry');
        } finally {
            await page.ctx.close();
        }
    });

    await check('overview: a server with a hostile domain is disabled, never a broken open link', async () => {
        const hostile = [
            { id: 'alpha', name: 'Head office', domain: 'rd.example.com', tlsTier: 'own' },
            { id: 'evil', name: '<img src=x onerror="window.__xss=1">',
                domain: '<script>window.__xss=2</script>.example.com', tlsTier: 'own' },
            { id: 'ipv6', name: 'IPv6 box', domain: '2001:db8::1', tlsTier: 'own' }
        ];
        const page = await openOverview(ctx);
        try {
            await installFixtures(page, hostile,
                { alpha: ALPHA_DEVICES, evil: [], ipv6: [] });
            await page.click('#pilot-overview [data-test="refresh"]');
            await waitTotal(page, '3', 'alpha');

            await page.selectOption('#pilot-overview [data-test="switcher"]', 'evil');
            await visible(page, '#pilot-overview [data-test="web-client-reason"]');
            let state = await page.evaluate(() => ({
                linkVisible: !!document.querySelector('#pilot-overview [data-test="web-client-link"]')
                    && document.querySelector('#pilot-overview [data-test="web-client-link"]').offsetParent !== null,
                xss: window.__xss,
                imgs: document.querySelectorAll('#pilot-overview img').length
            }));
            assertEqual(state.linkVisible, false, 'a hostile domain never enables the link');
            assertEqual(state.xss, undefined, 'the markup is never executed or injected');
            assertEqual(state.imgs, 0, 'no element was created from the hostile name');

            await page.selectOption('#pilot-overview [data-test="switcher"]', 'ipv6');
            await visible(page, '#pilot-overview [data-test="web-client-reason"]');
            state = await page.evaluate(() => ({
                linkVisible: !!document.querySelector('#pilot-overview [data-test="web-client-link"]')
                    && document.querySelector('#pilot-overview [data-test="web-client-link"]').offsetParent !== null
            }));
            assertEqual(state.linkVisible, false, 'a bare IPv6 address is not a domain either');
        } finally {
            await page.ctx.close();
        }
    });
}

if (isMain(import.meta.url)) process.exit(await runScenario(run, name) ? 1 : 0);
