// tests/e2e/live-wizard-gates.live.mjs -- the wizard must never walk a user
// into a pane that can only fail, and must never render a control over nothing.
//
// Found by hand on a real first run, reported as "no transcript": the Execute
// pane showed a Start button, an empty progress bar, a "Copy full transcript"
// button and nothing else. Two causes, both invisible to every other tier:
//
//   1. next() gated 'target', 'hostkey' and 'tls' but NOT 'detect'. Detection
//      is what produces the plan, and every later step consumes it -- so a user
//      who clicked past it walked through Ports (nothing to list) to Execute,
//      where Start could only ever error.
//
//   2. The progress bar, the copy button and the transcript region are views OF
//      A RUN. With no run they rendered as a 0% bar, a button that copies
//      nothing and an empty region: three dead controls and no statement of
//      what to do (spec 7.3).
//
// This drives the REAL wizard, because both defects are about what a user can
// click their way into -- which no unit test and no stub can establish. It runs
// against the localhost target, so it needs no SSH and no reachable host, and
// it never presses Start: nothing here installs anything.
export const name = 'live-wizard-gates';

export default async function run(ctx) {
    const { browser, creds, check, assertOk, assertEqual, login, openPilot, shot } = ctx;
    const page = await ctx.newPage(browser);

    const activeStep = (f) => f.evaluate(() => {
        const el = document.querySelector('[data-testid="setup-steps"] .active');
        return el ? el.getAttribute('data-step') : '(none)';
    });
    const seen = async (f, sel) => {
        const el = await f.$(sel);
        return el ? await el.isVisible() : false;
    };

    try {
        await check('live-wizard-gates: Detection & plan cannot be clicked past, and says so', async () => {
            await login(page, creds);
            const frame = await openPilot(page);
            await frame.waitForSelector('.pilot-shell', { state: 'visible', timeout: 15000 });
            await frame.click('[data-tab="setup"]', { timeout: 15000 });
            await frame.selectOption('[data-testid="target"]', 'local', { timeout: 15000 });
            await frame.click('[data-testid="next"]', { timeout: 15000 });
            assertEqual(await activeStep(frame), 'detect', 'target -> detect');

            // Click Next repeatedly WITHOUT detecting. The wizard must not move.
            for (let i = 0; i < 3; i++) {
                await frame.click('[data-testid="next"]', { timeout: 15000 });
                await page.waitForTimeout(300);
            }
            assertEqual(await activeStep(frame), 'detect',
                'the wizard walked past Detection with no plan -- every later step has nothing to work with');

            // And the refusal is visible: a Next that silently does nothing is
            // the same defect wearing a different hat.
            const gate = ((await frame.textContent('[data-testid="detect-gate"]')) || '').trim();
            assertOk(gate.length > 0, 'Next refused with no reason shown');
            assertOk(/detection/i.test(gate), `the reason must name what is missing: ${JSON.stringify(gate)}`);
            await shot(page, 'live-wizard-detect-gate');
        });

        await check('live-wizard-gates: the Execute pane renders no control over an absent run', async () => {
            const frame = await openPilot(page);
            // Reach Execute the only way that exists: detect for real. On a host
            // with no helper installed this legitimately fails -- in which case
            // the gate above already proved itself and there is nothing further
            // to check here, so report that rather than faking a plan.
            await frame.click('[data-testid="run-detect"]', { timeout: 15000 });
            await page.waitForTimeout(4000);
            const hasPlan = await frame.evaluate(() =>
                !!document.querySelector('[data-plan-step]'));
            if (!hasPlan) {
                const why = ((await frame.textContent('[data-testid="detect-error"]')) || '').trim();
                console.log(`      detection did not produce a plan on this host (${JSON.stringify(why)});` +
                    ' the Execute pane cannot be reached, which is the gate working');
                // The message must still be prose, not a Cockpit problem token.
                assertOk(!/^[a-z-]+$/.test(why),
                    `a raw problem token reached the screen: ${JSON.stringify(why)}`);
                return;
            }

            for (const step of ['tls', 'ports', 'execute']) {
                await frame.click('[data-testid="next"]', { timeout: 15000 });
                await page.waitForTimeout(500);
                if ((await activeStep(frame)) === step) continue;
                assertOk(false, `could not reach ${step}; stopped at ${await activeStep(frame)}`);
            }

            // Nothing has been started. The three views of a run must be absent,
            // and something must say what to do instead.
            assertOk(!(await seen(frame, '[data-testid="progress-bar"]')),
                'a 0% progress bar over no run is a dead control');
            assertOk(!(await seen(frame, '[data-testid="copy-transcript"]')),
                '"Copy full transcript" is offered with no transcript to copy');
            const idle = ((await frame.textContent('[data-testid="execute-idle"]')) || '').trim();
            assertOk(idle.length > 20, 'the pane must say what to do, not sit blank');
            assertOk(/start/i.test(idle), `the explanation must name the action: ${JSON.stringify(idle)}`);
            assertOk(await seen(frame, '[data-testid="run-start"]'), 'Start must still be offered');
            await shot(page, 'live-wizard-execute-idle');
        });
    } finally {
        await page.close();
    }
}
