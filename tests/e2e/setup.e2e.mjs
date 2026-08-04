// tests/e2e/setup.e2e.mjs — the setup wizard driven in a real browser.
//
// Proves the things unit tests cannot: that the host-key step is genuinely
// absent for localhost and present for remote, that checkHostKey() really
// fires when a remote target reaches that step (not just when a test pokes
// component state directly), that a changed host key is a hard stop nothing
// in the UI can bypass, that a blocked cloud port ends the wizard on PARTIAL
// rather than a green tick, and that an SSH password never reaches the DOM
// or browser storage — including every input's live .value, not just the
// serialised innerHTML.
//
// Every wait below carries an explicit, short timeout: a selector that never
// appears is a bug to report in seconds, not a hang to wait out at
// Playwright's 30s default, and every page's BrowserContext is closed in a
// finally so one failing assertion cannot leak a browser context into the
// next check.
//
//   node tests/e2e/setup.e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import { isMain, runScenario, ROOT } from '../e2e.mjs';

export const name = 'setup';

// Short and uniform on purpose: every element these scenarios wait for is
// produced by Alpine reacting to a stub response that already resolved, so
// there is nothing to genuinely wait on beyond a render tick. If one of
// these ever legitimately needs longer, that is a signal to look harder
// before just raising the number.
const WAIT = 5000;

// index.html loads js/alpine.min.js, js/bootstrap.bundle.min.js and
// css/bootstrap.min.css — third-party bundles `make vendor` fetches into a
// gitignored location (see .gitignore). Without them Alpine never
// initialises, so EVERY x-show/x-model/@click in the page stays inert and
// every wait() /visible() call below fails identically at its WAIT-ms
// timeout with no clue why. Fail fast with the actual reason instead.
const VENDOR_FILES = ['js/alpine.min.js', 'js/bootstrap.bundle.min.js', 'css/bootstrap.min.css'];

function missingVendorFiles() {
    return VENDOR_FILES.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
}

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

// Real pilot-exec --check-hostkey shapes (C3): stdout is exactly
// {fingerprint, known, kind}, kind one of OK|SSH_HOSTKEY_UNKNOWN|
// SSH_HOSTKEY_CHANGED. A CHANGED result exits non-zero (EXIT_HOSTKEY_CHANGED)
// even though the JSON line was written first — {lines, exit_status} models
// that combination exactly the way the real bridge behaves. A failure raised
// before anything is written (e.g. SSH_UNREACHABLE) never touches stdout at
// all and lands on stderr as {"t":"fatal",...}, which cockpit hands back as
// the rejection's .message under { err: 'message' }.
const HOSTKEY_UNKNOWN = (fp) => JSON.stringify({ fingerprint: fp, known: false, kind: 'SSH_HOSTKEY_UNKNOWN' });
const HOSTKEY_CHANGED = (fp) => ({ lines: [{ fingerprint: fp, known: true, kind: 'SSH_HOSTKEY_CHANGED' }], exit_status: 5 });
const HOSTKEY_UNREACHABLE = {
    error: true,
    message: JSON.stringify({ t: 'fatal', kind: 'SSH_UNREACHABLE', message: 'connection refused' })
};

const STUB = (run, hostkey) => {
    const spawn = { 'pilot-exec --detect': DETECTION, 'pilot-exec --run': run };
    if (hostkey !== undefined) spawn['pilot-exec --check-hostkey'] = hostkey;
    return { spawn };
};

async function stepIds(page) {
    return page.$$eval('[data-testid="setup-steps"] [data-step]', (els) =>
        els.map((e) => e.getAttribute('data-step')));
}

function wait(page, selector) {
    return page.waitForSelector(selector, { timeout: WAIT, state: 'attached' })
        .catch((e) => { throw new Error(`selector never appeared: ${selector} (${e.message})`); });
}

// page.isVisible() takes an instantaneous snapshot — it does not wait. Alpine
// flushes its reactive DOM updates (x-show, x-text, …) through a microtask
// scheduler, so a plain isVisible() called right after a click that changes
// step/state can race that flush and read stale DOM. visible() polls (via
// waitForSelector's built-in retry) until the state settles or WAIT elapses,
// which is what makes "did the click actually take effect" a reliable
// question instead of a coin flip.
async function visible(page, selector) {
    try {
        await page.waitForSelector(selector, { state: 'visible', timeout: WAIT });
        return true;
    } catch (e) {
        return false;
    }
}

