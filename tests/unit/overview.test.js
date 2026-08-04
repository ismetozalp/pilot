// Unit tests for js/features/overview.js — the landing screen: which server we
// are looking at, how many of its devices are online, and whether the web client
// can be opened at all.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const O = require('../../js/features/overview.js');
const D = require('../../js/features/devices-ui.js');
const Errors = require('../../js/core/errors.js');

const ROOT = path.join(__dirname, '..', '..');
const NOW = Date.UTC(2026, 7, 3, 12, 0, 0);
const PROTO_KEYS = ['__proto__', 'toString', 'constructor', 'valueOf', 'hasOwnProperty'];

function payload(list) {
    return { code: 0, message: '', data:
        { list, page: 1, total: list.length, page_size: 50 } };
}

const ALPHA = { id: 'alpha', name: 'Head office', domain: 'rd.example.com', tlsTier: 'own' };
const BETA = { id: 'beta', name: 'Lab', domain: '', tlsTier: 'none' };

// --- module shape --------------------------------------------------------

test('module loads with no DOM and no cockpit global', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof O.pilotOverview, 'function');
    assert.equal(typeof globalThis.pilotOverview, 'function');
    assert.equal(O.MOUNT_ID, 'pilot-overview');
    assert.equal(O.WIZARD_EVENT, 'pilot:open-wizard');
});

test('the module never touches cockpit and never builds an API URL (C12)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'js/features/overview.js'), 'utf8');
    assert.ok(!/cockpit\./.test(src));
    // The only URL this screen forms is the web client's own https:// address.
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    const urls = code.match(/'https?:\/\//g) || [];
    assert.equal(urls.length, 1, 'exactly one URL literal: the web client scheme');
});

test('index.html loads overview.js after devices-ui.js and before js/app.js', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.includes('js/features/overview.js'));
    assert.ok(srcs.indexOf('js/features/devices-ui.js') < srcs.indexOf('js/features/overview.js'));
    assert.ok(srcs.indexOf('js/features/overview.js') < srcs.indexOf('js/app.js'));
});

// --- validDomain ---------------------------------------------------------

test('validDomain: accepts real host names, case- and trailing-dot-insensitively', () => {
    for (const d of ['rd.example.com', 'RD.Example.COM', 'rd.example.com.',
        'a-b.co.uk', 'x1.y2.z3.example.org', 'sub.203-0-113-10.sslip.io'])
        assert.equal(O.validDomain(d), true, d);
});

test('validDomain: a bare IP address is not a domain — it cannot be certificated', () => {
    // C17: a bare IP gets no /ws/* path and no TLS at all.
    for (const d of ['203.0.113.10', '10.0.0.1', '192.168.1.1'])
        assert.equal(O.validDomain(d), false, d);
});

test('validDomain: rejects hostile and unusable values', () => {
    for (const bad of ['', '   ', 'localhost', 'example', '.com', 'a..b.com',
        '-lead.example.com', 'trail-.example.com', 'a\x0bb.com', 'a\nb.com',
        'exam ple.com', 'rd.example.com:443', 'https://rd.example.com',
        'user@rd.example.com', '../etc/passwd', 'münchen.de',
        ('a'.repeat(64) + '.example.com'), ('a.'.repeat(130) + 'com'),
        null, undefined, 7, {}, [], true])
        assert.equal(O.validDomain(bad), false, JSON.stringify(bad));
    for (const k of PROTO_KEYS) assert.equal(O.validDomain(k), false, k);
});

// --- normTier ------------------------------------------------------------

test('normTier: reads every recorded shape and defaults to none', () => {
    assert.equal(O.normTier({ tlsTier: 'own' }), 'own');
    assert.equal(O.normTier({ tls_tier: 'duckdns' }), 'duckdns');
    assert.equal(O.normTier({ tls: { tier: 'sslip' } }), 'sslip');
    assert.equal(O.normTier({ tls: true }), 'own');
    assert.equal(O.normTier({ tls: false }), 'none');
    assert.equal(O.normTier({ tlsTier: 'OWN' }), 'own');
    for (const bad of [null, undefined, {}, 'x', 7, [], { tlsTier: 'wildcard' },
        { tlsTier: '__proto__' }, { tlsTier: 7 }])
        assert.equal(O.normTier(bad), 'none', JSON.stringify(bad));
});

