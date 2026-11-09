#!/usr/bin/env python3
"""Detect ORBI data in the Orange Rails production database.

ORBI keeps its data in its own project and must not leave any in the Orange Rails
production database. This check reports a problem if any watched ORBI relation
exists there with rows in it, or exists as a view, materialized view or foreign
table.

It reads catalog and statistics views only (pg_class, pg_namespace and
pg_stat_user_tables). It never reads the rows of a watched table, so it adds
almost no IO. The statistics are estimates, not counts: a table can read zero
until the next analyze or autovacuum if its statistics were reset.

The connection string comes from ORANGERAILS_PROD_DB_URL in the environment.
The session is read-only, with a 10 second connect timeout, a 10 second
statement timeout and a 2 second lock timeout.

Exit codes:
  0  every watched ORBI relation is absent or empty, and both control tables
     were found, so the query ran against the right database.
  1  a watched ORBI relation holds rows, or is a view, materialized view or
     foreign table. Each one is printed with its schema.
  2  the check could not complete: no connection string, connection failure,
     timeout, a control table missing, or any unexpected error. This is never a
     clean result, because being unable to check is not evidence of absence.
"""
import os
import sys

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2 is not installed", file=sys.stderr)
    sys.exit(2)

# ORBI relations that must hold no rows in this database: the economic-data
# tables first, then the exchange-rate tables and the pair inventory view.
ORBI_RELATIONS = [
    "precious_metals_rates",
    "inflation_rates",
    "monetary_aggregates",
    "historical_money_prices",
    "wages",
    "source_terms_of_service",
    "exchange_rates",
    "exchange_rate_providers",
    "exchange_rate_resolutions",
    "orbi_pair_inventory_strength",
]

# Orange Rails tables that must always be present. If the query does not return
# them, it ran against the wrong database or the catalog was not readable, and an
# empty answer must not be mistaken for a clean one. Matched on presence only.
SENTINELS = ["waitlist", "adapter_requests"]

# relkind values that raise the alarm whatever their row estimates say:
# materialized view, view and foreign table. A view has no rows of its own to
# count, so its existence is the signal.
VIEW_LIKE = ("m", "v", "f")

SQL = """
SELECT n.nspname AS schema,
       c.relname AS name,
       c.relkind AS kind,
       c.reltuples::bigint AS reltuples,
       COALESCE(s.n_live_tup, 0) AS n_live_tup
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.relkind IN ('r', 'p', 'm', 'v', 'f')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND c.relname = ANY(%(names)s)
ORDER BY n.nspname, c.relname
"""

SESSION_OPTIONS = (
    "-c default_transaction_read_only=on"
    " -c statement_timeout=10000"
    " -c lock_timeout=2000"
)


def main():
    dsn = os.environ.get("ORANGERAILS_PROD_DB_URL")
    if not dsn:
        print("ERROR: ORANGERAILS_PROD_DB_URL is not set", file=sys.stderr)
        return 2

    queries_run = 0
    conn = None
    try:
        conn = psycopg2.connect(dsn, options=SESSION_OPTIONS, connect_timeout=10)
        with conn:
            with conn.cursor() as cur:
                cur.execute(SQL, {"names": ORBI_RELATIONS + SENTINELS})
                rows = cur.fetchall()
                queries_run += 1
    except psycopg2.OperationalError as exc:
        # Connection, authentication, timeout or cancellation. libpq reports these
        # with the host and user, never the password.
        reason = " ".join(str(exc).split())
        print(
            f"ERROR: check did not complete, queries run {queries_run} of 1: {reason}",
            file=sys.stderr,
        )
        return 2
    except Exception as exc:
        # Class name only. A malformed connection string error can quote the
        # string, and the string carries the password.
        print(
            f"ERROR: check did not complete, queries run {queries_run} of 1: "
            f"{type(exc).__name__}",
            file=sys.stderr,
        )
        return 2
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    found = {row[1] for row in rows}
    missing = [name for name in SENTINELS if name not in found]
    if missing:
        print(
            f"ERROR: control table(s) not found: {', '.join(missing)}. "
            "Wrong database, wrong role, or catalog not readable.",
            file=sys.stderr,
        )
        return 2

    offenders = []
    for schema, name, kind, reltuples, n_live_tup in rows:
        if name in SENTINELS:
            continue
        reasons = []
        if kind in VIEW_LIKE:
            reasons.append("view, materialized view or foreign table")
        if n_live_tup > 0 or reltuples > 0:
            reasons.append("rows present")
        if reasons:
            offenders.append(
                f"  {schema}.{name}: relkind={kind}, n_live_tup={n_live_tup}, "
                f"reltuples={reltuples} ({'; '.join(reasons)})"
            )

    if offenders:
        print(
            "FAIL: ORBI data is present in the Orange Rails production database "
            f"({len(offenders)} relation(s), queries run {queries_run} of 1):"
        )
        print("\n".join(offenders))
        return 1

    print(
        "OK: no ORBI relation holds rows in the Orange Rails production database "
        f"(queries run {queries_run} of 1, control tables found "
        f"{len(SENTINELS)} of {len(SENTINELS)})"
    )
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception as exc:
        # An uncaught Python error exits 1, which would read as "ORBI data present".
        print(f"ERROR: unexpected {type(exc).__name__}", file=sys.stderr)
        code = 2
    sys.exit(code)
