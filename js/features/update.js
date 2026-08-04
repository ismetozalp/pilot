// features/update.js — version badge state and GitHub-release self-update.
//
// THE CONSTRAINT THAT SHAPES THIS FILE (spec 10.2): manifest.json sets
// connect-src 'self', so a browser fetch() to api.github.com is blocked outright.
// Every network call here goes through cockpit.spawn(['curl', ...]) on the host.
// Reaching for fetch() appears to work in a unit test and fails silently in the
// browser — it is the single most likely way this feature gets reimplemented wrong.
// For the same reason this file never calls fetch() or XMLHttpRequest for ANYTHING,
// including reading the installed version: that comes from
// cockpit.file('/etc/pilot/installed-version') — the file `make install` stamps —
// rather than a same-origin fetch('VERSION'), so there is exactly one network
// primitive in this module to reason about, not two.
//
// Flow: check release -> confirm -> download -> unpack -> `make install` (superuser)
// -> detached Cockpit restart. Nothing touches /usr/share/cockpit/pilot until the
// `make install` step, so a failed update leaves the working version in place.
'use strict';
(function (root) {
    const Semver = root.PilotSemver ||
        (typeof require === 'function' ? require('../core/semver.js') : null);
    const Errors = root.PilotErrors ||
        (typeof require === 'function' ? require('../core/errors.js') : null);

    const PHASE = { IDLE: 'idle', CONFIRM: 'confirm', RUNNING: 'running', DONE: 'done', ERROR: 'error' };

    // Escapes only, never literal control bytes.
    const CONTROL = /[\x00-\x1f\x7f]/;
    const URL_UNSAFE = /[\x00-\x20\x7f]/;      // control characters AND the space
    const MAX_DOC = 512 * 1024;
    const MAX_NOTES = 20000;
    const MAX_URL = 2048;

    // Stamped by `make install` (Makefile: `printf '%s\n' "$(VERSION)" >
    // $(SYSCONF)/installed-version`) — the same fixed, root-owned config location
    // every other core module hardcodes (js/core/servers.js: /etc/pilot/servers).
    // This is deliberately NOT the VERSION file shipped beside index.html: that file
    // describes what the BROWSER happens to have cached, not what is installed.
    const INSTALLED_VERSION_PATH = '/etc/pilot/installed-version';

    // github.com serves the release page redirect; codeload serves zipballs;
    // the githubusercontent hosts serve the signed asset payloads themselves.
    const ASSET_HOSTS = ['github.com', 'codeload.github.com',
        'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];

    function oops(message, detail) {
        return Errors.create('GENERIC', message, detail === undefined ? null : detail);
    }

    // ---------------------------------------------------------------- pure

    // Accepts 'owner/name' or any github.com URL pointing at it.
    function releasesApiUrl(raw) {
        if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return '';
        if (CONTROL.test(raw)) return '';
        const repo = raw.trim()
            .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
            .replace(/\.git$/i, '')
            .replace(/^\/+|\/+$/g, '');
        if (!repo) return '';
        const parts = repo.split('/');
        // Exactly owner/name. Anything deeper is a path inside the repo, not the repo.
        if (parts.length !== 2 || !parts[0] || !parts[1]) return '';
        for (const p of parts) {
            if (!/^[A-Za-z0-9._-]+$/.test(p)) return '';
            // '.' and '..' pass the character test and would rewrite the API path.
            if (p === '.' || p === '..') return '';
        }
        return 'https://api.github.com/repos/' + parts[0] + '/' + parts[1] + '/releases/latest';
    }

    // Only GitHub's own hosts. The asset URL comes from a remote document and is
    // handed to curl, so it is treated as untrusted input throughout: the authority
    // is extracted explicitly rather than pattern-matched, because
    // "https://github.com@evil.example/x" starts with the right characters and is
    // served by evil.example.
    function isAllowedAssetUrl(url) {
        if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL) return false;
        if (URL_UNSAFE.test(url)) return false;
        if (url.indexOf('\\') !== -1) return false;
        const m = /^https:\/\/([^/]+)(\/.*)$/.exec(url);   // scheme is case-sensitive here
        if (!m) return false;
        const authority = m[1];
        if (authority.indexOf('@') !== -1) return false;   // embedded credentials
        if (authority.indexOf(':') !== -1) return false;   // explicit port
        if (!/^[A-Za-z0-9.-]+$/.test(authority)) return false;   // percent-encoding, unicode
        return ASSET_HOSTS.indexOf(authority.toLowerCase()) !== -1;
    }

    function pickAssetUrl(rel) {
        const assets = Array.isArray(rel.assets) ? rel.assets : [];
        for (const a of assets) {
            if (!a || typeof a.name !== 'string' || !/\.zip$/i.test(a.name)) continue;
            const u = typeof a.browser_download_url === 'string' ? a.browser_download_url : '';
            if (isAllowedAssetUrl(u)) return u;
        }
        const zipball = typeof rel.zipball_url === 'string' ? rel.zipball_url : '';
        return isAllowedAssetUrl(zipball) ? zipball : '';
    }

    // Reduce a GitHub release document to the few fields the UI needs.
    function parseRelease(text, installedVersion) {
        if (typeof text !== 'string') throw oops('GitHub returned no release document.');
        if (text.length > MAX_DOC)
            throw oops('GitHub returned a release document that is too large to be real.',
                { bytes: text.length });

        let rel;
        try {
            rel = JSON.parse(text);
        } catch (e) {
            throw oops('GitHub returned something that is not JSON.', { text: text.slice(0, 200) });
        }
        // Array.isArray matters: a JSON array is typeof 'object' and truthy, so it
        // would otherwise sail through and yield a release with no tag.
        if (!rel || typeof rel !== 'object' || Array.isArray(rel))
            throw oops('GitHub returned an unexpected release document.');
        // Rate limiting and a missing repository both arrive as HTTP 200 with a
        // "message" field, which would otherwise look like a release with no tag.
        if (!rel.tag_name && typeof rel.message === 'string' && rel.message)
            throw oops('GitHub: ' + rel.message.slice(0, 200));

        if (typeof rel.tag_name !== 'string' || !rel.tag_name)
            throw oops('GitHub release has no tag_name.');
        const tag = rel.tag_name;
        if (tag.length > 128 || CONTROL.test(tag))
            throw oops('GitHub release tag is not a usable version string.',
                { tag: tag.slice(0, 60) });

        const version = tag.replace(/^[vV]/, '');
        return {
            tag: tag,
            version: version,
            available: Semver.isNewer(version, installedVersion),
            assetUrl: pickAssetUrl(rel),
            notes: (typeof rel.body === 'string' ? rel.body : '').slice(0, MAX_NOTES),
            prerelease: rel.prerelease === true
        };
    }

    // `make zip` produces a single top-level pilot/ directory, and GitHub's zipball
    // also nests exactly one directory. Anything else means we unpacked something we
    // do not understand, and running `make install` on it would be reckless. Entries
    // come from `ls` over archive contents an attacker may control, so a traversing,
    // absolute or nested name disqualifies the listing rather than building a path.
    function chooseSourceDir(tmpDir, entries) {
        const list = Array.isArray(entries) ? entries : [];
        const dirs = [];
        for (const raw of list) {
            if (typeof raw !== 'string') return tmpDir;
            const n = raw.trim();
            if (!n || n === 'update.zip') continue;
            if (n === '.' || n === '..') return tmpDir;
            if (n.indexOf('/') !== -1 || CONTROL.test(n)) return tmpDir;
            dirs.push(n);
        }
        return dirs.length === 1 ? tmpDir + '/' + dirs[0] : tmpDir;
    }

    function blankState() {
        return {
            checking: false, available: false, error: '',
            version: '', tag: '', assetUrl: '', notes: '', prerelease: false
        };
    }

    // js/core/settings.js is owned by another section and its method names are not
    // pinned by the contracts, so this accepts a plain settings object OR a store
    // exposing read()/load()/get(). It never rejects: a settings file we cannot read
    // must degrade to "no repository configured", not to a broken badge.
    function readSettings(source) {
        const reader = ['read', 'load', 'get'].find(
            (n) => source && typeof source === 'object' && typeof source[n] === 'function');
        const got = reader
            ? Promise.resolve().then(() => source[reader]()).catch(() => null)
            : Promise.resolve(source);
        return got.then((obj) =>
            (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {});
    }

    // Projects spec 11.3's { update: { repo, checkOnStartup } }.
    function updatePrefs(settings) {
        const u = settings && typeof settings === 'object' && !Array.isArray(settings)
            && settings.update && typeof settings.update === 'object' ? settings.update : {};
        return {
            repo: typeof u.repo === 'string' ? u.repo : '',
            checkOnStartup: u.checkOnStartup === true
        };
    }

    // ---------------------------------------------------------------- I/O

    function hasCockpit() {
        return typeof cockpit !== 'undefined' && cockpit && typeof cockpit.spawn === 'function';
    }

    function spawn(argv, opts) {
        if (!hasCockpit())
            return Promise.reject(oops('cockpit is not available in this context.'));
        return cockpit.spawn(argv, Object.assign({ err: 'message' }, opts || {}));
    }

    // Same command run twice with and without a live-output callback: cockpit.spawn
    // returns a promise augmented with .stream() when the bridge supports it, and a
    // plain promise (a stub, or an older bridge) otherwise. Buffering the final
    // resolved text is the only way to guarantee the full log lands in updateLog
    // when no incremental callback ever fires — that path is exercised by every
    // fake used in tests, since a fake Promise has no .stream method.
    function spawnLive(argv, opts, onLine) {
        if (!hasCockpit())
            return Promise.reject(oops('cockpit is not available in this context.'));
        const p = cockpit.spawn(argv, Object.assign({ err: 'message' }, opts || {}));
        let streamed = false;
        let carry = '';
        const ingest = (chunk) => {
            carry += String(chunk);
            const parts = carry.split('\n');
            carry = parts.pop();
            for (const line of parts) if (line !== '') onLine(line);
        };
        if (typeof p.stream === 'function') p.stream((chunk) => { streamed = true; ingest(chunk); });
        return Promise.resolve(p).then((out) => {
            if (!streamed) ingest(out);
            if (carry.trim() !== '') onLine(carry.trim());
            return out;
        });
    }

    // ---------------------------------------------------------------- component

    function pilotUpdateUi() {
        return {
            update: blankState(),
            updatePhase: PHASE.IDLE,
            updateLog: [],
            installedVersion: '',
            // Remembered so the badge can distinguish "not checked yet" from
            // "checked, nothing new" — without it a click looks like a no-op.
            checkedAt: 0,
            prefs: { repo: '', checkOnStartup: false },
            _inFlight: false,

            async initUpdate(source) {
                this.installedVersion = await this.readInstalledVersion();
                this.prefs = updatePrefs(await readSettings(source));
                if (this.prefs.checkOnStartup && this.prefs.repo)
                    await this.checkForUpdate(false, this.prefs);
                return this.prefs;
            },

            async readInstalledVersion() {
                // NOT fetch('VERSION'): see the file header. This is same-origin to
                // the bridge either way, but keeping every read on cockpit.file/spawn
                // means there is exactly one network primitive in this file.
                if (typeof cockpit === 'undefined' || !cockpit || typeof cockpit.file !== 'function')
                    return '';
                try {
                    const text = await cockpit.file(INSTALLED_VERSION_PATH).read();
                    return typeof text === 'string' ? text.trim() : '';
                } catch (e) {
                    return '';
                }
            },

            async checkForUpdate(manual, prefs) {
                const p = prefs || this.prefs;
                const api = releasesApiUrl(p && p.repo);
                if (!api) {
                    this.update = Object.assign(blankState(), {
                        error: 'Set a GitHub repository (owner/name) in the settings file first.'
                    });
                    return this.update;
                }
                this.update = Object.assign(blankState(), { checking: true });
                try {
                    // NOT fetch(): CSP connect-src 'self' blocks api.github.com.
                    const out = await spawn(['curl', '-fsSL', '--max-time', '20',
                        '-H', 'Accept: application/vnd.github+json', '--', api]);
                    const rel = parseRelease(String(out), this.installedVersion || '0.0.0');
                    this.update = Object.assign(blankState(), rel, { checking: false });
                } catch (e) {
                    this.update = Object.assign(blankState(), {
                        error: (e && e.message) || String(e)
                    });
                }
                return this.update;
            },

            openUpdateModal() {
                if (!this.update.assetUrl) return false;
                this.updatePhase = PHASE.CONFIRM;
                this.updateLog = [];
                const el = root.document && root.document.getElementById('pilot-update');
                if (el && root.bootstrap) root.bootstrap.Modal.getOrCreateInstance(el).show();
                return true;
            },

            closeUpdateModal() {
                // An in-flight `make install` running as root must not be abandoned
                // half-done by someone clicking away.
                if (this._inFlight) return false;
                const el = root.document && root.document.getElementById('pilot-update');
                if (el && root.bootstrap) root.bootstrap.Modal.getOrCreateInstance(el).hide();
                this.updatePhase = PHASE.IDLE;
                return true;
            },

            async startSelfUpdate() {
                if (this._inFlight) return false;
                const url = this.update && this.update.assetUrl;
                if (!url) return false;
                if (!isAllowedAssetUrl(url)) {
                    this.updatePhase = PHASE.ERROR;
                    this.updateLog = ['Refusing to download from an unexpected host: ' + url];
                    return false;
                }

                this._inFlight = true;
                this.updatePhase = PHASE.RUNNING;
                this.updateLog = [];
                const log = (line) => this.updateLog.push(String(line));
                let tmpDir = '';

                try {
                    log('Downloading ' + url);
                    tmpDir = String(await spawn(['mktemp', '-d'])).trim();
                    const zipPath = tmpDir + '/update.zip';
                    // '--' terminates option parsing: the URL is remote data.
                    await spawn(['curl', '-fsSL', '--max-time', '300', '-o', zipPath, '--', url]);

                    log('Unpacking');
                    await spawn(['unzip', '-oq', zipPath, '-d', tmpDir]);

                    const listing = String(await spawn(['ls', '-1', tmpDir]))
                        .split('\n').map((s) => s.trim()).filter(Boolean);
                    const srcDir = chooseSourceDir(tmpDir, listing);

                    log('Installing: make -C ' + srcDir + ' install');
                    // Streamed line-by-line where the bridge supports it, so the log
                    // pane is live during the slowest step rather than appearing all
                    // at once when the command finally exits.
                    await spawnLive(['make', '-C', srcDir, 'install'], { superuser: 'require' }, log);

                    // --no-block so the restart survives this page's channel closing;
                    // restarting Cockpit from inside Cockpit otherwise kills the call
                    // that is doing the restarting.
                    log('Scheduling Cockpit restart');
                    await spawn(['systemd-run', '--no-block', '--',
                        'systemctl', 'try-restart', 'cockpit'], { superuser: 'require' });

                    log('Done — reload this page in a few seconds.');
                    this.updatePhase = PHASE.DONE;
                    return true;
                } catch (e) {
                    log('FAILED: ' + ((e && e.message) || String(e)));
                    log('The previously installed version is untouched.');
                    this.updatePhase = PHASE.ERROR;
                    return false;
                } finally {
                    this._inFlight = false;
                    if (tmpDir) {
                        try { await spawn(['rm', '-rf', '--', tmpDir]); } catch (e) { /* best effort */ }
                    }
                }
            },

            updateBadgeLabel() {
                if (this.update.checking) return 'Checking…';
                if (this.update.error) return 'Update check failed';
                if (this.update.available) return '↑ Update to ' + this.update.version;
                // Confirming "no update" matters as much as announcing one: without
                // it, clicking the badge looks like nothing happened.
                if (this.checkedAt && this.installedVersion)
                    return 'v' + this.installedVersion + ' — up to date';
                return this.installedVersion ? 'v' + this.installedVersion : 'Check for updates';
            },

            badgeTitle() {
                if (this.update.checking) return 'Checking for updates…';
                if (this.update.error)
                    return 'Update check failed: ' + this.update.error + ' — click to try again';
                if (this.update.available)
                    return 'Version ' + this.update.version + ' is available — click to install';
                if (!this.prefs.repo)
                    return 'Set a GitHub repository in the settings file to check for updates';
                if (this.checkedAt) return 'No update found. Click to check again.';
                return 'Click to check for updates';
            },

            badgeClass() {
                if (this.update.available) return 'pl-badge-update available';
                if (this.update.error) return 'pl-badge-update failed';
                return 'pl-badge-update';
            },

            // One control with two jobs: it checks when there is nothing to install
            // and opens the confirm modal when there is. A separate "check" button
            // would sit unused almost always.
            async onBadgeClick() {
                if (this.update.checking || this._inFlight) return false;
                if (this.update.available) return this.openUpdateModal();
                await this.checkForUpdate(true, this.prefs);
                this.checkedAt = Date.now();
                // "Up to date" is a response to a click, not a permanent claim.
                if (root.setTimeout) root.setTimeout(() => { this.checkedAt = 0; }, 20000);
                return true;
            }
        };
    }

    const PilotUpdate = {
        PHASE, ASSET_HOSTS,
        releasesApiUrl, parseRelease, isAllowedAssetUrl, chooseSourceDir, blankState,
        readSettings, updatePrefs, pilotUpdateUi
    };
    root.PilotUpdate = PilotUpdate;
    root.pilotUpdateUi = pilotUpdateUi;
    if (typeof module !== 'undefined' && module.exports) module.exports = PilotUpdate;
})(typeof window !== 'undefined' ? window : globalThis);
