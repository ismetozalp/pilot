#!/usr/bin/env node
// tools/pilot-wire.mjs — idempotent, verified wiring of a module into the
// skeleton-owned index.html and js/boot.js.
//
// Why this exists: C10 says only the OWNER creates a file, and everyone else
// extends it with an anchored edit. Round 2 broke twice on hand-written anchors —
// once by anchoring on a line a LATER task creates (so the edit aborted), once by
// a `sed` whose pattern never matched (so the edit silently did nothing).
//
// This tool has neither failure mode: it derives the insertion point from the C7
// order using whichever entries are actually present, it is a no-op when the wiring
// already exists, and it RE-READS the file afterwards and exits non-zero if the
// change did not take effect. It is a build-time script, not shipped plugin code,
// so it lives outside js/ and the smoke rules for js/** do not apply to it.

import fs from 'node:fs';
import path from 'node:path';

// C7 verbatim, plus js/features/theme-ui.js immediately after js/features/update.js.
const C7 = [
    'js/alpine.min.js', 'js/bootstrap.bundle.min.js',
    'js/core/errors.js', 'js/core/semver.js', 'js/core/themes.js', 'js/core/settings.js',
    'js/core/ostarget.js', 'js/core/ports.js', 'js/core/firewall.js', 'js/core/tls.js',
    'js/core/provision-plan.js', 'js/core/redact.js',
    'js/core/servers.js', 'js/core/api-io.js', 'js/core/api-client.js', 'js/core/addressbook.js',
    'js/core/emptystate.js',
    'js/features/update.js', 'js/features/theme-ui.js', 'js/features/setup-ui.js',
    'js/features/devices-ui.js', 'js/features/addressbook-ui.js',
    'js/features/users-ui.js', 'js/features/audit-ui.js',
    'js/features/server-ops-ui.js', 'js/features/overview.js',
    'js/app.js', 'js/boot.js'
];

function die(msg, code) {
    console.error('pilot-wire: ' + msg);
    process.exit(code === undefined ? 1 : code);
}

const args = process.argv.slice(2);
const ri = args.indexOf('--root');
let root = process.cwd();
if (ri !== -1) {
    if (!args[ri + 1]) die('--root needs a directory', 2);
    root = args[ri + 1];
    args.splice(ri, 2);
}
const cmd = args[0];
const target = args[1];
if (!cmd || !target || !['script', 'stylesheet', 'partial'].includes(cmd))
    die('usage: node tools/pilot-wire.mjs <script|stylesheet|partial> <path> [--root DIR]', 2);

const INDEX = path.join(root, 'index.html');
const BOOT = path.join(root, 'js', 'boot.js');
const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => fs.writeFileSync(p, s);

function indentAt(text, idx) {
    const start = text.lastIndexOf('\n', idx) + 1;
    const m = /^[ \t]*/.exec(text.slice(start, idx));
    return m ? m[0] : '';
}

function insertAfterLine(text, idx, line) {
    const nl = text.indexOf('\n', idx);
    const at = nl === -1 ? text.length : nl + 1;
    return text.slice(0, at) + line + '\n' + text.slice(at);
}

function insertBeforeLine(text, idx, line) {
    const start = text.lastIndexOf('\n', idx) + 1;
    return text.slice(0, start) + line + '\n' + text.slice(start);
}

function wireScript(src) {
    const i = C7.indexOf(src);
    if (i === -1) die(src + ' is not in the pinned C7 order');
    let html = read(INDEX);
    if (html.includes('src="' + src + '"')) {
        console.log('pilot-wire: index.html already loads ' + src);
        return;
    }
    const tag = '<script src="' + src + '"></script>';
    let idx = -1;
    let before = false;
    for (let k = i - 1; k >= 0 && idx === -1; k--) {
        const p = html.indexOf('src="' + C7[k] + '"');
        if (p !== -1) idx = p;
    }
    for (let k = i + 1; k < C7.length && idx === -1; k++) {
        const p = html.indexOf('src="' + C7[k] + '"');
        if (p !== -1) { idx = p; before = true; }
    }
    let out;
    if (idx === -1) {
        const b = html.lastIndexOf('</body>');
        if (b === -1) die('index.html has no </body> and no C7 script to anchor on');
        out = insertBeforeLine(html, b, '    ' + tag);
    } else {
        const ind = indentAt(html, idx);
        out = before ? insertBeforeLine(html, idx, ind + tag)
            : insertAfterLine(html, idx, ind + tag);
    }
    write(INDEX, out);

    const check = read(INDEX);
    if (!check.includes('src="' + src + '"'))
        die('inserting ' + src + ' into index.html did not take effect');
    const pos = C7.map((s) => check.indexOf('src="' + s + '"')).filter((p) => p !== -1);
    for (let k = 1; k < pos.length; k++)
        if (pos[k] < pos[k - 1]) die('index.html scripts are out of C7 order after inserting ' + src);
    console.log('pilot-wire: index.html now loads ' + src + ' in C7 order');
}

function wireStylesheet(href) {
    const html = read(INDEX);
    if (html.includes('href="' + href + '"')) {
        console.log('pilot-wire: index.html already links ' + href);
        return;
    }
    const tag = '<link rel="stylesheet" href="' + href + '">';
    const links = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)];
    let out;
    if (links.length) {
        const last = links[links.length - 1];
        out = insertAfterLine(html, last.index, indentAt(html, last.index) + tag);
    } else {
        const h = html.indexOf('</head>');
        if (h === -1) die('index.html has no </head> and no stylesheet link to anchor on');
        out = insertBeforeLine(html, h, '    ' + tag);
    }
    write(INDEX, out);
    if (!read(INDEX).includes('href="' + href + '"'))
        die('inserting the ' + href + ' link into index.html did not take effect');
    console.log('pilot-wire: index.html now links ' + href);
}

function wirePartial(p) {
    const js = read(BOOT);
    if (js.includes("'" + p + "'") || js.includes('"' + p + '"')) {
        console.log('pilot-wire: js/boot.js already injects ' + p);
        return;
    }
    const m = /PARTIALS\s*=\s*\[/.exec(js);
    if (!m) die('js/boot.js has no PARTIALS array literal — cannot register ' + p);
    const at = m.index + m[0].length;
    write(BOOT, js.slice(0, at) + "\n        '" + p + "'," + js.slice(at));
    if (!read(BOOT).includes("'" + p + "'"))
        die('registering ' + p + ' in js/boot.js did not take effect');
    console.log('pilot-wire: js/boot.js now injects ' + p);
}

if (cmd === 'script') wireScript(target);
else if (cmd === 'stylesheet') wireStylesheet(target);
else wirePartial(target);
