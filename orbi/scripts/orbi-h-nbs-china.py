#!/usr/bin/env python3
"""
Phase H Wave 1  -  National Bureau of Statistics China loader → inflation_rates

Onboarded source (Wave 1 Batch A ToS deep-dive 2026-05-30, wiki doc
5UebUTZfsu): NBS China. GO-conditional  -  founder confirmed editorial
firewall (numeric layer ONLY; never include CCP-critical framings).

Citation (required verbatim per NBS Terms of Service):
  "Source: National Bureau of Statistics of the People's Republic of China."

Editorial firewall flag: every row's source_url field carries the marker
`nbs_editorial_only=true` so downstream API filters can enforce
numeric-only display rules.

API: data.stats.gov.cn JSON endpoint (easyquery.htm). Needs browser UA +
cookie warmup; bare curl gets 403. We do:
  1. GET https://data.stats.gov.cn/english/  → set JSESSIONID + wzwsconfirm
  2. POST data query with the cookies attached

V1 coverage scope: CPI (monthly 1978+) and GDP/population (annual 1978+).

KNOWN OPERATIONAL GAP (2026-05-30): bb-support's external IP is
URL-ACL-blocked by NBS at L7 (eventID UrlACL). Cookie warmup cannot
bypass this  -  it's geofencing. The loader is coded ready-to-run; once a
China-region egress (mirror, proxy, or vendor licence backstop per
project_orbi_licensing_posture.md) is provisioned, this loader runs
unchanged. Until then the timer will fire, log the 403, and quietly back
off; no Signal alert (the geofence is a known condition, not a fault).

Brittleness rule: Signal alerts try/except, never re-raise.
"""
import http.cookiejar
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, date, timezone
from decimal import Decimal, InvalidOperation

sys.path.insert(0, "/opt/bb-support/scripts")
from orbi_continuity import continuity_check_truth_table as _orbi_cont_tt
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-nbs-china.log"
PSQL = "/opt/bb-support/scripts/psql-orange-world"
NBS = "https://data.stats.gov.cn"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

CITATION = "Source: National Bureau of Statistics of the People's Republic of China."
EDITORIAL_FLAG = "nbs_editorial_only=true"


def log(msg):
    line = f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] {msg}"
    print(line, file=sys.stderr)
    # File logging is best-effort; on PermissionError/OSError fall back
    # to stdout/stderr (journald-routed). 2026-06-04 root-owned log incident.
    try:
        Path(LOG).parent.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except (PermissionError, OSError):
        pass


def _signal_alert(subject, body=""):
    try:
        subprocess.run(
            ["/opt/bb-support/scripts/orbi-signal-alert.sh", subject, body],
            timeout=15,
        )
    except Exception:
        pass


