# Changelog

All notable changes to Pilot are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Pilot uses
[semantic versioning](https://semver.org/) — `VERSION` is the single source of
truth, read by the Makefile and by the self-updater.

## Unreleased

### Changed

- **`hbbs`/`hbbr` are now installed from
  [`wy414012/rustdesk-server`](https://github.com/wy414012/rustdesk-server) 1.4.3
  instead of the official `rustdesk/rustdesk-server` 1.1.16.** Official `hbbs`
  cannot serve a RustDesk client 1.4.1 or newer that is *signed in* to the API
  server, and Pilot's whole purpose — the address book — requires being signed in.
  The client reports `Failed to secure tcp: deadline has elapsed`, which reads like
  a firewall or certificate fault and is neither. **Temporary**: see
  [Why the server is a fork](README.md#why-the-server-is-a-fork) for the revert
  procedure and the upstream issues to watch.
- The Address Book's **bulk-tag** and **rename-tag** controls are dropdowns over the
  tags that exist, instead of free-text fields. Typing a tag name invented a new one
  on any typo, so a book could hold `laptop` and `Laptop` as separate tags with
  nothing on screen to reveal it. With no tags yet, both controls say so and offer
  the action that creates one.

- **The browser web client is disabled at provision time** (`app.web-client: 0`).
  The client bundled with `rustdesk-api` v2.7 latency-probes a hardcoded list of
  `rustdesk.com` servers and overwrites the stored rendezvous server with the
  winner, so it cannot reach a self-hosted deployment at all — it fails with
  "Failed to connect to rendezvous server". Serving it published a page that
  could not work and needed no login to reach. `/_admin/` and `/api` are separate
  routes and are unaffected. See
  [Why the browser web client is disabled](README.md#why-the-browser-web-client-is-disabled).
- Overview's **"Open the web client"** button is now **"Go to administration"**
  and opens `/_admin/`. It previously pointed at the site root, which redirects
  to the admin console anyway — so the button had never opened the web client,
  and now says so.

### Fixed

- Renaming a device now also updates its **address-book alias**. A device name lives
  in two tables on a rustdesk-api server and only the peer row was being written, so
  a renamed device kept its old name in the Address Book — and in the RustDesk
  desktop client, which reads the address-book alias.
- Address-book writes made from the Devices tab now refresh the Address Book tab.
  They are separate Alpine components, so a write on one was invisible to the other
  until the whole browser page was reloaded.
- The "not connected" banner no longer stays on screen after connecting. It carried a
  Bootstrap `d-flex` utility, whose `display: flex !important` overrides the inline
  `display: none` that `x-show` sets.
- `reconnect()` is bounded at 15 seconds and explains what to do when it expires. A
  Cockpit channel that never opens also never errors, so the button could sit on
  "Reconnecting…" forever with nothing in the browser console.

## 0.1.0

First release: a Cockpit plugin that provisions and then manages a self-hosted
RustDesk server.

### Provisioning

- A seven-step wizard — target, host key, detection and plan, TLS and domain,
  ports, execute, handover — for a localhost or a remote SSH target.
- Target detection (OS family, arch, init, firewall backend, disk, egress, an
  already-installed `hbbs`/API server) with the plan shown in full before
  anything runs, and a manual-mode shell script rendered from that same plan.
- Installs `hbbs`, `hbbr` and the RustDesk API server from pinned releases,
  verified against recorded SHA256 digests, or adopts what is already there
  without restarting it.
- Host-key confirmation on first connect; a *changed* key is a hard stop.
- Firewall rules for firewalld, ufw and nftables, plus the literal AWS
  security-group command for the ports Pilot cannot reach.
- TLS in three tiers — your own domain, an automatic `sslip.io` hostname, or
  DuckDNS — with a DNS pre-flight before ACME so a misdirected record is
  reported as itself rather than as an opaque failure that also burns a
  rate-limit attempt. Caddy is installed and configured on 443.
- A live JSON-line transcript, persisted to `/var/lib/pilot/runs/`, and a
  handover that reports partial success honestly rather than a green tick over
  an unreachable console.

### Management

- Overview: server switcher, device counts, and the web client link with the
  exact reason when it is unavailable.
- Devices: inventory with real online state, rename, delete, and add to an
  address book.
- Address Book: books, tag CRUD, bulk tag assignment, CSV import and export.
- Users and groups; connection, file-transfer and login audit logs with filters.
- Server Ops: service status, restarts, log tails, key rotation.
- Self-update from GitHub releases through the Cockpit bridge.
- 13 themes, persisted per user.

### Security

- Content security policy `default-src 'self'; connect-src 'self'`: the page
  cannot reach a remote host directly. API traffic goes through the Cockpit
  bridge; the update check goes through `cockpit.spawn(curl)`.
- No secret ever appears in an argv, an environment variable, a log line, the
  DOM or browser storage. SSH passwords reach `sshpass` over a pipe; the DuckDNS
  token reaches `curl` through a 0600 root-only config file that is deleted on
  every exit path; stored credentials live in 0600 sidecar files, never inside a
  server record.
- The privileged helper redacts every known form of a registered secret from
  every line it emits.
- API responses are rendered as text only. There is no `x-html` in the codebase.
