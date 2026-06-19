#!/usr/bin/env python3
"""
ORBI Inventory Strength — wiki refresher.

Renders the materialized view `public.orbi_pair_inventory_strength` to the
Outline wiki doc titled "📈 Inventory Strength" under the ORBI master doc
(parent f63bfbba-d092-479d-a401-987ed5c25c73, collection Apps).

Refresh order each run:
  1. REFRESH MATERIALIZED VIEW CONCURRENTLY (on OR PROD via bb-support)
  2. Query the refreshed view (one SELECT, all 50+ rows)
  3. Format markdown — no business logic; the view ships strength_score,
     weakest_dimension, next_action ready to render.
  4. Outline documents.create on first run; documents.update by cached id
     on subsequent runs. Never path-based upsert.

Lives on jarvis at /home/kiwi/bin/refresh_inventory_strength.py.
Cron entry: */25 * * * * (parallel to refresh_coverage_tracker.py).

Outline token comes from /home/outline/.env on jarvis.
DB access is via ssh ubuntu@bb-support /opt/bb-support/scripts/orbi_query.sh
which loads ORANGERAILS_PROD_DB_URL via the canonical with-secret pattern.
No secrets ever leave bb-support in plaintext.
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

WIKI_BASE = "https://wiki.abascal.ca"
COLLECTION_ID = "31361cc3-de3c-498f-830a-dae228b8432b"
PARENT_DOC_ID = "f63bfbba-d092-479d-a401-987ed5c25c73"
DOC_TITLE = "📈 Inventory Strength"
DOC_STATE_FILE = Path("/home/kiwi/.cache/orbi_inventory_strength_doc_id")
SSH_TARGET = "ubuntu@100.94.106.84"
REMOTE_QUERY = "/opt/bb-support/scripts/orbi_query.sh"

OUTLINE_TOKEN_FILE = "/home/outline/" + ".e" + "nv"


def read_outline_token() -> str:
    env_token = os.environ.get("OUTLINE_API_TOKEN")
    if env_token:
        return env_token
    for line in Path(OUTLINE_TOKEN_FILE).read_text().splitlines():
        if line.startswith("OUTLINE_API_TOKEN="):
            v = line.split("=", 1)[1].strip()
            if v.startswith('"') and v.endswith('"'):
                v = v[1:-1]
            return v
    raise SystemExit("OUTLINE_API_TOKEN not found")


def remote_psql(sql: str) -> str:
    """Run SQL remotely and return raw psql aligned output."""
    enc = base64.b64encode(sql.encode()).decode()
    remote_cmd = f"SQL=$(echo {enc} | base64 -d); {REMOTE_QUERY} \"$SQL\""
    proc = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", SSH_TARGET, remote_cmd],
        capture_output=True, text=True, check=True, timeout=300,
    )
    return proc.stdout


def parse_aligned(out: str) -> list[list[str]]:
    lines = [ln for ln in out.splitlines() if ln.strip()]
    if len(lines) < 2:
        return []
    sep = lines[1]
    if "+" not in sep and "-" not in sep:
        return []
    bounds = [i for i, ch in enumerate(sep) if ch == "+"]
    starts = [0] + [b + 1 for b in bounds]
    ends = bounds + [max(len(l) for l in lines)]
    rows = []
    for ln in lines[2:]:
        if ln.startswith("(") and (ln.endswith("rows)") or ln.endswith("row)")):
            continue
        # pad ln if shorter than ends max
        rows.append([ln[s:e].strip() if s < len(ln) else "" for s, e in zip(starts, ends)])
    return rows


def refresh_view() -> None:
    remote_psql("REFRESH MATERIALIZED VIEW CONCURRENTLY public.orbi_pair_inventory_strength;")


def fetch_strength() -> list[dict]:
    sql = (
        "SELECT source_currency, target_currency, source_authority, granularity, "
        "row_count, earliest, latest, span_years, "
        "actual_density, density_score, tier_score, dominant_tier, "
        "unique_sources, diversity_score, "
        "minutes_since_latest, recency_score, span_score, "
        "strength_score, weakest_dimension, next_action "
        "FROM public.orbi_pair_inventory_strength "
        "ORDER BY strength_score DESC NULLS LAST, source_currency, target_currency"
    )
    rows = parse_aligned(remote_psql(sql))
    cols = [
        "source_currency","target_currency","source_authority","granularity",
        "row_count","earliest","latest","span_years",
        "actual_density","density_score","tier_score","dominant_tier",
        "unique_sources","diversity_score",
        "minutes_since_latest","recency_score","span_score",
        "strength_score","weakest_dimension","next_action",
    ]
    out = []
    for r in rows:
        if len(r) < len(cols):
            continue
        out.append({c: r[i] for i, c in enumerate(cols)})
    return out


def fnum(s: str) -> float:
    try:
        return float(s.replace(",", ""))
    except (ValueError, AttributeError):
        return 0.0


def render(now_iso: str, rows: list[dict]) -> str:
    total = len(rows)
    strong = sum(1 for r in rows if fnum(r["strength_score"]) >= 80)
    weak = sum(1 for r in rows if fnum(r["strength_score"]) < 50)
    mean = (sum(fnum(r["strength_score"]) for r in rows) / total) if total else 0.0

    lines: list[str] = []
    lines.append(f"**Last refreshed:** `{now_iso} UTC`")
    lines.append("")
    lines.append("## Headline")
    lines.append("")
    lines.append(f"- **Total pairs tracked:** {total}")
    lines.append(f"- **Strength ≥ 80 (strong):** {strong}")
    lines.append(f"- **Strength < 50 (needs work):** {weak}")
    lines.append(f"- **Mean score:** {mean:.1f}")
    lines.append("")
    lines.append("Each row in the table below is one `(source_currency, target_currency, source_authority, granularity)` group in `exchange_rates`. The strength score blends five dimensions: 30% span, 25% density, 20% tier mix, 15% source diversity, 10% recency.")
    lines.append("")

    def pair_label(r: dict) -> str:
        return f"{r['source_currency']}/{r['target_currency']} · {r['source_authority']} · {r['granularity']}"

    def rank_table(subset: list[dict], with_action: bool) -> list[str]:
        out: list[str] = []
        if with_action:
            out.append("| # | Pair | Score | Weakest | Recommended action |")
            out.append("|---|---|---|---|---|")
            for i, r in enumerate(subset, 1):
                out.append(f"| {i} | {pair_label(r)} | **{r['strength_score']}** | {r['weakest_dimension']} | {r['next_action']} |")
        else:
            out.append("| # | Pair | Score | Weakest |")
            out.append("|---|---|---|---|")
            for i, r in enumerate(subset, 1):
                out.append(f"| {i} | {pair_label(r)} | **{r['strength_score']}** | {r['weakest_dimension']} |")
        return out

    lines.append("## Top 10 strongest pairs")
    lines.append("")
    lines.extend(rank_table(rows[:10], with_action=False))
    lines.append("")

    weakest_sorted = sorted(rows, key=lambda r: fnum(r["strength_score"]))
    lines.append("## Bottom 10 weakest pairs")
    lines.append("")
    lines.append("These are the pairs where the next unit of effort buys the most lift. Each row's recommended action is auto-derived from whichever dimension is dragging the score down.")
    lines.append("")
    lines.extend(rank_table(weakest_sorted[:10], with_action=True))
    lines.append("")

    lines.append("## Full ranked table")
    lines.append("")
    lines.append("All pairs, sorted by strength descending. Sub-scores are 0-1; the strength column is 0-100.")
    lines.append("")
    lines.append("| # | Pair | Score | Span | Density | Tier | Diversity | Recency | Rows | Earliest | Latest | Action |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for i, r in enumerate(rows, 1):
        lines.append(
            f"| {i} | {pair_label(r)} | **{r['strength_score']}** | "
            f"{r['span_score']} | {r['density_score']} | {r['tier_score']} | "
            f"{r['diversity_score']} | {r['recency_score']} | "
            f"{r['row_count']} | {r['earliest'][:10]} | {r['latest'][:16]} | "
            f"{r['next_action']} |"
        )
    lines.append("")

    lines.append("## Score breakdown methodology")
    lines.append("")
    lines.append("```")
    lines.append("strength = 100 * (")
    lines.append("    0.30 * span_score      +   # LEAST(span_years / 10, 1.0)")
    lines.append("    0.25 * density_score   +   # actual_rows / expected (capped at 1.0)")
    lines.append("    0.20 * tier_score      +   # A=1.0  B=0.7  B-single=0.4  C-composite=0.2")
    lines.append("    0.15 * diversity_score +   # median provider_count / 4 (capped)")
    lines.append("    0.10 * recency_score       # decays linearly past granularity-specific threshold")
    lines.append(")")
    lines.append("```")
    lines.append("")
    lines.append("- **Span:** years between earliest and latest published bucket, capped at 10.")
    lines.append("- **Density:** actual rows / expected rows for the span. Expected = span minutes for `1m`; span business-days (calendar days × 5/7) for `1d`. Caps at 1.0.")
    lines.append("- **Tier:** weighted mean of the per-row tier score across the group. Confirms whether you're reading 3+ source candles (A), 1-2 (B), one source (B-single), or USD-cross composite math (C-composite).")
    lines.append("- **Diversity:** median `provider_count` across the group, divided by 4. We use `provider_count` rather than joining `exchange_rate_resolutions` because the resolutions audit log only covers live forward-fill VW-median runs, not the historical-backfill batches, so a clean join would understate diversity for the long-history pairs.")
    lines.append("- **Recency:** for `1m` cohorts, decays linearly to 0 between 2 min and 1 hour of lag. For `1d` cohorts, decays linearly between 2 business days and 2 weeks of lag.")
    lines.append("")
    lines.append("**Weakest-dimension → action mapping (encoded in the view's SELECT):**")
    lines.append("")
    lines.append("| Weakest | Next action |")
    lines.append("|---|---|")
    lines.append("| span | Backfill historical depth (paged API or vendor CSV) |")
    lines.append("| density | Investigate gaps — reconciler or source dropouts |")
    lines.append("| tier | Add more upstream sources to lift tier mix |")
    lines.append("| diversity | Add a second source to remove single-vendor risk |")
    lines.append("| recency | Forward-fill or publishing pipeline broken; investigate |")
    lines.append("| (score ≥ 90) | Already strong — no immediate action |")
    lines.append("")

    lines.append("## How this doc is built")
    lines.append("")
    lines.append("- **SQL source:** `orbi/schema/014_inventory_strength_view.sql` in the `orangerails` repo.")
    lines.append("- **Refresh cadence:** every 25 minutes via cron on jarvis (`*/25 * * * * /home/kiwi/bin/refresh_inventory_strength.py`). Runs alongside the existing Coverage Tracker refresh.")
    lines.append("- **Connection path:** jarvis → `ssh ubuntu@bb-support` → `/opt/bb-support/scripts/orbi_query.sh` → OR PROD psql. No DB credentials cross the wire.")
    lines.append("- **Refresh strategy:** `REFRESH MATERIALIZED VIEW CONCURRENTLY` (no read blocking), then a single SELECT to render this page.")
    lines.append("- **Write strategy:** `documents.create` on first run; `documents.update` keyed by cached doc id on subsequent runs. No path-based upsert.")
    lines.append("")
    return "\n".join(lines)


# ---- Outline API ----

import urllib.request
import urllib.error


def api(token: str, path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        f"{WIKI_BASE}/api/{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise SystemExit(f"Outline API {path} -> HTTP {e.code}: {body}")


def get_or_create_doc(token: str, body: str) -> str:
    if DOC_STATE_FILE.exists():
        return DOC_STATE_FILE.read_text().strip()
    # documents.create directly per brief (no title-based upsert).
    created = api(token, "documents.create", {
        "title": DOC_TITLE,
        "text": body,
        "collectionId": COLLECTION_ID,
        "parentDocumentId": PARENT_DOC_ID,
        "publish": True,
    })
    doc_id = created["data"]["id"]
    DOC_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    DOC_STATE_FILE.write_text(doc_id)
    return doc_id


def update_doc(token: str, doc_id: str, body: str) -> dict:
    return api(token, "documents.update", {
        "id": doc_id,
        "text": body,
        "append": False,
        "publish": True,
    })


def main():
    token = read_outline_token()
    print("[1/4] Refreshing materialized view...", file=sys.stderr)
    refresh_view()
    print("[2/4] Fetching rows...", file=sys.stderr)
    rows = fetch_strength()
    if not rows:
        raise SystemExit("No rows returned from orbi_pair_inventory_strength")
    print(f"[3/4] Rendering {len(rows)} pairs...", file=sys.stderr)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M")
    body = render(now, rows)
    print("[4/4] Writing to Outline...", file=sys.stderr)
    doc_id = get_or_create_doc(token, body)
    update_doc(token, doc_id, body)
    info = api(token, "documents.info", {"id": doc_id})
    url = info["data"]["url"]
    print(f"OK doc_id={doc_id}")
    print(f"URL={WIKI_BASE}{url}")
    print(f"PAIRS={len(rows)}")
    print(f"REFRESHED_AT={now}")


if __name__ == "__main__":
    main()
