#!/usr/bin/env python3
"""ORBI comprehensive audit — 5 sections.

A. Database inventory  : table+row counts across 6 local DBs + 3 cloud projects
B. Density matrix      : exchange_rates source/pair/granularity vs theoretical
C. Year coverage       : year-by-year rows per (source_authority, target_currency)
D. Truth catalog depth : earliest/latest/spans per truth table
E. Writer health       : active loaders + last-write age

Run via: with-secret.py --vars ORBI_PROD_DB_PASSWORD,ORANGE_WORLD_PROD_DB_PASSWORD
         -- orbi-comprehensive-audit.py
"""
import os
import subprocess
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

OUT_DIR = "/var/log/orbi/audits"
TS = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")


def _load_local_dsn():
    for line in open("/opt/bb-support/.env"):
        if line.startswith("ORBI_LOCAL_DB_URL="):
            v = line.split("=", 1)[1].strip()
            return v[1:-1] if v.startswith('"') else v


def _local_env(db_name):
    p = urllib.parse.urlparse(_load_local_dsn())
    return {
        "PGHOST": p.hostname, "PGPORT": str(p.port or 5432),
        "PGUSER": urllib.parse.unquote(p.username or ""),
        "PGPASSWORD": urllib.parse.unquote(p.password or ""),
        "PGDATABASE": db_name,
    }


def _cloud_env(ref, pw_var):
    pw = os.environ.get(pw_var)
    if not pw:
        return None
    return {
        "PGHOST": f"db.{ref}.supabase.co", "PGPORT": "5432",
        "PGUSER": "postgres", "PGPASSWORD": pw, "PGDATABASE": "postgres",
        "PGSSLMODE": "require", "PGCONNECT_TIMEOUT": "15",
    }


LOCAL_DBS = ["orbi_prod", "orange_world_prod", "orange_rails_prod",
             "orbi_dev", "orange_world_dev", "orange_rails_dev"]
CLOUD_PROJECTS = {
    "orbi-prod":         _cloud_env("sqcventmypowhbaceufy", "ORBI_PROD_DB_PASSWORD"),
    "orange-world-prod": _cloud_env("gposxxmxenrdvewrprle", "ORANGE_WORLD_PROD_DB_PASSWORD"),
    "orange-rails-prod": _cloud_env(
        (os.environ.get("ORANGERAILS_PROD_SUPABASE_URL", "")
            .replace("https://", "").replace(".supabase.co", "").rstrip("/")),
        "ORANGERAILS_PROD_DB_PASSWORD"
    ) if os.environ.get("ORANGERAILS_PROD_SUPABASE_URL") else None,
}


def q(env, sql, timeout=60):
    r = subprocess.run(["psql", "-At", "-F", "|", "-c", sql],
                       capture_output=True, text=True, timeout=timeout, env={**os.environ, **env})
    if r.returncode != 0:
        return None
    return r.stdout.strip()


def fmt(n):
    try: return f"{int(n):,}"
    except: return str(n)


def section_a_inventory():
    print("\n" + "=" * 80)
    print("A. DATABASE INVENTORY — 6 local DBs + 2 reachable cloud projects")
    print("=" * 80)

    print("\n--- LOCAL DBs on bb-support 127.0.0.1:5435 ---")
    for db in LOCAL_DBS:
        env = _local_env(db)
        # check if DB exists + accessible
        ok = q(env, "SELECT 1")
        if not ok:
            print(f"\n[{db}] — UNREACHABLE or empty")
            continue
        sz = q(env, "SELECT pg_size_pretty(pg_database_size(current_database()))")
        # Read-only row estimate from the statistics view. No ANALYZE: an audit
        # must not write planner statistics (OR-T2710 step 8, CTO ruling
        # 2026-11-16 15:07). n_live_tup is maintained by autovacuum/stats.
        tables = q(env, """
            SELECT relname, n_live_tup::bigint AS approx_rows
            FROM pg_stat_user_tables
            WHERE schemaname='public'
            ORDER BY relname
        """, timeout=30)
        print(f"\n[{db}]  size={sz}")
        if not tables:
            print("  (no tables)")
            continue
        any_populated = False
        for line in tables.split("\n"):
            if "|" not in line: continue
            name, n = line.split("|")
            try:
                n_int = int(n) if n else 0
            except Exception:
                n_int = 0
            if n_int > 0:
                print(f"  {name:40s} {fmt(n_int):>15s}")
                any_populated = True
        if not any_populated:
            print("  (no populated tables)")

    print("\n--- CLOUD projects (Supabase) ---")
    for name, env in CLOUD_PROJECTS.items():
        if not env:
            print(f"\n[{name}] — env var missing, skipping")
            continue
        ok = q(env, "SELECT 1", timeout=30)
        if not ok:
            print(f"\n[{name}] — UNREACHABLE")
            continue
        # Cloud: same read-only estimate, no ANALYZE (OR-T2710 step 8)
        tables = q(env, """
            SELECT relname, n_live_tup::bigint
            FROM pg_stat_user_tables
            WHERE schemaname='public'
            ORDER BY relname
        """, timeout=60)
        print(f"\n[{name}]")
        if tables:
            for line in tables.split("\n"):
                if "|" not in line: continue
                t, n = line.split("|")
                try:
                    n_int = int(n) if n else 0
                except Exception:
                    n_int = 0
                if n_int > 0:
                    print(f"  {t:40s} {fmt(n_int):>15s}")