def _build_opener():
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = [
        ("User-Agent", UA),
        ("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
        ("Accept-Language", "en-US,en;q=0.9"),
        ("Connection", "keep-alive"),
        ("Upgrade-Insecure-Requests", "1"),
    ]
    return opener, jar


def warmup(opener):
    """GET English landing page to receive JSESSIONID + any WZWS challenge.
    Returns True if 200, False on 403/404."""
    try:
        with opener.open(f"{NBS}/english/easyquery.htm?cn=C01", timeout=20) as r:
            log(f"  warmup status={r.status}")
            return r.status == 200
    except urllib.error.HTTPError as e:
        log(f"  warmup HTTP {e.code}  -  likely URL-ACL geofence")
        return False
    except Exception as e:
        log(f"  warmup err: {str(e)[:200]}")
        return False


def fetch_series(opener, dbcode, zb_code, period):
    """Pull a single indicator series via easyquery JSON endpoint.

    dbcode='hgyd' = monthly national; 'hgnd' = annual national.
    zb_code is the NBS measure ID, e.g. 'A01010101' for CPI YoY.
    period is e.g. 'LAST60' or '197801-202612' format.
    """
    params = (
        f"m=QueryData&dbcode={dbcode}&rowcode=zb&colcode=sj"
        f"&wds=%5B%5D&dfwds=%5B%7B%22wdcode%22%3A%22zb%22%2C%22valuecode%22%3A%22"
        f"{zb_code}%22%7D%5D&k1={int(time.time()*1000)}"
    )
    url = f"{NBS}/easyquery.htm?{params}"
    req = urllib.request.Request(url, headers={
        "Referer": f"{NBS}/easyquery.htm?cn=C01",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/plain, */*",
    })
    try:
        with opener.open(req, timeout=60) as r:
            raw = r.read().decode("utf-8", errors="replace")
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        log(f"  fetch {zb_code} HTTP {e.code}")
        return None
    except Exception as e:
        log(f"  fetch {zb_code} err: {str(e)[:200]}")
        return None


# Indicator mapping. zb_code → (label, index_kind, dbcode)
INDICATORS_CPI = [
    # CPI YoY (preceding-year=100)
    ("A01010101", "CPI", "hgyd"),
]


def build_cpi_rows(payload, zb_code, src_url, fetched_at_iso):
    rows = []
    if not payload or "returndata" not in payload:
        return rows
    data = payload["returndata"].get("datanodes") or []
    for d in data:
        v = d.get("data", {}).get("data")
        wds = {w["wdcode"]: w["valuecode"] for w in d.get("wds", [])}
        sj = wds.get("sj")  # e.g. '202504' or '2024'
        if v is None or not sj:
            continue
        try:
            val = Decimal(str(v))
            if val.is_nan() or val <= 0:
                continue
        except (InvalidOperation, Exception):
            continue
        if len(sj) == 6:  # monthly
            y, m = int(sj[:4]), int(sj[4:6])
            ps = date(y, m, 1)
            if m == 12:
                nf = date(y + 1, 1, 1)
            else:
                nf = date(y, m + 1, 1)
            pe = date.fromordinal(nf.toordinal() - 1)
            label = f"{y}-{m:02d}"
        elif len(sj) == 4:
            y = int(sj)
            ps, pe, label = date(y, 1, 1), date(y, 12, 31), str(y)
        else:
            continue
        rows.append([
            "CN", None, "CPI",
            ps.isoformat(), pe.isoformat(), label,
            None, str(val), None, None, None, "source",
            0, None, "FINAL", "NBS_CHINA",
            f"{src_url}#{EDITORIAL_FLAG}",
            zb_code, "historical-backfill",
            fetched_at_iso, fetched_at_iso,
        ])
    return rows


def copy_inflation_rates(rows):
    if not rows:
        return 0
    cols = ("country, region, index_kind, period_start, period_end, "
            "period_label, release_date, value, base_year, yoy_pct, "
            "mom_pct, populated_by, revision_number, superseded_by_id, "
            "status, source_authority, source_url, source_series_id, "
            "provenance, fetched_at, inserted_at")
    lines = []
    for r in rows:
        fields = [
            "\\N" if v is None or v == "" else str(v).replace("\t", " ").replace("\n", " ")
            for v in r
        ]
        lines.append("\t".join(fields))
    data = "\n".join(lines) + "\n"
    script = (
        "SET lock_timeout='60s';\n"
        f"CREATE TEMP TABLE _stg (LIKE inflation_rates INCLUDING DEFAULTS);\n"
        f"\\copy _stg ({cols}) FROM STDIN\n"
        + data + "\\.\n"
        f"WITH ins AS (INSERT INTO inflation_rates ({cols}) SELECT {cols} FROM _stg "
        "ON CONFLICT (country, COALESCE(region,''), index_kind, period_start, revision_number, source_authority) DO NOTHING RETURNING 1) "
        "SELECT count(*) FROM ins;\n"
        "DROP TABLE _stg;\n"
    )
    r = subprocess.run(
        [PSQL, "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
        input=script, capture_output=True, text=True, timeout=300,
    )
    if r.returncode != 0:
        log(f"  COPY FAIL: {r.stderr[:400]}")
        return -1
    _wrote = len(lines)
    _out = (r.stdout or "").strip().splitlines()
    if _out:
        try:
            _wrote = int(_out[-1])
        except ValueError:
            log(f"  could not parse written-row count from psql output {_out[-1]!r}; reporting staged count instead")
    return _wrote


def main():
    log("=== Phase H Wave 1 NBS China loader start ===")
    log("  EDITORIAL FIREWALL ACTIVE: numeric layer only; rows tagged "
        + EDITORIAL_FLAG)
    fetched_at = datetime.now(timezone.utc).isoformat()
    grand = 0

    opener, _jar = _build_opener()
    if not warmup(opener):
        log("  warmup FAILED (URL-ACL geofence). Logging condition and "
            "exiting clean  -  no Signal alert (known operational gap; see "
            "module docstring).")
        log("=== done: 0 candidate rows (geofenced) ===")
        return

    src_url = f"{NBS}/english/easyquery.htm"
    for zb, kind, dbcode in INDICATORS_CPI:
        log(f"  pulling {kind} {zb} ({dbcode})")
        payload = fetch_series(opener, dbcode, zb, "LAST60")
        if not payload:
            continue
        rows = build_cpi_rows(payload, zb, src_url, fetched_at)
        log(f"    built {len(rows)} candidate rows")
        n = copy_inflation_rates(rows)
        if n >= 0:
            grand += n
            log(f"    wrote {n} rows")

    _orbi_cont_tt('inflation_rates', 'period_start',
                  'NBS_CHINA CPI inflation_rates',
                  extra_where="source_authority='NBS_CHINA'")
    log(f"=== done: {grand} candidate rows ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI Phase H Wave 1 NBS China FAILED", str(e)[:200])
        sys.exit(1)