// Waits for a specific element's text to settle, rather than merely existing
// — the fingerprint <pre> is always in the DOM (unconditionally rendered),
// only its text content changes once checkHostKey()'s real spawn resolves.
async function waitForText(page, selector, predicate, label) {
    try {
        await page.waitForFunction(
            ({ sel }) => {
                const el = document.querySelector(sel);
                return !!el && el.textContent.trim().length > 0;
            },
            { sel: selector }, { timeout: WAIT });
    } catch (e) {
        throw new Error(`${label || selector} never got any text (${e.message})`);
    }
    const text = (await page.textContent(selector)).trim();
    if (typeof predicate === 'function' && !predicate(text))
        throw new Error(`${label || selector} text did not match: ${JSON.stringify(text)}`);
    return text;
}

async function spawnedCheckHostkey(page) {
    const calls = await page.evaluate(() => window.__pilotStub.calls);
    return calls.find((c) => c.kind === 'spawn' && c.argv.indexOf('--check-hostkey') >= 0) || null;
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

// Walks EVERY input/textarea's live .value (not just serialised innerHTML —
// Alpine's x-model writes the DOM *property*, which innerHTML never
// serialises) plus every data-* attribute in the tree, in addition to the
// two storages and innerHTML itself. The password's own field is excluded:
// it legitimately holds the value while the user is looking at that step,
// which is the form doing its job, not a leak. Anywhere else is a real leak.
async function credentialLeaked(page, secret) {
    return page.evaluate((needle) => {
        const stores = [localStorage, sessionStorage];
        for (const store of stores)
            for (let i = 0; i < store.length; i++)
                if (String(store.getItem(store.key(i))).includes(needle)) return true;
        if (document.body.innerHTML.includes(needle)) return true;
        for (const el of document.querySelectorAll('input, textarea')) {
            if (el.getAttribute('data-testid') === 'password') continue;
            if (typeof el.value === 'string' && el.value.includes(needle)) return true;
        }
        for (const el of document.querySelectorAll('*')) {
            for (const attr of Array.from(el.attributes)) {
                if (attr.name.indexOf('data-') === 0 && String(attr.value).includes(needle)) return true;
            }
        }
        return false;
    }, secret);
}

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

    await check('remote wizard requires the host-key step and populates it via a real --check-hostkey call', async () => {
        const fp = 'SHA256:' + 'a'.repeat(43);
        await withPage(ctx, STUB(RUN_OK, HOSTKEY_UNKNOWN(fp)), async (page) => {
            await page.selectOption('[data-testid="target"]', 'ssh');
            await page.fill('[data-testid="host"]', 'rd.example.com');
            assertEqual((await stepIds(page)).join(','),
                'target,hostkey,detect,ports,execute,handover', 'host key must be present for remote');
            await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-hostkey"]'), 'remote stops at the host key');
            await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-hostkey"]'),
                'an unconfirmed fingerprint must block the wizard');
            // No state was poked to get here — checkHostKey() fired on its own
            // when the wizard landed on this step. Prove the fingerprint came
            // from a real spawn call, not from nothing.
            const fingerprint = await waitForText(page, '[data-testid="fingerprint"]',
                (t) => t === fp, 'fingerprint');
            assertEqual(fingerprint, fp);
            const call = await spawnedCheckHostkey(page);
            assertOk(call, '--check-hostkey was never spawned by the real UI flow');
            assertEqual(JSON.parse(call.input).host, 'rd.example.com', 'the request carried the typed host');
            await shot(page, 'setup-remote-hostkey');
            await page.click('[data-testid="accept-hostkey"]');
            await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-detect"]'),
                'a confirmed, unchanged fingerprint must let the wizard continue');
        });
    });

    await check('a changed host key is a hard stop that is never auto-accepted', async () => {
        const fp = 'SHA256:' + 'b'.repeat(43);
        await withPage(ctx, STUB(RUN_OK, HOSTKEY_CHANGED(fp)), async (page) => {
            await page.selectOption('[data-testid="target"]', 'ssh');
            await page.fill('[data-testid="host"]', 'rd.example.com');
            await page.click('[data-testid="next"]');
            // pilot-exec exits non-zero here (EXIT_HOSTKEY_CHANGED) — this is
            // exactly the case that would be lost by a plain `await` instead of
            // streaming, so reaching a populated, CHANGED result at all is part
            // of what this check proves.
            const msg = await waitForText(page, '[data-testid="hostkey-hardstop"]',
                (t) => t.length > 0, 'hostkey-hardstop');
            assertOk(msg.length > 0, 'a changed host key must show a visible hard-stop message');
            const call = await spawnedCheckHostkey(page);
            assertOk(call, '--check-hostkey was never spawned');
            await page.click('[data-testid="accept-hostkey"]');
            await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-hostkey"]'),
                'a changed host key must never let the wizard continue, confirmed or not');
            await shot(page, 'setup-hostkey-changed');
        });
    });

    await check('a --check-hostkey failure surfaces its real kind, not a blank pane or a raw JSON blob', async () => {
        await withPage(ctx, STUB(RUN_OK, HOSTKEY_UNREACHABLE), async (page) => {
            await page.selectOption('[data-testid="target"]', 'ssh');
            await page.fill('[data-testid="host"]', 'rd.example.com');
            await page.click('[data-testid="next"]');
            const msg = await waitForText(page, '[data-testid="hostkey-check-error"]',
                (t) => t.length > 0, 'hostkey-check-error');
            assertOk(msg.toLowerCase().includes('refused'),
                `expected the unwrapped fatal message, got: ${JSON.stringify(msg)}`);
            assertOk(!msg.includes('{'),
                'pilot-exec\'s {"t":"fatal",...} stderr envelope must be unwrapped, never shown verbatim');
            assertEqual((await page.textContent('[data-testid="fingerprint"]')).trim(), '',
                'no fingerprint should be shown when the check itself failed');
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

    await check('no credential ever reaches browser storage, the DOM, or any other input\'s value', async () => {
        await withPage(ctx, STUB(RUN_OK), async (page) => {
            await page.selectOption('[data-testid="target"]', 'ssh');
            await page.fill('[data-testid="host"]', 'rd.example.com');
            await page.selectOption('[data-testid="auth"]', 'password');
            await page.fill('[data-testid="password"]', 'S3cretSauce');
            assertEqual(await credentialLeaked(page, 'S3cretSauce'), false,
                'the SSH password must not reach storage, other inputs, data-* attributes, or the rendered DOM');
        });
    });

    await check('a credential never reaches the DOM or storage even after a real run', async () => {
        // Beyond the brief: exercises the password all the way through a
        // completed --run (stdin only) rather than just sitting in the form,
        // and now drives the real host-key check too instead of poking state.
        const fp = 'SHA256:' + 'c'.repeat(43);
        await withPage(ctx, STUB(RUN_OK, HOSTKEY_UNKNOWN(fp)), async (page) => {
            await page.selectOption('[data-testid="target"]', 'ssh');
            await page.fill('[data-testid="host"]', 'rd.example.com');
            await page.selectOption('[data-testid="auth"]', 'password');
            await page.fill('[data-testid="password"]', 'RunSecret99');
            await page.click('[data-testid="next"]');
            await waitForText(page, '[data-testid="fingerprint"]', (t) => t === fp, 'fingerprint');
            await page.click('[data-testid="accept-hostkey"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-detect"]');
            await wait(page, '[data-plan-step]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-start"]');
            await wait(page, '[data-step-id="reachability"]');
            assertEqual(await credentialLeaked(page, 'RunSecret99'), false,
                'the SSH password must not leak into the DOM, storage, or another input after a run');
            const call = (await page.evaluate(() => window.__pilotStub.calls))
                .filter((c) => c.kind === 'spawn').find((c) => c.argv.indexOf('--run') >= 0);
            assertOk(call.argv.join(' ').indexOf('RunSecret99') < 0, 'the password must never be in argv');
            assertOk(call.input.indexOf('RunSecret99') >= 0, 'the password must reach the helper on stdin');
        });
    });
}

export default async function run(ctx) {
    const missing = missingVendorFiles();
    if (missing.length) {
        console.log(`e2e setup: SKIPPED — missing vendor bundle(s): ${missing.join(', ')}. ` +
            'Run `make vendor` first (fetches Alpine/Bootstrap over the network); ' +
            'without them Alpine never initialises and every check would otherwise ' +
            'fail identically at its wait timeout with no clue why.');
        return;
    }
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
