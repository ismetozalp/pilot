// tests/e2e/addressbook.e2e.mjs -- the Address Book surface driven in a real browser.
//
// #pilot-addressbook sits behind x-show="tab === 'addressbook'" in the outer shell
// (js/app.js's pilotApp() defaults to tab: 'overview'), so every check below
// switches tabs first, exactly like tests/e2e/devices.e2e.mjs does for its own
// surface. Every request is driven through ctx.useTransport(), which replaces
// PilotApi.setTransport wholesale (C12/C15) -- this scenario never touches
// cockpit.http or builds a URL of its own.
//
// The default book is the PERSONAL one (js/core/addressbook.js's AB.PERSONAL.guid
// === ''), which api-client.js's ab.* endpoints reach as '/api/ab/peers?ab=',
// '/api/ab/tags/', '/api/ab/tag/add/', etc. -- a trailing-empty segment/query,
// not a missing one (see the Task 23 report for the api-client.js fix this
// scenario depends on: before it, every one of these calls rejected before ever
// reaching the transport installed below).
//
// Every wait carries an explicit, short timeout: a selector or a row count that
// never appears is a bug to report in seconds, not a hang.
//
//   node tests/e2e/addressbook.e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMain, runScenario } from '../e2e.mjs';

export const name = 'addressbook';

const WAIT = 5000;

const PEERS = [
    { id: 'a1', alias: 'Reception', hostname: 'ws-01.lan', platform: 'Windows', tags: ['office'] },
    { id: 'b2', alias: 'Workshop', hostname: 'ws-02.lan', platform: 'Linux', tags: [] }
];

function ok(data) { return { status: 200, body: { code: 0, message: '', data } }; }
const BOOKS_OK = ok({ profiles: [] });
function peersOk(list) { return ok({ peers: list }); }
function tagsOk(list) { return ok({ tags: list }); }
// A real non-2xx status (not a {code:1} application error) so errorKindFor()
// maps this to API_UNREACHABLE -- exercised at the transport level so the real
// kind mapping runs, not a shortcut straight to a chosen kind (mirrors
// devices.e2e.mjs's own "an auth failure recommends signing in again" check).
const TAGS_FAIL = { status: 503, body: { message: 'tag service unavailable' } };
const WRITE_OK = ok({});

// Every ab.* call for the default (personal, ab='') book. Individual checks
// override the entries they care about via ctx.useTransport()'s own table.
function baseRoutes(over) {
    return Object.assign({
        'GET /api/ab/shared/profiles': BOOKS_OK,
        'GET /api/ab/peers': peersOk(PEERS),
        'GET /api/ab/tags/': tagsOk(['office']),
        'POST /api/ab/peer/add/': WRITE_OK,
        'PUT /api/ab/peer/update/': WRITE_OK,
        'DELETE /api/ab/peer/': WRITE_OK,
        'POST /api/ab/tag/add/': WRITE_OK,
        'PUT /api/ab/tag/rename/': WRITE_OK,
        'DELETE /api/ab/tag/': WRITE_OK
    }, over || {});
}

async function openAddressBook(ctx, routes) {
    const page = await ctx.open(ctx.browser, {});
    page.setDefaultTimeout(WAIT);
    await page.waitForSelector('[data-tab="addressbook"]', { state: 'attached', timeout: WAIT });
    await page.click('[data-tab="addressbook"]');
    await page.waitForSelector('#pilot-addressbook [data-pilot="reload"]', { state: 'attached', timeout: WAIT });
    if (routes) await ctx.useTransport(page, routes);
    return page;
}

function rowIds(page) {
    return page.$$eval('#pilot-addressbook [data-pilot="peer-row"]',
        (rows) => rows.map((r) => r.getAttribute('data-peer-id')));
}

