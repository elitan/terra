# testing roadmap

## scope

- dialects: all community-supported postgres majors (currently 14-18) and sqlite
- no mysql-family work
- atlas is scenario inspiration only

## hard gates

- line coverage >= 95
- function coverage >= 95
- core path coverage (`src/core/schema/parser`, `src/core/schema/differ.ts`, `src/core/schema/inspector.ts`, `src/core/schema/service.ts`) >= 98 line and function
- flake gate: critical suite 3/3 green
- deterministic json output for cli `plan` and `apply`

## phases

### phase 0

- add docs and matrix
- add `tools/test-doctor.ts`
- add test script topology
- add per-path coverage gate support
- add one command for full pr matrix run

### phase 1

- move tests into target layout:
  - `src/test/unit`
  - `src/test/integration/postgres`
  - `src/test/integration/sqlite`
  - `src/test/e2e`
  - `src/test/property`
  - `src/test/perf`
  - `src/test/harness`
  - `src/test/fixtures`
- centralize dialect-specific harness helpers
- add machine-readable assertion helpers
- add silent test mode for ci

### phase 2

- track full feature matrix and gaps
- keep ordered backlog by risk

### phase 3

- postgres core scenario packs:
  - tables
  - columns
  - constraints
  - indexes
  - views
  - schemas
  - comments
- postgres advanced packs:
  - enums
  - sequences
  - functions
  - procedures
  - triggers
  - materialized views
  - extensions

### phase 4

- sqlite recreation/data-preservation expansion
- sqlite unsupported-feature strict error code checks
- sqlite trigger/view/index edge and idempotency coverage

### phase 5

- pg matrix:
  - pr: oldest and newest supported majors (currently 14, 18)
  - nightly: every supported major (currently 14, 15, 16, 17, 18)
- maintain version-variance map

### phase 6

- cli product completeness:
  - `plan` command
  - `--format text|json`
  - `--no-color`
- cli json contract tests
- docs alignment

### phase 7

- property/fuzz expansion
- keep deterministic seeds in pr
- persist failing seed/path artifacts

### phase 8

- resilience/concurrency/perf gates
- add perf regression gate script

### phase 9

- ci split:
  - pr workflow
  - nightly workflow
  - release workflow
- release blocked on all gates

### phase 10

- operating model:
  - every bug starts with failing test
  - every feature has happy/edge/failure/idempotency tests
  - weekly flake and runtime review
  - monthly threshold review

## default execution order

1. update docs/matrix
2. add failing tests
3. implement feature/fix
4. run matrix scripts
5. merge only if all hard gates pass
