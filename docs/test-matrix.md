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
| indexes | covered | covered | SQLite mixed column/expression keys, collations, ASC/DESC ordering, partial predicates, planner use, recreation, rollback, and memory/file parity covered |
| views | covered | covered | sqlite full definitions, explicit column lists, replacement, recreation ordering, and rollback covered |
| schemas | covered | gap | sqlite unsupported by design |
| enums | covered | gap | sqlite unsupported by design |
| sequences | covered | gap | sqlite unsupported by design |
| functions | covered | gap | sqlite unsupported by design |
| procedures | covered | gap | sqlite unsupported by design |
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
