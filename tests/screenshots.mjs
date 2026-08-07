// tests/screenshots.mjs — the images in README.md.
//
// NOT a test. It drives the same stubbed harness the e2e tier uses, but poses a
// HEALTHY deployment rather than the failure states the tests deliberately
// provoke: the e2e captures are full of "not connected" banners and "Update
// check failed", which is correct for a test and useless as a screenshot.
//
// Every value here is fictional and stays fictional. The hostnames are
// example.com (RFC 2606), the addresses are RFC 5737 documentation ranges, and
// the device ids are obviously fake. Nothing is read from a real server, so a
// screenshot cannot leak one — which is the whole reason this file exists
// instead of cropping a live capture.
//
//   node tests/screenshots.mjs        # writes screenshots/*.png
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, open, launch } from './e2e.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'screenshots');

// ---------------------------------------------------------------- fixtures

const SERVER = {
    id: 'rd-example-com',
    host: 'rd.example.com',
    sshPort: 22,
    sshUser: 'admin',
    apiPort: 21114,
    tls: true,
    domain: 'rd.example.com',
    hbbsKey: 'K9tPqR3wXyZ2aB4cD6eF8gH0jL1mN5oP7qS9tU2vW4x=',
    hbbsPorts: [21115, 21116, 21117, 21118, 21119],
    installDir: '/opt/rustdesk-api',
    createdAt: '2026-08-01T09:00:00Z'
};

const DEVICES = [
    { row_id: 1, id: '183 927 461', alias: 'Reception desk', hostname: 'reception',
      platform: 'Windows', version: '1.4.9', last_online_ip: '198.51.100.14',
      last_online_time: 0, user_name: 'sam' },
    { row_id: 2, id: '470 118 235', alias: 'Workshop laptop', hostname: 'workshop',
      platform: 'Linux', version: '1.4.9', last_online_ip: '198.51.100.27',
      last_online_time: 0, user_name: 'sam' },
    { row_id: 3, id: '902 553 018', alias: 'Design iMac', hostname: 'studio',
      platform: 'Mac OS', version: '1.4.9', last_online_ip: '198.51.100.31',
      last_online_time: 0, user_name: 'ali' },
    { row_id: 4, id: '661 204 397', alias: 'Warehouse PC', hostname: 'warehouse',
      platform: 'Windows', version: '1.4.8', last_online_ip: '198.51.100.44',
      last_online_time: 1, user_name: 'ali' }
];

// Three online, one long offline — a believable estate rather than all-green.
function devicesNow() {
    const now = Math.floor(Date.now() / 1000);
    return DEVICES.map((d, i) => Object.assign({}, d,
        { last_online_time: i === 3 ? now - 7200 : now - (12 + i * 9) }));
}

const AB_PEERS = [
    { row_id: 1, id: '183 927 461', alias: 'Reception desk', hostname: 'reception',
      platform: 'Windows', tags: ['front-of-house'], username: 'sam' },
    { row_id: 2, id: '470 118 235', alias: 'Workshop laptop', hostname: 'workshop',
      platform: 'Linux', tags: ['field'], username: 'sam' },
    { row_id: 3, id: '902 553 018', alias: 'Design iMac', hostname: 'studio',
      platform: 'Mac OS', tags: ['studio'], username: 'ali' },
    { row_id: 4, id: '661 204 397', alias: 'Warehouse PC', hostname: 'warehouse',
      platform: 'Windows', tags: [], username: 'ali' }
];

const USERS = [
    { id: 1, username: 'admin', email: 'admin@example.com', is_admin: true, status: 1, group_id: 1 },
    { id: 2, username: 'sam', email: 'sam@example.com', is_admin: false, status: 1, group_id: 1 },
    { id: 3, username: 'ali', email: 'ali@example.com', is_admin: false, status: 1, group_id: 2 }
];

function auditRows() {
    const now = Math.floor(Date.now() / 1000);
    return [
        { id: 4, peer_id: '183 927 461', from_peer: '470 118 235', created_at: now - 240, close_time: now - 60 },
        { id: 3, peer_id: '902 553 018', from_peer: '183 927 461', created_at: now - 1800, close_time: now - 1500 },
        { id: 2, peer_id: '661 204 397', from_peer: '470 118 235', created_at: now - 5400, close_time: now - 5100 },
        { id: 1, peer_id: '470 118 235', from_peer: '902 553 018', created_at: now - 9000, close_time: now - 8880 }
    ];
}

