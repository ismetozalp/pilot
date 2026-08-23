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
        window.__inventory = inv;
        document.addEventListener('pilot:open-wizard', (ev) => { window.__wizard.push(ev.detail); });

        // Builds a transport BOUND to one server id, exactly like a real
        // PilotApiIo.transport(conn) closure captures one server's address at
        // the moment js/app.js's wireApi() builds it. This matters once
        // js/features/overview.js's own onServerChanged() can fire a second,
        // concurrent fetch alongside selectServer()'s eager one (see
        // js/features/overview.js's loadSummary() token guard): an
        // in-flight request from an OLD transport must keep answering for
        // the OLD server even after the page has switched again, never read
        // whatever server happens to be current when it finally executes --
        // a single shared mutable "current server" variable would get that
        // wrong in exactly the way a real per-connection closure cannot.
        function transportFor(id) {
            return async (req) => {
                // api-client.js's buildRequest() folds `query` into the
                // path's own query string before the transport ever sees it.
                const path = (req && req.path) || '';
                // The Devices surface (js/features/devices-ui.js) ALSO
                // listens for pilot:server-changed and independently
                // refetches its own inventory on every switch -- correct,
                // expected cross-surface behaviour (Task 20), not a defect.
                // Overview's own summary request is distinguished by its
                // fixed page_size (SUMMARY_PAGE_SIZE=200, never overridden)
                // and by never sending a `q` filter.
                const isOverview = /(^|[?&])page_size=200(&|$)/.test(path) && !/(^|[?&])q=/.test(path);
                window.__calls.push({ server: id, path: path, surface: isOverview ? 'overview' : 'other' });
                const rows = window.__inventory[id] || [];
                return { status: 200, body: { code: 0, message: '', data:
                    { list: rows, page: 1, total: rows.length, page_size: 50 } } };
            };
        }
        document.addEventListener('pilot:server-changed', (ev) => {
            window.PilotApi.setTransport(transportFor(ev.detail.id));
        });
        window.PilotApi.setTransport(transportFor('alpha'));
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

    await check('overview: administration opens in a new tab when TLS is configured, and is never framed', async () => {
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
            // /webclient/ is where rustdesk-api serves the browser client. The
            // site root 302s to /_admin/, so pointing there opened the ADMIN
            // console -- a page that loads, which is why it read as working.
            // The card links to the ADMIN CONSOLE. Pilot disables the web
            // client at provision time -- the bundled one cannot reach a
            // self-hosted rendezvous server -- so linking to it was a dead end.
            assertEqual(link.href, 'https://rd.example.com/_admin/',
                'the port-less https address, ON the admin console');
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

            // GAP B (task 33): window.__wizard above only proves the event was
            // DISPATCHED -- that was already true before this fix, via a
            // test-harness-only listener installed by installFixtures(). The
            // production defect was that NOTHING else reacted to it: clicking
            // "Set up TLS" left #pilot-setup hidden and the tab unchanged.
            // This is the real, mutation-verified assertion: js/app.js's
            // openWizard() (wired in index.html on .pilot-shell) must actually
            // switch the tab.
            await page.waitForSelector('[data-tab="setup"].active', { timeout: WAIT });
            await page.waitForSelector('#pilot-setup', { state: 'visible', timeout: WAIT });
            assertOk(true, 'clicking "Set up TLS" must genuinely navigate to the Setup tab, not just dispatch an event');
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
            // selectServer()'s own eager fetch is still cache-aware (it alone
            // would make this exactly 2 -- one per server). But the CRITICAL
            // review fix added onServerChanged(), which forces one CONFIRMING
            // re-fetch every time the real "the switch has genuinely landed"
            // signal arrives (js/app.js's notifyServerChanged(), or here,
            // installFixtures()' stand-in for it) -- correctness over raw
            // efficiency, deliberately: it is what stops a stale eager fetch
            // from a still-old transport silently winning. So each switch now
            // costs one eager fetch plus one confirming fetch.
            assertEqual(out.calls, 4, 'one eager + one confirming Overview request per switch');
            // Exact interleaving between the eager and confirming fetch of
            // the SAME switch is not guaranteed (both are async and can
            // settle in either order) -- what must hold is that each server
            // was asked about exactly twice, never more, never the wrong one.
            const counts = out.servers.split(',').reduce((m, s) => (m[s] = (m[s] || 0) + 1, m), {});
            assertEqual(counts.alpha, 2, 'alpha was asked about exactly twice');
            assertEqual(counts.beta, 2, 'beta was asked about exactly twice');
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

    // --- CRITICAL: the switch must actually re-wire PilotApi's transport ---
    //
    // Every check above drives Overview through a hand-rolled fake transport
    // installed by installFixtures(), which hides the exact defect a live
    // review run reproduced: selectServer() only persists the choice and
    // dispatches 'pilot:server-changed' -- it never itself calls
    // PilotApi.setTransport. Before index.html gained
    // `@pilot:server-changed.document="switchServer($event.detail.id)"` (and
    // js/app.js's switchServer() gained its re-entrancy guard), NOTHING closed
    // that loop: the UI switcher would show "beta" while every HTTP request
    // kept dialling alpha's address forever. This check drives ONLY the
    // Overview <select> -- never window.alpineData().switchServer() directly,
    // which would prove the wiring exists but not that the switcher UI
    // actually reaches it -- against the REAL, file-backed PilotServers
    // registry and the REAL cockpit stub, exactly like
    // tests/e2e/devices.e2e.mjs's own multi-server check. It asserts on
    // window.__pilotStub.calls' recorded `address`, never on the UI label,
    // because the label was right while the review found the data wrong.
    const PROBE_OK = { code: 0, message: '', data: {} };

    function serverRec(id, host) {
        return { id, host, sshPort: 22, apiPort: 21114, tls: false,
            domain: null, hbbsKey: null, hbbsPorts: [], installDir: '/opt/rustdesk-api', createdAt: null };
    }

    function realMultiServerStub(alphaDevices) {
        return {
            spawn: {
                // Exactly the argv js/core/servers.js's list() joins and runs;
                // Overview's own default registry (root.PilotServers) is what
                // calls this, unlike js/app.js's wireApi()/switchServer(),
                // which only ever reads a single record by id and never lists.
                'find /etc/pilot/servers -maxdepth 1 -type f -name *.json':
                    '/etc/pilot/servers/alpha.json\n/etc/pilot/servers/beta.json\n'
            },
            files: {
                '/etc/pilot/config.json': JSON.stringify({ activeServer: 'alpha' }),
                '/etc/pilot/servers/alpha.json': JSON.stringify(serverRec('alpha', 'alpha.example.com')),
                '/etc/pilot/servers/alpha.token': 'TOK-ALPHA',
                '/etc/pilot/servers/beta.json': JSON.stringify(serverRec('beta', 'beta.example.com')),
                '/etc/pilot/servers/beta.token': 'TOK-BETA'
            },
            http: {
                // Stubbed only so wireApi()'s advisory compatibility probe
                // does not leave an unrelated console error behind; it runs
                // AFTER notifyServerChanged() and does not gate this check.
                'GET /admin/swagger/doc.json': { status: 404, body: '404 page not found' },
                'GET /api/currentUser': PROBE_OK,
                'POST /api/ab/shared/profiles': PROBE_OK,
                'POST /api/ab/peers': PROBE_OK,
                'GET /api/admin/user/list': PROBE_OK,
                'GET /api/admin/group/list': PROBE_OK,
                'GET /api/admin/audit_conn/list': PROBE_OK,
                'GET /api/admin/audit_file/list': PROBE_OK,
                'GET /api/admin/login_log/list': PROBE_OK,
                'GET /api/admin/peer/list': listOk(alphaDevices)
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

    function peerCalls(page) {
        return page.evaluate(() => window.__pilotStub.calls
            .filter((c) => c.kind === 'http' && c.method === 'GET' && c.path.indexOf('/api/admin/peer') === 0));
    }

    await check('CRITICAL: switching ONLY through the Overview control re-wires the real transport', async () => {
        const page = await ctx.open(ctx.browser, realMultiServerStub(ALPHA_DEVICES));
        page.setDefaultTimeout(WAIT);
        try {
            await installAlpineHelper(page);
            await waitApiReady(page);
            // 'attached', not the default 'visible': an <option> inside a
            // <select> reports no box of its own, so a plain visibility wait
            // would time out even once it genuinely exists.
            await page.waitForSelector('#pilot-overview [data-test="switcher"] option',
                { state: 'attached', timeout: WAIT });
            await page.waitForFunction(() =>
                document.querySelectorAll('#pilot-overview [data-test="switcher"] option').length === 2,
                null, { timeout: WAIT });

            const before = await peerCalls(page);
            assertOk(before.length >= 1, 'the initial load already fetched alpha\'s devices');
            assertEqual(before[before.length - 1].address, 'alpha.example.com',
                'the initial transport dials alpha, as configured');

            // Swapped BEFORE switching, exactly like devices.e2e.mjs's own
            // multi-server check: the later assertion can only pass if the
            // switch genuinely triggered a NEW fetch that observed the swap,
            // never a coincidental re-render of data already in memory.
            await page.evaluate((list) => {
                window.__pilotStub.http['GET /api/admin/peer/list'] = { status: 200, body:
                    { code: 0, message: '', data: { list, page: 1, total: list.length, page_size: 50 } } };
            }, BETA_DEVICES);

            // The ONLY action in this check: the Overview <select>. Never
            // window.alpineData().switchServer() -- that would prove the
            // re-wiring code exists, not that the switcher UI reaches it.
            await page.selectOption('#pilot-overview [data-test="switcher"]', 'beta');

            // Proves the REAL shell-level switch completed (not just
            // Overview's own local activeId), i.e. that the loop actually
            // closed: js/app.js's own activeServerId, not anything
            // Overview keeps for itself.
            await page.waitForFunction(
                () => window.alpineData().activeServerId === 'beta', null, { timeout: WAIT });

            await waitTotal(page, String(BETA_DEVICES.length), 'beta, after the real switch');

            const after = await peerCalls(page);
            const last = after[after.length - 1];
            assertEqual(last.address, 'beta.example.com',
                'the request AFTER switching carries the NEW server\'s address, not the old one');

            // Not a one-off: a further, independent action (Overview's own
            // Refresh button) must ALSO still dial beta -- this is exactly
            // what the review reported broken ("ALL calls after switch stay
            // alpha forever").
            await page.click('#pilot-overview [data-test="refresh"]');
            await page.waitForFunction(
                (n) => window.__pilotStub.calls.filter((c) =>
                    c.kind === 'http' && c.path.indexOf('/api/admin/peer') === 0).length > n,
                after.length, { timeout: WAIT });
            const final = await peerCalls(page);
            assertEqual(final[final.length - 1].address, 'beta.example.com',
                'every subsequent request keeps dialling the newly active server, not just the first one');
            await shot(page, 'overview-real-switch');
        } finally {
            await page.ctx.close();
        }
    });

    // The whole round trip for an expired token, in a real browser: the surface
    // that reported the failure is the one that recovers from it. Before this,
    // Overview printed "Recommended: sign in again on this server." and offered
    // nowhere to do it -- the token is minted once, at provisioning handover,
    // and the server's token-expire retires it a week later.
    await check('overview: an expired token can be signed back in from the surface that reports it', async () => {
        const page = await openOverview(ctx);
        try {
            await page.evaluate(() => {
                window.__login = [];
                window.__written = [];
                // What rustdesk-api actually answers for an expired token: HTTP
                // 200, with the real status in the BODY. Measured on a live
                // server, and the reason api-client.js reads the body code
                // before it reads any prose.
                const expired = { status: 200,
                    body: { code: 403, message: 'Please log in first.', data: null } };
                let signedIn = false;
                window.PilotApi.setTransport(async (req) => {
                    const path = (req && req.path) || '';
                    if (path.indexOf('/api/admin/login') === 0) {
                        // api-client.js serialises the body to JSON before any
                        // transport sees it, so this is the literal wire text.
                        window.__login.push(String(req.body || ''));
                        signedIn = true;
                        return { status: 200, body: { code: 0, message: '', data: { token: 'minted' } } };
                    }
                    if (!signedIn) return expired;
                    return { status: 200, body: { code: 0, message: '', data:
                        { list: [{ id: '1', alias: 'a', online: true, last_online: 1754222400 }],
                          page: 1, total: 1, page_size: 50 } } };
                });
                window.PilotOverview.setRegistry({
                    list: async () => [{ id: 'alpha', name: 'Head office',
                        domain: 'rd.example.com', tlsTier: 'own' }],
                    active: async () => 'alpha',
                    setActive: async () => {},
                    writeSecret: async (id, kind, value) => { window.__written.push([id, kind, value]); }
                });
                // js/app.js owns the transport and re-reads the token on this
                // event. Here it stands in for that re-wire.
                document.addEventListener('pilot:credentials-changed', () => { window.__rewired = true; });
            });
            await page.click('#pilot-overview [data-test="refresh"]');

            assertOk(await visible(page, '#pilot-overview [data-test="sign-in"]'),
                'an expired token offers a way back in, not just an explanation');
            await shot(page, 'overview-signin-needed');

            await page.fill('#pilot-overview [data-test="sign-in-password"]', 'hunter2');
            await page.click('#pilot-overview [data-test="sign-in-submit"]');

            await waitTotal(page, '1', 'after signing back in');
            const out = await page.evaluate(() => ({
                login: window.__login, written: window.__written,
                rewired: !!window.__rewired,
                left: document.querySelector('#pilot-overview [data-test="sign-in-password"]').value
            }));
            assertEqual(out.login.length, 1, 'exactly one sign-in was attempted');
            const sent = JSON.parse(out.login[0]);
            assertEqual(sent.username, 'admin', 'signs in as the one administrator');
            assertEqual(sent.password, 'hunter2', 'with the password that was typed');
            assertEqual(JSON.stringify(out.written), JSON.stringify([['alpha', 'token', 'minted']]),
                'the new token is stored as the server token sidecar');
            assertOk(out.rewired, 'the shell is told to re-read the token it just stored');
            assertEqual(out.left, '', 'the password is not left sitting in the DOM');
            // waitForSelector('hidden') waits for the card to GO, which is the
            // claim. visible() returns false only after its whole timeout
            // elapses, so it would instead demand the card be hidden for the
            // full window -- and one stale in-flight expired response landing
            // late is enough to fail that without anything being wrong.
            await page.waitForSelector('#pilot-overview [data-test="sign-in"]',
                { state: 'hidden', timeout: WAIT });
            await shot(page, 'overview-signin-recovered');
        } finally {
            await page.ctx.close();
        }
    });
}

if (isMain(import.meta.url)) process.exit(await runScenario(run, name) ? 1 : 0);
