# Lakebase — app state for the traffic what-if app

Application config, saved scenarios, run history, and audit. **All traffic data
lives in Unity Catalog** (`lanl.caltrans_traffic`) and is queried via DBSQL —
nothing here duplicates lakehouse data.

## Provisioned resources

| Property | Value |
|---|---|
| Project | `projects/caltrans-app` |
| Branch | `production` (default, READY) |
| Endpoint | `primary` — `ENDPOINT_TYPE_READ_WRITE`, ACTIVE |
| Database | `databricks_postgres` |
| Postgres version | **17.10** |
| Autoscaling | **0.5 – 2 CU** (tuned down from the 1/1 default) |
| Suspend timeout | 86400s — see [Known issues](#known-issues) |
| Role | `thomas.seufert@databricks.com` (`DATABRICKS_SUPERUSER`, auth `LAKEBASE_OAUTH_V1`) |

### Hosts

```
direct : ep-divine-mode-d23no6aj.database.us-east-1.cloud.databricks.com
pooled : ep-divine-mode-d23no6aj-pooler.database.us-east-1.cloud.databricks.com
```

> ⚠️ **Use the DIRECT host.** The `-pooler` host rejects Lakebase OAuth tokens
> with `SASL authentication failed`. Verified 2026-07-27: the direct host
> authenticates fine with the same freshly-minted token. If you need pooling,
> pool client-side (in the app) rather than via the pooler endpoint.

## Connecting

Credentials are **short-lived OAuth tokens used as the Postgres password** —
never a workspace PAT.

```bash
# mint a credential (~1 hour TTL)
databricks postgres generate-database-credential \
  projects/caltrans-app/branches/production/endpoints/primary -o json

export PGPASSWORD="<token>"
psql "host=ep-divine-mode-d23no6aj.database.us-east-1.cloud.databricks.com \
      port=5432 dbname=databricks_postgres \
      user=thomas.seufert@databricks.com sslmode=require"
```

Observed TTL is **~1 hour** (minted 14:09Z → expired 15:09Z). In the app,
recycle physical connections at ~45 min (`max_lifetime=2700`) or mint a fresh
credential per new physical connection. A pool that holds connections longer
than the token lifetime will fail mid-session.

## Applying the schema

```bash
psql "host=... sslmode=require" -v ON_ERROR_STOP=1 -f lakebase/schema.sql
```

`schema.sql` is idempotent (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`), so it
is safe to re-run and usable as a migration baseline.

## Schema

All objects live in the `app` schema.

| Table | Purpose |
|---|---|
| `app.config` | Key/value app config as `JSONB`. Seeded with catalog/schema pointers, default corridors, animation frame count, and BPR coefficients. |
| `app.scenarios` | Saved what-if scenarios. `levers JSONB` + GIN index so the lever vocabulary can evolve without migrations. |
| `app.scenario_runs` | One row per execution. Stores the KPI rollup (`kpis JSONB`), timing, and optional LLM `narrative` — not full results, which stay in / are recomputed from the lakehouse. |
| `app.audit` | Append-only user action log. |

`app.scenarios.updated_at` is maintained by the `trg_scenarios_touch` trigger.

### Lever shape

```json
{
  "closures":         [{"segment_id": 123, "lanes_blocked": 2}],
  "demand_deltas":    [{"corridor": "I-405", "direction": "N", "pct": 20}],
  "incidents":        [{"segment_id": 456, "severity": 3,
                        "start_hour": 7, "duration_min": 45}],
  "capacity_changes": [{"segment_id": 789, "new_capacity_vph": 2200}]
}
```

## Verified working (2026-07-27)

Smoke test run against the live endpoint, then rolled back:

- Connection + `SELECT version()` → PostgreSQL 17.10
- All 4 tables created; 6 config rows seeded
- Insert/return round-trip across `scenarios` → `scenario_runs` → `audit`,
  including the FK relationship
- GIN containment query `levers @> '{"closures":[{"segment_id":101}]}'` matched
- `updated_at` trigger fired on UPDATE

## Known issues

**Suspend timeout is stuck at 86400s (24h).** Autoscaling min/max updated fine
via `spec.autoscaling_limit_{min,max}_cu`, but every mask path tried for the
suspend timeout was rejected by the beta API:

- `suspend_timeout_duration` → `Unknown field path in update_mask`
- `spec.suspend_timeout_duration` → `Unknown field path in update_mask`
- `spec.settings.suspend_timeout_duration` → `unknown field`
- `spec.default_endpoint_settings.suspend_timeout_duration` (on the project) → `Unknown field path`

**Cost impact:** the endpoint will not scale to zero until 24h idle. It floors
at 0.5 CU rather than 0, so idle cost is ~0.5 CU continuously. Either set the
suspend timeout in the Databricks UI, or delete the project when the demo is
idle:

```bash
databricks postgres delete-project projects/caltrans-app
```

## App deployment ordering

⚠️ **Deploy the Databricks App before initializing schemas as a human user.**
The app service principal needs `CAN_CONNECT_AND_CREATE` and should own the
`app` schema. This schema was created by `thomas.seufert@databricks.com`, so
after the app is deployed grant its SP explicitly:

```sql
GRANT USAGE, CREATE ON SCHEMA app TO "<app-service-principal-id>";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA app TO "<app-service-principal-id>";
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT ALL ON TABLES TO "<app-service-principal-id>";
```

Skipping this is the documented #1 source of Lakebase `permission denied (42501)`
errors in deployed apps.

## Bundle resource binding

```yaml
- name: postgres          # `postgres`, NOT the retired `database` key
  postgres:
    branch:   projects/caltrans-app/branches/production
    database: projects/caltrans-app/branches/production/databases/databricks-postgres
    permission: CAN_CONNECT_AND_CREATE
```
