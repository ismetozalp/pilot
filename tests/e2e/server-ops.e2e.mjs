// tests/e2e/server-ops.e2e.mjs — Server Ops (day-2 operations) driven in a
// real browser.
//
// #pilot-server-ops sits behind x-show="tab === 'server-ops'" in the outer
// shell (same shape as tests/e2e/audit.e2e.mjs and tests/e2e/devices.e2e.mjs
// for their own surfaces), so every check switches tabs first.
//
// This surface runs pilot-exec over cockpit.spawn, not the PilotApi HTTP
// façade, so it is driven through the stub's scripted `spawn` map (the same
// mechanism tests/e2e/setup.e2e.mjs uses), never ctx.useTransport(). The
// server itself (registry record + optional .ssh secret) is driven through
// the stub's scripted `files` map, exactly like tests/e2e/servers.e2e.mjs
// drives real wiring.
//
//   node tests/e2e/server-ops.e2e.mjs
import { isMain, runScenario } from '../e2e.mjs';

export const name = 'server-ops';

const WAIT = 5000;

function rec(id, host) {
    return JSON.stringify({
        id, host, sshPort: 22, apiPort: 21114, tls: false,
        domain: null, hbbsKey: null, hbbsPorts: [], installDir: '/opt/rustdesk-api', createdAt: null
    });
}

const RUN_STATUS_OK = [
    '{"t":"run-start","run_id":"20260803T204500Z","transport":"local","steps":1}',
    '{"t":"step-start","id":"status","title":"Service status","cmd":"systemctl is-active"}',
    '{"t":"output","id":"status","stream":"stdout","line":"active"}',
    '{"t":"output","id":"status","stream":"stdout","line":"active"}',
    '{"t":"output","id":"status","stream":"stdout","line":"failed"}',
    '{"t":"step-end","id":"status","status":"ok","exit":0,"ms":10}',
    '{"t":"run-end","status":"ok","kind":null}'
].join('\n') + '\n';

const NEW_LINE = '[2026-08-03 15:47:56.007358 +00:00] INFO [src/relay_server.rs:453] ' +
    'New relay request eed8c682-1234-5678-9abc-def012345678 from [::ffff:198.51.100.23]:44181';
const PAIRED_LINE = '[2026-08-03 15:47:56.067211 +00:00] INFO [src/relay_server.rs:437] ' +
    'Relayrequest eed8c682-1234-5678-9abc-def012345678 from [::ffff:198.51.100.23]:52390 got paired';
const CLOSED_LINE = '[2026-08-03 16:00:36.305113 +00:00] INFO [src/relay_server.rs:449] ' +
    'Relay of [::ffff:198.51.100.23]:52390 closed';

const RUN_RELAY_OK = [
    '{"t":"run-start","run_id":"20260803T204600Z","transport":"local","steps":1}',
    '{"t":"step-start","id":"relay-log","title":"Recent relay sessions","cmd":"journalctl"}',
    '{"t":"output","id":"relay-log","stream":"stdout","line":' + JSON.stringify(NEW_LINE) + '}',
    '{"t":"output","id":"relay-log","stream":"stdout","line":' + JSON.stringify(PAIRED_LINE) + '}',
    '{"t":"output","id":"relay-log","stream":"stdout","line":' + JSON.stringify(CLOSED_LINE) + '}',
    '{"t":"step-end","id":"relay-log","status":"ok","exit":0,"ms":10}',
    '{"t":"run-end","status":"ok","kind":null}'
].join('\n') + '\n';

const RUN_DOCTOR_FAIL = {
    error: true,
    message: JSON.stringify({ t: 'fatal', kind: 'HBBS_NOT_FOUND', message: 'hbbs is not installed on this host' })
};

async function openTab(ctx, stub) {
    const page = await ctx.open(ctx.browser, stub);
    page.setDefaultTimeout(WAIT);
    await page.click('[data-tab="server-ops"]');
    return page;
}

async function visible(page, selector) {
    try { await page.waitForSelector(selector, { state: 'visible', timeout: WAIT }); return true; }
    catch (e) { return false; }
}

// Alpine's :disabled binding depends on the async loadServer() call this
// surface's init() kicks off — a button can be visible and attached before
// that promise resolves, so a plain isDisabled() right after visible() races
// it. This polls until the element is genuinely enabled or the timeout
// elapses, rather than reading disabled state at an arbitrary instant.
async function waitEnabled(page, selector) {
    try {
        await page.waitForFunction((sel) => {
            const el = document.querySelector(sel);
            return !!el && !el.disabled;
        }, selector, { timeout: WAIT });
        return true;
    } catch (e) {
        return false;
    }
}

