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

// Every required port reachable, unless a scenario says otherwise. Without
// this the stub rejected --probe-ports as unscripted, probeReach() took its
// catch path, and the e2e tier never exercised the probe at ALL -- the same
// shape of gap that let "Every required port is reachable" mean nothing.
const PROBE_ALL_OK = JSON.stringify({
    host: '127.0.0.1',
    results: [21114, 21115, 21116, 21117].map((port) =>
        ({ port, proto: 'tcp', reachable: true, detail: '' }))
}) + '\n';

const STUB = (run, hostkey, probe) => {
    const spawn = {
        'pilot-exec --detect': DETECTION,
        'pilot-exec --run': run,
        'pilot-exec --probe-ports': probe === undefined ? PROBE_ALL_OK : probe
    };
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
// Polls a SNAPSHOT until it satisfies the predicate, and returns that same
// snapshot. The point is atomicity: a caller asserting a simultaneous invariant
// ("these two are never both showing") must read both facts from one moment,
// not from two round trips with the page free to move in between. waitForText
// below cannot do that -- it waits, then reads again.
async function waitForCondition(page, take, predicate, label) {
    const deadline = Date.now() + WAIT;
    let last = null;
    for (;;) {
        last = await take();
        if (predicate(last)) return last;
        if (Date.now() > deadline)
            throw new Error(`${label || 'condition'} never held within ${WAIT}ms; last: ` +
                JSON.stringify(last));
        await new Promise((r) => setTimeout(r, 50));
    }
}

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
async function credentialLeaked(page, secret, ownFields) {
    return page.evaluate(({ needle, own }) => {
        const stores = [localStorage, sessionStorage];
        for (const store of stores)
            for (let i = 0; i < store.length; i++)
                if (String(store.getItem(store.key(i))).includes(needle)) return true;
        if (document.body.innerHTML.includes(needle)) return true;
        for (const el of document.querySelectorAll('input, textarea')) {
            if (own.includes(el.getAttribute('data-testid'))) continue;
            if (typeof el.value === 'string' && el.value.includes(needle)) return true;
        }
        for (const el of document.querySelectorAll('*')) {
            for (const attr of Array.from(el.attributes)) {
                if (attr.name.indexOf('data-') === 0 && String(attr.value).includes(needle)) return true;
            }
        }
        return false;
    }, { needle: secret, own: ['password'].concat(Array.isArray(ownFields) ? ownFields : []) });
}

async function runBody(ctx) {
    const { browser, check, assertEqual, assertOk, assertMatch, shot } = ctx;

    await check('localhost wizard never shows the host-key step', async () => {
        await withPage(ctx, STUB(RUN_OK), async (page) => {
            await page.selectOption('[data-testid="target"]', 'local');
            assertEqual((await stepIds(page)).join(','),
                'target,detect,tls,ports,execute,handover', 'host key must be absent for localhost');
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
                'target,hostkey,detect,tls,ports,execute,handover', 'host key must be present for remote');
            await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-hostkey"]'), 'remote stops at the host key');

            // No state was poked to get here — checkHostKey() fired on its own
            // when the wizard landed on this step. Prove the fingerprint came
            // from a real spawn call, not from nothing.
            const fingerprint = await waitForText(page, '[data-testid="fingerprint"]',
                (t) => t === fp, 'fingerprint');
            assertEqual(fingerprint, fp);

            // BEFORE Next has ever been refused: the pane already says what is
            // needed. The old button said nothing, so the only way to learn it
            // was required was to press Next and be told off.
            assertOk(await visible(page, '[data-testid="hostkey-pending"]'),
                'the pane must say what is still needed before Next is pressed');
            assertEqual(await page.isChecked('[data-testid="accept-hostkey"]'), false);

            await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-hostkey"]'),
                'an unconfirmed fingerprint must block the wizard');
            // Once refused, the red error carries the same instruction, so the
            // grey hint stands down rather than saying it twice.
            //
            // This is a SIMULTANEOUS invariant -- "these two are never both
            // showing" -- and reading it as two separate round trips is what
            // made it flaky: the page is free to move between the two reads, so
            // the assertion was about two different moments in time. Waiting for
            // the error first (the previous attempt) narrowed the window without
            // closing it. One evaluate, one snapshot, both facts: now it either
            // holds or it does not, and the answer is the same every run.
            const pair = await waitForCondition(page, () => page.evaluate(() => {
                const el = (id) => document.querySelector('[data-testid="' + id + '"]');
                const err = el('hostkey-error');
                const pend = el('hostkey-pending');
                const root = document.querySelector('#pilot-setup');
                const d = root && root._x_dataStack ? root._x_dataStack[0] : null;
                return {
                    errText: err ? (err.textContent || '').trim() : '',
                    pendingVisible: !!pend && pend.offsetParent !== null,
                    pendDisplay: pend ? (pend.style.display || '(unset)') : '(missing)',
                    state: d ? {
                        step: d.step, busy: d.busy,
                        errorsHostkey: d.errors ? d.errors.hostkey : '(no errors obj)',
                        hostkey: d.hostkey
                    } : '(no alpine data)'
                };
            // Waits for the pair to SETTLE, and both facts come from one
            // snapshot so a settled state is really settled.
            //
            // Not "never both, at any instant": x-text on the error and x-show
            // on the hint are separate Alpine effects over the same state, and
            // Alpine batches DOM mutations -- so a single frame with the error
            // already painted and the hint not yet hidden is an implementation
            // artifact, not something a user can perceive. Asserting the
            // instantaneous version made this check fail roughly one run in ten
            // for a condition the product does not actually violate. The real
            // requirement is that the user is never LEFT looking at both, and
            // that is what this asserts; if it never settles, the throw carries
            // the last snapshot and the component state with it.
            }), (v) => /Confirm the host key/i.test(v.errText) && !v.pendingVisible,
                'the error to appear and the hint to stand down');
            assertMatch(pair.errText, /Confirm the host key/i);
            assertOk(!pair.pendingVisible,
                'the hint and the error must not both say the same thing: ' + JSON.stringify(pair));
            const call = await spawnedCheckHostkey(page);
            assertOk(call, '--check-hostkey was never spawned by the real UI flow');
            assertEqual(JSON.parse(call.input).host, 'rd.example.com', 'the request carried the typed host');
            await shot(page, 'setup-remote-hostkey');
            // The confirmation is a CHECKBOX, so the state it shows must be the
            // state the wizard gates on -- and it must be reversible. Before
            // ticking, the pane says what is still needed; a button said nothing
            // and the only way to discover it was required was to be refused.
            await page.click('[data-testid="accept-hostkey"]');
            assertEqual(await page.isChecked('[data-testid="accept-hostkey"]'), true);
            assertOk(await visible(page, '[data-testid="hostkey-confirmed"]'));
            assertOk(!(await visible(page, '[data-testid="hostkey-pending"]')));

            // Untick really withdraws: the box is not decoration over a
            // one-way flag.
            await page.click('[data-testid="accept-hostkey"]');
            assertEqual(await page.isChecked('[data-testid="accept-hostkey"]'), false);
            await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-hostkey"]'),
                'withdrawing confirmation must block the wizard again');
            assertMatch(await page.textContent('[data-testid="hostkey-error"]'), /Confirm the host key/i);

            await page.click('[data-testid="accept-hostkey"]');
            await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-detect"]'),
                'a confirmed, unchanged fingerprint must let the wizard continue');
        });
    });

    // Detection is a real round trip to the target. An unchanged, still-clickable
    // button made that look like nothing had happened.
    await check('Detect shows it is working and cannot be pressed again mid-flight', async () => {
        await withPage(ctx, { spawn: { 'pilot-exec --detect': DETECTION } }, async (page) => {
            await page.selectOption('[data-testid="target"]', 'local');
            await page.click('[data-testid="next"]');
            assertOk(!(await visible(page, '[data-testid="detect-spinner"]')),
                'nothing is happening yet, so nothing may spin');
            assertEqual(await page.isDisabled('[data-testid="run-detect"]'), false);

            await page.click('[data-testid="run-detect"]');
            await wait(page, '[data-plan-step]');
            // Once the plan is in, the button is usable again and re-labelled.
            assertEqual(await page.isDisabled('[data-testid="run-detect"]'), false);
            assertOk(!(await visible(page, '[data-testid="detect-spinner"]')),
                'the spinner must clear when detection ends');
            assertMatch(await page.textContent('[data-testid="run-detect"]'), /Detect again/,
                'the label must say the plan can be rebuilt, not offer a first Detect again');
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

    // GAP C (task 33): PilotServers.writeSecret() had NO caller anywhere in
    // the repo, so checking "remember for day-2 operations" persisted
    // nothing and Server Ops' credential-gated controls could never become
    // enabled. This drives a REAL successful ssh install with the checkbox
    // on, then switches to Server Ops IN THE SAME PAGE (same underlying
    // cockpit-stub.js `files` store, not the unit tier's throwaway fixture)
    // and proves the previously-disabled control becomes enabled — the
    // credential must round-trip through the real writeSshCredential() /
    // readSecret()+decodeSshCredential() pair, not merely be claimed saved.
    await check('GAP C: "remember for day-2 operations" persists a real credential -- ' +
        'proven by Server Ops reading it back after a real run, never via argv or the transcript', async () => {
        const SERVER_ID = 'rd-example-com';
        const fp = 'SHA256:' + 'd'.repeat(43);
        const stub = {
            spawn: {
                'pilot-exec --detect': DETECTION, 'pilot-exec --run': RUN_OK,
                'pilot-exec --probe-ports': PROBE_ALL_OK,
                'pilot-exec --check-hostkey': HOSTKEY_UNKNOWN(fp),
                // writeSshCredential() (js/core/servers.js's writeSecret())
                // chmods and chowns the secret file after writing it — no
                // earlier e2e scenario ever exercised that path since it had
                // no caller before this fix.
                chmod: '', chown: ''
            },
            files: {
                '/etc/pilot/config.json': JSON.stringify({ activeServer: SERVER_ID }),
                ['/etc/pilot/servers/' + SERVER_ID + '.json']: JSON.stringify({
                    id: SERVER_ID, host: 'rd.example.com', sshPort: 22, apiPort: 21114, tls: false,
                    domain: null, hbbsKey: null, hbbsPorts: [], installDir: '/opt/rustdesk-api', createdAt: null
                })
            }
        };
        const page = await ctx.open(ctx.browser, stub);
        page.setDefaultTimeout(WAIT);
        try {
            // Before: the pre-seeded record has no .ssh secret at all yet, so
            // a credential-needing op must be disabled with a clear reason.
            await page.click('[data-tab="server-ops"]');
            await wait(page, '[data-testid="op-status"]');
            assertOk(await page.locator('[data-testid="op-status"]').isDisabled(),
                'a credentialled op must be disabled before any secret is stored');
            const reasonBefore = await page.locator('[data-testid="op-status-reason"]').innerText();
            assertOk(/credential/i.test(reasonBefore), 'the reason must say why, not just disable silently');

            await page.click('[data-tab="setup"]');
            await page.selectOption('[data-testid="target"]', 'ssh');
            await page.fill('[data-testid="host"]', 'rd.example.com');
            await page.selectOption('[data-testid="auth"]', 'password');
            await page.fill('[data-testid="password"]', 'RememberedSecret42');
            await page.check('[data-testid="remember"]');
            assertOk(await page.isChecked('[data-testid="remember"]'), 'the checkbox must actually bind');
            await page.click('[data-testid="next"]');
            await waitForText(page, '[data-testid="fingerprint"]', (t) => t === fp, 'fingerprint');
            await page.click('[data-testid="accept-hostkey"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-detect"]');
            await wait(page, '[data-plan-step]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-start"]');
            await wait(page, '[data-step-id="reachability"]');

            assertEqual(await credentialLeaked(page, 'RememberedSecret42'), false,
                'the SSH password must not leak into the DOM, storage, another input, or the transcript');
            const calls = await page.evaluate(() => window.__pilotStub.calls);
            for (const c of calls) {
                if (c.kind === 'spawn')
                    assertOk(c.argv.join(' ').indexOf('RememberedSecret42') < 0,
                        'the credential must never appear in any spawned argv, including the ' +
                        'writeSshCredential chmod/chown calls: ' + JSON.stringify(c.argv));
            }
            const runCall = calls.filter((c) => c.kind === 'spawn').find((c) => c.argv.indexOf('--run') >= 0);
            assertOk(runCall.input.indexOf('RememberedSecret42') >= 0,
                'the provisioning envelope itself legitimately carries it on stdin');

            // The actual proof: switch to Server Ops IN THIS SAME PAGE and
            // confirm the credential-gated op is now enabled — this can only
            // be true if persistCredential() really called
            // PilotServers.writeSshCredential() and server-ops-ui.js really
            // read it back via readSecret()+decodeSshCredential(). Server Ops
            // does not poll or refresh merely because its tab becomes
            // visible again (x-show toggles the same live component, it does
            // not remount) — it reloads on 'pilot:server-changed', the same
            // event a real reconnect/server-switch fires, so this dispatches
            // that event for the SAME server id to trigger exactly that.
            await page.click('[data-tab="server-ops"]');
            await page.evaluate((id) => {
                document.dispatchEvent(new CustomEvent('pilot:server-changed', { detail: { id }, bubbles: true }));
            }, SERVER_ID);
            await page.waitForFunction(() => {
                const el = document.querySelector('[data-testid="op-status"]');
                return !!el && !el.disabled;
            }, null, { timeout: WAIT });
            const reasonGone = await page.locator('[data-testid="op-status-reason"]').innerText().catch(() => '');
            assertEqual(reasonGone, '', 'the "no stored credential" reason must be gone now that one is stored');
            await shot(page, 'setup-remember-credential-persisted');
        } finally {
            await page.ctx.close();
        }
    });

    // ============================================== FINAL REVIEW, FINDING 1 ==
    //
    // THE DEFECT: js/core/tls.js, js/core/provision-plan.js's tls-* steps and
    // js/features/overview.js's web-client link were all fully built and fully
    // unit-tested, and NOTHING could reach any of them: planChoicesFor()
    // hardcoded tlsTier:'none', index.html had no domain/tier/DuckDNS input at
    // all, and the Overview "Set up TLS" CTA jumped to a step id the wizard did
    // not have. These checks drive the REAL page through the real TLS step and
    // assert on what the plan the page actually built contains -- never on a
    // component's internal state.

    // Reads the plan the page is really holding, exactly as the detect pane
    // renders it: the step ids in the DOM, not a component property.
    async function planStepIds(page) {
        return page.$$eval('[data-plan-step]', (els) => els.map((e) => e.getAttribute('data-plan-step')));
    }

    // The wizard's own DNS pre-flight runs `getent ahostsv4 <host>` through the
    // bridge. 203.0.113.10 is DETECTION's public_ip, so this is the "DNS
    // already points here" answer.
    const GETENT_OK = '203.0.113.10 STREAM rd.example.com\n203.0.113.10 DGRAM\n';
    const GETENT_ELSEWHERE = '198.51.100.7  STREAM other.example.com\n';
    const GETENT_NXDOMAIN = { error: true, message: 'getent: key not found', exit_status: 2 };

    await check("FINDING 1: the wizard's TLS step drives a real Let's Encrypt plan -- " +
        'the emitted plan carries the tls-* steps and the ports step switches to 443', async () => {
        await withPage(ctx, { spawn: { 'pilot-exec --detect': DETECTION, 'pilot-exec --run': RUN_OK,
            'pilot-exec --probe-ports': PROBE_ALL_OK,
            'getent ahostsv4': GETENT_OK } }, async (page) => {
            await page.selectOption('[data-testid="target"]', 'local');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-detect"]');
            await wait(page, '[data-plan-step]');

            const before = await planStepIds(page);
            assertOk(!before.some((id) => id.indexOf('tls-') === 0),
                'the default plan is still TLS-free: ' + before.join(','));

            await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-tls"]'), 'the wizard has a TLS step');
            await page.selectOption('[data-testid="tls-tier"]', 'own');
            await page.fill('[data-testid="tls-domain"]', 'rd.example.com');
            assertMatch(await page.textContent('[data-testid="tls-host"]'), /rd\.example\.com/,
                'the pane names the host the certificate will be requested for');
            await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-ports"]'), 'a valid domain lets the wizard on');

            // THE proof: the plan the page is holding now really contains the
            // steps that were unreachable before.
            await page.click('[data-testid="back"]');
            await page.click('[data-testid="back"]');
            const after = await planStepIds(page);
            for (const id of ['tls-caddy', 'tls-caddyfile', 'tls-reload'])
                assertOk(after.includes(id), `the plan must contain ${id}, got: ${after.join(',')}`);
            assertOk(!after.includes('tls-duckdns'), 'the own-domain tier needs no DuckDNS step');

            // The manual script is a rendering of that same plan.
            await page.click('[data-testid="manual-toggle"]');
            const script = await page.textContent('[data-testid="manual-script"]');
            assertMatch(script, /https:\/\/rd\.example\.com \{/, 'the Caddyfile is rendered for the domain');

            // And the ports step follows the tier: 443 and 80 required, and
            // 21114 no longer offered to the internet.
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            const cloud = await page.textContent('[data-testid="cloud-ports"]');
            assertMatch(cloud, /443\/tcp/, 'the TLS tier requires 443');
            assertMatch(cloud, /80\/tcp/, 'ACME HTTP-01 requires 80');
            assertOk(cloud.indexOf('21114/tcp') < 0,
                'with TLS the API port is reached through the proxy, not opened: ' + cloud);
            await shot(page, 'setup-tls-letsencrypt');
        });
    });

    await check('FINDING 1: a bare IP can never become a TLS target -- PilotTls.validate() ' +
        'is still the authority and the wizard will not leave the step', async () => {
        await withPage(ctx, STUB(RUN_OK), async (page) => {
            await page.selectOption('[data-testid="target"]', 'local');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-detect"]');
            await wait(page, '[data-plan-step]');
            await page.click('[data-testid="next"]');
            await page.selectOption('[data-testid="tls-tier"]', 'own');
            await page.fill('[data-testid="tls-domain"]', '203.0.113.10');
            await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-tls"]'), 'a bare IP must not pass');
            assertMatch(await page.textContent('[data-testid="tls-error"]'), /bare IP address/i,
                'and it must say why');
        });
    });

    await check('FINDING 1: the DuckDNS token reaches the helper on stdin ONLY -- never in an ' +
        'argv, the DOM, storage, the transcript or the written server record', async () => {
        const TOKEN = 'DuckSecret-0123456789';
        await withPage(ctx, { spawn: { 'pilot-exec --detect': DETECTION, 'pilot-exec --run': RUN_OK,
            'pilot-exec --probe-ports': PROBE_ALL_OK,
            'getent ahostsv4': GETENT_OK, chmod: '', chown: '',
            'find /etc/pilot/servers -maxdepth 1 -type f -name *.json': '/etc/pilot/servers/local.json\n' },
        files: {} }, async (page) => {
            await page.selectOption('[data-testid="target"]', 'local');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-detect"]');
            await wait(page, '[data-plan-step]');
            await page.click('[data-testid="next"]');
            await page.selectOption('[data-testid="tls-tier"]', 'duckdns');
            await page.fill('[data-testid="tls-duckdns-sub"]', 'pilot-demo');
            await page.fill('[data-testid="tls-duckdns-token"]', TOKEN);
            await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-ports"]'), 'a valid DuckDNS pair lets the wizard on');
            await page.click('[data-testid="back"]');
            await page.click('[data-testid="back"]');
            const ids = await planStepIds(page);
            for (const id of ['tls-duckdns-token', 'tls-duckdns', 'tls-caddyfile'])
                assertOk(ids.includes(id), `the plan must contain ${id}, got: ${ids.join(',')}`);

            // The manual script must not print it either.
            await page.click('[data-testid="manual-toggle"]');
            const script = await page.textContent('[data-testid="manual-script"]');
            assertOk(script.indexOf(TOKEN) < 0, 'the manual script must never render the token');
            assertMatch(script, /DUCKDNS_TOKEN:\?/, 'it asks for the token from the environment instead');

            // detect -> tls -> ports -> execute
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-start"]');
            await wait(page, '[data-step-id="reachability"]');

            assertEqual(await credentialLeaked(page, TOKEN, ['tls-duckdns-token']), false,
                'the DuckDNS token must not reach storage, the DOM, another input or a data-* attribute');
            const calls = await page.evaluate(() => window.__pilotStub.calls);
            for (const c of calls) {
                if (c.kind === 'spawn')
                    assertOk(c.argv.join(' ').indexOf(TOKEN) < 0,
                        'the token must never appear in any spawned argv: ' + JSON.stringify(c.argv));
                if (c.kind === 'replace')
                    assertOk(String(c.content).indexOf(TOKEN) < 0,
                        'the token must never be written to ' + c.path);
            }
            const runCall = calls.filter((c) => c.kind === 'spawn').find((c) => c.argv.indexOf('--run') >= 0);
            assertOk(runCall.input.indexOf(TOKEN) >= 0,
                'it legitimately travels inside the envelope on stdin');
            const envelope = JSON.parse(runCall.input);
            const staged = envelope.steps.filter((s) => s.id === 'tls-duckdns-token')[0];
            assertOk(staged && staged.secret === true, 'and only inside a step marked secret');
            assertEqual(staged.write.mode, '0600');
            for (const step of envelope.steps)
                assertOk(step.argv.join(' ').indexOf(TOKEN) < 0,
                    'no step argv may carry the token: ' + step.id);
            const transcript = await page.textContent('[data-testid="transcript"]');
            assertOk(transcript.indexOf(TOKEN) < 0, 'the transcript must not carry the token');
            await shot(page, 'setup-tls-duckdns');
        });
    });

    await check('FINDING 1: the spec §6.1 DNS pre-flight blocks the run before ACME is invoked, ' +
        'so no rate-limit attempt is burnt', async () => {
        for (const [label, getent] of [['pointing elsewhere', GETENT_ELSEWHERE], ['no A record', GETENT_NXDOMAIN]]) {
            await withPage(ctx, { spawn: { 'pilot-exec --detect': DETECTION, 'pilot-exec --run': RUN_OK,
            'pilot-exec --probe-ports': PROBE_ALL_OK,
                'getent ahostsv4': getent } }, async (page) => {
                await page.selectOption('[data-testid="target"]', 'local');
                await page.click('[data-testid="next"]');
                await page.click('[data-testid="run-detect"]');
                await wait(page, '[data-plan-step]');
                await page.click('[data-testid="next"]');
                await page.selectOption('[data-testid="tls-tier"]', 'own');
                await page.fill('[data-testid="tls-domain"]', 'rd.example.com');
                await page.click('[data-testid="tls-check-dns"]');
                await waitForText(page, '[data-testid="tls-preflight"]', (t) => t.length > 0, 'preflight');
                assertEqual(await page.getAttribute('[data-testid="tls-preflight"]', 'data-kind'),
                    'TLS_DNS_MISMATCH', `${label}: the pre-flight must name the mismatch`);

                await page.click('[data-testid="next"]');
                await page.click('[data-testid="next"]');
                await page.click('[data-testid="run-start"]');
                assertOk(await visible(page, '[data-testid="execute-error"]'),
                    `${label}: the refusal must be visible on the pane the user is looking at`);
                assertMatch(await page.textContent('[data-testid="execute-error-message"]'),
                    /rd\.example\.com/, `${label}: and it must name the host it checked`);
                const spawned = (await page.evaluate(() => window.__pilotStub.calls))
                    .filter((c) => c.kind === 'spawn' && c.argv.indexOf('--run') >= 0);
                assertEqual(spawned.length, 0,
                    `${label}: pilot-exec --run must never be spawned when DNS does not point here`);
            });
        }
    });

    // ========================================================= TASK 34 =====
    //
    // THE DEFECT: PilotServers.write() had ZERO callers anywhere in js/ -- no
    // shipped code path ever registered a server, so a user could run this
    // wizard to a successful finish and Overview/Devices/Address
    // Book/Users/Audit/Server Ops stayed permanently at their empty states.
    // The GAP C scenario above only ever passes because it PRE-SEEDS
    // /etc/pilot/servers/rd-example-com.json into the stub's own file map --
    // hard-coding the exact record no shipped code could create. This
    // scenario is the actual proof: it drives the wizard to a successful
    // LOCAL finish with NOTHING pre-seeded in `files` at all, then proves
    // the server that appears is the REAL one registerServer() wrote --
    // never the synthetic FALLBACK_SERVER js/features/overview.js shows for
    // an empty registry (name "This server") -- by asserting the switcher
    // option's own text is "localhost", the real record's `host` field,
    // which nothing but a genuine registry read can produce. It then proves
    // Devices really queries that server: a live /admin/peer request must
    // reach the stub with the address the record carries, driven through
    // the real js/app.js wireApi()/switchServer() wiring (never
    // ctx.useTransport(), which replaces PilotApi.setTransport wholesale and
    // would hide the very defect this guards against -- see
    // tests/e2e/servers.e2e.mjs's and tests/e2e/devices.e2e.mjs's own
    // comments on exactly this point).
    const PROBE_OK = { code: 0, message: '', data: {} };
    const REGISTERED_DEVICE = { id: '999999999', alias: 'Freshly Registered Pi', online: true,
        last_online: 1754222400, ip: '10.0.0.42', platform: 'Linux', version: '1.3.7' };

    function listOk(list) {
        return { status: 200, body: { code: 0, message: '', data:
            { list, page: 1, total: list.length, page_size: 50 } } };
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

    // The stub for THIS scenario alone: deliberately no `files` entry for
    // /etc/pilot/config.json or any /etc/pilot/servers/*.json -- the whole
    // point is that nothing pre-seeds the registry. The `find` line is the
    // one concession the stub's own design requires: cockpit-stub.js's spawn
    // responses are static text, not a live view of `files`, so it cannot
    // itself notice a file registerServer() writes mid-scenario -- the
    // static answer below simply states what a real `find` WOULD report
    // once that write lands. The JSON CONTENT itself is never hard-coded
    // here; PilotServers.read('local') still returns exactly whatever
    // Servers.write() really put in `files['/etc/pilot/servers/local.json']`.
    const REGISTERS_STUB = {
        spawn: {
            'pilot-exec --detect': DETECTION,
            'pilot-exec --run': RUN_OK,
            'find /etc/pilot/servers -maxdepth 1 -type f -name *.json':
                '/etc/pilot/servers/local.json\n'
        },
        files: {},
        http: {
            'GET /admin/swagger/doc.json': { status: 404, body: '404 page not found' },
            'GET /api/currentUser': PROBE_OK,
            'GET /api/admin/peer/list': listOk([REGISTERED_DEVICE]),
            'POST /api/ab/shared/profiles': PROBE_OK,
            'POST /api/ab/peers': PROBE_OK,
            'GET /api/admin/user/list': PROBE_OK,
            'GET /api/admin/group/list': PROBE_OK,
            'GET /api/admin/audit_conn/list': PROBE_OK,
            'GET /api/admin/audit_file/list': PROBE_OK,
            'GET /api/admin/login_log/list': PROBE_OK
        }
    };

    await check('TASK 34: a successful local install registers "local" for real, with NOTHING ' +
        'pre-seeded in the registry -- Overview\'s switcher shows the REAL record and Devices ' +
        'genuinely queries it', async () => {
        const page = await ctx.open(ctx.browser, REGISTERS_STUB);
        page.setDefaultTimeout(WAIT);
        try {
            await installAlpineHelper(page);
            await page.click('[data-tab="setup"]');
            await page.selectOption('[data-testid="target"]', 'local');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-detect"]');
            await wait(page, '[data-plan-step]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-start"]');
            await wait(page, '[data-step-id="reachability"][data-status="ok"]');
            await page.click('[data-testid="next"]');
            assertEqual(await page.getAttribute('[data-testid="handover-status"]', 'data-status'),
                'ok', 'this proof needs a clean success, not a partial');

            // PROOF 1: the registry itself really has a "local" record now --
            // read straight through the same PilotServers module every
            // surface uses, no UI involved yet.
            const record = await page.evaluate(() => window.PilotServers.read('local'));
            assertOk(record, 'PilotServers.read("local") found nothing -- registerServer() never wrote it');
            assertEqual(record.host, 'localhost');
            assertOk(!Object.prototype.hasOwnProperty.call(record, 'password'),
                'a server record must never carry a secret');

            // PROOF 2: js/app.js's real activeServerId flips to "local" --
            // proving registerServer() actually called setActive() and
            // dispatched 'pilot:server-changed', not merely written a file
            // nothing else ever looks at.
            await page.waitForFunction(
                () => window.alpineData() && window.alpineData().activeServerId === 'local',
                null, { timeout: WAIT });
            await page.waitForFunction(
                () => window.alpineData() && window.alpineData().apiReady === true,
                null, { timeout: WAIT });

            // PROOF 3: Overview's switcher shows the REAL record, not the
            // synthetic FALLBACK_SERVER js/features/overview.js renders for
            // an empty registry -- distinguished by the visible option TEXT:
            // the fallback reads "This server", a genuine record with no
            // `name` field falls back to its `host`, "localhost". Refresh is
            // a real click on Overview's own control (loadServers() is
            // fetched once at mount, before this run ever happened, so
            // picking up the file registerServer() just wrote needs the same
            // Refresh a real user would reach for).
            await page.click('[data-tab="overview"]');
            await page.click('#pilot-overview [data-test="refresh"]');
            await page.waitForFunction(() => {
                const opt = document.querySelector('#pilot-overview [data-test="switcher"] option[value="local"]');
                return !!opt && opt.textContent.trim() === 'localhost';
            }, null, { timeout: WAIT });

            // PROOF 4: Devices genuinely queries this server -- a REAL
            // /admin/peer request reaches the stub, and the row it renders
            // is the one this scenario's own stub attached to that route
            // (never a coincidental leftover from some other server's cache).
            await page.click('[data-tab="devices"]');
            await page.click('#pilot-devices [data-test="refresh"]');
            await page.waitForFunction(
                () => document.querySelectorAll('#pilot-devices [data-test="row"]').length === 1,
                null, { timeout: WAIT });
            const peerCalls = (await page.evaluate(() => window.__pilotStub.calls))
                .filter((c) => c.kind === 'http' && c.path.indexOf('/api/admin/peer') === 0);
            assertOk(peerCalls.length >= 1,
                'Devices never actually queried the newly registered server');
            const names = await page.$$eval('#pilot-devices [data-test="name"] span[x-text]',
                (els) => els.map((e) => e.textContent.trim()));
            assertOk(names.includes('Freshly Registered Pi'),
                'the rendered row is not the device this scenario\'s own stub attached to /admin/peer');

            await shot(page, 'setup-registers-server-e2e');
        } finally {
            await page.ctx.close();
        }
    });

    // The Execute pane, before Start: the progress bar, "Copy full transcript"
    // and the transcript region are all views OF A RUN. Reported from a real
    // first run as "no transcript" -- what the user saw was a 0% bar, a button
    // that copies nothing and an empty region, with no statement of what to do.
    // The live tier cannot reach this pane on a host with no helper installed,
    // so the assertion lives here, where detection really produces a plan.
    await check('the Execute pane renders no control over an absent run (§7.3)', async () => {
        await withPage(ctx, { spawn: { 'pilot-exec --detect': DETECTION, 'pilot-exec --run': RUN_OK } },
            async (page) => {
            await page.selectOption('[data-testid="target"]', 'local');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-detect"]');
            await wait(page, '[data-plan-step]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            assertEqual(await page.getAttribute('[data-testid="pane-execute"]', 'data-testid'), 'pane-execute');

            assertOk(!(await visible(page, '[data-testid="progress-bar"]')),
                'a 0% progress bar over no run is a dead control');
            assertOk(!(await visible(page, '[data-testid="copy-transcript"]')),
                '"Copy full transcript" is offered with no transcript to copy');
            assertOk(await visible(page, '[data-testid="execute-idle"]'),
                'and in their place the pane must say what to do');
            assertMatch(await page.textContent('[data-testid="execute-idle"]'), /Start/,
                'the explanation must name the action that produces a transcript');
            assertOk(await visible(page, '[data-testid="run-start"]'), 'Start must still be offered');

            // The instant Start is pressed, the bar appears -- it must not wait
            // for the first step to land, or the click looks like it did nothing.
            await page.click('[data-testid="run-start"]');
            // Wait for the run to actually produce a step -- polling the bar's
            // mere presence races the spawn, since the element exists (hidden)
            // the whole time.
            await wait(page, '[data-step-id]');
            assertOk(!(await visible(page, '[data-testid="execute-idle"]')),
                'the idle explanation must go away once a run exists');
            await shot(page, 'setup-execute-idle');
        });
    });

    // Detection is what PRODUCES the plan; leaving that step without one walked
    // the user through Ports (nothing to list) to an Execute pane whose Start
    // could only ever fail.
    await check('Detection & plan cannot be clicked past, and the refusal is visible', async () => {
        await withPage(ctx, {}, async (page) => {
            await page.selectOption('[data-testid="target"]', 'local');
            await page.click('[data-testid="next"]');
            for (let i = 0; i < 3; i++) await page.click('[data-testid="next"]');
            assertOk(await visible(page, '[data-testid="pane-detect"]'),
                'the wizard walked past Detection with no plan');
            assertOk(!(await visible(page, '[data-testid="pane-execute"]')));
            assertMatch(await page.textContent('[data-testid="detect-gate"]'), /detection first/i,
                'a Next that silently does nothing is the same defect in a different hat');
        });
    });

    // The handover's verdict must come from a REAL probe of this host, not from
    // the target's own `ss` output. Before the probe existed the claim was
    // vacuous; before this scenario existed, nothing drove it end to end.
    await check('a port the target is listening on but this host cannot reach is reported, not hidden',
        async () => {
        const blocked = JSON.stringify({ host: '127.0.0.1', results: [
            { port: 21114, proto: 'tcp', reachable: false, detail: 'timed out after 4.0s' },
            { port: 21115, proto: 'tcp', reachable: true, detail: '' }
        ] }) + '\n';
        await withPage(ctx, STUB(RUN_OK, undefined, blocked), async (page) => {
            await page.selectOption('[data-testid="target"]', 'local');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-detect"]');
            await wait(page, '[data-plan-step]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-start"]');
            await wait(page, '[data-testid="pane-handover"] [data-testid="handover-status"]');
            await waitForText(page, '[data-testid="handover-status"]', (t) => t.trim() !== '', 'handover');

            const status = await page.textContent('[data-testid="handover-status"]');
            assertMatch(status, /21114\/tcp/,
                'a port this host cannot reach must appear in the verdict: ' + status);
            assertOk(!/Every required port is reachable/.test(status),
                'the run succeeded and the target was listening — which is exactly the ' +
                'situation that used to be reported as a clean finish');
            // And the REASON, because "dropped" and "refused" need opposite fixes.
            assertMatch(await page.textContent('[data-testid="blocked-ports"]'),
                /cloud or edge firewall/i);
            await shot(page, 'setup-blocked-port');
        });
    });

    await check('when every port really is reachable, the verdict says so', async () => {
        await withPage(ctx, STUB(RUN_OK), async (page) => {
            await page.selectOption('[data-testid="target"]', 'local');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-detect"]');
            await wait(page, '[data-plan-step]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-start"]');
            await waitForText(page, '[data-testid="handover-status"]', (t) => t.trim() !== '', 'handover');
            assertMatch(await page.textContent('[data-testid="handover-status"]'),
                /Every required port is reachable/);
            assertEqual((await page.textContent('[data-testid="blocked-ports"]')).trim(), '');
        });
    });

    // ============================================== FINAL REVIEW, FINDING 2 ==
    //
    // THE DEFECT: registered / registrationError / registeredServerId were
    // written by registerServer() and appeared in NO template. Six unit tests
    // asserted the state, including one whose message reads "the activation
    // failure must still be surfaced" -- it was surfaced to nobody. A rejected
    // PilotServers.write() (missing/unwritable /etc/pilot, SELinux, a failed
    // setActive()) showed a green successful handover while every console tab
    // stayed empty with no explanation.
    await check('FINDING 2: a failing PilotServers.write() produces a VISIBLE error and a retry, ' +
        'not a green handover', async () => {
        const stub = {
            spawn: { 'pilot-exec --detect': DETECTION, 'pilot-exec --run': RUN_OK },
            // cockpit-stub.js rejects read AND replace for a file scripted with
            // {error:true} -- exactly what an unwritable /etc/pilot looks like.
            // 'access-denied' is what the real bridge reports for a
            // Limited-access Cockpit session, which is the DEFAULT for every
            // account -- by far the most likely way this fails in the field.
            files: { '/etc/pilot/servers/local.json':
                { error: true, message: 'permission denied', problem: 'access-denied' } }
        };
        await withPage(ctx, stub, async (page) => {
            await page.selectOption('[data-testid="target"]', 'local');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-detect"]');
            await wait(page, '[data-plan-step]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-start"]');
            await wait(page, '[data-step-id="reachability"][data-status="ok"]');
            await page.click('[data-testid="next"]');

            // The run itself really did succeed -- which is exactly what made
            // the silent registration failure so misleading.
            assertEqual(await page.getAttribute('[data-testid="handover-status"]', 'data-status'), 'ok');
            assertOk(await visible(page, '[data-testid="registration-error"]'),
                'a rejected write() must be shown, not swallowed behind a green tick');
            assertMatch(await page.textContent('[data-testid="registration-error-message"]'),
                /could not write \/etc\/pilot\/servers\/local\.json/i,
                'and it must name the operation and path that actually failed');
            // GENERIC earns NO one-click remediation, so the sentence line is
            // absent -- and must be, because PilotErrors.remediation() answers
            // the internal token 'none' for it, and a bold red "none" under a
            // failure reads as a second, nonsense error.
            assertOk(!(await visible(page, '[data-testid="registration-remediation"]')),
                'a kind with no remediation shows no remediation line at all');
            const shown = await page.textContent('[data-testid="registration-error"]');
            assertOk(!/\b(none|retry|reauthorize|manual-mode|fix-dns|open-ports|hard-stop)\b/.test(shown),
                'the remediation VOCABULARY must never reach the screen: ' + JSON.stringify(shown));
            // What GENERIC does carry is the system's own reason -- and it is
            // the only thing that says what went wrong (js/core/errors.js: the
            // UI surfaces the raw detail verbatim, §8).
            assertOk(await visible(page, '[data-testid="registration-cause"]'),
                'a GENERIC failure must show the reason the bridge reported');
            assertMatch(await page.textContent('[data-testid="registration-cause"]'), /access-denied|denied|not-found/i,
                'and that reason must be the real problem, not a placeholder');
            assertOk(!(await visible(page, '[data-testid="registered"]')),
                'it must NOT also claim the server was registered');
            assertOk(await visible(page, '[data-testid="registration-retry"]'),
                'and it must offer a way to try again');
            await shot(page, 'setup-registration-failed');
        });
    });

    // The other half of FINDING 1: js/features/overview.js's web client could
    // only ever be disabled, because no shipped path could record a server with
    // TLS. This drives the whole loop in one page -- wizard TLS step, real run,
    // real registration, then Overview -- and asserts the link is enabled with
    // the exact https address, plus that the CTA on a NON-TLS server actually
    // lands on the wizard's TLS step (it was a no-op with a listener before).
    await check('FINDING 1 (end to end): a TLS install records the domain and Overview\'s ' +
        'web client link becomes enabled, and "Set up TLS" really opens the TLS step', async () => {
        const stub = {
            spawn: {
                'pilot-exec --detect': DETECTION, 'pilot-exec --run': RUN_OK,
                'pilot-exec --probe-ports': PROBE_ALL_OK,
                'getent ahostsv4': '203.0.113.10 STREAM rd.example.com\n',
                'find /etc/pilot/servers -maxdepth 1 -type f -name *.json':
                    '/etc/pilot/servers/local.json\n'
            },
            files: {},
            http: REGISTERS_STUB.http
        };
        const page = await ctx.open(ctx.browser, stub);
        page.setDefaultTimeout(WAIT);
        try {
            // Before any install: no server has TLS, so the link is disabled and
            // its CTA is the only route forward.
            await page.click('[data-tab="overview"]');
            await wait(page, '#pilot-overview [data-test="web-client-disabled"]');
            assertMatch(await page.textContent('#pilot-overview [data-test="web-client-reason"]'),
                /TLS is not configured/i, 'the reason is shown, not just a dead button');
            await page.click('#pilot-overview [data-test="web-client-fix"]');
            assertOk(await visible(page, '[data-testid="pane-tls"]'),
                'the "Set up TLS" CTA must land on the wizard\'s TLS step');

            // Now actually do it. Back out of the TLS step the CTA jumped to
            // (tls -> detect -> target) and drive the wizard properly.
            await page.click('[data-testid="back"]');
            await page.click('[data-testid="back"]');
            await page.selectOption('[data-testid="target"]', 'local');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-detect"]');
            await wait(page, '[data-plan-step]');
            await page.click('[data-testid="next"]');
            await page.selectOption('[data-testid="tls-tier"]', 'own');
            await page.fill('[data-testid="tls-domain"]', 'rd.example.com');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="next"]');
            await page.click('[data-testid="run-start"]');
            await wait(page, '[data-step-id="reachability"][data-status="ok"]');
            await page.click('[data-testid="next"]');
            assertEqual(await page.getAttribute('[data-testid="handover-status"]', 'data-status'), 'ok');

            // FINDING 2's half: the registration outcome is now RENDERED.
            assertOk(await visible(page, '[data-testid="registered"]'),
                'the handover must say which server it registered');
            assertMatch(await page.textContent('[data-testid="registered"]'), /local/,
                'and name it');

            // The record itself carries the TLS facts the Overview link needs.
            const record = await page.evaluate(() => window.PilotServers.read('local'));
            assertEqual(record.tls, true, 'a TLS install must record tls:true');
            assertEqual(record.domain, 'rd.example.com', 'and the exact certified hostname');

            await page.click('[data-tab="overview"]');
            await page.click('#pilot-overview [data-test="refresh"]');
            await page.waitForFunction(() => {
                const a = document.querySelector('#pilot-overview [data-test="web-client-link"]');
                return !!a && a.getAttribute('href') === 'https://rd.example.com/webclient/';
            }, null, { timeout: WAIT });
            await shot(page, 'overview-web-client-enabled');
        } finally {
            await page.ctx.close();
        }
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
