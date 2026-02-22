# property suite profile

baseline run:

1. command: `TERRADB_TEST_SILENT=1 FC_SEED=20260218 bun --env-file=.env test src/test/properties/`
2. result: `58 pass`, `0 fail`
3. duration: `51.25s`

slowest tests:

1. `Property-Based: Schema Idempotency > property: equivalent type aliases produce identical schemas` (`4615.15ms`)
2. `Property-Based: Type Normalization > property: type alias pairs are commutative (A→B = B→A)` (`1934.42ms`)
3. `Property-Based: Schema Idempotency > property: apply(schema) is always idempotent` (`1733.08ms`)
4. `Property-Based: Type Normalization > property: case variations of same type are equivalent` (`1552.16ms`)
5. `Property-Based: Default Value Normalization > property: numeric defaults are normalized correctly` (`1526.01ms`)
6. `Property-Based: Default Value Normalization > property: string defaults preserve content` (`1492.64ms`)
7. `Property-Based: Default Value Normalization > property: type change with same default doesn't drop/set default` (`1448.43ms`)
8. `Property-Based: Type Normalization > property: type normalization is transitive (if A≡B and B≡C then A≡C)` (`1306.97ms`)
9. `Property-Based: Default Value Normalization > property: adding default is detected` (`1293.51ms`)
10. `Property-Based: Default Value Normalization > property: changing default value is detected` (`1277.67ms`)

targeted rerun commands:

1. `TERRADB_TEST_SILENT=1 FC_SEED=20260218 bun --env-file=.env test src/test/properties/schema-idempotency.property.test.ts`
2. `TERRADB_TEST_SILENT=1 FC_SEED=20260218 bun --env-file=.env test src/test/properties/type-normalization.property.test.ts`
3. `TERRADB_TEST_SILENT=1 FC_SEED=20260218 bun --env-file=.env test src/test/properties/default-normalization.property.test.ts`