def section_b_density():
    print("\n" + "=" * 80)
    print("B. DENSITY MATRIX — exchange_rates on orbi_prod (Completeness Map style)")
    print("=" * 80)
    env = _local_env("orbi_prod")
    # Now computes TWO density columns:
    #   theoretical %  — actual / full 1m-or-1d coverage over series span (the
    #                    "potential" if every minute had a trade — meaningful for
    #                    high-volume modern markets, misleading for sparse pairs)
    #   achievable %   — actual / max(actual) across peer sources for same
    #                    (target, granularity). 100% means "no peer source has
    #                    more rows than we do for this pair"; this is the cell
    #                    to trust for "is this a real gap or structural?"
    sql = """
        WITH bounds AS (
            SELECT source_authority, source_currency, target_currency, granularity, COUNT(*) AS actual,
                MIN(bucket_ts) AS first_ts,
                MAX(bucket_ts) AS last_ts,
                EXTRACT(EPOCH FROM (MAX(bucket_ts) - MIN(bucket_ts))) AS span_s
            FROM exchange_rates
            WHERE granularity IN ('1m','1d')
            GROUP BY 1,2,3,4
        ),
        peer_max AS (
            SELECT source_currency, target_currency, granularity, MAX(actual) AS peer_best
            FROM bounds GROUP BY 1,2,3
        )
        SELECT
            b.source_authority, b.target_currency, b.granularity,
            b.actual,
            CASE b.granularity
                WHEN '1m' THEN GREATEST(1, (b.span_s/60)::bigint)
                WHEN '1d' THEN GREATEST(1, (b.span_s/86400)::bigint)
            END AS theoretical,
            ROUND((b.actual * 100.0) / NULLIF(
                CASE b.granularity
                    WHEN '1m' THEN GREATEST(1, (b.span_s/60)::bigint)
                    WHEN '1d' THEN GREATEST(1, (b.span_s/86400)::bigint)
                END, 0
            ), 2) AS theor_pct,
            ROUND((b.actual * 100.0) / NULLIF(p.peer_best, 0), 2) AS achievable_pct
        FROM bounds b JOIN peer_max p USING (source_currency, target_currency, granularity)
        ORDER BY achievable_pct ASC, b.actual DESC
    """
    out = q(env, sql, timeout=600)
    if not out:
        print("  (query failed or timed out — try later when loaders are paused)")
        return
    print(f"\n  {'source':22s} {'pair':6s} {'gran':4s} {'actual':>12s} {'theor%':>8s} {'achiev%':>9s}")
    print("  " + "-" * 70)
    for line in out.split("\n"):
        parts = line.split("|")
        if len(parts) != 8: continue
        src, src_ccy, tgt, gran, actual, theor, theor_pct, achiev_pct = parts
        marker = ""
        try:
            a = float(achiev_pct)
            if a < 50: marker = " ⚠ real gap"
            if a < 20: marker = " ⚠⚠ big real gap"
            if a >= 95: marker = " ✓ ≈100% of available"
        except: pass
        print(f"  {src:22s} {src_ccy}/{tgt:6s} {gran:4s} {fmt(actual):>12s} {theor_pct:>7s}% {achiev_pct:>8s}%{marker}")


