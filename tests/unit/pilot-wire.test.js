// Unit tests for tools/pilot-wire.mjs — the only thing in this section that edits
// skeleton-owned files (index.html, js/boot.js).
//
// Round 2 lost a feature to a `sed` that matched nothing and exited 0. Every case
// here is therefore about the tool being idempotent, order-correct, and LOUD when
// it cannot do what it was asked.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TOOL = path.join(__dirname, '..', '..', 'tools', 'pilot-wire.mjs');

function sandbox(indexHtml, bootJs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-wire-'));
    fs.writeFileSync(path.join(dir, 'index.html'), indexHtml);
    fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'js', 'boot.js'), bootJs === undefined ? '' : bootJs);
    return dir;
}

function run(dir, args) {
    return execFileSync(process.execPath, [TOOL, ...args, '--root', dir],
        { encoding: 'utf8' });
}

function runFails(dir, args) {
    try {
        execFileSync(process.execPath, [TOOL, ...args, '--root', dir],
            { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
        return { status: e.status, stderr: String(e.stderr) };
    }
    throw new Error('expected pilot-wire to fail, but it succeeded');
}

const INDEX = [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '    <link rel="stylesheet" href="css/bootstrap.min.css">',
    '</head>',
    '<body>',
    '    <script src="../base1/cockpit.js"></script>',
    '    <script src="js/core/errors.js"></script>',
    '    <script src="js/features/setup-ui.js"></script>',
    '    <script src="js/app.js"></script>',
    '    <script src="js/boot.js"></script>',
    '</body>',
    '</html>',
    ''
].join('\n');

const BOOT = "(function () {\n    'use strict';\n    const PARTIALS = [];\n})();\n";

test('script inserts after the nearest preceding C7 module', () => {
    const dir = sandbox(INDEX, BOOT);
    run(dir, ['script', 'js/core/semver.js']);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.ok(html.includes('<script src="js/core/semver.js"></script>'));
    assert.ok(html.indexOf('js/core/errors.js') < html.indexOf('js/core/semver.js'));
    assert.ok(html.indexOf('js/core/semver.js') < html.indexOf('js/features/setup-ui.js'));
});

test('script inserts before the nearest following C7 module when nothing precedes it', () => {
    const bare = INDEX.replace('    <script src="js/core/errors.js"></script>\n', '');
    const dir = sandbox(bare, BOOT);
    run(dir, ['script', 'js/core/semver.js']);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.ok(html.indexOf('js/core/semver.js') < html.indexOf('js/features/setup-ui.js'));
});

test('script is idempotent — a second run changes nothing', () => {
    const dir = sandbox(INDEX, BOOT);
    run(dir, ['script', 'js/core/semver.js']);
    const once = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    run(dir, ['script', 'js/core/semver.js']);
    assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), once);
});

test('theme-ui.js is a known C7 entry and lands right after update.js', () => {
    const dir = sandbox(INDEX, BOOT);
    run(dir, ['script', 'js/features/update.js']);
    run(dir, ['script', 'js/features/theme-ui.js']);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.ok(html.indexOf('js/features/update.js') < html.indexOf('js/features/theme-ui.js'));
    assert.ok(html.indexOf('js/features/theme-ui.js') < html.indexOf('js/features/setup-ui.js'));
});

test('script refuses a path that is not in the C7 order', () => {
    const dir = sandbox(INDEX, BOOT);
    const r = runFails(dir, ['script', 'js/core/not-pinned.js']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not in the pinned C7 order/);
});

test('stylesheet inserts after the last existing stylesheet link', () => {
    const dir = sandbox(INDEX, BOOT);
    run(dir, ['stylesheet', 'css/themes.css']);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.ok(html.includes('<link rel="stylesheet" href="css/themes.css">'));
    assert.ok(html.indexOf('css/bootstrap.min.css') < html.indexOf('css/themes.css'));
    run(dir, ['stylesheet', 'css/themes.css']);
    assert.equal(
        (fs.readFileSync(path.join(dir, 'index.html'), 'utf8').match(/css\/themes\.css/g) || []).length,
        1);
});

test('partial registers into an empty PARTIALS array and stays idempotent', () => {
    const dir = sandbox(INDEX, BOOT);
    run(dir, ['partial', 'html/modals/update.html']);
    const js = fs.readFileSync(path.join(dir, 'js', 'boot.js'), 'utf8');
    assert.ok(js.includes("'html/modals/update.html'"));
    run(dir, ['partial', 'html/modals/update.html']);
    const twice = fs.readFileSync(path.join(dir, 'js', 'boot.js'), 'utf8');
    assert.equal((twice.match(/html\/modals\/update\.html/g) || []).length, 1);
});

test('partial registers into a non-empty PARTIALS array without losing entries', () => {
    const dir = sandbox(INDEX,
        "var PARTIALS = [\n    'html/modals/confirm.html'\n];\n");
    run(dir, ['partial', 'html/modals/theme.html']);
    const js = fs.readFileSync(path.join(dir, 'js', 'boot.js'), 'utf8');
    assert.ok(js.includes("'html/modals/confirm.html'"));
    assert.ok(js.includes("'html/modals/theme.html'"));
});

test('partial fails loudly rather than silently when there is no PARTIALS array', () => {
    // The exact round-2 defect: a no-op edit that exits 0 and drops the feature.
    const dir = sandbox(INDEX, "(function () { 'use strict'; })();\n");
    const r = runFails(dir, ['partial', 'html/modals/update.html']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no PARTIALS array/);
});

test('usage errors exit 2', () => {
    const dir = sandbox(INDEX, BOOT);
    assert.equal(runFails(dir, ['script']).status, 2);
    assert.equal(runFails(dir, ['nonsense', 'x']).status, 2);
});
