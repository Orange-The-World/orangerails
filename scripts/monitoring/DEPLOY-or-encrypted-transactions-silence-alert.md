# Deploy: or-encrypted-transactions-silence-alert

Part of OR-E0022. Run these steps on bb-us after PR is merged to dev.
Requires shell access (CTO or SP seat).

## 1. Install the script

```bash
cp scripts/monitoring/or-encrypted-transactions-silence-alert ~/.local/bin/
chmod +x ~/.local/bin/or-encrypted-transactions-silence-alert
```

## 2. Create the credentials file

Populate the EnvironmentFile with the prod Supabase token and sre-bot Zulip credentials.
Never commit the file; keep it at mode 600.

```bash
mkdir -p ~/.config/or-alerts
# Populate with the four required keys (do not print values):
# ORANGERAILS_PROD_ACCESS_TOKEN=<from BB-SUPPORT vault: ORANGERAILS_PROD_ACCESS_TOKEN>
# ZULIP_SITE=https://waggle.orangerails.com
# ZULIP_EMAIL=<sre-bot email from /home/ubuntu/orgs/orangerails/agents/sre/.zuliprc>
# ZULIP_KEY=<sre-bot key from same .zuliprc>
chmod 600 ~/.config/or-alerts/encrypted-transactions.env
```

## 3. Install systemd units

```bash
cp scripts/monitoring/or-encrypted-transactions-silence-alert.service \
   scripts/monitoring/or-encrypted-transactions-silence-alert.timer \
   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now or-encrypted-transactions-silence-alert.timer
```

## 4. Test acceptance criteria

```bash
# Should exit 1 and log ALERT (prod table is 23+ days silent as of 2026-11-04):
systemctl --user start or-encrypted-transactions-silence-alert.service
journalctl --user -u or-encrypted-transactions-silence-alert.service -n 20

# Check Zulip #or-connectors for the alert post.
# When prod data resumes, run again -- expect OK exit 0.
```

## 5. Verify timer is active

```bash
systemctl --user list-timers or-encrypted-transactions-silence-alert.timer
```
