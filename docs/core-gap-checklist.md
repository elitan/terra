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
- done: preserve zero-attribute composite types and explicit attribute collations.
- done: support dependency-ordered composite create/drop and native attribute evolution.
- done: classify composite attribute drops as destructive and reject blocked type changes during planning.
- done: traverse array/domain/range/multirange relation dependencies and coordinate dependent type/view removal.
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
- done: add enum integration regression for ordered middle-value insertion.
- done: support insertion-only enum evolution while rejecting retained-label reordering.
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
- done: restore generated PostgreSQL idempotency properties for immutable partial-index predicates, expression indexes, and row-local CHECK expressions; remove stale normalization-limit notes after PostgreSQL 14/18 verification.
- done: replace the stale PostgreSQL foreign-key action-tracking limitation with an exhaustive generated lifecycle property for all 40 unequal `ON DELETE`/`ON UPDATE` transitions, including plan replacement, row preservation, catalog convergence, empty replan, and runtime behavior across PostgreSQL 14-18.
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
- done: make changed-file mutation testing select candidates from added and modified hunk lines, carry the exact diff reference into reports, use event base/head SHAs with full history on clean CI checkouts, and mutation-test the gate implementation itself.
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
- done: preserve SQLite's historical primary-key nullability for ordinary rowid tables, exact `INTEGER PRIMARY KEY` ROWID aliases including the inline `DESC` exception, explicit `NOT NULL`, and `STRICT`/`WITHOUT ROWID` tables, including legal NULL-key rows through recreation.
- done: preserve case-normalized SQLite declared type identity instead of collapsing `INT` into `INTEGER`, lifecycle-test ordinary and `STRICT` `ANY` affinity behavior, and transactionally reject ROWID-alias promotion when NULL source keys would be silently regenerated.
- done: add PostgreSQL 18 local, PR CI, release-verification, inspector-snapshot, CLI-discovery, and full matrix lanes without changing nightly automation.
- done: reject PostgreSQL 18 `NOT ENFORCED`, temporal `WITHOUT OVERLAPS`/`PERIOD`, and advanced named/table-level/inheritance/validation `NOT NULL` semantics while parsing desired schemas; reject unenforced, temporal, and `NOT NULL` inheritance/validation flags on managed external tables without confusing supported `NOT VALID` checks and foreign keys, while normalizing ordinary external `NOT NULL` names to column nullability.
- done: reject unlogged partitioned parents and explicit unlogged leaf partitions in desired schemas and PostgreSQL 14-17 external catalog state, while retaining full ordinary unlogged-table lifecycle support; this avoids the pre-18 mixed-persistence behavior and PostgreSQL 18's parent rejection.
- done: preserve PostgreSQL domain base types, collations, defaults, nullability, named/generated checks, and validation state, using native transactional alteration with rollback-safe validation.
- done: preserve PostgreSQL range subtype, effective operator class, collation, support functions, and explicit/automatic multirange names without default-option drift.
- done: replace unused immutable domain/range definitions in drop-before-create order, reject replacements with relation/type/routine dependents, and use dependency-ordered `RESTRICT` drops instead of data-losing `CASCADE`.
- done: detect direct, array, multirange, derived type, relation, and routine-signature dependencies for domain/range replacement and removal, while filtering internal range constructors.
- done: reject same-apply range support-function creation before mutation with a prerequisite/shell-type diagnostic.
- done: unify enum, composite, domain, range, and generated-multirange dependency ordering across same-apply creation, composite alteration, and coordinated removal; reject cross-family cycles, ambiguous references, and physical type-name collisions before mutation.
- done: inspect enum dependencies through direct/array relation attributes, composites, derived domains/ranges, routine signatures, owning defaults/constraints/indexes, and machine-readable catalog identities; reject retained or unmodeled dependents before mutation while allowing coordinated removal, and suppress index drops made redundant by a column drop.
- done: apply machine-readable catalog dependency inspection and one shared retained-owner classifier across enums, composites, domains, and ranges; retained routines, policies, triggers, casts, relation expressions, and unmanaged objects reject replacement/removal during planning, while modeled policy/trigger removal is coordinated in the same apply.
- done: model PostgreSQL row-level security as independent ENABLE/FORCE flags and policies as complete semantic CREATE POLICY definitions; cover all commands, modes, role forms, expressions, external convergence, enforcement behavior, mixed ALTER TABLE constraints, transactional replacement/removal, idempotency, and pre-mutation rejection of ALTER POLICY or negative RLS mutations on PostgreSQL 14-18.
- done: preserve PostgreSQL standalone and identity-sequence logged/unlogged persistence with PostgreSQL 14 versus 15-18 semantics; replace destructive option and ownership recreation with native ALTER operations that preserve OIDs, dependents, live counter state, schema-qualified ownership, and idempotency.
- done: preserve PostgreSQL ordinary trigger `UPDATE OF` columns, transition tables, default statement timing, and origin/disabled/replica/always firing modes; apply mode-only changes natively, preserve constraint/event trigger modes and qualified functions, ignore matching partition clones, reject divergent clone state plus bulk/ONLY mutations, and converge idempotently on PostgreSQL 14-18.
- done: preserve PostgreSQL DEFAULT/FULL/NOTHING/USING INDEX replica identity on ordinary and partition relations; inspect missing selected indexes, validate index eligibility before mutation, reset and restore identity around dependency changes, keep constraint-backed work atomic, and execute concurrent standalone index builds before dependent assignments on PostgreSQL 14-18.
- done: preserve PostgreSQL persistent clustering choices for ordinary and inherited tables plus materialized views; validate non-partial built-in clusterable indexes, order resets and assignments around standalone/constraint-backed replacements and replica identity, reject partition catalog drift, and keep physical CLUSTER outside schema apply on PostgreSQL 14-18.
- done: preserve PostgreSQL per-column statistics targets plus `n_distinct` and `n_distinct_inherited` overrides for ordinary/inherited tables and materialized views; canonicalize PostgreSQL 14-16 negative versus PostgreSQL 17-18 null defaults, expand desired non-`ONLY` targets across declared inheritance descendants while generating relation-local changes, preserve metadata through type and materialized-view column renames, reset external drift in place, and support expression-index statistics targets with concurrent-build ordering on PostgreSQL 14-18.
- done: reject invalid targets and attribute values, duplicate or unknown options, missing columns, implicit materialized-view output names, and partition statistics catalog drift before mutation.
- done: model PostgreSQL index keys as one lossless ordered sequence across mixed column/expression and multiple-expression indexes; preserve per-key collation, effective operator class and options, sort/null ordering, and every expression statistics target; validate catalog alignment and converge across PostgreSQL 14-18 without default-opclass drift.
- done: reject SQLite query-derived `CREATE TABLE ... AS SELECT`, `VALUES`, and CTE forms before target mutation; distinguish valid view/generated-column `AS` clauses plus comments, literals, and trigger bodies; prove file and shared-memory target state remains unchanged.
- done: exact-pin and certify `libsql` 0.5.29 with embedded SQLite 3.45.1; verify desired parsing, inspection, and execution share the runtime and assert the supported FTS5 and RTree compile features.
- done: preserve SQLite deferred foreign-key enforcement timing through parse, stored-definition inspection, semantic diff, recreation, runtime behavior, data preservation, and idempotent reapply; normalize every other accepted deferrability spelling to the immediate default and match mixed constraints independently of pragma row order; add the SQLite differ, inspector, and definition parser to the changed-file mutation gate and kill all 12 selected mutants.
- done: reject SQLite `IF NOT EXISTS` for tables, virtual tables, indexes, views, and triggers before desired-model construction or target mutation so duplicate and racing conflicting definitions cannot disappear as successful no-ops; distinguish top-level grammar from comments, literals, identifiers, and trigger bodies, and mutation-test the parser preflight.
- done: force SQLite table-recreation copies to `INSERT OR ABORT` so desired `UNIQUE`, primary-key, or `NOT NULL` `ON CONFLICT IGNORE`/`REPLACE` policies cannot silently discard duplicate rows or rewrite NULLs; prove migration failure rolls back schema, rows, storage classes, and temporary artifacts while preserving the policies for future application writes.
- done: make PostgreSQL comments lossless for schemas, ordinary/partitioned tables, relation/composite columns, ordinary/materialized views, indexes, sequences, and user-defined types; scope schema comments by their target, discriminate `pg_description` rows by `classoid`, normalize domain comments to type identity, and reject unsupported targets, removals, or duplicate declarations before mutation across PostgreSQL 14-18.
- done: preserve concrete PostgreSQL `CREATE SCHEMA AUTHORIZATION` owners and authorization-derived schema names, order same-apply roles before owned schemas, normalize conditional existence, repair external owner drift, and reject contextual owners, inline schema elements, or duplicate declarations before mutation across PostgreSQL 14-18.
- done: treat PostgreSQL extension names as database-wide identities, inspect recursive extension dependencies, retain cascade-installed requirements, relocate desired externally installed extensions, order removals dependent-first with `RESTRICT`, roll back on unmanaged dependents, escape version literals, and reject ambiguous duplicate declarations or options across PostgreSQL 14-18.
- done: replace PostgreSQL table-removal `CASCADE` with `RESTRICT`, order managed ordinary/materialized view drops and foreign-key removal before referenced tables, and roll back without deleting unmanaged views or stripping unmanaged foreign keys across PostgreSQL 14-18.
- done: eliminate the remaining generated PostgreSQL `CASCADE` drops for partition hierarchies and foreign servers; separate partition removal from bound detachment, order managed triggers/views/constraints and leaves first, run foreign-server replacement drops before creates, and block on unmanaged views, foreign keys, user mappings, or foreign tables with `RESTRICT` across PostgreSQL 14-18.
- done: model PostgreSQL foreign-server type, version, wrapper, and complete option maps losslessly; normalize conditional creation and option order, preserve empty/quoted fields despite parser-library AST loss, use native version/add/set/drop option alteration without changing OIDs, mappings, foreign tables, or grants, and reject duplicate definitions plus immutable type/wrapper changes before mutation across PostgreSQL 14-18.
- done: make explicitly declared concrete PostgreSQL foreign-server ownership lossless through parsing, catalog inspection, deterministic post-create/state-change alteration, external drift repair, and idempotent reapply without changing OIDs, mappings, foreign tables, or grants; reject contextual, duplicate, and unbound owner declarations before mutation across PostgreSQL 14-18 while leaving omitted ownership unmanaged.
- done: complete PostgreSQL foreign-server removal with explicit multi-name absent-state declarations, deterministic `RESTRICT` drops, destructive/strict-mode classification, idempotent absence, transactional rollback that preserves mappings and foreign tables, and pre-mutation rejection of `CASCADE` across PostgreSQL 14-18; keep unrelated database-wide servers unmanaged and reject rename syntax explicitly.
- done: unify PostgreSQL `ROLE`, `USER`, and legacy `GROUP` declarations under one cluster-wide identity; model every visible role attribute with documented defaults, inspect and alter only changed attributes natively, preserve OIDs and unmanaged ownership/membership/password/configuration state, support explicit dependency-protected removal, and reject unobservable or imperative role clauses before mutation across PostgreSQL 14-18.
- done: make concrete PostgreSQL table, sequence, schema, and foreign-server privileges declarative through atomic grant identities, ACL/default provenance inspection, native grant-option changes, omission-based restrictive revocation, strict-mode classification, external drift repair, pseudo-`PUBLIC` discrimination, portable PostgreSQL 14-18 privilege filtering, and pre-mutation rejection of expanding, unobservable, membership, or unsafe non-owner-grantor semantics.
- done: make PostgreSQL global and per-schema default privileges declarative for portable table, sequence, routine, type, and schema privileges; model positive and negative hard-wired defaults, grant options, `PUBLIC`, future-object behavior, owner/schema omission scope, native baseline restoration, strict-mode classification, rollback, drift repair, and external convergence across PostgreSQL 14-18; translate the `pg_default_acl` sequence code to `acldefault`'s distinct sequence code and preserve version-specific `MAINTAIN` and large-object defaults unmanaged.
- done: prove PostgreSQL policy replacement and ENABLE/FORCE removal remain atomic when a later policy creation fails; verify rollback restores exact policy and table-enforcement catalog state, non-owner row visibility, stored rows, and idempotency across PostgreSQL 14-18.
- done: classify ordinary, conditional, and PostgreSQL concurrent `CREATE UNIQUE INDEX` statements as indexes in CLI statement metadata instead of `other`; cover the generated SQLite and PostgreSQL JSON plan paths at the supported version boundaries, classify the strict-mode statement classifier as high-risk for changed-file mutation testing, and kill its selected mutant.
- done: make the CLI `constraint` metadata category reachable for PostgreSQL `ALTER TABLE` ADD/ALTER/VALIDATE/DROP/RENAME CONSTRAINT actions without stealing CREATE TABLE or inline ADD COLUMN declarations; verify generated enum, constraint, and concurrent-index phase ordering on PostgreSQL 14 and 18.
- done: replace the blanket destructive classification of PostgreSQL `ALTER COLUMN` with action-aware matching; keep type conversions and DROP DEFAULT/NOT NULL/IDENTITY/EXPRESSION blocked by strict mode while allowing SET DEFAULT/NOT NULL, storage/compression, and index-statistics changes, including a batched generated PostgreSQL 14/18 strict dry run and four killed high-risk classifier mutants.
- done: classify PostgreSQL `DISABLE ROW LEVEL SECURITY` and `NO FORCE ROW LEVEL SECURITY` as destructive while leaving ENABLE/FORCE safe; prove strict mode blocks enforcement weakening without removing the retained policy or changing either catalog flag across PostgreSQL 14 and 18, and kill both selected high-risk classifier mutants.
- done: classify PostgreSQL table and sequence `SET UNLOGGED` as destructive while leaving `SET LOGGED` safe; prove strict mode preserves populated table state across PostgreSQL 14 and 18 plus sequence OID, logged persistence, and live counter state on PostgreSQL 18, with version-gated PostgreSQL 14 sequence behavior and high-risk classifier mutation coverage.
- done: classify PostgreSQL table, constraint, and event trigger `DISABLE`/`ENABLE REPLICA` enforcement weakening as destructive while leaving `ENABLE`/`ENABLE ALWAYS` safe; prove strict rejection retains origin catalog modes and actual row- and DDL-trigger execution across PostgreSQL 14 and 18 with grammar-aware quoted-name matching and high-risk classifier mutation coverage.
- done: classify PostgreSQL `REPLICA IDENTITY NOTHING` as destructive while leaving `FULL`, `DEFAULT`, and `USING INDEX` safe; prove strict mode permits identity strengthening, blocks removal of old-row identity, and retains exact catalog state plus populated rows across PostgreSQL 14 and 18 with an end-anchored quoted-identifier-safe matcher and high-risk classifier mutation coverage.
- done: classify PostgreSQL table `NO INHERIT` detachment as destructive while leaving compatible `INHERIT` attachment safe; prove strict rejection retains the inheritance link, parent-query row visibility, inherited definitions, and child rows across PostgreSQL 14 and 18 before non-strict detachment localizes state and converges, using a qualified-identifier-safe matcher distinct from constraint `NO INHERIT` syntax.
- done: classify explicit PostgreSQL role `NOLOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, `NOREPLICATION`, and `NOBYPASSRLS` capability removal as destructive while leaving positive grants safe; prove strict rejection preserves exact attributes, OID, external ownership, membership, password/expiration, and configuration across PostgreSQL 14 and 18 with a quoted-role-safe option matcher.
- done: classify PostgreSQL `DETACH PARTITION` as destructive while leaving `ATTACH PARTITION` safe; prove strict rejection preserves the child OID, original bound, partition link, parent-query visibility, and populated rows across PostgreSQL 14 and 18 before ordinary transactional detach/attach changes the bound and converges, using an anchored matcher for qualified identifiers and all documented detach variants.
- done: classify PostgreSQL existing-schema `OWNER TO` transfers as destructive while leaving `CREATE SCHEMA ... AUTHORIZATION` safe; prove strict rejection preserves the former owner, schema OID, contained table, and populated rows across PostgreSQL 14 and 18 before ordinary apply transfers ownership in place and converges, using a quoted-identifier-safe exact grammar matcher.
- done: classify PostgreSQL foreign-server option `DROP` actions as destructive while leaving `ADD`/`SET` safe; prove strict rejection of mixed and removal-only changes preserves exact version/options, OID, user mappings, foreign tables, and grants across PostgreSQL 14 and 18 before ordinary native alteration converges, using a literal-safe option grammar matcher.
- done: classify PostgreSQL sequence `OWNED BY NONE` dependency removal as destructive while leaving ownership attachment safe; prove strict rejection preserves the exact owner target, sequence OID, live value, and called state across PostgreSQL 14 and 18 before ordinary native detachment converges, using an exact qualified-identifier-safe matcher.
- done: classify generated PostgreSQL `COMMENT ON ... IS NULL` metadata removal as destructive while leaving non-empty comment creation and replacement safe; prove strict rejection preserves all 17 supported schema, relation, column, index, sequence, and type comments across PostgreSQL 14 and 18 before ordinary omission-based removal converges, using an exact supported-target and quoted-identifier-safe matcher.
- done: classify PostgreSQL table and materialized-view `SET WITHOUT CLUSTER` metadata removal as destructive while leaving `CLUSTER ON` assignment safe; prove strict rejection preserves selected indexes, relation OIDs, and populated/materialized rows across PostgreSQL 14 and 18 before ordinary native removal converges, using an exact documented-grammar matcher.
- done: make PostgreSQL ordinary-view option transitions explicit native `ALTER VIEW SET`/`RESET` operations; classify check/security option removal, `CASCADED`-to-`LOCAL`, and false-valued security changes as destructive while leaving additions and strengthening safe; preserve the current enforcement during simultaneous query replacement, and prove strict rejection retains exact options, query, OID, behavior, and base rows across PostgreSQL 14 and 18.
- done: classify PostgreSQL domain `DROP DEFAULT` and `DROP NOT NULL` weakening as destructive while leaving `SET DEFAULT` and `SET NOT NULL` safe; prove strict rejection preserves domain/table OIDs, exact catalog state, stored rows, inherited default behavior, and null rejection across PostgreSQL 14 and 18 before ordinary native weakening converges, using an exact quoted-qualified-identifier-safe matcher.
- done: classify PostgreSQL `REFRESH MATERIALIZED VIEW ... WITH NO DATA` depopulation as destructive while leaving ordinary and explicit `WITH DATA` refresh safe; prove strict rejection preserves scannability, relation OID, and exact materialized rows across PostgreSQL 14 and 18 before ordinary native depopulation and repopulation converge, using an exact quoted-qualified-identifier-safe matcher.
- done: classify PostgreSQL existing-server `OWNER TO` authority transfers as destructive while preserving strict-safe ownership initialization for same-plan server creation; correlate quoted server identities exactly and prove strict rejection retains the prior owner, OID, user mapping, foreign table, and grant across PostgreSQL 14 and 18 before ordinary native repair converges.
- done: classify standalone PostgreSQL foreign-server `VERSION NULL` metadata removal as destructive while leaving concrete version replacement safe; split version and option removal lifecycles and prove strict rejection independently preserves exact version/options, OID, user mapping, foreign table, and grant across PostgreSQL 14 and 18 before ordinary native removal converges.
- done: split generated PostgreSQL table/materialized-view storage-parameter, per-column distinct-option, and relation/index statistics-target resets into explicit statements and classify them as destructive while leaving positive assignments safe; prove strict rejection preserves exact metadata, relation/index OIDs, populated/materialized rows, tablespace, and dependent views across PostgreSQL 14 and 18 before ordinary native resets converge.
- done: split generated PostgreSQL standalone and identity-sequence `CYCLE` enablement from compatible definition changes and classify it as destructive while leaving `NO CYCLE` safe; prove strict rejection preserves exact bounds/options, relation and sequence OIDs, live values, and rows across PostgreSQL 14 and 18 before ordinary native enablement demonstrates documented wraparound reuse and converges.
- done: split generated PostgreSQL identity `SET GENERATED BY DEFAULT` enforcement weakening from compatible sequence-option changes and classify it as destructive while leaving `SET GENERATED ALWAYS` strengthening safe; prove strict rejection preserves table/sequence OIDs, live sequence state, and populated rows across PostgreSQL 14 and 18 before ordinary native weakening permits explicit values and both directions converge.
- done: emit PostgreSQL standalone-sequence `AS` clauses only for real numeric type changes, classify those changes as destructive while leaving bound/start/increment/cache-only edits safe, and prove strict rejection preserves the exact definition, OID, and live value across PostgreSQL 14 and 18 before ordinary in-place narrowing and widening converge.
- done: classify PostgreSQL role `CONNECTION LIMIT -1` resets as destructive while leaving finite limits safe; prove limit-only strict rejection preserves the role OID and finite catalog value across PostgreSQL 14 and 18 before ordinary unlimited reset and strict-safe finite restoration converge.
- done: split generated PostgreSQL column `SET COMPRESSION default` resets from compatible storage changes and classify them as destructive while leaving concrete compression assignments safe; prove strict rejection preserves the exact physical catalog state, table OID, and populated rows across PostgreSQL 14 and 18 before ordinary reset and concrete restoration converge.
- done: classify PostgreSQL table and materialized-view `SET ACCESS METHOD` physical rewrites as destructive, including batched table alterations; prove strict rejection preserves relation OIDs, relfilenodes, populated rows, and materialized-view dependents on PostgreSQL 15-18 while PostgreSQL 14 continues to reject unsupported changes before mutation, then prove ordinary native rewrites and resets converge.
- done: reject externally retained PostgreSQL 17-18 partitioned-parent access methods, including explicit `heap`, before planning instead of reconstructing them as omitted and losing their documented future-partition inheritance semantics; prove PostgreSQL 14-16 reject parent methods at creation while default-derived leaves still use the current `default_table_access_method`.
- done: classify PostgreSQL table and materialized-view `SET TABLESPACE` physical data-file moves as destructive, including batched table alterations; prove strict rejection preserves relation/index OIDs, current tablespaces and storage parameters, populated/materialized rows, and view dependents across PostgreSQL 14 and 18 before ordinary custom placement and default resets converge.
- done: retain exact CLI statement categories for supported PostgreSQL `ALTER INDEX`, `ALTER VIEW`, `ALTER MATERIALIZED VIEW`, materialized-view refresh, `ALTER SCHEMA`, `ALTER EXTENSION`, and constraint/event/table-trigger operations instead of reporting `other`, generic `table`, or `constraint`; prove direct classification and ordered plan metadata across channels.
- done: classify TerraDB-emitted PostgreSQL `CREATE OR REPLACE VIEW`, `FUNCTION`, and `PROCEDURE` statements as their managed objects instead of `other`; prove the prefixes directly and through ordered CLI plan metadata.
- done: classify TerraDB-emitted PostgreSQL `CREATE UNLOGGED TABLE` and version-gated `CREATE UNLOGGED SEQUENCE` statements as `table` and `sequence` instead of `other`; prove direct and ordered CLI plan metadata while retaining PostgreSQL 14's existing sequence rejection.
- done: classify supported SQLite FTS5/RTree `CREATE VIRTUAL TABLE` statements as `table` rather than `other`, matching their ordinary `DROP TABLE` removal category; prove the contract through direct classification and a real JSON CLI plan.
- done: make CLI category/risk classification lexical-aware so keywords inside PostgreSQL/SQLite strings, quoted identifiers, dollar bodies, line comments, and nested block comments cannot misclassify safe statements or trigger strict-mode blocking; retain real table/domain/type destructive actions and prove direct, executor, property, and strict JSON CLI behavior.
- done: route only structural PostgreSQL `CREATE [UNIQUE] INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` statements outside the main transaction instead of matching arbitrary `CONCURRENTLY` text; prove simultaneous literal-default changes remain transactional while a real concurrent index remains isolated.
- done: structure PostgreSQL sequence creation, ownership detachment/attachment, and removal around dependent table changes instead of searching generated SQL for `OWNED BY`; preserve retained sequences during owner-table removal, drop defaults before standalone sequences, accept ownership-keyword identifiers, and normalize quoted `regclass` default casts idempotently.
- done: make PostgreSQL SQL-object canonicalization lexical-aware so formatting, comments, and structural `EXECUTE PROCEDURE` normalization cannot rewrite quoted strings, identifiers, or dollar bodies; prove constraint-trigger argument whitespace and keyword changes replace the trigger and change runtime `TG_ARGV` values, with policy literal behavior retained across PostgreSQL 14-18.
- done: replace PostgreSQL view-definition regex normalization with parsed AST comparison so local schema, source-column qualification, identifier quoting, comments, formatting, and parentheses normalize structurally without rewriting literal whitespace or qualifier-looking text; prove planned replacement, runtime output changes, base-row preservation, and idempotency across PostgreSQL 14-18.
- done: classify PostgreSQL domain container validation from semantic alterations instead of rendered SQL text, allowing safe default changes when quoted domain names contain validation keywords while retaining pre-mutation rejection for constraint additions, validation, and `SET NOT NULL` across PostgreSQL 14-18.
- done: route PostgreSQL table constraint drops ahead of partition removals from parsed `AlterTableCmd` nodes instead of rendered SQL text, preventing quoted `DROP CONSTRAINT` names from moving unrelated table creation or foreign-key alteration ahead of a newly referenced partition across PostgreSQL 14-18.
- done: recognize PostgreSQL serial pseudo-types from structural catalog ownership/default dependencies plus an exact canonical `nextval` expression instead of matching keyword text; preserve create/add/remove/idempotent workflows and reject unsafe existing-column transitions in either direction before changing columns, sequences, defaults, or rows across PostgreSQL 14-18.
- done: canonicalize PostgreSQL's documented `serial2`, `serial4`, and `serial8` aliases to their `smallserial`, `serial`, and `bigserial` definitions with implicit `NOT NULL`; prove creation, base integer types, owned defaults, alias/canonical idempotency, and equivalent replans across PostgreSQL 14-18.
- done: inspect canonical PostgreSQL serial-owned sequence start, increment, minimum, maximum, cache, and cycle options; reject every definition drift before mutation while preserving sequence OIDs/options, defaults, ownership, rows, and live values, and continue treating counter advancement plus `RESTART` as unmanaged runtime state across PostgreSQL 14-18.
- done: inspect PostgreSQL serial-owned sequence persistence using version-aware server semantics; require logged/unlogged persistence to match the owning table on PostgreSQL 15-18, retain PostgreSQL 14's logged sequence behavior for unlogged tables, and reject external persistence drift before mutation while preserving exact sequence state, ownership, defaults, and rows.
- done: reject PostgreSQL serial and serial-alias declarations with explicit `NULL`, `DEFAULT`, identity, or generated clauses during parsing because they conflict with serial's implicit `NOT NULL` and sequence default; preserve explicit `NOT NULL` as an equivalent spelling and prove pre-mutation failure before preceding desired changes across PostgreSQL 14-18.
- done: reject invalid PostgreSQL serial pseudo-type shapes with `pg_catalog` qualification, type modifiers, or array bounds before planning; preserve PostgreSQL's valid quoted-lowercase `"serial"` spelling and keep other schema-qualified names ending in `serial` on the custom-type path without applying preceding desired changes across PostgreSQL 14-18.
- done: preserve `pg_type.typnamespace` identity when `format_type` renders a custom type as any serial alias; keep scalar/array table columns, partition column reconstruction, and composite attributes schema-qualified, allow qualified custom arrays through pseudo-type validation, and prove empty replans plus exact table/type OID and row preservation across PostgreSQL 14-18.
- done: preserve the catalog namespace when PostgreSQL `format_type` omits an explicitly declared visible custom-type schema; compare scalar and array references by catalog identity across ordinary and partitioned table columns, composite attributes, domain bases, and range subtypes, while retaining schema/shape drift detection and proving empty replans plus exact relation/type OID and row preservation across PostgreSQL 14-18.
- done: normalize PostgreSQL's decorative array size bounds and dimensionality to one catalog array type for builtin and user-defined types; cover bracket and SQL-standard `ARRAY[n]` syntax across ordinary/partition columns, composite attributes, domain bases, range subtypes, and existing routine signatures with empty replans plus exact type/relation OID and row preservation across PostgreSQL 14-18.
- done: decode every PostgreSQL interval field mask into its documented SQL spelling, preserve temporal precision boundaries `0..6` across ordinary/partitioned columns, arrays, composite attributes, and domain bases, and reject silently clamped precision or uninspectable temporal range-subtype modifiers before mutation across PostgreSQL 14-18.
- done: validate PostgreSQL character lengths `1..10485760` and bit-string lengths `1..83886080` across ordinary/partitioned columns, arrays, composite attributes, and domain bases; reject malformed or uninspectable range-subtype modifiers before mutation; and preserve unbounded character/bit forms plus the distinct one-byte `"char"` identity through columns and routines across PostgreSQL 14-18.
- next: continue the official PostgreSQL 14-18 and SQLite grammar/catalog audit and select the next highest-impact lossless schema gap.

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
