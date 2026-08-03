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

test('an idempotency check is rendered as a real guard that skips the step if satisfied', () => {
    const out = P.manualScript(P.build(DET_ADOPT, CH_LOCAL));
    assert.ok(out.indexOf('if ! id -u rustdesk-api >/dev/null 2>&1; then\n') !== -1, 'check condition');
    assert.ok(out.indexOf("echo \"skip: install-user (already satisfied)\"\n") !== -1, 'skip message');
    assert.ok(out.indexOf('fi\n') !== -1, 'guard closes with fi');
});

test('a write step becomes a quoted heredoc plus chmod and chown', () => {
    const plan = P.build(DET_ADOPT, CH_LOCAL);
    const cfg = plan.steps.filter((s) => s.id === 'configure')[0];
    const out = P.manualScript(plan);
    // Delimiter is quoted with nonce to avoid collisions
    assert.ok(out.indexOf("cat > /opt/rustdesk-api/conf/config.yaml <<'PILOT_EOF_0'\n") !== -1);
    assert.ok(out.indexOf('\nPILOT_EOF_0\nchmod 0640 /opt/rustdesk-api/conf/config.yaml\n') !== -1);
    assert.ok(out.indexOf('\nchown rustdesk-api:rustdesk-api /opt/rustdesk-api/conf/config.yaml\n') !== -1);
    // The content is reproduced verbatim, with no trailing blank line inside the heredoc.
    assert.ok(out.indexOf('\n' + cfg.write.content.replace(/\n$/, '') + '\nPILOT_EOF_0\n') !== -1);
    // The heredoc delimiter is quoted, so nothing inside is expanded by the shell.
    assert.equal(out.indexOf('<<PILOT_EOF'), -1);
});

test('a write step creates its parent directory first', () => {
    const out = P.manualScript(P.build(DET_ADOPT, CH_LOCAL));
    const lines = out.split('\n');
    const i = lines.findIndex((l) => l.indexOf("cat > /etc/systemd/system/rustdesk-api.service <<'PILOT_EOF") === 0);
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

test('a write step with delimiter-collision content is handled safely (delimiter nonce added)', () => {
    const out = P.manualScript(rawPlan([
        rawStep({ id: 'w', argv: [], write: { path: '/test', mode: '0600', owner: 'root:root',
            content: 'line1\nPILOT_EOF_0\nline3\n' } })
    ]));
    // Content must be present verbatim
    assert.ok(out.indexOf('line1\nPILOT_EOF_0\nline3') !== -1, 'content preserved');
    // Delimiter must be collision-free (PILOT_EOF_1 when PILOT_EOF_0 is in content)
    assert.ok(out.indexOf("<<'PILOT_EOF_1'") !== -1 || out.indexOf("<<'PILOT_EOF_2'") !== -1, 'delimiter has nonce');
    // Ensure PILOT_EOF_0 without nonce is not used as delimiter
    assert.equal(out.indexOf("<<'PILOT_EOF'"), -1, 'plain PILOT_EOF not used as delimiter when collision exists');
});

test('a write step with dangerous content ($(...), backticks, $VAR) is quoted safely in heredoc', () => {
    const out = P.manualScript(rawPlan([
        rawStep({ id: 'w', argv: [], write: { path: '/test', mode: '0600', owner: 'root:root',
            content: '#!/bin/sh\necho "$(touch /tmp/PWNED)"\necho `id`\necho $HOME\n' } })
    ]));
    // Content must appear as-is (no command execution possible)
    assert.ok(out.indexOf('$(touch /tmp/PWNED)') !== -1);
    assert.ok(out.indexOf('`id`') !== -1);
    assert.ok(out.indexOf('$HOME') !== -1);
    // Delimiter is quoted, so shell does not expand anything inside
    assert.ok(out.indexOf("<<'PILOT_EOF") !== -1, 'delimiter is quoted');
});

test('a secret DuckDNS step redacts the token, never emitting it in cleartext', () => {
    // DuckDNS step has secret: true and the token in argv
    const out = P.manualScript(rawPlan([
        rawStep({ id: 'tls-duckdns', argv: ['curl', '-fsS', 'https://www.duckdns.org/update?domains=myhost&token=SECRET123ABC&ip='], secret: true })
    ]));
    // The literal token must NOT appear anywhere
    assert.equal(out.indexOf('SECRET123ABC'), -1, 'literal token does not appear');
    // Placeholder must be present
    assert.ok(out.indexOf('${DUCKDNS_TOKEN}') !== -1, 'placeholder present');
    // Env var instruction must be present
    assert.ok(out.indexOf('DUCKDNS_TOKEN=') !== -1, 'env var instruction present');
});

test('an idempotency-checked step is truly skipped on re-run (resumable script)', () => {
    const plan = rawPlan([
        rawStep({ id: 'user', argv: ['useradd', 'testuser'], check: { argv: ['id', '-u', 'testuser'], expect: 'zero' } })
    ]);
    const out = P.manualScript(plan);
    // First run: check fails (user does not exist), so useradd runs
    // Second run: check passes (user exists), so skip message prints instead
    assert.ok(out.indexOf('if ! id -u testuser >/dev/null 2>&1; then') !== -1);
    assert.ok(out.indexOf('useradd testuser') !== -1);
    assert.ok(out.indexOf("echo \"skip: user (already satisfied)\"") !== -1);
    assert.ok(out.indexOf('fi') !== -1);
});