// --- webClientLink -------------------------------------------------------

test('webClientLink: TLS plus a domain gives a port-less https address', () => {
    const w = O.webClientLink(ALPHA);
    assert.equal(w.enabled, true);
    // C17: Caddy listens on 443 because the client appends no port.
    assert.equal(w.url, 'https://rd.example.com/');
    assert.equal(w.action, 'open');
    assert.equal(w.reason, '');
});

test('webClientLink: every TLS tier that produces a certificate enables the link', () => {
    for (const tier of ['own', 'sslip', 'duckdns']) {
        const w = O.webClientLink({ id: 'a', domain: 'rd.example.com', tlsTier: tier });
        assert.equal(w.enabled, true, tier);
        assert.equal(w.url, 'https://rd.example.com/', tier);
    }
});

test('webClientLink: no TLS is disabled with the exact reason and a route to the wizard', () => {
    const w = O.webClientLink(BETA);
    assert.equal(w.enabled, false);
    assert.equal(w.url, null);
    assert.equal(w.reason, O.REASON.noTls);
    assert.equal(w.action, 'wizard-tls');
    assert.ok(w.reason.length > 0);
});

test('webClientLink: TLS with no domain and TLS with a broken domain say different things', () => {
    assert.equal(O.webClientLink({ tlsTier: 'own', domain: '' }).reason, O.REASON.noDomain);
    assert.equal(O.webClientLink({ tlsTier: 'own', domain: '203.0.113.10' }).reason, O.REASON.badDomain);
    assert.equal(O.webClientLink({ tlsTier: 'own', domain: 'a\x0bb.com' }).reason, O.REASON.badDomain);
    assert.notEqual(O.REASON.noDomain, O.REASON.badDomain);
    assert.notEqual(O.REASON.noTls, O.REASON.noDomain);
});

test('webClientLink: the domain may live under tls.domain', () => {
    const w = O.webClientLink({ id: 'a', tls: { tier: 'own', domain: 'rd.example.com' } });
    assert.equal(w.enabled, true);
    assert.equal(w.url, 'https://rd.example.com/');
});

test('webClientLink: hostile servers are disabled, never enabled with a broken URL', () => {
    for (const bad of [null, undefined, '', 7, [], {}, true, Object.create(null),
        { tlsTier: 'own', domain: 'https://evil.example/#' },
        { tlsTier: 'own', domain: 'rd.example.com/../admin' },
        { tlsTier: 'own', domain: 'rd.example.com:8443' },
        { tlsTier: 'own', domain: 'rd.example.com\nSet-Cookie: x' }]) {
        const w = O.webClientLink(bad);
        assert.equal(w.enabled, false, JSON.stringify(bad));
        assert.equal(w.url, null, JSON.stringify(bad));
        assert.equal(w.action, 'wizard-tls', JSON.stringify(bad));
        assert.ok(w.reason.length > 0, JSON.stringify(bad));
    }
});

test('webClientLink: a bare IPv6 address is not a domain either — badDomain, never enabled', () => {
    for (const d of ['2001:db8::1', '::1', 'fe80::1%eth0', '[2001:db8::1]']) {
        const w = O.webClientLink({ tlsTier: 'own', domain: d });
        assert.equal(w.enabled, false, d);
        assert.equal(w.url, null, d);
        assert.equal(w.reason, O.REASON.badDomain, d);
        assert.equal(w.action, 'wizard-tls', d);
    }
});

test('webClientLink: script markup, unicode and a very long domain are all badDomain, never rendered raw', () => {
    const cases = [
        '<script>alert(1)</script>.example.com',
        'javascript:alert(1)',
        'münchen.de',
        '例え.jp',
        ('a.'.repeat(200) + 'com')
    ];
    for (const d of cases) {
        const w = O.webClientLink({ tlsTier: 'own', domain: d });
        assert.equal(w.enabled, false, d);
        assert.equal(w.url, null, d);
        assert.equal(w.reason, O.REASON.badDomain, d);
        assert.ok(!/</.test(w.reason), 'the reason is a fixed sentence, never an echo of the input');
    }
});

