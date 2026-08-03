# test matrix

## dimensions

- feature
- operation: create, alter, drop, idempotent-reapply, rollback-on-error
- dialect: postgres, sqlite
- postgres version: 14, 15, 16, 17, 18

## sqlite runtime baseline

- desired-schema parser, migration executor, and inspector: `libsql` 0.5.22 with SQLite 3.45.1
- desired schemas are parsed by the execution runtime so accepted grammar cannot exceed apply support

## status key

- `covered`: has tests in repo
- `partial`: tests exist but missing one or more operations or version breadth
- `gap`: no test yet

## current feature matrix

| feature | postgres | sqlite | notes |
|---|---|---|---|
| tables | covered | covered | broad base tests present |
| columns | covered | covered | includes many conversion cases |
| constraints | covered | partial | nested checks and unique-constraint lifecycle/rollback covered; names and conflict clauses remain under audit |
| indexes | covered | covered | includes partial/expression in pg |
| views | covered | covered | sqlite view coverage exists |
| schemas | covered | gap | sqlite unsupported by design |
| enums | covered | gap | sqlite unsupported by design |
| sequences | covered | gap | sqlite unsupported by design |
| functions | covered | gap | sqlite unsupported by design |
| procedures | covered | gap | sqlite unsupported by design |
| triggers | covered | covered | sqlite header metadata, body-DML separation, replacement, execution, and repeated reapply tested in memory and on disk |
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
| pr | 14, 18 | yes |
| nightly | 14, 15, 16, 17, 18 | yes |
| release | 14, 18 + extension suites | yes |

## explicit gaps backlog

1. add PostgreSQL 18 local, CI, snapshot, and release verification lanes
2. complete SQLite constraint-name, conflict-clause, and generated-column interaction coverage
3. add deterministic json snapshots for `plan` and `apply` across pg/sqlite
4. add per-feature rollback-on-error assertions for all core objects
5. add grammar-aware SQLite fuzzing against the bundled runtime