def section_c_year_coverage():
    print("\n" + "=" * 80)
    print("C. YEAR-BY-YEAR COVERAGE — exchange_rates per (source, target, year)")
    print("=" * 80)
    env = _local_env("orbi_prod")
    sql = """
        SELECT
            source_authority,
            target_currency,
            EXTRACT(YEAR FROM bucket_ts)::int AS yr,
            count(*) AS rows
        FROM exchange_rates
        WHERE source_authority IN ('KRAKEN','BITSTAMP','BITFINEX','COINBASE_EXCHANGE',
                                    'BITSO','MERCADO_BITCOIN','MEMPOOL_SPACE','ORBI')
          AND bucket_ts >= '2010-01-01'
        GROUP BY 1,2,3
        ORDER BY 1,2,3
    """
    out = q(env, sql, timeout=180)
    if not out:
        return
    grid = {}
    pairs = set()
    years = set()
    for line in out.split("\n"):
        p = line.split("|")
        if len(p) != 4: continue
        src, tgt, yr, n = p[0], p[1], int(p[2]), int(p[3])
        key = (src, tgt)
        pairs.add(key)
        years.add(yr)
        grid[(key, yr)] = n
    years = sorted(years)
    pairs = sorted(pairs)
    print(f"\n  {'pair':24s}", end="")
    for y in years:
        print(f" {y:>7d}", end="")
    print()
    print("  " + "-" * (24 + 8 * len(years)))
    for src, tgt in pairs:
        label = f"{src}/{tgt}"[:22]
        print(f"  {label:24s}", end="")
        for y in years:
            n = grid.get(((src, tgt), y), 0)
            if n == 0:
                cell = "   --- "
            elif n < 50_000:
                cell = f" {n:>6,}⚠"[:8]
            elif n < 400_000:
                cell = f" {n:>6,}"[:8]
            else:
                cell = f" {n:>6,}"
            print(cell, end="")
        print()


def section_d_truth_depth():
    print("\n" + "=" * 80)
    print("D. TRUTH CATALOG DEPTH — orange_world_prod")
    print("=" * 80)
    env = _local_env("orange_world_prod")
    tables = [
        ("inflation_rates", "country, index_kind", "period_start", "period_start"),
        ("historical_money_prices", "asset, quote_in", "year_start", "year_start"),
        ("wages", "country, measure", "period_start", "period_start"),
        ("monetary_aggregates", "country, aggregate", "period_start", "period_start"),
        ("precious_metals_rates", "source_metal, target_currency", "bucket_ts", "bucket_ts"),
        ("commodity_prices", "commodity, frequency", "period_start", "period_start"),
        ("bitcoin_network_metrics", "metric_name", "bucket_ts", "bucket_ts"),
    ]
    for table, dim, earliest_col, latest_col in tables:
        sql = f"""
            SELECT
                {dim} AS series,
                count(*) AS rows,
                MIN({earliest_col}) AS earliest,
                MAX({latest_col}) AS latest
            FROM {table}
            GROUP BY {dim}
            ORDER BY MIN({earliest_col})
            LIMIT 20
        """
        out = q(env, sql, timeout=60)
        if not out:
            continue
        print(f"\n[{table}]  (top 20 by earliest)")
        print(f"  {'series':45s} {'rows':>10s} {'earliest':>12s} {'latest':>12s}")
        for line in out.split("\n"):
            p = line.split("|")
            if len(p) < 4: continue
            ser = p[0][:43]
            print(f"  {ser:45s} {fmt(p[1]):>10s} {str(p[2])[:10]:>12s} {str(p[3])[:10]:>12s}")


def section_e_writer_health():
    print("\n" + "=" * 80)
    print("E. WRITER + SYNC HEALTH")
    print("=" * 80)

    out = subprocess.run(
        ["systemctl", "list-units", "--type=service", "--state=running",
         "--no-pager", "--no-legend"],
        capture_output=True, text=True
    ).stdout
    print("\nActive ORBI/forward-fill/sync services:")
    for line in out.splitlines():
        name = line.split()[0] if line.strip() else ""
        if any(k in name for k in ("orbi", "forward-fill", "sync")):
            print(f"  ✓ {name}")

    env = _local_env("orbi_prod")
    print("\nLast write age per source_authority (orbi_prod.exchange_rates):")
    out = q(env, """
        SELECT source_authority,
               EXTRACT(EPOCH FROM (now() - max(bucket_ts)))::bigint AS age_s,
               count(*) AS rows_total
        FROM exchange_rates
        GROUP BY 1
        ORDER BY age_s
    """, timeout=60)
    if out:
        for line in out.split("\n"):
            p = line.split("|")
            if len(p) != 3: continue
            src, age, n = p
            try:
                age_i = int(age)
                if age_i < 600: age_str = f"{age_i}s"
                elif age_i < 86400: age_str = f"{age_i // 60}m"
                else: age_str = f"{age_i // 86400}d"
            except: age_str = age
            print(f"  {src:22s} newest={age_str:>8s}  total={fmt(n):>12s}")


def main():
    Path(OUT_DIR).mkdir(parents=True, exist_ok=True)
    print(f"ORBI comprehensive audit @ {datetime.now(timezone.utc).isoformat(timespec='seconds')}")
    section_a_inventory()
    section_b_density()
    section_c_year_coverage()
    section_d_truth_depth()
    section_e_writer_health()
    print("\n" + "=" * 80)
    print(f"DONE — full output: /var/log/orbi/audits/comprehensive-{TS}.txt")
    print("=" * 80)


if __name__ == "__main__":
    main()
