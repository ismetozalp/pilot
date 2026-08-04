// tests/e2e/live-csp.live.mjs -- the headline regression this whole tier exists
// to catch: a CSP violation that every stubbed test passes.
//
// tests/e2e.mjs's static server does not enforce manifest.json's
// content-security-policy at all. Real Cockpit does. Pilot's self-update design
// (js/features/update.js) exists BECAUSE `connect-src 'self'` blocks a raw
// fetch() to api.github.com -- if someone "simplifies" that back to fetch(),
// every stub test stays green and this is the only tier that notices, because
// only a real browser under a real CSP header produces the console message
// isCspViolation() matches.
//
// This scenario logs in, opens Pilot, visits every tab in turn (the update
// check and any per-tab data load are the most likely places a stray fetch/XHR
// would appear), and asserts the ENTIRE collected console transcript contains
// neither a CSP violation nor a pageerror. On failure it prints the offending
// message text so the cause is obvious -- credentials are redacted at the
// console-listener level in run-live.mjs, never here.
export const name = 'live-csp';

export default async function run(ctx) {
    const { browser, creds, check, assertEqual, login, openPilot, isCspViolation } = ctx;
    const page = await ctx.newPage(browser);

    try {
        await check('live-csp: log in, open Pilot, and visit every tab', async () => {
            await login(page, creds);
            const frame = await openPilot(page);
            await frame.waitForSelector('.pilot-shell', { state: 'visible', timeout: 15000 });
            const tabs = await frame.evaluate(() => {
                const app = window.PilotApp;
                return (app && Array.isArray(app.TABS)) ? app.TABS.map((t) => ({ id: t.id, mount: t.mount })) : [];
            });
            for (const t of tabs) {
                await frame.click(`[data-tab="${t.id}"]`, { timeout: 15000 });
                await frame.waitForSelector(`#${t.mount}`, { state: 'visible', timeout: 15000 });
            }
            // Also open the theme picker: the modal and its assets are exactly
            // the kind of lazily-shown surface a CSP regression likes to hide in.
            await frame.click('[data-tab="overview"]', { timeout: 15000 });
            await frame.click('[title="Change the colour theme"]', { timeout: 15000 });
            await frame.waitForSelector('#pilot-theme', { state: 'visible', timeout: 15000 });
        });

        await check('live-csp: no CSP violation in the browser console', async () => {
            const violations = page.consoleMessages.filter(isCspViolation);
            assertEqual(violations.length, 0,
                `expected zero CSP violations, got: ${JSON.stringify(violations)}`);
        });

        await check('live-csp: no pageerror was raised', async () => {
            assertEqual(page.pageErrors.length, 0,
                `expected zero pageerrors, got: ${JSON.stringify(page.pageErrors)}`);
        });
    } finally {
        await page.ctx.close();
    }
}
