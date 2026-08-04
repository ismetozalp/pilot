// tests/e2e/live-smoke.live.mjs -- Pilot driven inside a REAL, installed
// Cockpit at https://localhost:9090, not tests/e2e.mjs's stubbed harness.
//
// Run by tests/e2e/run-live.mjs (`npm run test:live`), gated on PILOT_LIVE=1.
// This scenario proves the things the stub literally cannot: that Pilot shows
// up in the real nav (a wrong manifest.json would leave it missing), that the
// plugin loads at all under the real base1/cockpit.js bridge, that every tab
// renders, and that the theme picker restyles a real, unstubbed page.
//
// Every step below carries an explicit timeout via ctx helpers; there is no
// unbounded wait in this file.
export const name = 'live-smoke';

export default async function run(ctx) {
    const { browser, creds, check, assertOk, assertEqual, login, openPilot, shot } = ctx;
    const page = await ctx.newPage(browser);
    let frame = null;

    try {
        await check('live-smoke: log in and reach the Cockpit shell', async () => {
            await login(page, creds);
            await shot(page, 'shell');
        });

        await check('live-smoke: Pilot appears in the navigation (catches a wrong manifest.json)', async () => {
            const navLink = page.locator('#host-apps a[href="/pilot"]');
            await navLink.waitFor({ state: 'visible', timeout: 15000 });
            assertEqual(await navLink.count(), 1, 'expected exactly one Pilot nav entry');
        });

        await check('live-smoke: opening Pilot renders its root element', async () => {
            frame = await openPilot(page);
            await frame.waitForSelector('.pilot-shell', { state: 'visible', timeout: 15000 });
            await shot(page, 'pilot-root');
        });

        let tabs = [];
        await check('live-smoke: every tab renders without throwing', async () => {
            assertOk(!!frame, 'Pilot frame must be open before its tabs can be exercised');
            tabs = await frame.evaluate(() => {
                const app = window.PilotApp;
                return (app && Array.isArray(app.TABS)) ? app.TABS.map((t) => ({ id: t.id, mount: t.mount })) : [];
            });
            assertOk(tabs.length > 0, 'window.PilotApp.TABS must not be empty');
            for (const t of tabs) {
                await frame.click(`[data-tab="${t.id}"]`, { timeout: 15000 });
                await frame.waitForSelector(`#${t.mount}`, { state: 'visible', timeout: 15000 });
                await shot(page, `tab-${t.id}`);
            }
            assertEqual(page.pageErrors.length, 0,
                `no pageerror while exercising every tab, got: ${page.pageErrors.join('; ')}`);
        });

        // This check used to hardcode "Nord" AND the tier had no cleanup, so the
        // run wrote theme:"nord" to the real ~/.config/cockpit/pilot/settings.json
        // and the NEXT run started already on Nord: before === after, and the
        // check failed forever after passing exactly once on a fresh machine. It
        // was self-poisoning, not flaky. The fix is in two places: run-live.mjs
        // now snapshots and restores that file in a finally, and this check picks
        // a theme that is genuinely DIFFERENT from whatever is currently applied,
        // chosen from the palette the page itself offers. The assertion is
        // unchanged and deliberately so — a theme switch changing a real computed
        // style is the whole point of the check.
        await check('live-smoke: the theme picker restyles the real page', async () => {
            assertOk(!!frame, 'Pilot frame must be open before the theme picker can be exercised');
            await frame.click('[data-tab="overview"]', { timeout: 15000 });
            await frame.waitForSelector('[title="Change the colour theme"]', { state: 'visible', timeout: 15000 });

            // Which theme to switch TO is decided from the page's own state:
            // the currently applied theme's base (light/dark) picks the opposite
            // one, so the two palettes are guaranteed to differ whatever the
            // developer's settings happen to say today.
            const target = await frame.evaluate(() => {
                const applied = document.documentElement.getAttribute('data-bs-theme') || '';
                const themes = (window.PilotThemes && window.PilotThemes.THEMES) || [];
                const current = themes.filter((t) => t.id === applied)[0] || null;
                const base = current ? current.base : null;
                const wantDark = base !== 'dark';
                const pick = themes.filter((t) => t.id !== applied && t.base === (wantDark ? 'dark' : 'light'))[0];
                return pick ? { id: pick.id, label: pick.label, from: applied } : null;
            });
            assertOk(!!target, 'the theme registry must offer a theme different from the applied one');

            const before = await frame.evaluate(() => getComputedStyle(document.body).backgroundColor);
            await frame.click('[title="Change the colour theme"]', { timeout: 15000 });
            await frame.waitForSelector('#pilot-theme', { state: 'visible', timeout: 15000 });
            await frame.click(`#pilot-theme button:has-text("${target.label}")`, { timeout: 15000 });
            await frame.waitForFunction(
                (id) => document.documentElement.getAttribute('data-bs-theme') === id,
                target.id, { timeout: 15000 });
            const after = await frame.evaluate(() => getComputedStyle(document.body).backgroundColor);
            assertOk(after !== before,
                'a theme switch must change a real computed style, not just the attribute ' +
                `(${target.from || 'none'} -> ${target.id}: before=${before} after=${after})`);
            await shot(page, `theme-${target.id}`);
        });
    } finally {
        await page.ctx.close();
    }
}
