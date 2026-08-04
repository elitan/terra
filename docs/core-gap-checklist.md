# core gap checklist

## active tracker

- done: add cli deterministic raw json byte-equality test.
- done: add strict + dry-run destructive-block contract test.
- done: rerun `src/test/cli/cli-contract.test.ts` and `test:core` green.
- done: make logger/output coverage tests env-independent.
- done: full `test:coverage` gate green (`1244` pass, `97.97%` line, `96.40%` function).
- done: add schema-service strict mode integration tests on postgres path.
- done: add schema-service advisory lock timeout/release integration tests.
- done: add cli stderr/stdout separation contract tests.
- done: add cli exit code matrix test across success/parser/validation/strict.
- done: add cli json error-shape stability test across failure classes.
- done: add differ deterministic ordering tests with mixed object kinds.
- done: fix non-deterministic alter/index ordering in `SchemaDiffer`.
- done: fix cross-schema same-name table collisions in `SchemaDiffer` table matching/drop logic.
- done: add regression tests for same table name across schemas.
- done: fix text-to-bigint cast bug in `SchemaDiffer` using-expression logic.
- done: add differ private + integration regression tests for bigint cast precision.
- done: make function parser/handler/sql generation schema-aware.
- done: add regression test for same function name across managed schemas.
- done: make trigger parser/handler/inspector/sql generation schema-aware.
- done: add regression test for same trigger name across managed schemas.
- done: add schema-service prompt behavior tests for non-interactive mode.
- done: fail fast in non-interactive apply without `--auto-approve`.
- done: add cli non-interactive prompt-required tests (text and json).
- done: add cli json error snapshot stability tests for common failure paths.
- done: extend schema-service integration tests for prompt pass/fail paths through CLI.
- done: add cli strict-before-prompt contract tests (text and json).
- done: add cli migration runtime-failure contract test and assert stable `MIGRATION_ERROR` json output code.
- done: add trigger `WHEN`/function-args parse in parser + inspector and diff idempotency coverage.
- done: add trigger update integration regression for `WHEN`/args changes.
- done: add explicit safe-widen vs unsafe-narrow differ matrix tests.
- done: add trigger function-args normalization/equivalence tests (`'1'` vs `1`) and stable formatting.
- done: add db leak scanner loop and fix suite teardown leaks in `circular-dependencies`, `check-constraints`, `foreign-keys`, `issue-70-not-in-idempotency`, `unique-constraints`, `destructive-operations`, `unique-constraint-vs-index`.
- done: fix `performance-regression` benchmark timeout flake (`INTEGER` -> `BIGINT` case).
- done: rerun `test:core`, targeted patched suites, and full `test:coverage` gate green (`1277` pass, `98.00%` line, `96.67%` function).
- done: add parser boundary coverage for quoted identifiers and mixed-case names.
- done: add more malformed ddl seeds with deterministic replay command.
- done: add parser + inspector + sql generation coverage for deferrable fk/unique and complex check expressions.
- done: add full parser object-matrix parity assertions.
- done: add differ no-op equivalence tests for defaults and generated expressions.
- done: make `test:core` deterministic with serial execution.
- done: fix sequence option normalization to stop idempotency drift on explicit/implicit defaults.
- done: add sequence idempotency regression tests for explicit defaults, implicit defaults, and real option updates.
- done: make enum handling schema-aware for same enum names across schemas.
- done: add enum schema-scope regression tests (no-op, targeted append, scoped removal).
- done: add enum duplicate-value guard to fail fast before generating unsafe repeated ALTER TYPE statements.
- done: add enum mixed-case append and duplicate-guard regression tests.
- done: make sequence, procedure, and view handlers schema-aware for keying and drop/create sql.
- done: add cross-schema name-collision regression tests for sequence, procedure, and view handlers.
- done: add schema-service integration regressions for same-name cross-schema sequence/procedure/view lifecycle.
- done: fix view idempotency for local schema-qualified vs inspector-unqualified definitions.
- done: add explicit schema-qualified view reference normalization regression matrix (quoted/unquoted/current-schema/other-schema).
- done: normalize quoted simple identifiers in view definitions for idempotency while keeping mixed-case differences.
- done: add schema-service integration regressions for quoted local-schema view references in public and tenant schemas.
- done: add deterministic multi-table mixed-operation ordering regression test in `SchemaDiffer`.
- done: make `SchemaDiffer` table processing order deterministic across input table ordering.
- done: rerun `test:core` and full `test:coverage` gate green (`1308` pass, `98.02%` line, `96.72%` function).
- done: add enum integration regression for unsafe middle-value insertion (reordering contract).
- done: fix enum unsafe-change classification to report reordering for non-append insertions.
- done: add schema-qualified same-name enum integration test for scoped append behavior.
- done: fix enum introspection grouping by schema+name to avoid cross-schema enum value merge.
- done: harden enum suite cleanup to include `tenant_a` schema.
- done: rerun `test:core`, enum integration suite, and full `test:coverage` gate green (`1311` pass, `98.00%` line, `96.74%` function).
- done: add parser matrix coverage for view/materialized-view option edge forms.
- done: fix view parser `security_barrier` normalization for `on/off` and bare-flag forms.
- done: add parser regression tests for schema-qualified and quoted routine parameter/return types.
- done: fix function/procedure parser type extraction to preserve schema-qualified custom types.
- done: add integration regression for schema-qualified custom types in function/procedure apply path.
- done: fix routine handler keying to include signature and prevent overload collisions.
- done: add routine handler overload regression tests for function and procedure create/drop isolation.
- done: rerun targeted parser/function suites and `test:core` green (`98` pass).
- done: fix inspector view dependency lookup to support non-`public` schemas (remove hardcoded schema).
- done: add inspector contract coverage for schema-scoped view dependency lookup.
- done: rerun `test:core` green after inspector dependency fix (`98` pass).
- done: add inspector function dependency extraction helper and contract tests (default schema, non-public schema, failure fallback).
- done: rerun `test:core` green after function dependency work (`99` pass).
- done: add inspector metadata parity contract tests for index opclass/storage parameter extraction.
- done: make inspector object ordering deterministic across schemas for views/materialized views/functions/procedures/sequences/extensions.
- done: add inspector routine ordering contract test for cross-schema deterministic query ordering.
- done: rerun `test:core` green after inspector ordering/metadata changes (`101` pass).
- done: add inspector cross-schema filtering contract coverage for views/materialized views with schema-array assertions.
- done: rerun `test:core` green after cross-schema filtering coverage (`101` pass).
- done: add schema-service integration regression for overloaded functions/procedures lifecycle and idempotent reapply.
- done: rerun function integration suite and `test:core` green after overload lifecycle coverage (`101` pass).
- done: add sqlite parity regression for in-memory vs file-backed core apply/idempotency behavior.
- done: rerun sqlite parity test and `test:core` green after sqlite parity coverage (`101` pass).
- done: add sqlite parity coverage for trigger/view/index combinations with repeated reapply.
- done: fix sqlite trigger sql generation to use sqlite trigger definition (remove invalid `EXECUTE FUNCTION` path).
- done: preserve SQLite VIRTUAL/STORED generated columns through inspection, additive changes, recreation, removal, and rollback.
- done: preserve complete SQLite views and table/view triggers through generalized table recreation and failed-migration rollback.
- done: preserve complete SQLite index definitions, including mixed expression/column keys, collations, sort orders, and partial predicates, through recreation and rollback.
- done: preserve SQLite STRICT/WITHOUT ROWID options, quoted identifiers, named constraints, collations, conflict policies, and exact table DDL through additive changes and recreation.
- done: preserve SQLite AUTOINCREMENT high-water marks through table recreation so deleted historical rowids are not reused.
- done: preserve hidden SQLite ROWID values through table recreation, including shadowed built-in names and the inline `INTEGER PRIMARY KEY DESC` exception; fail before mutation when no ROWID name is accessible.
- done: enforce SQLite CHECK constraints during migrations even when the caller set `ignore_check_constraints=ON`, then restore the connection setting after success or rollback.
- done: verify SQLite foreign-key integrity before committing generalized migrations even when the caller set `foreign_keys=OFF`, then preserve that setting after success or rollback.
- done: restore SQLite `defer_foreign_keys` after every successful or failed migration because SQLite clears it automatically at transaction boundaries.
- done: force SQLite schema validation while migrating even when the caller enabled `writable_schema`, then restore the caller setting after success or rollback.
- done: run SQLite foreign-key and integrity diagnostics inside generalized migration transactions, limit integrity output to the first error, and roll back before commit on any reported violation.
- done: classify the SQLite migration executor as critical for changed-file mutation testing and route its mutants through real SQLite executor and validation suites.
- done: manage SQLite FTS5/RTree virtual tables losslessly and exclude their implementation-owned shadow tables from desired/current schema diffs.
- done: cover SQLite virtual-table create, query behavior, idempotency, destructive strict-mode blocking, definition change, view restoration, rollback, and removal in memory and on disk.
- done: reject connection-local SQLite temporary tables, views, triggers, and virtual tables instead of silently omitting them from the persistent desired schema.
- done: preflight SQLite `ATTACH`, `DETACH`, and `VACUUM` statements so desired-schema parsing cannot create or mutate external database files.
- done: reject top-level SQLite DML, query, DROP/ALTER, maintenance, and transaction statements while preserving INSERT/UPDATE/DELETE/SELECT inside CREATE TRIGGER bodies.
- done: add deterministic grammar-aware SQLite generation across identifier quoting, comments, table options, constraints, generated columns, indexes, views, triggers, FTS5, runtime behavior, and apply/replan idempotency.
- done: fix SQLite virtual-table idempotency across equivalent identifier quote styles found by grammar seed `20260803`, path `0`.
- done: add sqlite table recreation regressions for referenced-table migration with existing child rows and post-migration fk enforcement.
- done: fix sqlite table recreation transaction path to temporarily suspend fk checks, run `PRAGMA foreign_key_check`, and restore enforcement.
- done: add sqlite rollback/no-leak regression for failed table recreation (`_users_new` cleanup + original row preservation).
- done: rerun sqlite suite green after rollback/no-leak regression (`138` sqlite pass).
- done: rerun sqlite suites and `test:core` green (`137` sqlite pass, `101` core pass).
- done: add property tests for destructive diff classification with case/whitespace fuzz coverage.
- done: fix destructive classifier false positive on safe enum statements (`CREATE TYPE`, `ALTER TYPE ... ADD VALUE`).
- done: add strict-mode integration regression for enum create + value append.
- done: rerun property suite and `test:core` green (`3` property pass, `102` core pass).
- done: add property replay workflow docs and seed artifact catalog (`docs/property-fuzz-replay.md`, `src/test/fixtures/property-failure-seeds.json`).
- done: add `test:property:replay` script with exact-path guard (`FC_TARGET` required when `FC_PATH` is set).
- done: validate replay command with recorded seed/path against the fixed regression.
- done: add shrinking assertion coverage for property failures to guarantee small reproducible counterexamples.
- done: profile property suite runtime and record slowest cases (`docs/property-suite-profile.md`).
- done: cap replay-path usage to target file with script guard and docs (`FC_TARGET` required with `FC_PATH`).
- done: default property scripts to silent mode to reduce output noise while preserving replay overrides.
- done: add changed-file mutation gate tool with threshold enforcement and baseline report output (`tools/check-mutation-gate.ts`).
- done: add mutation scripts and usage docs (`test:mutation:changed:report`, `test:mutation:changed:gate`, `docs/mutation-gate.md`).
- done: add escaped mutant rollup tool by module/reason (`tools/summarize-escaped-mutants.ts`).
- done: add escaped mutant report script (`test:mutation:escaped:report`) and validate with sample mutation report input.
- done: make escaped mutant rollups consume native changed-file runner results, direct locations/operators, and absolute manifest paths without hiding survivors.
- done: add schema-service advisory lock recovery regression for failed apply then successful retry with same lock.
- done: rerun advisory integration suite and `test:core` green after lock recovery coverage (`103` pass).
- done: add cli command help output contract tests for root/apply/plan command surfaces.
- done: rerun cli contract suite and `test:core` green after help contract coverage.
- done: add inspector fixture snapshots across pg14/15/16/17 with normalized metadata baseline.
- done: add inspector snapshot scripts (`test:inspector:snapshots`, `test:inspector:snapshots:update`).
- done: add prompt-required text output snapshot stability test for cli non-interactive mode.
- done: add parser gap coverage tests for function/procedure/sequence/column/view branch gaps.
- done: rerun full `test:coverage` gate green (`1346` pass, `98.24%` line, `96.96%` function; parser `98.75%` line).
- done: register pg14/15 vs pg16/17 view-definition variance in version variance map.
- done: fix pg14/15 same-schema view idempotency drift from single-source column qualification rewrite.
- done: add regression coverage for pg14/15 single-source qualifier rewrite and multi-source no-normalize guard.
- done: rerun `test:pg:14`, `test:pg:17`, `test:pg:extensions`, and `test:sqlite` green (`2286` pg matrix pass, `18` extension pass, `137` sqlite pass).
- done: rerun `test:property:pr` green after view + cli error-contract additions (`58` property pass).
- done: add cli error-code contract matrix for parser/validation/strict/migration json failure paths.
- done: add direct `TerraError` subclass code-stability matrix test, including non-cli-only `DependencyError`.
- done: expand rollback coverage with sqlite table-recreate failure assertion for no temp-table leak + original row preservation.
- done: add postgres-side migration-failure rollback assertion in schema-service integration for partial transactional apply failure.
- done: add schema-service private rollback assertion that concurrent statements are skipped if transactional execution fails.
- done: add integration test proving concurrent statements never run when transactional statements fail in real postgres path.
- done: extend rollback contract with post-failure lock-state verification in same mixed transactional+concurrent scenario.
- done: add strict-mode + advisory-lock integration regression to ensure lock release on strict failure.
- done: remove stale negative-default TODO note now that the regression is green.
- done: rerun full `test:coverage` gate green (`1355` pass, `98.21%` line, `96.97%` function; parser `98.75%` line).
- done: add postgres cli contract for strict failure with advisory lock enabled, lock reuse on retry, and table cleanup.
- done: rerun `src/test/cli/cli-contract.test.ts` and `test:core` green (`29` cli pass, `108` core pass).
- done: rerun full `test:coverage` gate after new postgres cli lock contract (`1357` pass, `98.21%` line, `96.97%` function).
- done: rerun `src/test/schema-service.test.ts` on pg14 green (`26` pass).
- done: run changed-files mutation report (`target files: 8`, score source missing, report still pass).
- done: run changed-files mutation gate and confirm it fails without score source (`result: fail (target files changed and score missing)`).
- done: enhance mutation gate score resolution to auto-read `MUTATION_REPORT_PATH` and default report path when present.
- done: validate mutation gate score ingestion using synthetic report input (`score: 91`, gate pass).
- done: add cli regression for dry-run apply path with held advisory lock to prove lock is not required in dry-run mode.
- done: rerun `src/test/cli/cli-contract.test.ts` and `test:core` green after dry-run lock regression (`30` cli pass, `108` core pass).
- done: rerun `test:property:pr`, `test:fuzz`, and `test:flake` green in this cycle.
- done: rerun `test:property:nightly` green across seeds `20260218`, `20260219`, `20260220`.
- done: rerun full `test:coverage` gate green after new cli dry-run lock regression (`1358` pass, `98.21%` line, `96.97%` function).
- done: run extra property stress seeds (`20260221`, `20260222`, `20260223`) with zero failures.
- done: rerun `test:core` on PG14 and PG17 green (`108` pass each).
- done: rerun `test:inspector:snapshots` green across PG14/15/16/17.
- done: rerun `test:pg:extensions` and `test:sqlite` green (`18` extension pass, `138` sqlite pass).
- done: add schema-service integration regression for advisory-lock release on parser failure.
- done: add cli regression for advisory-lock release on parser failure and successful retry with same lock.
- done: rerun `src/test/schema-service.test.ts`, `src/test/cli/cli-contract.test.ts`, and `test:core` green (`27`, `31`, `109` pass).
- done: rerun full `test:coverage` gate green after parser-failure lock regressions (`1360` pass, `98.21%` line, `96.97%` function).
- done: add real changed-files mutation runner (`tools/run-mutation-changed.ts`) with report output at `coverage/mutation/mutation-report.json`.
- done: wire `test:mutation:changed:report` and `test:mutation:changed:gate` to generate and consume real mutation scores.
- done: fix mutation baseline script to clear stale mutation report before baseline generation.
- done: widen parser mutation test command to include parser-focused suites (`parser-module`, function/procedure/table/constraint coverage, view/trigger suites).
- done: skip comment-only line mutations to avoid false-positive survivors.
- done: add parser regressions for non-`pg_catalog` schema-qualified builtin aliases in function/procedure parsing.
- done: add parser regression for `A_Const.String` boolean tokens in view `security_barrier` parsing.
- done: rerun changed-files mutation flow and gate green with real score (`32` mutants, `32` killed, `100.00` score, threshold `85`).
- done: wire `test:mutation:changed:gate` into CI PR checks with runtime cap and mutation report artifact upload.
- done: simplify mutation runner parsing/failure helpers and cli json-line extraction helpers with no behavior change.
- done: rerun parser coverage suites, `schema-service`, `cli-contract`, `test:mutation:changed:gate`, and `tsc --noEmit` green after simplification pass.
- done: upgrade the PostgreSQL parser and deparser to the PostgreSQL 18 grammar while preserving a typed compatibility boundary for statement dispatch.
- done: parse implicit and explicit PostgreSQL 18 virtual generated columns, fail before mutation on PostgreSQL 14-17, and cover create, inspect, evaluate, storage-kind change, base-row preservation, and idempotent reapply on PostgreSQL 18.
- done: fix PostgreSQL 18 virtual generated-column inspection so catalog storage kind `v` remains `GENERATED ALWAYS` instead of causing a perpetual drop/add diff.
- done: normalize PostgreSQL 18 AST-only expression source locations so `IN` and `= ANY` remain semantically equivalent after the parser upgrade.
- done: normalize PostgreSQL 18 `NOT NULL` catalog rows through column nullability instead of duplicating them as reconstructed table constraints.
- done: add PostgreSQL 18 local, PR CI, release-verification, inspector-snapshot, CLI-discovery, and full matrix lanes without changing nightly automation.
- next: audit PostgreSQL 18 constraint additions (`NOT ENFORCED`, named `NOT NULL`, and temporal constraints) for complete lifecycle support or explicit pre-mutation rejection.

## parser

1. no open high-priority parser gap in active tracker.

## differ

1. no open high-priority differ gap in active tracker.

## inspector

1. no open high-priority inspector gap in active tracker.

## schema-service

1. no open high-priority schema-service gap in active tracker.

## cli contract

1. no open high-priority cli contract gap in active tracker.

## sqlite parity

1. no open high-priority sqlite parity gap in active tracker.

## property and fuzz

1. no open high-priority property/fuzz gap in active tracker.

## mutation

1. no open high-priority mutation gap in active tracker.
