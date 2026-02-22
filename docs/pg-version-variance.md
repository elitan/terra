# postgres version variance map

## target versions

- 14
- 15
- 16
- 17

## allowed variance policy

- allow differences in system-generated names only when semantic behavior is unchanged
- allow differences in planner/explain outputs only for performance tests
- do not allow differences in generated migration statements for equivalent schemas
- do not allow differences in error classes for destructive/validation paths

## current known variances

| area | versions | status | note |
|---|---|---|---|
| view definition column qualification | 14, 15 vs 16, 17 | tracked | inspector matrix snapshot shows `users.id`/`users.email` qualification in 14/15 and unqualified projection in 16/17 for same view definition |
