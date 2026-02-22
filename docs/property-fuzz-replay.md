# property and fuzz replay

## property tests (`fast-check`)

when a property test fails, copy `seed` and `path` from the failure output.

replay the exact failing case:

```bash
FC_SEED=<seed> FC_PATH=<path> FC_TARGET=<property-test-file> bun run test:property:replay
```

replay same seed without fixed path:

```bash
FC_SEED=<seed> bun run test:property:replay
```

if `FC_PATH` is set, `FC_TARGET` is required.

all property scripts run with `TERRADB_TEST_SILENT=1` by default.

to see full sql/log output during replay:

```bash
TERRADB_TEST_SILENT=0 FC_SEED=<seed> FC_PATH=<path> FC_TARGET=<property-test-file> bun run test:property:replay
```

## parser fuzz tests

replay one fuzz case:

```bash
PARSER_FUZZ_SEED=<seed> PARSER_FUZZ_FIXTURE_CASE=<n> PARSER_FUZZ_RANDOM_CASE=<n> bun run test:fuzz:replay
```

run default deterministic fuzz seed:

```bash
bun run test:fuzz
```

## seed artifact file

record fixed failures in:

`src/test/fixtures/property-failure-seeds.json`

required fields:

1. `id`
2. `testFile`
3. `seed`
4. `path`
5. `counterexample`
6. `status`
7. `fixedIn`

after a fix:

1. add failing seed/path and counterexample.
2. link the fix in `fixedIn`.
3. keep `status` as `fixed`.
