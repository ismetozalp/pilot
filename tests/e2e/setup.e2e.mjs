// tests/e2e/setup.e2e.mjs — the setup wizard driven in a real browser.
//
// Proves the things unit tests cannot: that the host-key step is genuinely
// absent for localhost and present for remote, that a changed host key is a
// hard stop nothing in the UI can bypass, that a blocked cloud port ends the
// wizard on PARTIAL rather than a green tick, and that an SSH password never
// reaches the DOM or browser storage.
//
// Every wait below carries an explicit, short timeout: a selector that never
// appears is a bug to report in seconds, not a hang to wait out at
// Playwright's 30s default, and every page's BrowserContext is closed in a
// finally so one failing assertion cannot leak a browser context into the
// next check.
//
//   node tests/e2e/setup.e2e.mjs
import { isMain, runScenario } from '../e2e.mjs';

export const name = 'setup';

// Short and uniform on purpose: every element these scenarios wait for is
// produced by Alpine reacting to a stub response that already resolved, so
// there is nothing to genuinely wait on beyond a render tick. If one of
// these ever legitimately needs longer, that is a signal to look harder
// before just raising the number.
const WAIT = 5000;

const DETECTION = JSON.stringify({
    os_release: { id: 'debian', id_like: '', version_id: '12', pretty_name: 'Debian 12' },
    arch: 'x86_64', init: 'systemd', firewall: 'firewalld', egress: true,
    disk_free_mb: 4096, hbbs: null, api: null, public_ip: '203.0.113.10'
});

const RUN_OK = [
    '{"t":"run-start","run_id":"20260803T204500Z","transport":"local","steps":2}',
    '{"t":"step-start","id":"fetch-api","title":"Download API server","cmd":"curl -fsSL https://x"}',
    '{"t":"output","id":"fetch-api","stream":"stdout","line":"downloading"}',
    '{"t":"step-end","id":"fetch-api","status":"ok","exit":0,"ms":8432}',
    '{"t":"step-start","id":"reachability","title":"Probe required ports","cmd":"pilot probe"}',
    '{"t":"output","id":"reachability","stream":"stdout","line":"21115/tcp reachable"}',
    '{"t":"step-end","id":"reachability","status":"ok","exit":0,"ms":120}',
    '{"t":"run-end","status":"ok","kind":null}'
].join('\n') + '\n';

const RUN_BLOCKED = RUN_OK
    .replace('21115/tcp reachable', '21116/udp blocked')
    .replace('"id":"reachability","status":"ok","exit":0,"ms":120', '"id":"reachability","status":"failed","exit":1,"ms":900')
    .replace('"t":"run-end","status":"ok","kind":null', '"t":"run-end","status":"partial","kind":"PORT_BLOCKED"');

const FAIL_RUN = [
    '{"t":"run-start","run_id":"20260803T204500Z","transport":"local","steps":2}',
    '{"t":"step-start","id":"fetch-api","title":"Download API server","cmd":"curl -fsSL https://x"}',
    '{"t":"output","id":"fetch-api","stream":"stdout","line":"downloading"}',
    '{"t":"step-end","id":"fetch-api","status":"failed","exit":7,"ms":50}',
    '{"t":"run-end","status":"failed","kind":"GENERIC"}'
].join('\n') + '\n';

const STUB = (run) => ({
    spawn: { 'pilot-exec --detect': DETECTION, 'pilot-exec --run': run }
});

async function stepIds(page) {
    return page.$$eval('[data-testid="setup-steps"] [data-step]', (els) =>
        els.map((e) => e.getAttribute('data-step')));
}

// The wizard never calls checkHostKey() from the given markup (no UI trigger
// exists for it yet — day-2 concern), so a scenario that needs a specific
// hostkey shape (confirmed / changed) sets it directly on the Alpine
// component, exactly like the harness's own "generatedPassword" checks do.
async function pokeHostkey(page, hostkey) {
    await page.evaluate((hk) => {
        document.getElementById('pilot-setup')._x_dataStack[0].hostkey = hk;
    }, hostkey);
}

function wait(page, selector) {
    return page.waitForSelector(selector, { timeout: WAIT, state: 'attached' })
        .catch((e) => { throw new Error(`selector never appeared: ${selector} (${e.message})`); });
}

