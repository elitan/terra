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
| tables | covered | covered | PostgreSQL inheritance is lifecycle-tested while structure-copying `LIKE` and typed `OF` shorthand fail before planning rather than becoming empty/partial tables; SQLite regular/FTS5/RTree virtual tables, shadow filtering, STRICT/WITHOUT ROWID, exact DDL, quoted identifiers, AUTOINCREMENT high-water preservation, changes, removal, and rollback covered in memory and on disk |
| columns | covered | covered | includes conversions plus SQLite VIRTUAL/STORED inspection, add, recreate, remove, rollback, and memory/file parity |
| constraints | covered | covered | PostgreSQL foreign-key MATCH FULL and NOT VALID state, omitted referenced-column inference, and CHECK NO INHERIT/NOT VALID state are lifecycle-tested on 14-17, including validation rollback and inheritance enforcement; implicit references resolve forward, composite, self, quoted, and schema-qualified primary keys while unresolvable external shorthand fails before planning; PostgreSQL 15+ ON DELETE column subsets are preserved while 14 rejects them before planning; MATCH SIMPLE normalizes to the default, failed validation rolls back, and unimplemented MATCH PARTIAL is rejected before planning; SQLite named inline/table constraints, collations, sort order, and ON CONFLICT behavior are preserved and change-detected |
| indexes | covered | covered | PostgreSQL per-key collations are preserved across parsing, inspection, comparison, generation, external creation, replacement, and idempotent reapply for column and expression indexes; same-name tables and indexes remain isolated across schemas, while indexes targeting undefined or ambiguously unqualified non-public tables fail before planning; SQLite mixed column/expression keys, collations, ASC/DESC ordering, partial predicates, planner use, recreation, rollback, and memory/file parity covered |
| views | covered | covered | PostgreSQL ordinary-view `check_option`, `security_barrier`, and PostgreSQL 15+ `security_invoker` options are parsed in every supported form, inspected, generated, behavior-tested, changed/reset without losing OIDs or dependents, rolled back, externally converged, and rejected before mutation on unsupported versions or values; ordinary and materialized view output-column lists are parsed, inspected, generated, renamed collision-safely without losing dependents or materialized rows, expanded/reduced, rolled back, and reapplied idempotently; materialized-view indexes preserve complete metadata through creation, inspection, external convergence, targeted replacement/removal, view recreation, schema isolation, and idempotent reapply; materialized-view population state, access methods, storage parameters, and tablespaces survive the full lifecycle, alter in place where the server supports it, fail before mutation on unsupported PostgreSQL versions, roll back transactionally, and converge idempotently; ordinary-view index targets fail before planning; SQLite full definitions, explicit column lists, replacement, recreation ordering, and rollback covered |
| schemas | covered | gap | sqlite unsupported by design |
| enums | covered | gap | sqlite unsupported by design |
| sequences | covered | gap | sqlite unsupported by design |
| functions | covered | gap | PostgreSQL `LEAKPROOF` and deterministic per-function `SET` configuration are parsed, inspected, behavior-tested, changed/reset with dependency-safe replacement, externally converged, rolled back, and reapplied idempotently; environment-capturing `SET FROM CURRENT`, SQL-standard bodies, linked-object bodies, `SUPPORT`, `WINDOW`, and `TRANSFORM` fail before planning while unmodeled; SQLite unsupported by design |
| procedures | covered | gap | PostgreSQL deterministic per-procedure `SET` configuration is parsed, inspected, behavior-tested, changed/reset with OID-preserving replacement, externally converged, rolled back, and reapplied idempotently; environment-capturing and other unmodeled routine forms fail before planning; SQLite unsupported by design |
| triggers | covered | covered | sqlite header metadata, literal-safe bodies, table/view recreation restoration, execution, rollback, and repeated reapply tested in memory and on disk |
| materialized views | covered | gap | sqlite unsupported by design |
| extensions | covered | gap | pgvector/postgis tests present |
| advisory locks | covered | gap | sqlite unsupported by design |
| cli contract | partial | partial | json/no-color added, more cases needed |
| deterministic output | partial | partial | json format added, snapshot depth pending |
| parser robustness | partial | covered | malformed corpus and random ascii fuzz plus deterministic SQLite grammar generation; PostgreSQL rejects session-local or query-derived tables plus all other untracked top-level data/query/session/transaction/maintenance/DDL commands before planning while preserving materialized views and routine-body SQL; SQLite enforces CREATE-only top-level input, preserves trigger-body DML, rejects temporary objects, and preflights external-file statements without keyword false positives |
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
2. add deterministic json snapshots for `plan` and `apply` across pg/sqlite
3. add per-feature rollback-on-error assertions for all core objects
