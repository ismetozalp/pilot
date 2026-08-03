// tests/e2e/harness.e2e.mjs — the harness proving itself in a real browser.
//
// Everything here is about the bridge fake and the harness seams, never about a
// surface: those belong to the scenarios that own them. Deliberately so, because
// this file must keep passing as the plugin grows, and an assertion about
// another task's markup would make it a tripwire on their work instead.
//
//   node tests/e2e/harness.e2e.mjs
import fs from 'node:fs';
import { isMain, runScenario } from '../e2e.mjs';

export const name = 'harness';

const TRANSCRIPT = [
    { t: 'run-start', run_id: '20260803T204500Z', transport: 'local', steps: 1 },
    { t: 'step-start', id: 'fetch-api', title: 'Fetch the API server', cmd: 'curl -fsSL' },
    { t: 'output', id: 'fetch-api', stream: 'stdout', line: 'downloading' },
    { t: 'step-end', id: 'fetch-api', status: 'ok', exit: 0, ms: 12 },
    { t: 'run-end', status: 'ok', kind: null }
];

export default async function run(ctx) {
    const page = await ctx.open(ctx.browser, {
        spawn: {
            'pilot-exec --run': { lines: TRANSCRIPT, chunk: 'split' },
            'echo hi': 'hi\n'
        },
        files: { '/etc/pilot/harness-marker': 'present' },
        http: { 'GET /api/harness-probe': { status: 200, body: { code: 0, message: '', data: { ok: true } } } }
    });

    await ctx.check('open() navigates to the served index.html by itself', async () => {
        ctx.assertMatch(page.url(), /\/index\.html$/, 'open() did not navigate');
    });

    await ctx.check('the stub replaces the Cockpit bridge before page scripts run', async () => {
        const shape = await page.evaluate(() => ({
            spawn: typeof window.cockpit.spawn,
            file: typeof window.cockpit.file,
            http: typeof window.cockpit.http,
            dbus: typeof window.cockpit.dbus,
            calls: Array.isArray(window.__pilotStub.calls)
        }));
        ctx.assertEqual(shape.spawn, 'function', 'cockpit.spawn missing');
        ctx.assertEqual(shape.file, 'function', 'cockpit.file missing');
        ctx.assertEqual(shape.http, 'function', 'cockpit.http missing');
        ctx.assertEqual(shape.dbus, 'function', 'cockpit.dbus missing');
        ctx.assertOk(shape.calls, 'no call log');
    });

    await ctx.check('a scripted spawn resolves and is recorded in the call log', async () => {
        const r = await page.evaluate(async () => {
            const out = await window.cockpit.spawn(['echo', 'hi'], { superuser: 'require' });
            const call = window.__pilotStub.calls.filter((c) => c.kind === 'spawn').pop();
            return { out, argv: call.argv.join(' '), superuser: call.opts.superuser };
        });
        ctx.assertEqual(r.out, 'hi\n');
        ctx.assertEqual(r.argv, 'echo hi');
        ctx.assertEqual(r.superuser, 'require');
    });

    await ctx.check('streamed JSON lines arrive in fragments and reassemble in order', async () => {
        const r = await page.evaluate(async () => {
            const chunks = [];
            const settled = await window.cockpit
                .spawn(['pilot-exec', '--run'])
                .stream((c) => chunks.push(c));
            return { chunks: chunks.length, settled, text: chunks.join('') };
        });
        ctx.assertEqual(r.chunks, TRANSCRIPT.length * 2, 'lines did not arrive split');
        ctx.assertEqual(r.settled, '', 'a streamed spawn must resolve empty');
        const parsed = r.text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
        ctx.assertEqual(parsed.map((o) => o.t).join(','),
            TRANSCRIPT.map((o) => o.t).join(','), 'transcript order changed');
        ctx.assertEqual(parsed[0].run_id, '20260803T204500Z');
    });

    await ctx.check('an unstubbed spawn rejects instead of resolving empty', async () => {
        const msg = await page.evaluate(() =>
            window.cockpit.spawn(['pilot-exec', '--detect'])
                .then(() => 'resolved', (e) => e.message));
        ctx.assertMatch(msg, /no stub for: pilot-exec --detect/, 'an unscripted call resolved');
    });

    await ctx.check('cockpit.file round-trips and logs both directions', async () => {
        const r = await page.evaluate(async () => {
            const f = window.cockpit.file('/etc/pilot/harness-marker');
            const before = await f.read();
            await f.replace('rewritten');
            const after = await f.read();
            const wrote = window.__pilotStub.calls.filter((c) => c.kind === 'replace');
            return { before, after, wrote: wrote.length, content: wrote[0].content };
        });
        ctx.assertEqual(r.before, 'present');
        ctx.assertEqual(r.after, 'rewritten');
        ctx.assertEqual(r.wrote, 1);
        ctx.assertEqual(r.content, 'rewritten');
    });

    await ctx.check('cockpit.http answers scripted responses through the bridge', async () => {
        // The bridge fake itself — surfaces use PilotApi.setTransport (C12).
        const r = await page.evaluate(async () => {
            let seenStatus = 0;
            const body = await window.cockpit.http({ address: '127.0.0.1', port: 21114 })
                .request({ method: 'GET', path: '/api/harness-probe' })
                .response((status) => { seenStatus = status; });
            const call = window.__pilotStub.calls.filter((c) => c.kind === 'http').pop();
            return { body: JSON.parse(body), seenStatus, address: call.address };
        });
        ctx.assertEqual(r.seenStatus, 200);
        ctx.assertEqual(r.body.code, 0);
        ctx.assertEqual(r.address, '127.0.0.1');
    });

    await ctx.check('useTransport installs a C12 transport and records what surfaces ask for', async () => {
        // A stand-in PilotApi so this scenario tests the harness seam and not
        // whether api-client.js happens to be loaded yet.
        await page.evaluate(() => {
            window.PilotApi = { setTransport(fn) { window.__pilotHarnessTransport = fn; } };
        });
        await ctx.useTransport(page, {
            'GET /api/peers': { body: { code: 0, message: '', data: { list: [], total: 0 } } },
            'POST /api/ab/peer/add/': { status: 200, body: { code: 0 } }
        });
        const r = await page.evaluate(async () => {
            const t = window.__pilotHarnessTransport;
            const ok = await t({ method: 'GET', path: '/api/peers', query: { page: 1 } });
            const written = await t({ method: 'POST', path: '/api/ab/peer/add/', body: { id: '1' }, admin: true });
            const missing = await t({ method: 'GET', path: '/api/nope' }).then(() => null, (e) => e.message);
            return { ok, written, missing, calls: window.__pilotTransport.calls };
        });
        ctx.assertEqual(r.ok.status, 200);
        ctx.assertEqual(r.ok.body.code, 0);
        ctx.assertEqual(r.written.status, 200);
        ctx.assertMatch(r.missing, /no route for GET \/api\/nope/, 'an unrouted request resolved');
        ctx.assertEqual(r.calls.length, 3);
        ctx.assertEqual(r.calls[0].query.page, 1);
        ctx.assertEqual(r.calls[1].admin, true, 'the admin flag was dropped');
    });

    await ctx.check('the stub records page errors so scenarios can assert on them', async () => {
        await page.evaluate(() => {
            window.dispatchEvent(new ErrorEvent('error', { message: 'pilot-e2e-selftest' }));
        });
        const errors = await page.evaluate(() => window.__pilotStub.errors.slice());
        ctx.assertOk(errors.some((e) => /pilot-e2e-selftest/.test(e)),
            `the error log did not record it: ${JSON.stringify(errors)}`);
    });

    await ctx.check('shot() writes a screenshot where it says it does', async () => {
        const file = await ctx.shot(page, 'harness');
        ctx.assertOk(fs.existsSync(file), `no screenshot at ${file}`);
        ctx.assertOk(fs.statSync(file).size > 0, 'the screenshot is empty');
    });

    await page.ctx.close();

    const degraded = await ctx.open(ctx.browser, {
        httpAddressCap: false,
        http: { 'GET /api/harness-probe': { body: { code: 0 } } }
    });

    await ctx.check('a bridge without the address capability fails proxied requests', async () => {
        const problem = await degraded.evaluate(() =>
            window.cockpit.http({ address: '10.0.0.5', port: 21114 })
                .get('/api/harness-probe')
                .then(() => 'resolved', (e) => e.problem));
        ctx.assertEqual(problem, 'not-supported',
            'a bridge with no address capability answered anyway');
    });

    await ctx.check('the same bridge still serves localhost requests', async () => {
        const code = await degraded.evaluate(async () =>
            JSON.parse(await window.cockpit.http({}).get('/api/harness-probe')).code);
        ctx.assertEqual(code, 0);
    });

    await degraded.ctx.close();
}

if (isMain(import.meta.url)) process.exit(await runScenario(run, name) ? 1 : 0);
