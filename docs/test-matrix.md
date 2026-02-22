# test matrix

## dimensions

- feature
- operation: create, alter, drop, idempotent-reapply, rollback-on-error
- dialect: postgres, sqlite
- postgres version: 14, 15, 16, 17

## status key

- `covered`: has tests in repo
- `partial`: tests exist but missing one or more operations or version breadth
- `gap`: no test yet

## current feature matrix

| feature | postgres | sqlite | notes |
|---|---|---|---|
| tables | covered | covered | broad base tests present |
| columns | covered | covered | includes many conversion cases |
| constraints | covered | covered | includes fk/check/unique paths |
| indexes | covered | covered | includes partial/expression in pg |
| views | covered | covered | sqlite view coverage exists |
| schemas | covered | gap | sqlite unsupported by design |
| enums | covered | gap | sqlite unsupported by design |
| sequences | covered | gap | sqlite unsupported by design |
| functions | covered | gap | sqlite unsupported by design |
| procedures | covered | gap | sqlite unsupported by design |
| triggers | covered | covered | sqlite trigger support tested |
| materialized views | covered | gap | sqlite unsupported by design |
| extensions | covered | gap | pgvector/postgis tests present |
| advisory locks | covered | gap | sqlite unsupported by design |
| cli contract | partial | partial | json/no-color added, more cases needed |
| deterministic output | partial | partial | json format added, snapshot depth pending |
| parser robustness | partial | partial | malformed corpus and random ascii fuzz added |
| performance budgets | partial | partial | perf tests exist, gate script pending |
| flake rerun gate | partial | partial | script/workflow added, trend tracking pending |

## version matrix target

| lane | postgres versions | sqlite |
|---|---|---|
| pr | 14, 17 | yes |
| nightly | 14, 15, 16, 17 | yes |
| release | 14, 17 + extension suites | yes |

## explicit gaps backlog

1. deterministic json snapshots for `plan` and `apply` across pg/sqlite
2. per-feature rollback-on-error assertions for all core objects
3. parser fuzz corpus and triage automation
4. pg version-variance map with expected diffs
5. perf gate thresholds encoded in script