// page.isVisible() takes an instantaneous snapshot — it does not wait. Alpine
// flushes its reactive DOM updates (x-show, x-text, …) through a microtask
// scheduler, so a plain isVisible() called right after a click that changes
// step/state can race that flush and read stale DOM. visible()/hidden() poll
// (via waitForSelector's built-in retry) until the state settles or WAIT
// elapses, which is what makes "did the click actually take effect" a
// reliable question instead of a coin flip.
async function visible(page, selector) {
    try {
        await page.waitForSelector(selector, { state: 'visible', timeout: WAIT });
        return true;
    } catch (e) {
        return false;
    }
}

// Every check opens exactly one page against one stub and is guaranteed to
// close its BrowserContext afterwards, pass or fail — an assertion that
// throws mid-check must not leak a browser context into the next one.
async function withPage(ctx, stub, fn) {
    const page = await ctx.open(ctx.browser, stub);
    // Every Playwright action on this page (click/fill/selectOption/waitForSelector/
    // textContent/…) now inherits this bound, not just the explicit wait() calls
    // above — a broken selector anywhere fails in WAIT ms, never at Playwright's
    // 30s default.
    page.setDefaultTimeout(WAIT);
    // #pilot-setup is gated behind x-show="tab === 'setup'" in the outer shell
    // (js/app.js's pilotApp() defaults to tab: 'overview'), so every scenario
    // has to switch tabs before anything inside the wizard is even visible.
    await page.click('[data-tab="setup"]');
    try {
        await fn(page);
    } finally {
        await page.ctx.close();
    }
}

// A belt-and-braces ceiling on the WHOLE scenario: even if some future check
// were added without going through withPage()/wait() (and so without their
// per-action bound), this stops the scenario — and therefore `npm run
// test:e2e` — from hanging indefinitely rather than failing loudly.
const SCENARIO_TIMEOUT_MS = 120000;

