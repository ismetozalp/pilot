// tests/e2e/theme.e2e.mjs -- the theme picker driven in a real browser.
//
// Unit tests already prove that PilotThemeUi.apply() delegates entirely to
// PilotThemes.resolve() and writes data-bs-theme/data-pl-theme onto a fake
// document. What only a real browser can prove is that clicking a theme button
// really restyles the rendered page: that css/themes.css actually loads, that the
// attribute selectors in it actually match <html data-bs-theme="...">, and that a
// real computed style (not just the attribute) follows. The theme picker's
// x-init runs on load regardless of whether the modal is ever opened, so the very
// first check below is that the default (system) render already carries a
// data-bs-theme -- no click required.
//
// window.cockpit.user() in cockpit-stub.js resolves { name: 'root', id: 0 } with
// no `home` field, so js/core/settings.js's real read() catches the resulting
// "no home directory" error and quietly returns its defaults (system) -- this
// scenario deliberately does not assert persistence through the real settings
// file for that reason; that degrade-to-in-memory path is covered at the unit
// level (adaptStore, setTheme still applies when persistence fails). This
// scenario is only about restyling: the DOM attribute and a real computed style,
// per theme, with a screenshot.
//
// Task 31 taught cockpit-stub.js's user() to merge a scenario-supplied `home`
// (tests/e2e/cockpit-stub.js), so the last check below opens the page with
// { user: { home: '/root' } } and asserts the OTHER half: that choosing a theme
// really round-trips through js/core/settings.js's home()/write()/read(), not
// just through the in-memory Alpine component.
//
// Every wait carries an explicit, short timeout: a selector that never appears
// is a bug to report in seconds, not a hang.
//
//   node tests/e2e/theme.e2e.mjs
import { isMain, runScenario } from '../e2e.mjs';

export const name = 'theme';

const WAIT = 5000;

// Every registry id (spec 11.1) plus its expected resolved attr with the OS
// preference forced to light (system/light/dark/sepia -> 'light', everything
// else -> its own id -- see js/core/themes.js). Kept in lockstep with the
// registry via the page's own window.PilotThemes rather than duplicated here,
// so this scenario cannot silently drift from Task 28's registry.
async function openThemePicker(ctx) {
    const page = await ctx.open(ctx.browser, {});
    page.setDefaultTimeout(WAIT);
    await page.waitForFunction(
        () => !!window.PilotThemeUi && !!window.PilotThemes,
        null, { timeout: WAIT });
    // x-init="initTheme(...)" is async; wait for the attribute it writes rather
    // than an arbitrary tick.
    await page.waitForFunction(
        () => document.documentElement.hasAttribute('data-bs-theme'),
        null, { timeout: WAIT });
    return page;
}

async function themeIds(page) {
    return page.evaluate(() => window.PilotThemes.ids());
}

async function domAttrs(page) {
    return page.evaluate(() => ({
        bs: document.documentElement.getAttribute('data-bs-theme'),
        pl: document.documentElement.getAttribute('data-pl-theme')
    }));
}