test('webClientLink: an enabled URL never carries a port, a path or a query', () => {
    const w = O.webClientLink({ tlsTier: 'own', domain: 'RD.Example.COM.' });
    assert.equal(w.url, 'https://rd.example.com/');
    assert.ok(!/:\d/.test(w.url.slice('https://'.length)));
    assert.equal(w.url.split('/').length, 4);
});

// --- normalizeServers ----------------------------------------------------

test('normalizeServers: accepts records and bare ids, and de-duplicates', () => {
    const rows = O.normalizeServers([ALPHA, 'gamma', ALPHA, { id: 'delta' }]);
    assert.deepEqual(rows.map((r) => r.id), ['alpha', 'gamma', 'delta']);
    assert.equal(rows[0].name, 'Head office');
    assert.equal(rows[1].name, 'gamma', 'a bare id is its own label');
    assert.equal(rows[2].tlsTier, 'none');
});

test('normalizeServers: entries with no id are dropped — they cannot be switched to', () => {
    assert.deepEqual(O.normalizeServers([{ name: 'nameless' }, '', '   ', null, 7, [], {}]), []);
});

test('normalizeServers: hostile input is an empty list, never a throw', () => {
    for (const bad of [null, undefined, 'alpha', 7, {}, true])
        assert.deepEqual(O.normalizeServers(bad), [], String(bad));
});

// --- the wizard hand-off -------------------------------------------------

test('openWizardTls dispatches the TLS step for the active server', () => {
    assert.deepEqual(O.wizardDetail('alpha'), { step: 'tls', serverId: 'alpha' });
    assert.deepEqual(O.wizardDetail(null), { step: 'tls', serverId: 'local' });
    const fired = [];
    const target = { dispatchEvent: (ev) => { fired.push(ev); return true; } };
    const had = typeof globalThis.CustomEvent === 'function';
    if (!had) globalThis.CustomEvent = function (n, o) { this.type = n; this.detail = o && o.detail; };
    try {
        assert.equal(O.openWizardTls('alpha', target), true);
        assert.equal(fired[0].type, 'pilot:open-wizard');
        assert.deepEqual(fired[0].detail, { step: 'tls', serverId: 'alpha' });
        assert.equal(O.openWizardTls('alpha', {}), false);
        assert.equal(O.openWizardTls('alpha', null), false);
    } finally { if (!had) delete globalThis.CustomEvent; }
});

// --- the component -------------------------------------------------------

const DEVICES = [
    { id: '1', alias: 'a', online: true, last_online: 1754222400 },
    { id: '2', alias: 'b', online: false, last_online: 1754136000 },
    { id: '3', alias: 'c', online: true, last_online: 1754222401 }
];
const BETA_DEVICES = [{ id: '9', alias: 'lab-1', online: false, last_online: 1754136000 }];

function fakeApi(perServer) {
    const calls = [];
    let which = 'alpha';
    return {
        calls,
        use: (id) => { which = id; },
        devices: {
            list: async (q) => { calls.push([which, q]); return payload(perServer[which] || []); }
        }
    };
}

function fakeRegistry(over) {
    const o = over || {};
    const state = { active: o.initialActive === undefined ? 'alpha' : o.initialActive };
    const seen = [];
    return {
        seen,
        state,
        list: o.list || (async () => [ALPHA, BETA]),
        active: o.active === null ? undefined : (o.active || (async () => state.active)),
        setActive: o.setActive === null ? undefined
            : (o.setActive || (async (id) => { seen.push(id); state.active = id; }))
    };
}

function component(over) {
    const o = over || {};
    // Mirrors the registry override just below: `api: null` must mean "really no
    // API client", not "unspecified" — a plain `o.api || fakeApi(...)` would treat
    // an explicit null the same as an absent key and silently substitute a working
    // fake, which is exactly the "no API client" test below needs to NOT happen.
    const api = o.api === null ? null : (o.api || fakeApi({ alpha: DEVICES, beta: BETA_DEVICES }));
    const c = O.pilotOverview({
        api: api,
        registry: o.registry === null ? null : (o.registry || fakeRegistry()),
        doc: o.doc || null,
        now: () => NOW
    });
    c.__api = api;
    return c;
}

test('the component constructs with nothing at all', () => {
    const c = O.pilotOverview();
    assert.deepEqual(c.servers, []);
    assert.equal(c.activeId, null);
    assert.equal(c.hasApi(), false);
});