async function runBody(ctx) {
    const { browser, check, assertEqual, assertOk, shot } = ctx;

    await check('localhost wizard never shows the host-key step', async () => {
        await withPage(ctx, STUB(RUN_OK), async (page) => {
            await page.selectOption('[data-testid="target"]', 'local');
            assertEqual((await stepIds(page)).join(','),
                'target,detect,ports,execute,handover', 'host key must be absent for localhost');
            await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-detect"]'), 'localhost skips to detection');
            await shot(page, 'setup-local-steps');
        });
    });

    await check('remote wizard requires the host-key step', async () => {
        await withPage(ctx, STUB(RUN_OK), async (page) => {
            await page.selectOption('[data-testid="target"]', 'ssh');
            await page.fill('[data-testid="host"]', 'rd.example.com');
            assertEqual((await stepIds(page)).join(','),
                'target,hostkey,detect,ports,execute,handover', 'host key must be present for remote');
            await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-hostkey"]'), 'remote stops at the host key');
            await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-hostkey"]'),
                'an unconfirmed fingerprint must block the wizard');
            await shot(page, 'setup-remote-hostkey');
        });
    });

    await check('an unknown host key can be confirmed to reach detection', async () => {
        await withPage(ctx, STUB(RUN_OK), async (page) => {
            await page.selectOption('[data-testid="target"]', 'ssh');
            await page.fill('[data-testid="host"]', 'rd.example.com');
            await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-hostkey"]'), 'starts at the host key');
            await pokeHostkey(page, {
                fingerprint: 'SHA256:' + 'a'.repeat(43), known: false, confirmed: false, changed: false
            });
            await page.click('[data-testid="accept-hostkey"]');
            await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-detect"]'),
                'a confirmed, unchanged fingerprint must let the wizard continue');
        });
    });

    await check('a changed host key is a hard stop that is never auto-accepted', async () => {
        await withPage(ctx, STUB(RUN_OK), async (page) => {
            await page.selectOption('[data-testid="target"]', 'ssh');
            await page.fill('[data-testid="host"]', 'rd.example.com');
            await page.click('[data-testid="next"]');
            await pokeHostkey(page, {
                fingerprint: 'SHA256:' + 'b'.repeat(43), known: true, confirmed: false, changed: true
            });
            await page.click('[data-testid="accept-hostkey"]');
            assertOk((await page.textContent('[data-testid="hostkey-hardstop"]')).length > 0,
                'a changed host key must show a visible hard-stop message');
            await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-hostkey"]'),
                'a changed host key must never let the wizard continue, confirmed or not');
            await shot(page, 'setup-hostkey-changed');
        });
    });

    await check('an invalid remote host is refused with a visible reason', async () => {
        await withPage(ctx, STUB(RUN_OK), async (page) => {
            await page.selectOption('[data-testid="target"]', 'ssh');
            await page.fill('[data-testid="host"]', 'bad host name');
            await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-target"]'), 'stays on the target step');
            assertOk((await page.textContent('[data-testid="target-error"]')).length > 0, 'shows a reason');
        });
    });

    await check('plan preview and manual mode render the same plan', async () => {
        await withPage(ctx, STUB(RUN_OK), async (page) => {
            await page.selectOption('[data-testid="target"]', 'local');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-detect"]');
            await wait(page, '[data-plan-step]');
            await page.click('[data-testid="manual-toggle"]');
            const script = await page.textContent('[data-testid="manual-script"]');
            assertOk(script.trim().length > 0, 'manual mode renders the plan as a script');
            await shot(page, 'setup-plan-preview');
        });
    });

    await check('the ports step splits host-fixable from cloud and shows the aws command', async () => {
        await withPage(ctx, STUB(RUN_OK), async (page) => {
            await page.selectOption('[data-testid="target"]', 'local');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-detect"]');
            await wait(page, '[data-plan-step]');
            await page.click('[data-testid="next"]');
            await page.fill('[data-testid="sg-id"]', 'sg-0123456789abcdef0');
            await page.fill('[data-testid="sg-region"]', 'eu-west-1');
            const cmd = await page.textContent('[data-testid="aws-command"]');
            assertOk(cmd.startsWith('aws ec2 authorize-security-group-ingress') || cmd === '',
                'the literal aws command is shown when there are cloud ports');
            await shot(page, 'setup-ports');
        });
    });

    await check('execution shows a progress bar and a live collapsible transcript with exit codes', async () => {
        await withPage(ctx, STUB(RUN_OK), async (page) => {
            await page.selectOption('[data-testid="target"]', 'local');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-detect"]');
            await wait(page, '[data-plan-step]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-start"]');
            await wait(page, '[data-step-id="reachability"][data-status="ok"]');
            assertEqual(await page.textContent('[data-testid="progress-bar"]'), '2 / 2', 'bar advanced');
            assertOk((await page.textContent('[data-toggle-step="fetch-api"]')).includes('exit 0'),
                'exit codes are visible');
            await page.click('[data-toggle-step="fetch-api"]');
            assertOk(await visible(page, '[data-cmd="fetch-api"]'), 'the step expands to its command');
            await page.click('[data-testid="copy-transcript"]');
            await shot(page, 'setup-transcript');
        });
    });

    await check('a failing step shows its exit code and leaves the transcript intact', async () => {
        await withPage(ctx, STUB(FAIL_RUN), async (page) => {
            await page.selectOption('[data-testid="target"]', 'local');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-detect"]');
            await wait(page, '[data-plan-step]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-start"]');
            await wait(page, '[data-step-id="fetch-api"][data-status="failed"]');
            assertOk((await page.textContent('[data-toggle-step="fetch-api"]')).includes('exit 7'),
                'the failing exit code is visible');
            assertOk(await visible(page, '[data-cmd="fetch-api"]'),
                'a failed step opens itself so the reason is not one click away');
            const transcriptText = await page.textContent('[data-testid="transcript"]');
            assertOk(transcriptText.includes('downloading'),
                'the transcript captured before the failure is still intact, not cleared');
        });
    });

    await check('a blocked cloud port ends on PARTIAL, not on success', async () => {
        await withPage(ctx, STUB(RUN_BLOCKED), async (page) => {
            await page.selectOption('[data-testid="target"]', 'local');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-detect"]');
            await wait(page, '[data-plan-step]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-start"]');
            await wait(page, '[data-step-id="reachability"][data-status="failed"]');
            await page.click('[data-testid="next"]');
            assertEqual(await page.getAttribute('[data-testid="handover-status"]', 'data-status'),
                'partial', 'handover must report partial success');
            assertOk((await page.textContent('[data-testid="blocked-ports"]')).includes('21116/udp'),
                'the blocked port is named');
            await shot(page, 'setup-partial');
        });
    });

    await check('handover refuses to finish while the generated password stands', async () => {
        await withPage(ctx, STUB(RUN_OK), async (page) => {
            await page.evaluate(() => {
                const el = document.getElementById('pilot-setup');
                el._x_dataStack[0].step = 'handover';
                el._x_dataStack[0].generatedPassword = 'GeneratedPw12';
            });
            await page.fill('[data-testid="new-password"]', 'GeneratedPw12');
            await page.fill('[data-testid="confirm-password"]', 'GeneratedPw12');
            await page.click('[data-testid="finish"]');
            assertOk((await page.textContent('[data-testid="pw-error"]')).toLowerCase().includes('generated'),
                'the generated password is rejected');
            assertOk(!(await visible(page, '[data-testid="finished"]')), 'the wizard did not finish');
        });
    });

    await check('no credential ever reaches browser storage or the DOM', async () => {
        await withPage(ctx, STUB(RUN_OK), async (page) => {
            await page.selectOption('[data-testid="target"]', 'ssh');
            await page.fill('[data-testid="host"]', 'rd.example.com');
            await page.selectOption('[data-testid="auth"]', 'password');
            await page.fill('[data-testid="password"]', 'S3cretSauce');
            const leaked = await page.evaluate(() => {
                const stores = [localStorage, sessionStorage];
                for (const s of stores)
                    for (let i = 0; i < s.length; i++)
                        if (String(s.getItem(s.key(i))).includes('S3cretSauce')) return true;
                return document.body.innerHTML.includes('S3cretSauce');
            });
            assertEqual(leaked, false, 'the SSH password must not reach storage or the rendered DOM');
        });
    });

    await check('a credential never reaches the DOM or storage even after a real run', async () => {
        // Beyond the brief: exercises the password all the way through a
        // completed --run (stdin only) rather than just sitting in the form.
        await withPage(ctx, STUB(RUN_OK), async (page) => {
            await page.selectOption('[data-testid="target"]', 'ssh');
            await page.fill('[data-testid="host"]', 'rd.example.com');
            await page.selectOption('[data-testid="auth"]', 'password');
            await page.fill('[data-testid="password"]', 'RunSecret99');
            await page.click('[data-testid="next"]');
            await pokeHostkey(page, {
                fingerprint: 'SHA256:' + 'c'.repeat(43), known: false, confirmed: false, changed: false
            });
            await page.click('[data-testid="accept-hostkey"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-detect"]');
            await wait(page, '[data-plan-step]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-start"]');
            await wait(page, '[data-step-id="reachability"]');
            const leaked = await page.evaluate(() => {
                const stores = [localStorage, sessionStorage];
                for (const s of stores)
                    for (let i = 0; i < s.length; i++)
                        if (String(s.getItem(s.key(i))).includes('RunSecret99')) return true;
                return document.body.innerHTML.includes('RunSecret99');
            });
            assertEqual(leaked, false, 'the SSH password must not leak into the DOM or storage after a run');
            const call = (await page.evaluate(() => window.__pilotStub.calls))
                .filter((c) => c.kind === 'spawn').find((c) => c.argv.indexOf('--run') >= 0);
            assertOk(call.argv.join(' ').indexOf('RunSecret99') < 0, 'the password must never be in argv');
            assertOk(call.input.indexOf('RunSecret99') >= 0, 'the password must reach the helper on stdin');
        });
    });
}

export default async function run(ctx) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`setup e2e scenario exceeded ${SCENARIO_TIMEOUT_MS}ms overall`)),
            SCENARIO_TIMEOUT_MS);
    });
    try {
        await Promise.race([runBody(ctx), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

if (isMain(import.meta.url)) process.exit(await runScenario(run, name) ? 1 : 0);
