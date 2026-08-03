// tests/unit/provision-manual.test.js — PilotProvisionPlan.manualScript(): manual
// mode is a rendering of the SAME plan object, so this suite pins the rendering
// (golden) and the shell quoting that stops plan data becoming shell syntax.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const P = require('../../js/core/provision-plan.js');

const GOLDEN = path.join(__dirname, '..', 'fixtures', 'golden');

const DET_ADOPT = {
    os_release: { id: 'debian', id_like: '', version_id: '12', pretty_name: 'Debian GNU/Linux 12 (bookworm)' },
    arch: 'x86_64', init: 'systemd', firewall: 'none', egress: true, disk_free_mb: 4096,
    hbbs: { version: '1.1.16', install: 'deb', ports: [21115, 21116, 21117],
            pubkey: 'AbCdEf0123456789+/=', data_dir: '/var/lib/rustdesk-server' },
    api: null, public_ip: '203.0.113.10'
};
const CH_LOCAL = { target: 'local', installHbbs: false, tlsTier: 'none', domain: null, duckdns: null,
    apiPort: 21114, sshPort: 22, openFirewall: false };

// A hand-built plan: manualScript validates shape only, so this is how the
// renderer's quoting is driven with input build() would never produce.
function rawPlan(steps) {
    return { target: 'local', host: null, arch: 'amd64', warnings: [], steps: steps };
}
function rawStep(over) {
    return Object.assign({ id: 'x', title: 't', mutating: true, why: 'w', argv: [], write: null,
        check: null, sha256: null, secret: false }, over);
}

test('the adopt/local/no-TLS script matches the golden byte for byte', () => {
    const plan = P.build(DET_ADOPT, CH_LOCAL);
    assert.equal(P.manualScript(plan), fs.readFileSync(path.join(GOLDEN, 'plan-manual-adopt-local.sh'), 'utf8'));
});

test('the script is a runnable sh script that stops on the first failure', () => {
    const out = P.manualScript(P.build(DET_ADOPT, CH_LOCAL));
    assert.equal(out.split('\n')[0], '#!/bin/sh');
    assert.ok(out.indexOf('\nset -eu\n') !== -1);
    assert.equal(out[out.length - 1], '\n', 'the script ends with a newline');
});

test('every plan warning is carried into the script as a comment', () => {
    const plan = P.build(DET_ADOPT, CH_LOCAL);
    assert.ok(plan.warnings.length >= 2);
    for (const w of plan.warnings) assert.ok(P.manualScript(plan).indexOf('# WARNING: ' + w + '\n') !== -1, w);
});

test('every step contributes a numbered block carrying its title and why', () => {
    const plan = P.build(DET_ADOPT, Object.assign({}, CH_LOCAL, { tlsTier: 'own', domain: 'rd.example.com' }));
    const out = P.manualScript(plan);
    const n = plan.steps.length;
    for (let i = 0; i < n; i++) {
        assert.ok(out.indexOf('# [' + (i + 1) + '/' + n + '] ' + plan.steps[i].title + '\n') !== -1, plan.steps[i].id);
        assert.ok(out.indexOf('# ' + plan.steps[i].why + '\n') !== -1, plan.steps[i].id);
    }
});

test('every download is followed by a sha256sum check of the -o path', () => {
    const plan = P.build(DET_ADOPT, Object.assign({}, CH_LOCAL, { installHbbs: true }));
    const out = P.manualScript(plan);
    let n = 0;
    for (const s of plan.steps) {
        if (s.sha256 === null) continue;
        n++;
        const dest = s.argv[s.argv.length - 1];
        assert.ok(out.indexOf("printf '%s  %s\\n' " + s.sha256 + ' ' + dest + ' | sha256sum -c -\n') !== -1, s.id);
    }
    assert.ok(n >= 1);
    assert.equal(out.match(/sha256sum -c -/g).length, n, 'exactly one check per download');
});

test('a secret step is flagged so it is never pasted into a shared log', () => {
    const out = P.manualScript(P.build(DET_ADOPT, CH_LOCAL));
    assert.ok(out.indexOf('# SECRET: this step carries a credential - do not paste it into a shared log.\n') !== -1);
});

