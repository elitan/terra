# postgres version variance map

## target versions

- 14
- 15
- 16
- 17
- 18

## allowed variance policy

- allow differences in system-generated names only when semantic behavior is unchanged
- allow differences in planner/explain outputs only for performance tests
- do not allow differences in generated migration statements for equivalent schemas
- do not allow differences in error classes for destructive/validation paths

## current known variances

| area | versions | status | note |
|---|---|---|---|
| view definition column qualification | 14, 15 vs 16, 17, 18 | tracked | inspector matrix snapshot shows `users.id`/`users.email` qualification in 14/15 and unqualified projection in 16-18 for same view definition |
| generated column storage | 14-17 vs 18 | enforced | stored generated columns are supported throughout; PostgreSQL 18 adds virtual generated columns and makes them the default when the storage kind is omitted, while TerraDB rejects virtual definitions before mutation on 14-17 |
| `NOT NULL` catalog rows | 14-17 vs 18 | normalized | PostgreSQL 18 adds `pg_constraint` rows for column nullability; TerraDB continues to model nullability on columns and excludes those duplicate rows when reconstructing table constraints |
| advanced constraint semantics | 18 | rejected | `NOT ENFORCED`, temporal `WITHOUT OVERLAPS`/`PERIOD`, and named, table-level, `NO INHERIT`, or `NOT VALID` `NOT NULL` forms fail while parsing desired schemas; unenforced, temporal, and `NOT NULL` inheritance/validation flags on managed external tables fail inspection before diffing, while an ordinary external `NOT NULL` name normalizes to column nullability |
| unlogged partition hierarchies | 14-17 vs 18 | rejected | PostgreSQL 14-17 allow unlogged partitioned parents without propagating persistence consistently to children, while PostgreSQL 18 rejects those parents; TerraDB supports ordinary unlogged tables but rejects unlogged partition parents and explicit unlogged leaf partitions in desired SQL and external catalog state before planning |
| unlogged sequences | 14 vs 15-18 | enforced | PostgreSQL 15 adds standalone unlogged sequences plus explicit `LOGGED`/`UNLOGGED` identity-sequence options and makes an implicit identity sequence follow table persistence. PostgreSQL 14 lacks the syntax and keeps an identity sequence logged behind an unlogged table; TerraDB rejects explicit persistence on 14 and normalizes the implicit catalog variance by server version. |