async function waitRowCount(page, n) {
    try {
        await page.waitForFunction(
            (want) => document.querySelectorAll('#pilot-addressbook [data-pilot="peer-row"]').length === want,
            n, { timeout: WAIT });
    } catch (e) {
        const got = await page.$$eval('#pilot-addressbook [data-pilot="peer-row"]', (r) => r.length);
        throw new Error(`expected ${n} peer row(s), still ${got} after ${WAIT}ms (${e.message})`);
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

async function text(page, selector) {
    return (await page.textContent(selector)).trim();
}

export default async function run(ctx) {
    const { check, assertEqual, assertOk, assertMatch, shot, transportCalls } = ctx;

    await check('addressbook: peers render even when the tag endpoint fails, with a real remediation shown', async () => {
        const page = await openAddressBook(ctx, baseRoutes({ 'GET /api/ab/tags/': TAGS_FAIL }));
        try {
            await page.click('#pilot-addressbook [data-pilot="reload"]');
            await waitRowCount(page, 2);
            assertEqual((await rowIds(page)).join(','), 'a1,b2', 'peer rows');
            const peersErr = await text(page, '#pilot-addressbook [data-pilot="peers-error"]');
            assertEqual(peersErr, '', 'the peer table must not inherit the tags failure');
            assertOk(await visible(page, '#pilot-addressbook [data-pilot="tags-error"]'),
                'the tags failure must be reported');
            const tagsErr = await text(page, '#pilot-addressbook [data-pilot="tags-error"]');
            assertMatch(tagsErr, /tag service unavailable/, 'the specific reason is shown');
            assertMatch(tagsErr, /try again/i,
                'API_UNREACHABLE\'s real remediation is rendered, not a hardcoded "Try again"');
            await shot(page, 'addressbook-tags-failed');
        } finally {
            await page.ctx.close();
        }
    });

    await check('addressbook: tags render once the tag endpoint recovers', async () => {
        const page = await openAddressBook(ctx, baseRoutes());
        try {
            await page.click('#pilot-addressbook [data-pilot="reload"]');
            await page.waitForSelector('#pilot-addressbook [data-pilot="tag"]', { timeout: WAIT });
            const tags = await page.$$eval('#pilot-addressbook [data-pilot="tag"]',
                (els) => els.map((e) => e.textContent.trim()));
            assertEqual(tags.length, 1, 'one tag chip');
            assertOk(tags[0].includes('office'), 'the office tag is listed');
            assertEqual(await text(page, '#pilot-addressbook [data-pilot="tags-error"]'), '',
                'no tags error after recovery');
        } finally {
            await page.ctx.close();
        }
    });

    await check('addressbook: bulk tag assignment writes one update per selected peer', async () => {
        const page = await openAddressBook(ctx, baseRoutes());
        try {
            await page.click('#pilot-addressbook [data-pilot="reload"]');
            await waitRowCount(page, 2);
            await page.click('#pilot-addressbook [data-pilot="select-all"]');
            await page.fill('#pilot-addressbook [data-pilot="bulk-tags"]', 'floor 1');
            await page.click('#pilot-addressbook [data-pilot="bulk-apply"]');
            await page.waitForSelector('#pilot-addressbook [data-pilot="notice"] .alert', { timeout: WAIT });
            const calls = await transportCalls(page);
            const writes = calls.filter((c) => c.method === 'PUT' && /peer\/update/.test(c.path));
            assertEqual(writes.length, 2, 'one write per selected peer');
            const cells = await page.$$eval('#pilot-addressbook [data-pilot="peer-tags"]',
                (els) => els.map((e) => e.textContent.trim()));
            assertOk(cells.every((c) => c.includes('floor 1')), 'both rows show the new tag: ' + cells.join(' | '));
            assertEqual(await text(page, '#pilot-addressbook [data-pilot="write-error"]'), '',
                'a clean bulk write reports no error');
            await shot(page, 'addressbook-bulk-tagged');
        } finally {
            await page.ctx.close();
        }
    });

    await check('addressbook: the filter narrows the table without losing the loaded peers', async () => {
        const page = await openAddressBook(ctx, baseRoutes());
        try {
            await page.click('#pilot-addressbook [data-pilot="reload"]');
            await waitRowCount(page, 2);
            await page.fill('#pilot-addressbook [data-pilot="filter"]', 'Workshop');
            await waitRowCount(page, 1);
            assertEqual((await rowIds(page)).join(','), 'b2', 'only the matching peer is listed');
            assertEqual(await text(page, '#pilot-addressbook [data-pilot="count"]'), '1 of 2 peers',
                'the count reflects the filter');
        } finally {
            await page.ctx.close();
        }
    });

    await check('addressbook: renaming and deleting a tag writes through PilotApi and updates every peer shown', async () => {
        const page = await openAddressBook(ctx, baseRoutes());
        try {
            await page.click('#pilot-addressbook [data-pilot="reload"]');
            await waitRowCount(page, 2);
            await page.fill('#pilot-addressbook [data-pilot="rename-from"]', 'office');
            await page.fill('#pilot-addressbook [data-pilot="rename-to"]', 'HQ');
            await page.click('#pilot-addressbook [data-pilot="rename-tag"]');
            await page.waitForFunction(() => {
                const chip = document.querySelector('#pilot-addressbook [data-pilot="tag"]');
                return !!chip && chip.textContent.includes('HQ');
            }, null, { timeout: WAIT });
            let calls = await transportCalls(page);
            assertOk(calls.some((c) => c.method === 'PUT' && /tag\/rename/.test(c.path)),
                'the rename went through PilotApi');

            await page.click('#pilot-addressbook [data-pilot="tag"] .btn-close');
            await page.waitForFunction(() =>
                document.querySelectorAll('#pilot-addressbook [data-pilot="tag"]').length === 0,
                null, { timeout: WAIT });
            calls = await transportCalls(page);
            assertOk(calls.some((c) => c.method === 'DELETE' && /\/api\/ab\/tag\//.test(c.path)),
                'the delete went through PilotApi');
            const cells = await page.$$eval('#pilot-addressbook [data-pilot="peer-tags"]',
                (els) => els.map((e) => e.textContent.trim()));
            assertOk(cells.every((c) => !c.includes('HQ') && !c.includes('office')),
                'the deleted tag is gone from every peer row: ' + cells.join(' | '));

            // GAP D (task 33): the chip list rendered NOTHING with zero tags —
            // no message, no next action, forbidden by spec §7.3. This is now
            // genuinely zero tags (the only one just got deleted above), so
            // it is the real moment to prove the empty state actually shows.
            assertOk(await visible(page, '#pilot-addressbook [data-pilot="tags-empty"]'),
                'an empty tag list must show a message and a next action, not nothing');
            const emptyText = (await text(page, '#pilot-addressbook [data-pilot="tags-empty"]')).replace(/\s+/g, ' ').trim();
            assertEqual(emptyText, 'No tags yet. Add a tag',
                'must be EmptyState.forKind(\'tag\')\'s own copy, not ad hoc text');
            await page.click('#pilot-addressbook [data-pilot="tags-empty-action"]');
            const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
            assertEqual(focused, 'pilot-ab-newtag',
                'the action must focus the add-tag input, not switch tabs (this surface already IS Address Book)');
        } finally {
            await page.ctx.close();
        }
    });

    await check('addressbook: exporting downloads the real peer data under the pinned filename', async () => {
        const page = await openAddressBook(ctx, baseRoutes());
        try {
            await page.click('#pilot-addressbook [data-pilot="reload"]');
            await waitRowCount(page, 2);
            const [download] = await Promise.all([
                page.waitForEvent('download', { timeout: WAIT }),
                page.click('#pilot-addressbook [data-pilot="export-csv"]')
            ]);
            assertMatch(download.suggestedFilename(), /^pilot-addressbook-personal-\d{8}\.csv$/,
                'csvFilename() names the file after the active (personal) book');
            const csvPath = await download.path();
            const csvText = fs.readFileSync(csvPath, 'utf8');
            assertMatch(csvText, /^id,alias,username,hostname,platform,tags,note\r\n/, 'the pinned header');
            assertMatch(csvText, /a1,Reception,.*ws-01\.lan,Windows,office/, 'a1 is really in the export');
            assertMatch(csvText, /b2,Workshop,.*ws-02\.lan,Linux/, 'b2 is really in the export');
        } finally {
            await page.ctx.close();
        }
    });

    await check('addressbook: importing a CSV with a duplicate id merges it and tells the operator what fused', async () => {
        const page = await openAddressBook(ctx, baseRoutes());
        try {
            await page.click('#pilot-addressbook [data-pilot="reload"]');
            await waitRowCount(page, 2);
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-ab-'));
            const file = path.join(dir, 'dedupe.csv');
            fs.writeFileSync(file,
                'id,alias,hostname,tags\r\nc3,Kiosk,,lobby\r\nc3,Kiosk,ws-09.lan,lobby,foyer\r\n');
            await page.setInputFiles('#pilot-addressbook [data-pilot="csv-file"]', file);
            await page.waitForSelector('#pilot-addressbook [data-pilot="import-report"] .alert', { timeout: WAIT });
            const problems = await page.$$eval('#pilot-addressbook [data-pilot="import-problem"]',
                (els) => els.map((e) => e.textContent.trim()));
            assertOk(problems.some((p) => /duplicate id merged: c3/.test(p)),
                'the operator is told a fusion happened: ' + JSON.stringify(problems));
            await waitRowCount(page, 3);
            await shot(page, 'addressbook-csv-import-dedupe');
        } finally {
            await page.ctx.close();
        }
    });

    await check('addressbook: importing a CSV with a duplicated column header surfaces the problem', async () => {
        const page = await openAddressBook(ctx, baseRoutes());
        try {
            await page.click('#pilot-addressbook [data-pilot="reload"]');
            await waitRowCount(page, 2);
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-ab-'));
            const file = path.join(dir, 'dupheader.csv');
            fs.writeFileSync(file, 'id,alias,id\r\nc4,Kiosk,ignored\r\n');
            await page.setInputFiles('#pilot-addressbook [data-pilot="csv-file"]', file);
            await page.waitForSelector('#pilot-addressbook [data-pilot="import-report"] .alert', { timeout: WAIT });
            const problems = await page.$$eval('#pilot-addressbook [data-pilot="import-problem"]',
                (els) => els.map((e) => e.textContent.trim()));
            assertOk(problems.some((p) => /duplicate column header: id/.test(p)),
                'the duplicate header must be named: ' + JSON.stringify(problems));
        } finally {
            await page.ctx.close();
        }
    });

    await check('addressbook: an address book with no peers offers a real import action, not a dead end', async () => {
        const page = await openAddressBook(ctx, baseRoutes({ 'GET /api/ab/peers': peersOk([]) }));
        try {
            await page.click('#pilot-addressbook [data-pilot="reload"]');
            assertOk(await visible(page, '#pilot-addressbook [data-pilot="peers-empty"] p'),
                'the empty state appears');
            assertEqual(await page.$$eval('#pilot-addressbook [data-pilot="peer-row"]', (r) => r.length), 0);

            // Prove the action reaches the real file input, not a dead click
            // handler: replace its .click() with a marker before triggering it.
            await page.evaluate(() => {
                const input = document.querySelector('#pilot-addressbook [data-pilot="csv-file"]');
                input.click = () => { window.__pilotFilePickerOpened = true; };
            });
            const action = page.locator('#pilot-addressbook [data-pilot="peers-empty-action"]');
            assertOk(await action.isVisible(), 'a real, clickable control, not just a message');
            assertEqual(await action.evaluate((el) => el.tagName), 'BUTTON');
            await action.click();
            const opened = await page.evaluate(() => window.__pilotFilePickerOpened === true);
            assertOk(opened, 'the empty state\'s action genuinely reaches the CSV file picker');
        } finally {
            await page.ctx.close();
        }
    });

    await check('addressbook: a filter with no matches offers its own next action, distinct from "no peers at all"', async () => {
        const page = await openAddressBook(ctx, baseRoutes());
        try {
            await page.click('#pilot-addressbook [data-pilot="reload"]');
            await waitRowCount(page, 2);
            await page.fill('#pilot-addressbook [data-pilot="filter"]', 'nothing-matches-anything');
            assertOk(await visible(page, '#pilot-addressbook [data-pilot="peers-empty-filtered"] p'),
                'a filtered-to-zero result gets its own message');
            assertOk(!(await page.locator('#pilot-addressbook [data-pilot="peers-empty"] p').isVisible()),
                '"no peers at all" must not show when two peers merely do not match the filter');
            await page.click('#pilot-addressbook [data-pilot="peers-empty-filtered-action"]');
            await waitRowCount(page, 2);
            assertEqual(await page.inputValue('#pilot-addressbook [data-pilot="filter"]'), '',
                'clearing the filter from the empty state actually clears it');
        } finally {
            await page.ctx.close();
        }
    });

    await check('addressbook: a hostile peer or tag cannot inject markup and renders as text', async () => {
        const hostile = [{
            id: 'h1',
            alias: '<img src=x onerror="window.__xss=1">',
            hostname: '\u202etxt.exe',
            platform: 'z'.repeat(500),
            tags: ['<script>window.__xss2=1</script>']
        }];
        const page = await openAddressBook(ctx, baseRoutes({
            'GET /api/ab/peers': peersOk(hostile),
            'GET /api/ab/tags/': tagsOk(['<script>window.__xss2=1</script>'])
        }));
        try {
            await page.click('#pilot-addressbook [data-pilot="reload"]');
            await waitRowCount(page, 1);
            const out = await page.evaluate(() => ({
                xss: window.__xss === 1 || window.__xss2 === 1,
                imgs: document.querySelectorAll('#pilot-addressbook img').length,
                scripts: document.querySelectorAll('#pilot-addressbook script').length,
                alias: document.querySelector('#pilot-addressbook [data-pilot="peer-row"] td:nth-child(3)').textContent
            }));
            assertEqual(out.xss, false, 'nothing from the payload ever executes');
            assertEqual(out.imgs, 0, 'no element was created from the payload');
            assertEqual(out.scripts, 0, 'no script element was created from the payload');
            assertOk(out.alias.includes('<img'), 'the raw text is shown to the operator, not stripped');
            const tagText = await page.$eval('#pilot-addressbook [data-pilot="tag"]', (el) => el.textContent);
            assertOk(tagText.includes('<script>'), 'a hostile tag is shown as text too');
        } finally {
            await page.ctx.close();
        }
    });

    // --- multi-server: the address book must survive a real switchServer() ----
    //
    // Deliberately NOT driven through ctx.useTransport(), which replaces
    // PilotApi.setTransport wholesale and would hide the exact defect this
    // guards against: js/app.js's real wireApi()/switchServer() are what must
    // dispatch 'pilot:server-changed', and pilotAddressBookUi()'s onServerChanged
    // must actually be listening for it and reloading -- both files are
    // exercised for real here, exactly like tests/e2e/devices.e2e.mjs proves the
    // transport re-wiring itself.
    function serverRec(id, host) {
        return { id, host, sshPort: 22, apiPort: 21114, tls: false,
            domain: null, hbbsKey: null, hbbsPorts: [], installDir: '/opt/rustdesk-api', createdAt: null };
    }

    function multiServerStub(prodPeers) {
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
                'GET /api/currentUser2': WRITE_OK,
                'GET /api/ab/shared/profiles': BOOKS_OK,
                'GET /api/ab/peers': peersOk(prodPeers),
                'GET /admin/user': WRITE_OK,
                'GET /admin/group': WRITE_OK,
                'GET /admin/audit_conn': WRITE_OK,
                'GET /admin/audit_file': WRITE_OK,
                'GET /admin/login_log': WRITE_OK,
                'GET /admin/peer': WRITE_OK
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

    const PROD_PEERS = [{ id: 'p1', alias: 'Prod One', hostname: 'p1.lan', platform: 'Linux', tags: [] }];
    const STAGING_PEERS = [
        { id: 's1', alias: 'Staging One', hostname: 's1.lan', platform: 'Linux', tags: [] },
        { id: 's2', alias: 'Staging Two', hostname: 's2.lan', platform: 'Linux', tags: [] }
    ];

    await check('addressbook: switching the active server reloads the address book with no manual click', async () => {
        const page = await ctx.open(ctx.browser, multiServerStub(PROD_PEERS));
        page.setDefaultTimeout(WAIT);
        try {
            await installAlpineHelper(page);
            await waitApiReady(page);
            await page.click('[data-tab="addressbook"]');

            // No reload click anywhere in this check: the initial fetch and the
            // one after switching must both happen on their own.
            await waitRowCount(page, PROD_PEERS.length);
            assertOk((await rowIds(page)).includes('p1'),
                'prod\'s peers are shown on load with no manual reload click');

            // Swapped BEFORE switching so the assertion below can only pass if
            // switchServer() genuinely triggered a NEW fetch that observed the
            // swap, not a coincidental re-render of data already in memory.
            await page.evaluate((list) => {
                window.__pilotStub.http['GET /api/ab/peers'] = { status: 200, body:
                    { code: 0, message: '', data: { peers: list } } };
            }, STAGING_PEERS);

            await page.evaluate(() => window.alpineData().switchServer('staging'));
            await page.waitForFunction(
                () => window.alpineData().activeServerId === 'staging', null, { timeout: WAIT });

            await waitRowCount(page, STAGING_PEERS.length);
            const after = await rowIds(page);
            assertOk(after.includes('s1') && after.includes('s2'),
                'switching server replaced the peer list with no manual reload');
            assertOk(!after.includes('p1'), 'the previous server\'s rows are gone, not merely appended to');
            await shot(page, 'addressbook-server-switch');
        } finally {
            await page.ctx.close();
        }
    });
}

if (isMain(import.meta.url)) process.exit(await runScenario(run, name) ? 1 : 0);
