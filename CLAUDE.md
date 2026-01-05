# CLAUDE.md

- never create markdown files
- no emojis

## Commit and PR conventions

Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages and PR titles (PRs are squash-merged, so the PR title becomes the commit message).

| Prefix | When to use | Release section |
|--------|-------------|-----------------|
| `feat:` | New features | Features |
| `fix:` | Bug fixes | Bug Fixes |
| `chore:` | Maintenance, deps, CI | Other Changes |
| `docs:` | Documentation | Other Changes |
| `refactor:` | Code refactoring | Other Changes |
| `test:` | Adding/updating tests | Other Changes |

Examples:
- `feat: add support for PostgreSQL array types`
- `fix: handle NULL values in column defaults`
- `chore: update dependencies`

## What is dbterra

Declarative schema management for PostgreSQL and SQLite. Users write `CREATE` statements, dbterra generates `ALTER`/`DROP` to reach that state.

## Commands

```bash
bun test                    # run tests (needs postgres via docker compose up -d)
bun test src/test/sqlite/   # run SQLite tests only
bun run build               # build
gh workflow run release.yml -f version=X.Y.Z  # release to npm
```

Test DB: `postgres://test_user:test_password@localhost:5487/sql_terraform_test`

## Key files

- `src/providers/` - database provider abstraction
- `src/providers/postgres/` - PostgreSQL-specific implementation
- `src/providers/sqlite/` - SQLite-specific implementation
- `src/core/schema/service.ts` - main schema service (uses provider)
- `src/core/schema/handlers/` - handlers for non-table objects (PG only)
