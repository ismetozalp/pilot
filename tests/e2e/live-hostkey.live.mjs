// tests/e2e/live-hostkey.live.mjs -- the host-key step under a REAL Cockpit,
// where the privileged helper genuinely may not be installed.
//
// This scenario exists because of a defect found by hand on a real first run,
// which 1452 unit tests, 106 integration tests, 8 smoke rules and 10 stubbed
// e2e scenarios all missed -- every one of them supplies a working spawn.
//
// What the user saw: an empty bordered box, an enabled "This fingerprint is
// correct" button beneath it, and in red, as the entire explanation, the word
//
//     not-found
//
// Two separate defects, both only reachable when cockpit.spawn REJECTS:
//
//   1. 'not-found' is Cockpit's channel problem TOKEN. cockpit.spawn() sets
//      .message to that same token when the process wrote no stderr of its own
//      -- and the pane rendered .message verbatim. The real meaning is
//      "/usr/libexec/pilot/pilot-exec does not exist", i.e. `sudo make install`
//      has never been run: dropping in or symlinking the plugin directory
//      installs the web assets but NOT the privileged helper, which has to live
//      at a root-owned path. That is the single most likely first-run failure
//      there is, and it read as gibberish.
//
//   2. The fingerprint box and its Accept button rendered with no fingerprint
//      to show -- an empty control, which spec 7.3 forbids outright. Worse than
//      empty: "This fingerprint is correct" was clickable over nothing.
//
// The stubbed tier cannot catch either one, because tests/e2e/cockpit-stub.js
// answers every scripted spawn and rejects unscripted ones with problem
// 'no-stub' -- a token this table has no entry for, and one a real bridge never
// emits. Only a real Cockpit bridge produces a real 'not-found'.
//
// This scenario is therefore written to pass BOTH WAYS, because whether the
// helper is installed is a property of the machine, not of the code:
//   - helper absent  -> no empty box, no Accept button, and the error is a
//                       sentence that names the fix, never a bare token.
//   - helper present -> a real fingerprint, and the Accept button appears.
// What it never tolerates is an empty control or a machine token on screen.
export const name = 'live-hostkey';

// Every Cockpit channel problem code that could plausibly surface here. If any
// of these is what the user reads, something rendered a token.
const TOKENS = [
    'not-found', 'access-denied', 'authentication-failed', 'not-supported',
    'no-cockpit', 'terminated', 'disconnected', 'internal-error', 'timeout',
    'protocol-error', 'no-host', 'unknown-host', 'unknown-hostkey'
];

export default async function run(ctx) {
    const { browser, creds, check, assertOk, login, openPilot, shot } = ctx;
    const page = await ctx.newPage(browser);

    try {
        await check('live-hostkey: a remote target with no helper never shows an empty control ' +
            'or a raw problem token', async () => {
            await login(page, creds);
            const frame = await openPilot(page);
            await frame.waitForSelector('.pilot-shell', { state: 'visible', timeout: 15000 });
            await frame.click('[data-tab="setup"]', { timeout: 15000 });

            // A remote target is what makes the host-key step visible at all --
            // visibleSteps() hides it for localhost.
            await frame.selectOption('[data-testid="target"]', 'ssh', { timeout: 15000 });
            await frame.fill('[data-testid="host"]', 'example.invalid', { timeout: 15000 });
            await frame.click('[data-testid="next"]', { timeout: 15000 });
            await frame.waitForSelector('[data-testid="pane-hostkey"]', { state: 'visible', timeout: 15000 });

            // next() fires checkHostKey() as deliberate fire-and-forget, so wait
            // for it to settle rather than racing the spawn.
            await frame.waitForFunction(
                () => { const el = document.querySelector('[data-testid="hostkey-checking"]');
                    return !el || el.offsetParent === null; },
                null, { timeout: 20000 });

            const seen = async (sel) => {
                const el = await frame.$(sel);
                return el ? await el.isVisible() : false;
            };
            const textOf = async (sel) => {
                const el = await frame.$(sel);
                if (!el || !(await el.isVisible())) return '';
                return ((await el.textContent()) || '').trim();
            };

            const fpShown = await seen('[data-testid="fingerprint"]');
            const acceptShown = await seen('[data-testid="accept-hostkey"]');
            const fp = await textOf('[data-testid="fingerprint"]');
            const err = await textOf('[data-testid="hostkey-check-error"]');
            const hard = await textOf('[data-testid="hostkey-hardstop"]');
            console.log(`      helper reachable: ${fpShown ? 'yes' : 'no'}` +
                (err ? ` | error: ${JSON.stringify(err)}` : ''));

            // 7.3, in both worlds: a visible box always has something in it.
            assertOk(!fpShown || fp.length > 0,
                'the fingerprint box is visible but empty -- an empty control is never acceptable');
            assertOk(!acceptShown || fp.length > 0,
                '"This fingerprint is correct" is offered with no fingerprint to confirm');
            assertOk(fpShown === acceptShown,
                'the box and its Accept button must appear and disappear together');

            // And whatever is on screen is prose, never a machine token.
            for (const shown of [err, hard]) {
                if (!shown) continue;
                assertOk(!TOKENS.includes(shown.toLowerCase()),
                    `a raw Cockpit problem token reached the screen: ${JSON.stringify(shown)}`);
                assertOk(shown.length > 20 && /\s/.test(shown),
                    `the explanation must be a sentence, not a token: ${JSON.stringify(shown)}`);
            }

            // With no fingerprint there must still be SOMETHING telling the user
            // why -- a blank pane is the original defect in a different costume.
            assertOk(fpShown || err.length > 0 || hard.length > 0,
                'no fingerprint and no explanation: the pane is silently stuck');

            // The specific first-run case, asserted only when it is the one that
            // actually happened on this machine.
            if (/not installed/i.test(err))
                assertOk(/make install/.test(err),
                    'the missing-helper message must name the command that fixes it');

            await shot(page, 'live-hostkey');
        });
    } finally {
        await page.close();
    }
}