test('refresh lists the servers, picks the registry\'s active one and summarises it', async () => {
    const c = component();
    await c.refresh(true);
    assert.deepEqual(c.servers.map((s) => s.id), ['alpha', 'beta']);
    assert.equal(c.activeId, 'alpha');
    assert.equal(c.server.name, 'Head office');
    assert.deepEqual(c.summary, { total: 3, listed: 3, online: 2, offline: 1 });
    assert.equal(c.summaryError, null);
    assert.equal(c.webClient.enabled, true);
});

test('a registry with no servers still gives a usable single-server screen', async () => {
    const c = component({ registry: fakeRegistry({ list: async () => [] }) });
    await c.refresh(true);
    assert.deepEqual(c.servers.map((s) => s.id), [O.FALLBACK_SERVER.id]);
    assert.equal(c.activeId, 'local');
    assert.equal(c.webClient.enabled, false);
});

test('a registry that rejects is reported but does not blank the screen', async () => {
    const c = component({ registry: fakeRegistry({
        list: async () => { throw Errors.create('GENERIC', '/etc/pilot/servers is unreadable'); }
    }) });
    await c.refresh(true);
    assert.equal(c.servers.length, 1);
    assert.match(c.errorText(c.registryError), /unreadable/);
    assert.equal(c.summaryError, null, 'the devices summary is independent of the registry');
});

test('no registry at all, and a registry missing active/setActive, both work', async () => {
    const bare = component({ registry: null });
    await bare.refresh(true);
    assert.equal(bare.activeId, 'local');

    const partial = component({ registry: { list: async () => [ALPHA, BETA] } });
    await partial.refresh(true);
    assert.equal(partial.activeId, 'alpha', 'with no active() the first server is active');
    assert.equal(await partial.selectServer('beta'), true);
    assert.equal(partial.activeId, 'beta', 'a missing setActive() is not an error');
});

test('an active id the registry no longer lists falls back to the first server', async () => {
    const c = component({ registry: fakeRegistry({ initialActive: 'deleted-server' }) });
    await c.refresh(true);
    assert.equal(c.activeId, 'alpha');
});

test('a devices failure leaves the server identity and the web client link intact', async () => {
    const c = component({ api: { devices: {
        list: async () => { throw Errors.create('API_AUTH_FAILED', 'token rejected'); }
    } } });
    await c.refresh(true);
    assert.equal(c.server.id, 'alpha');
    assert.equal(c.webClient.enabled, true, 'the web client does not depend on the API listing');
    assert.equal(c.errorText(c.summaryError), 'token rejected');
    assert.equal(c.errorRemediation(c.summaryError), Errors.remediation('API_AUTH_FAILED'));
    assert.match(c.errorRemediationLabel(c.summaryError), /sign in again/i,
        'API_AUTH_FAILED\'s remediation is reauthorize, not a hardcoded "Try again"');
    assert.deepEqual(c.summary, O.emptySummary());
});

test('errorRemediationLabel: a generic failure says try again, a hard stop says so, an unknown kind is silent', () => {
    const c = O.pilotOverview();
    assert.match(c.errorRemediationLabel(Errors.create('API_UNREACHABLE', 'down')), /try again/i);
    assert.match(c.errorRemediationLabel(Errors.create('SSH_HOSTKEY_CHANGED', 'changed')),
        /cannot be resolved automatically/i);
    assert.equal(c.errorRemediationLabel(null), '');
    assert.equal(c.errorRemediationLabel(undefined), '');
});

test('the summary error renders both the message and a kind-specific remediation, not just a retry button', () => {
    assert.ok(O.TEMPLATE.includes('data-test="summary-error-remediation"'));
    assert.ok(O.TEMPLATE.includes('x-text="errorRemediationLabel(summaryError)"'));
});

test('no API client is a stated reason rather than a zero count', async () => {
    const c = component({ api: null });
    await c.refresh(true);
    assert.ok(c.summaryError);
    assert.match(c.errorText(c.summaryError), /API client/);
    assert.deepEqual(c.summary, O.emptySummary());
});

