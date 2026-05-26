# ORBI ops — supervisor + alerting

Two operational reliability layers for ORBI, both live on **bb-support**:

1. **Forward-fill systemd supervisor** — keeps `forward-fill.ts` running across
   crashes and reboots, with structured logging via journald.
2. **Reconciler crash alerting** — when the 5-minute reconciler cron job exits
   non-zero, push a Signal message to the founder via the local signal-cli
   REST API.

Neither is auto-installed by this repo. Both ship as version-controlled scripts
plus a one-command installer / runbook so the founder can flip them on.

---

## 1. Forward-fill systemd supervisor

### What it does

- Runs `bun run scripts/forward-fill.ts` as a systemd service.
- Restarts on crash (`Restart=on-failure`, 15s back-off, max 10 restarts / 5min).
- Starts automatically on boot (`WantedBy=multi-user.target`).
- Logs go to both journald **and** `/tmp/orbi-forward-fill.log` (the existing
  log path stays compatible with anything that tails it).
- Hardened: `ProtectSystem=full`, read-only `/opt/bb-support`, memory cap 512M.

### Install (one command)

```bash
sudo /home/ubuntu/AIHUB/REPOS/orangerails/orbi/scripts/ops/install-systemd.sh
```

The installer is idempotent. It:

1. Prints the unit-file sha256 (sanity check).
2. Kills any existing manual `bun run scripts/forward-fill.ts` process so we
   don't double-publish.
3. Copies `orbi-forward-fill.service` into `/etc/systemd/system/`.
4. `daemon-reload`, `enable`, `restart`.
5. Verifies `is-active` and tails recent journald logs.

### Check status

```bash
systemctl status orbi-forward-fill
systemctl is-active orbi-forward-fill
```

### Read logs

```bash
# Live journald stream:
journalctl -u orbi-forward-fill -f

# Or the legacy log file:
tail -f /tmp/orbi-forward-fill.log
```

### Stop temporarily

```bash
sudo systemctl stop orbi-forward-fill
```

It will restart on boot. To disable permanently:

```bash
sudo systemctl disable --now orbi-forward-fill
```

### Roll back to nohup-style

```bash
sudo systemctl disable --now orbi-forward-fill
sudo rm /etc/systemd/system/orbi-forward-fill.service
sudo systemctl daemon-reload
# Then restart the old way:
cd /home/ubuntu/AIHUB/REPOS/orangerails/orbi
nohup bun run scripts/forward-fill.ts > /tmp/orbi-forward-fill.log 2>&1 &
```

---

## 2. Reconciler crash alerting

### What it does

Wraps `scripts/reconcile-gaps.ts`. Exit 0 → quiet. Non-zero exit → POSTs a
Signal message to the founder via the local signal-cli REST API
(`127.0.0.1:8090/v2/send`).

- Sender: `+15128818663` (the registered signal-cli account on bb-support).
- Recipient: `+17057123215` (founder).
- Payload includes the last 20 lines of `/tmp/orbi-reconciler.log` for context.
- Last API response is cached at `/tmp/orbi-alert-last.json` for debugging.

### Install (crontab swap — founder does this)

Open the crontab:

```bash
crontab -e
```

Replace the existing reconciler line:

```cron
*/5 * * * * sleep 30 && cd /home/ubuntu/AIHUB/REPOS/orangerails/orbi && bun run scripts/reconcile-gaps.ts >> /tmp/orbi-reconciler.log 2>&1
```

with:

```cron
*/5 * * * * sleep 30 && /home/ubuntu/AIHUB/REPOS/orangerails/orbi/scripts/ops/alert-on-failure.sh
```

(See also `RECONCILER_CRON.md` in this directory for the canonical line.)

### Smoke test

```bash
/home/ubuntu/AIHUB/REPOS/orangerails/orbi/scripts/ops/test-alert.sh
```

This:

1. Confirms signal-cli REST is reachable on `127.0.0.1:8090`.
2. Prints the JSON payload that **would** be sent, without sending it.
3. Verifies the wrapper exits non-zero when its inner command fails.

To actually trigger a real Signal alert (use sparingly):

```bash
DRY_RUN=0 bash -c 'cd /tmp && /home/ubuntu/AIHUB/REPOS/orangerails/orbi/scripts/ops/alert-on-failure.sh; echo done'
# (forces failure because /tmp has no orbi project)
```

### Roll back

Re-edit the crontab back to the original line. The wrapper is purely
additive — disabling it just means crashes go silent again.

---

## Files

| Path | Purpose |
|------|---------|
| `orbi-forward-fill.service` | systemd unit (canonical copy in repo) |
| `install-systemd.sh`        | one-command installer (requires sudo) |
| `alert-on-failure.sh`       | reconciler wrapper, sends Signal on crash |
| `test-alert.sh`             | dry-run smoke test of the alert path |
| `README.md`                 | this file |
| `RECONCILER_CRON.md`        | canonical crontab line for founder |

## Signal-cli endpoint reference

Validated `2026-05-26` on bb-support:

```
$ curl -sS http://127.0.0.1:8090/v1/about
{"versions":["v1","v2"],"build":2,"mode":"normal","version":"0.99",
 "capabilities":{"v2/send":["quotes","mentions"]}}

$ curl -sS http://127.0.0.1:8090/v1/accounts
["+15128818663"]
```

Endpoint shape: `POST /v2/send` with JSON body
`{message, number, recipients: [...]}`.