async function bodyBg(page) {
    return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

export default async function run(ctx) {
    const { check, assertEqual, assertOk, assertMatch, shot } = ctx;

    await check('theme: the default render already carries a resolved data-bs-theme with no click', async () => {
        const page = await openThemePicker(ctx);
        try {
            const attrs = await domAttrs(page);
            assertOk(attrs.bs === 'light' || attrs.bs === 'dark',
                `data-bs-theme should resolve to light or dark, got ${JSON.stringify(attrs.bs)}`);
            assertEqual(attrs.pl, 'system', 'the chosen id defaults to system');
        } finally {
            await page.ctx.close();
        }
    });

    await check('theme: opening the picker and choosing a custom theme restyles the page for real', async () => {
        const page = await openThemePicker(ctx);
        try {
            const before = await bodyBg(page);
            await page.click('[title="Change the colour theme"]');
            await page.waitForSelector('#pilot-theme', { state: 'visible', timeout: WAIT });
            const nordBtn = page.locator('#pilot-theme button', { hasText: 'Nord' });
            await nordBtn.waitFor({ state: 'visible', timeout: WAIT });
            await nordBtn.click();
            await page.waitForFunction(
                () => document.documentElement.getAttribute('data-bs-theme') === 'nord',
                null, { timeout: WAIT });
            const attrs = await domAttrs(page);
            assertEqual(attrs.bs, 'nord', 'data-bs-theme after choosing Nord');
            assertEqual(attrs.pl, 'nord', 'data-pl-theme after choosing Nord');
            const after = await bodyBg(page);
            assertOk(after !== before,
                `a theme switch must change a real computed style, not just the attribute (before=${before} after=${after})`);
            // Nord is a dark palette (js/core/themes.js): its body background is a
            // near-black teal, definitely not Bootstrap's default white/near-white.
            assertMatch(after, /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/, 'a real rgb(a) colour was computed');
            await shot(page, 'theme-nord');
        } finally {
            await page.ctx.close();
        }
    });

    await check('theme: every registry theme applies its own resolved attr and a screenshot is taken for each', async () => {
        const page = await openThemePicker(ctx);
        try {
            const ids = await themeIds(page);
            assertOk(ids.length === 13, `expected 13 registry themes, got ${ids.length}`);
            await page.click('[title="Change the colour theme"]');
            await page.waitForSelector('#pilot-theme', { state: 'visible', timeout: WAIT });

            const seenBg = new Set();
            for (const id of ids) {
                await page.evaluate((themeId) => {
                    const root = document.querySelector('[x-data^="pilotThemeUi"]');
                    const alpine = window.Alpine && window.Alpine.$data ? window.Alpine.$data(root) : null;
                    if (alpine) alpine.setTheme(themeId);
                }, id);
                await page.waitForFunction(
                    (themeId) => document.documentElement.getAttribute('data-pl-theme') === themeId,
                    id, { timeout: WAIT });
                const attrs = await domAttrs(page);
                const expectedAttr = await page.evaluate(
                    (themeId) => window.PilotThemes.resolve(themeId, false).attr, id);
                assertEqual(attrs.bs, expectedAttr, `data-bs-theme for ${id}`);
                assertEqual(attrs.pl, id, `data-pl-theme for ${id}`);
                seenBg.add(await bodyBg(page));
                await shot(page, `theme-${id}`);
            }
            // The 13 registry themes are not all visually identical -- at minimum
            // light-based and dark-based palettes must compute different body
            // backgrounds, not the same colour thirteen times over.
            assertOk(seenBg.size > 1,
                `expected more than one distinct computed background across ${ids.length} themes, got ${seenBg.size}`);
        } finally {
            await page.ctx.close();
        }
    });

    await check('theme: choosing "System" stops following an earlier explicit choice and re-resolves from the OS preference', async () => {
        const page = await openThemePicker(ctx);
        try {
            await page.click('[title="Change the colour theme"]');
            await page.waitForSelector('#pilot-theme', { state: 'visible', timeout: WAIT });
            const sepiaBtn = page.locator('#pilot-theme button', { hasText: 'Sepia' });
            await sepiaBtn.waitFor({ state: 'visible', timeout: WAIT });
            await sepiaBtn.click();
            await page.waitForFunction(
                () => document.documentElement.getAttribute('data-pl-theme') === 'sepia',
                null, { timeout: WAIT });
            const systemBtn = page.locator('#pilot-theme button', { hasText: 'System' });
            await systemBtn.click();
            await page.waitForFunction(
                () => document.documentElement.getAttribute('data-pl-theme') === 'system',
                null, { timeout: WAIT });
            const attrs = await domAttrs(page);
            assertOk(attrs.bs === 'light' || attrs.bs === 'dark',
                'data-bs-theme after returning to System must resolve to light or dark');
        } finally {
            await page.ctx.close();
        }
    });

    await check('theme: choosing a theme persists through the real js/core/settings.js, not just in memory', async () => {
        // A scripted home is what makes this checkable at all -- see the note at
        // the top of this file and the anchored fix in cockpit-stub.js's user().
        const SETTINGS_PATH = '/root/.config/cockpit/pilot/settings.json';
        const page = await ctx.open(ctx.browser, { user: { home: '/root' } });
        page.setDefaultTimeout(WAIT);
        try {
            await page.waitForFunction(
                () => !!window.PilotThemeUi && !!window.PilotThemes && !!window.PilotSettings,
                null, { timeout: WAIT });
            await page.waitForFunction(
                () => document.documentElement.hasAttribute('data-bs-theme'),
                null, { timeout: WAIT });
            await page.click('[title="Change the colour theme"]');
            await page.waitForSelector('#pilot-theme', { state: 'visible', timeout: WAIT });
            const nordBtn = page.locator('#pilot-theme button', { hasText: 'Nord' });
            await nordBtn.waitFor({ state: 'visible', timeout: WAIT });
            await nordBtn.click();
            await page.waitForFunction(
                () => document.documentElement.getAttribute('data-pl-theme') === 'nord',
                null, { timeout: WAIT });
            // setTheme() awaits the store write before Alpine settles, but wait on
            // the stub's own file table -- the fact actually being asserted --
            // rather than an arbitrary tick.
            await page.waitForFunction(
                (path) => {
                    const raw = window.__pilotStub && window.__pilotStub.files &&
                        window.__pilotStub.files[path];
                    return typeof raw === 'string' && raw.indexOf('"nord"') !== -1;
                },
                SETTINGS_PATH, { timeout: WAIT });

            const persisted = await page.evaluate((path) => {
                const raw = window.__pilotStub.files[path];
                return window.PilotSettings.parse(raw);
            }, SETTINGS_PATH);
            assertEqual(persisted.ui.theme, 'nord',
                `the real settings file at ${SETTINGS_PATH} must contain the chosen theme`);

            // The round trip: read it back through the real read()/home() path
            // (a fresh call, not the in-memory `theme` field) and confirm it
            // resolves the same value that was written.
            const reread = await page.evaluate(() => window.PilotSettings.read());
            assertEqual(reread.ui.theme, 'nord',
                'PilotSettings.read() must resolve the theme that was just persisted');
            await shot(page, 'theme-persist-roundtrip');
        } finally {
            await page.ctx.close();
        }
    });
}

if (isMain(import.meta.url)) process.exit(await runScenario(run, name) ? 1 : 0);