test('switching servers records the choice, tells the other surfaces, and caches', async () => {
    const reg = fakeRegistry();
    const api = fakeApi({ alpha: DEVICES, beta: BETA_DEVICES });
    const fired = [];
    const doc = { dispatchEvent: (ev) => { fired.push(ev); return true; }, addEventListener() {} };
    const had = typeof globalThis.CustomEvent === 'function';
    if (!had) globalThis.CustomEvent = function (n, o) { this.type = n; this.detail = o && o.detail; };
    try {
        const c = component({ api, registry: reg, doc });
        await c.refresh(true);
        assert.equal(api.calls.length, 1);

        api.use('beta');
        assert.equal(await c.selectServer('beta'), true);
        assert.equal(c.activeId, 'beta');
        assert.deepEqual(reg.seen, ['beta'], 'the registry was told');
        assert.deepEqual(c.summary, { total: 1, listed: 1, online: 0, offline: 1 });
        assert.equal(c.webClient.enabled, false, 'beta has no TLS');
        assert.equal(c.webClient.reason, O.REASON.noTls);
        assert.equal(fired.filter((e) => e.type === D.SERVER_CHANGED_EVENT).length, 1);

        api.use('alpha');
        assert.equal(await c.selectServer('alpha'), true);
        assert.deepEqual(c.summary, { total: 3, listed: 3, online: 2, offline: 1 },
            'alpha\'s numbers came back');
        assert.equal(c.webClient.enabled, true);
        assert.equal(api.calls.length, 2, 'a server we have already summarised is not refetched');
    } finally { if (!had) delete globalThis.CustomEvent; }
});

test('selecting the active server, or one that is not listed, changes nothing', async () => {
    const api = fakeApi({ alpha: DEVICES, beta: BETA_DEVICES });
    const c = component({ api });
    await c.refresh(true);
    assert.equal(await c.selectServer('alpha'), true);
    assert.equal(await c.selectServer('nope'), false);
    assert.equal(await c.selectServer(''), false);
    assert.equal(await c.selectServer(null), false);
    for (const k of PROTO_KEYS) assert.equal(await c.selectServer(k), false, k);
    assert.equal(c.activeId, 'alpha');
    assert.equal(api.calls.length, 1);
});

test('a later refresh does not undo the switch the user just made', async () => {
    // The registry's active() is consulted only when nothing is selected yet.
    const reg = fakeRegistry({ active: async () => 'alpha' });
    const api = fakeApi({ alpha: DEVICES, beta: BETA_DEVICES });
    const c = component({ api, registry: reg });
    await c.refresh(true);
    api.use('beta');
    await c.selectServer('beta');
    await c.refresh(false);
    assert.equal(c.activeId, 'beta', 'refresh must not snap back to the stored active id');
    assert.equal(c.server.id, 'beta');
});

test('a setActive that rejects still switches the view and reports the failure', async () => {
    const c = component({ registry: fakeRegistry({
        setActive: async () => { throw Errors.create('GENERIC', 'read-only filesystem'); }
    }) });
    await c.refresh(true);
    assert.equal(await c.selectServer('beta'), true);
    assert.equal(c.activeId, 'beta');
    assert.match(c.errorText(c.actionError), /read-only/);
});

test('setRegistry overrides the default lookup and can be cleared', async () => {
    const reg = fakeRegistry({ list: async () => ['only-one'] });
    O.setRegistry(reg);
    try {
        assert.equal(O.registry(), reg);
        const c = O.pilotOverview({ api: fakeApi({ 'only-one': [] }), now: () => NOW });
        await c.refresh(true);
        assert.deepEqual(c.servers.map((s) => s.id), ['only-one']);
    } finally {
        O.setRegistry(null);
        assert.equal(O.registry(), null);
    }
});

test('setRegistry called AFTER a component already exists still reaches it', async () => {
    // The real integration order: Alpine calls `pilotOverview()` with no
    // arguments at mount time, and only afterwards (e.g. from boot.js, or a
    // test fixture) does anything call PilotOverview.setRegistry(). If the
    // component captured the registry once at construction, that call would be
    // silently unreachable — exactly the class of bug that made Task 20's
    // pilot:server-changed wiring dead on arrival until it was mutation-tested.
    O.setRegistry(null);
    try {
        const c = O.pilotOverview({ api: fakeApi({ alpha: DEVICES, local: [] }), now: () => NOW });
        await c.refresh(true);
        assert.deepEqual(c.servers.map((s) => s.id), ['local'],
            'with no registry set yet, the fallback single-server screen is shown');

        O.setRegistry(fakeRegistry());
        await c.refresh(true);
        assert.deepEqual(c.servers.map((s) => s.id), ['alpha', 'beta'],
            'a registry installed after construction is picked up on the next refresh');
    } finally {
        O.setRegistry(null);
    }
});

