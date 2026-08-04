# Changelog

All notable changes to Pilot are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Pilot uses
[semantic versioning](https://semver.org/) — `VERSION` is the single source of
truth, read by the Makefile and by the self-updater.

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