const ok = (data) => ({ status: 200, body: { code: 0, msg: 'ok', data } });

function routes() {
    return {
        'GET /api/admin/peer/list': ok({ list: devicesNow(), total: 4, page: 1, page_size: 50 }),
        'POST /api/ab/personal': { status: 200, body: { guid: '1-1-0', name: 'admin', personal: true } },
        'POST /api/ab/shared/profiles': ok({ profiles: [] }),
        'POST /api/ab/peers': { status: 200, body: { data: AB_PEERS, total: 4 } },
        'POST /api/ab/tags/1-1-0': { status: 200,
            body: [{ id: 1, name: 'front-of-house' }, { id: 2, name: 'field' }, { id: 3, name: 'studio' }] },
        'GET /api/admin/user/list': ok({ list: USERS, total: 3, page: 1, page_size: 50 }),
        'GET /api/admin/group/list': ok({ list: [{ id: 1, name: 'Default group' }, { id: 2, name: 'Studio' }], total: 2 }),
        'GET /api/admin/audit_conn/list': ok({ list: auditRows(), total: 4, page: 1, page_size: 50 }),
        'GET /api/admin/audit_file/list': ok({ list: [], total: 0 }),
        'GET /api/admin/login_log/list': ok({ list: [], total: 0 }),
        'GET /api/peers': ok({ list: devicesNow(), total: 4 })
    };
}

// A registry with one healthy, TLS-enabled server, so no surface renders the
// "no server configured" or "not connected" empty states.
function stub() {
    const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
    const id = SERVER.id;
    const probeOk = { status: 200, body: { code: 0, msg: 'ok', data: {} } };
    return {
        files: {
            // activeServer, not "active" -- js/core/servers.js reads that key,
            // and getting it wrong renders every surface's "no server" state.
            '/etc/pilot/config.json': JSON.stringify({ activeServer: id }),
            ['/etc/pilot/servers/' + id + '.json']: JSON.stringify(SERVER),
            ['/etc/pilot/servers/' + id + '.token']: 'stub-token',
            ['/etc/pilot/servers/' + id + '.ssh']: 'pem:stub',
            '/etc/pilot/installed-version': version + '\n'
        },
        spawn: {
            // EXACTLY the argv js/core/servers.js's list() joins and runs. A
            // shorter key ('ls') matches nothing, the registry reads as empty,
            // and every screenshot shows the not-connected banner instead of
            // the surface it is meant to show.
            'find /etc/pilot/servers -maxdepth 1 -type f -name *.json':
                '/etc/pilot/servers/' + id + '.json\n',
            // Same version installed as published, so the header badge reads a
            // calm v<VERSION> rather than "Update check failed".
            'curl': JSON.stringify({ tag_name: 'v' + version, assets: [],
                published_at: '2026-08-07T00:00:00Z' })
        },
        // THE transport, once js/app.js's wireApi() has run. A useTransport()
        // call is overwritten by it, so the fixtures have to live here or every
        // surface renders its empty state over a connected server.
        http: Object.assign({
            // The advisory compatibility probe: answered so it leaves neither a
            // console error nor a warning strip across the top of every shot.
            'GET /admin/swagger/doc.json': { status: 404, body: '404 page not found' },
            'GET /api/currentUser': probeOk
        }, routes())
    };
}

const SHOTS = [
    { tab: 'overview',    file: 'overview.png' },
    { tab: 'devices',     file: 'devices.png' },
    { tab: 'addressbook', file: 'address-book.png' },
    { tab: 'users',       file: 'users.png' },
    { tab: 'audit',       file: 'audit.png' },
    { tab: 'server-ops',  file: 'server-ops.png' },
    { tab: 'settings',    file: 'settings.png' },
    { tab: 'setup',       file: 'setup.png' }
];

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const server = await serve(ROOT);
    const browser = await launch();
    const page = await open(browser, stub());
    await page.waitForTimeout(3000);

    for (const shot of SHOTS) {
        await page.evaluate((id) => {
            const shell = document.querySelector('.pilot-shell');
            const d = shell && shell._x_dataStack ? shell._x_dataStack[0] : null;
            if (d) d.selectTab(id);
        }, shot.tab);
        await page.waitForTimeout(1800);
        const target = path.join(OUT, shot.file);
        await page.screenshot({ path: target });
        console.log('  wrote screenshots/' + shot.file);
    }

    await browser.close();
    await server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