test('an idempotency probe is rendered as a skip hint, not as an executed command', () => {
    const out = P.manualScript(P.build(DET_ADOPT, CH_LOCAL));
    assert.ok(out.indexOf('# Already done if this exits zero: id -u rustdesk-api\n') !== -1);
    const probe = out.split('\n').filter((l) => l === 'id -u rustdesk-api');
    assert.deepEqual(probe, [], 'the probe itself is never emitted as a command');
});

test('a write step becomes a quoted heredoc plus chmod and chown', () => {
    const plan = P.build(DET_ADOPT, CH_LOCAL);
    const cfg = plan.steps.filter((s) => s.id === 'configure')[0];
    const out = P.manualScript(plan);
    assert.ok(out.indexOf("cat > /opt/rustdesk-api/conf/config.yaml <<'PILOT_EOF'\n") !== -1);
    assert.ok(out.indexOf('\nPILOT_EOF\nchmod 0640 /opt/rustdesk-api/conf/config.yaml\n') !== -1);
    assert.ok(out.indexOf('\nchown rustdesk-api:rustdesk-api /opt/rustdesk-api/conf/config.yaml\n') !== -1);
    // The content is reproduced verbatim, with no trailing blank line inside the heredoc.
    assert.ok(out.indexOf('\n' + cfg.write.content.replace(/\n$/, '') + '\nPILOT_EOF\n') !== -1);
    // The heredoc delimiter is quoted, so nothing inside is expanded by the shell.
    assert.equal(out.indexOf('<<PILOT_EOF'), -1);
});

test('a write step creates its parent directory first', () => {
    const out = P.manualScript(P.build(DET_ADOPT, CH_LOCAL));
    const lines = out.split('\n');
    const i = lines.indexOf("cat > /etc/systemd/system/rustdesk-api.service <<'PILOT_EOF'");
    assert.ok(i > 0);
    assert.equal(lines[i - 1], 'install -d -m 0755 /etc/systemd/system');
});

test('arguments that are not shell-safe are single-quoted, and quotes are escaped', () => {
    const out = P.manualScript(rawPlan([
        rawStep({ id: 'a', argv: ['echo', "it's", 'two words', 'a;rm -rf /', 'nl\nhere', '$HOME', '*'] })
    ]));
    assert.ok(out.indexOf("echo 'it'\\''s' 'two words' 'a;rm -rf /' 'nl\nhere' '$HOME' '*'\n") !== -1, out);
});

test('shell-safe arguments stay unquoted so the script is readable', () => {
    const out = P.manualScript(rawPlan([
        rawStep({ id: 'a', argv: ['curl', '-fsSL', 'https://h/x.tar.gz?a=1', '-o', '/var/cache/pilot/x.tar.gz'] })
    ]));
    assert.ok(out.indexOf("curl -fsSL 'https://h/x.tar.gz?a=1' -o /var/cache/pilot/x.tar.gz\n") !== -1, out);
});

test('a write path with no directory part does not produce install -d on an empty string', () => {
    const out = P.manualScript(rawPlan([
        rawStep({ id: 'w', argv: [], write: { path: '/top', mode: '0600', owner: 'root:root', content: 'x\n' } })
    ]));
    assert.ok(out.indexOf('install -d -m 0755 /\n') !== -1, out);
});

test('an empty step list still yields a valid script', () => {
    const out = P.manualScript(rawPlan([]));
    assert.equal(out, '#!/bin/sh\n' +
        '# Generated by Pilot - manual provisioning script. Run every line as root, in order.\n' +
        '# target=local arch=amd64 steps=0\n' +
        'set -eu\n');
});

test('manualScript rejects anything that is not a plan', () => {
    for (const bad of [null, undefined, {}, { steps: 'x' }, [], 'plan', 5, { steps: {} }]) {
        assert.throws(() => P.manualScript(bad), (e) => {
            assert.equal(e.kind, 'GENERIC');
            return true;
        });
    }
});

test('manualScript does not mutate the plan it renders', () => {
    const plan = P.build(DET_ADOPT, CH_LOCAL);
    const copy = JSON.parse(JSON.stringify(plan));
    P.manualScript(plan);
    assert.deepEqual(plan, copy);
});