test('an explicit registry dependency is not overridden by a later setRegistry call', async () => {
    // The opposite case: a caller that DID pass a registry explicitly (every
    // unit test above does this via component()) must keep using exactly that
    // one, even if setRegistry() is also called — an explicit dependency always
    // wins over the module-level seam.
    const explicit = fakeRegistry({ list: async () => [ALPHA] });
    const c = O.pilotOverview({ api: fakeApi({ alpha: DEVICES }), registry: explicit, now: () => NOW });
    O.setRegistry(fakeRegistry({ list: async () => [BETA] }));
    try {
        await c.refresh(true);
        assert.deepEqual(c.servers.map((s) => s.id), ['alpha'],
            'the explicitly-injected registry is used, not the module-level one');
    } finally {
        O.setRegistry(null);
    }
});

test('TEMPLATE has no redundant x-init: Alpine already calls init() on its own', () => {
    // Task 20 found that a duplicate x-init="init()" alongside x-data doubles
    // every fetch on mount (Alpine invokes init() automatically). Same shape,
    // same fix, guarded here so it cannot silently come back.
    assert.ok(!/x-init/.test(O.TEMPLATE));
});

test('the summary counts come from devices-ui, not from a second parser', async () => {
    const c = component();
    await c.refresh(true);
    const rows = D.deviceRows(payload(DEVICES), NOW);
    assert.equal(c.summary.listed, rows.length);
    assert.equal(c.summary.online, rows.filter((r) => r.online).length);
});

// --- the template --------------------------------------------------------

test('the web client opens in a new tab and is never framed', () => {
    assert.ok(!/<iframe/i.test(O.TEMPLATE), 'framing would need CSP frame-src to a remote origin');
    assert.ok(O.TEMPLATE.includes('target="_blank"'));
    assert.ok(O.TEMPLATE.includes('rel="noopener noreferrer"'));
    assert.ok(O.TEMPLATE.includes(':href="webClient.url"'));
});

test('the disabled web client shows its reason and a one-click route to the wizard', () => {
    assert.ok(O.TEMPLATE.includes('data-test="web-client-reason"'));
    assert.ok(O.TEMPLATE.includes('x-text="webClient.reason"'));
    assert.ok(O.TEMPLATE.includes('data-test="web-client-fix"'));
    assert.ok(O.TEMPLATE.includes('openWizardTls()'));
});

test('the template renders text only and offers real controls', () => {
    assert.ok(!/x-html/.test(O.TEMPLATE));
    assert.ok(O.TEMPLATE.includes('x-data="pilotOverview()"'));
    for (const hook of ['switcher', 'refresh', 'total', 'online', 'offline',
        'summary-error', 'web-client-link'])
        assert.ok(O.TEMPLATE.includes('data-test="' + hook + '"'), hook);
});

test('no x-show shares an element with a Bootstrap display utility', () => {
    for (const line of O.TEMPLATE.split('\n')) {
        if (!line.includes('x-show')) continue;
        assert.ok(!/\bd-(flex|block|inline|inline-flex|inline-block|grid|table)\b/.test(line), line);
    }
});

test('mount injects the template once and creates its host if the page has none', () => {
    const attrs = {};
    const host = { id: '', innerHTML: '',
        getAttribute: (k) => attrs[k] || null,
        setAttribute: (k, v) => { attrs[k] = v; } };
    const created = [];
    const doc = {
        getElementById: (id) => (id === 'pilot-overview' && created.length ? host : null),
        createElement: () => host,
        body: { appendChild: (el) => { created.push(el); } }
    };
    assert.equal(O.mount(doc), true);
    assert.equal(host.id, 'pilot-overview');
    assert.ok(host.innerHTML.includes('x-data="pilotOverview()"'));
    host.innerHTML = 'untouched';
    assert.equal(O.mount(doc), false);
    assert.equal(host.innerHTML, 'untouched');
    for (const bad of [null, undefined, {}, 'x', 7]) assert.equal(O.mount(bad), false, String(bad));
});