export default async function run(ctx) {
    const { check, assertEqual, assertOk, assertMatch, shot } = ctx;

    await check('server-ops: no server configured renders the empty state and zero operation controls', async () => {
        // DEFAULT_STUB's /etc/pilot/config.json is '{}' (no activeServer) and
        // it ships no /etc/pilot/servers/*.json — exactly "no server
        // configured", with no extra stubbing needed.
        const page = await openTab(ctx, {});
        try {
            assertOk(await visible(page, '#pilot-server-ops [data-testid="server-ops-empty"]'),
                'the empty state must render when no server is configured');
            const opButtons = await page.locator('#pilot-server-ops [data-testid^="op-"]').count();
            assertEqual(opButtons, 0, 'no operation control may render at all with no server (spec §7.3)');
            await shot(page, 'server-ops-empty');
        } finally { await page.ctx.close(); }
    });

    // GAP B (task 33): this CTA dispatches 'pilot:open-wizard' ({}, no step —
    // js/features/overview.js's "Set up TLS" is the one that carries a step).
    // Before this fix nothing outside a test harness listened for it at all:
    // clicking "Run setup" left #pilot-setup hidden and the tab unchanged.
    await check('server-ops: the empty state\'s "Run setup" CTA genuinely navigates to Setup, not just dispatches an event', async () => {
        const page = await openTab(ctx, {});
        try {
            await visible(page, '#pilot-server-ops [data-testid="server-ops-empty-action"]');
            await page.click('#pilot-server-ops [data-testid="server-ops-empty-action"]');
            await page.waitForSelector('[data-tab="setup"].active', { timeout: WAIT });
            assertOk(await visible(page, '#pilot-setup'),
                '"Run setup" must genuinely switch to the Setup tab');
        } finally { await page.ctx.close(); }
    });

    await check('server-ops: a server with no stored credential disables every credentialled op with a visible reason', async () => {
        const page = await openTab(ctx, {
            files: {
                '/etc/pilot/config.json': JSON.stringify({ activeServer: 'edge1' }),
                '/etc/pilot/servers/edge1.json': rec('edge1', 'edge1.example.com')
            }
        });
        try {
            await visible(page, '#pilot-server-ops [data-testid="op-status"]');
            assertOk(await page.locator('#pilot-server-ops [data-testid="op-status"]').isDisabled(),
                'status must be disabled without a stored credential');
            assertOk(await page.locator('#pilot-server-ops [data-testid="op-rotate-key"]').isDisabled());
            const reason = await page.locator('#pilot-server-ops [data-testid="op-status-reason"]').innerText();
            assertMatch(reason, /credential/i, 'the disabled reason must actually say why');
            await shot(page, 'server-ops-no-credential');
        } finally { await page.ctx.close(); }
    });

    await check('server-ops: status renders parsed, per-service unit states from a real pilot-exec run', async () => {
        const page = await openTab(ctx, {
            files: {
                '/etc/pilot/config.json': JSON.stringify({ activeServer: 'local' }),
                '/etc/pilot/servers/local.json': rec('local', '127.0.0.1')
            },
            spawn: { 'pilot-exec --run': RUN_STATUS_OK }
        });
        try {
            assertOk(await waitEnabled(page, '#pilot-server-ops [data-testid="op-status"]'),
                'the local target needs no stored credential, so status must become enabled');
            await page.click('#pilot-server-ops [data-testid="op-status"]');
            await visible(page, '#pilot-server-ops [data-testid="server-ops-status"]');
            const rows = await page.locator('#pilot-server-ops [data-testid="server-ops-status-row"]').count();
            assertEqual(rows, 3, 'all three services must render a row');
            assertEqual(await page.locator('#pilot-server-ops [data-testid="server-ops-status-hbbs"]').innerText(), 'active');
            assertEqual(await page.locator('#pilot-server-ops [data-testid="server-ops-status-api"]').innerText(), 'failed');
            const calls = await page.evaluate(() => window.__pilotStub.calls);
            const spawned = calls.find((c) => c.kind === 'spawn' && c.argv.indexOf('--run') >= 0);
            assertOk(spawned, 'pilot-exec --run must actually have been spawned');
            assertOk(spawned.input.indexOf('is-active') > -1, 'the systemctl argv must reach the envelope');
            await shot(page, 'server-ops-status');
        } finally { await page.ctx.close(); }
    });

    await check('server-ops: relay-log renders parsed sessions from the real hbbr.log format', async () => {
        const page = await openTab(ctx, {
            files: {
                '/etc/pilot/config.json': JSON.stringify({ activeServer: 'local' }),
                '/etc/pilot/servers/local.json': rec('local', '127.0.0.1')
            },
            spawn: { 'pilot-exec --run': RUN_RELAY_OK }
        });
        try {
            await waitEnabled(page, '#pilot-server-ops [data-testid="op-relay-log"]');
            await page.click('#pilot-server-ops [data-testid="op-relay-log"]');
            await visible(page, '#pilot-server-ops [data-testid="server-ops-relay"]');
            const rows = await page.locator('#pilot-server-ops [data-testid="server-ops-relay-row"]').count();
            assertEqual(rows, 1);
            const rowText = await page.locator('#pilot-server-ops [data-testid="server-ops-relay-row"]').first().innerText();
            assertMatch(rowText, /198\.51\.100\.23/, 'the ipv6-mapped address must render in dotted form');
            const summary = await page.locator('#pilot-server-ops [data-testid="server-ops-relay-summary"]').innerText();
            assertMatch(summary, /1/, 'the summary must report the session count');
            await shot(page, 'server-ops-relay-log');
        } finally { await page.ctx.close(); }
    });

    await check('server-ops: a failing op shows its real kind and leaves the surface usable', async () => {
        const page = await openTab(ctx, {
            files: {
                '/etc/pilot/config.json': JSON.stringify({ activeServer: 'local' }),
                '/etc/pilot/servers/local.json': rec('local', '127.0.0.1')
            },
            spawn: { 'pilot-exec --run': RUN_DOCTOR_FAIL }
        });
        try {
            await waitEnabled(page, '#pilot-server-ops [data-testid="op-doctor"]');
            await page.click('#pilot-server-ops [data-testid="op-doctor"]');
            await visible(page, '#pilot-server-ops [data-testid="op-doctor-alert"]');
            const alertText = await page.locator('#pilot-server-ops [data-testid="op-doctor-alert"]').innerText();
            assertMatch(alertText, /HBBS_NOT_FOUND/, 'the real error kind must be visible, not a generic toast');
            assertEqual(await page.locator('#pilot-server-ops [data-testid="op-status-alert"]').count(), 0,
                'a different op must be unaffected');
            assertOk(!(await page.locator('#pilot-server-ops [data-testid="op-status"]').isDisabled()),
                'the rest of the surface must still be usable after one op fails');
            await shot(page, 'server-ops-failed-op');
        } finally { await page.ctx.close(); }
    });

    await check('server-ops: rotate-key refuses to proceed until the exact server id is typed', async () => {
        const page = await openTab(ctx, {
            files: {
                '/etc/pilot/config.json': JSON.stringify({ activeServer: 'local' }),
                '/etc/pilot/servers/local.json': rec('local', '127.0.0.1')
            },
            spawn: { 'pilot-exec --run': '' }
        });
        try {
            await waitEnabled(page, '#pilot-server-ops [data-testid="op-rotate-key"]');
            await page.click('#pilot-server-ops [data-testid="op-rotate-key"]');
            await visible(page, '#pilot-server-ops [data-testid="server-ops-confirm"]');
            assertOk(await page.locator('#pilot-server-ops [data-testid="server-ops-confirm-run"]').isDisabled(),
                'confirm must start disabled');
            await page.fill('#pilot-server-ops [data-testid="server-ops-confirm-input"]', 'wrong-id');
            assertOk(await page.locator('#pilot-server-ops [data-testid="server-ops-confirm-run"]').isDisabled(),
                'the wrong id must not unlock it');
            const before = (await page.evaluate(() => window.__pilotStub.calls)).length;
            await page.fill('#pilot-server-ops [data-testid="server-ops-confirm-input"]', 'local');
            assertOk(!(await page.locator('#pilot-server-ops [data-testid="server-ops-confirm-run"]').isDisabled()),
                'the exact server id must unlock it');
            const after = (await page.evaluate(() => window.__pilotStub.calls)).length;
            assertEqual(after, before, 'typing must never itself run the operation');
            await shot(page, 'server-ops-rotate-key-confirm');
        } finally { await page.ctx.close(); }
    });
}

if (isMain(import.meta.url)) process.exit(await runScenario(run, name) ? 1 : 0);
