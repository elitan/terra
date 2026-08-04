import { normalizeSQLiteIdentifier } from "./sqlite-identifier";

const SQLITE_RECREATION_TABLE_PATTERN =
  /^CREATE\s+(?:VIRTUAL\s+)?TABLE\s+"_(?:""|[^"])+_new(?:_\d+)?"(?=\s*(?:\(|USING\b))/i;

export function chooseSQLiteRecreationTableName(
  tableName: string,
  occupiedNames: ReadonlySet<string>
): string {
  const baseName = `_${tableName}_new`;
  const normalizedOccupiedNames = new Set(
    [...occupiedNames].map(function (name) {
      return normalizeSQLiteIdentifier(name);
    })
  );
  let candidate = baseName;
  let suffix = 2;

  while (normalizedOccupiedNames.has(normalizeSQLiteIdentifier(candidate))) {
    candidate = `${baseName}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function isSQLiteRecreationTableStatement(statement: string): boolean {
  return SQLITE_RECREATION_TABLE_PATTERN.test(statement.trim());
}

export function hasSQLiteTableRecreation(
  statements: readonly string[]
): boolean {
  const temporaryTableNames = new Set<string>();
  for (const statement of statements) {
    const trimmed = statement.trim();
    if (!isSQLiteRecreationTableStatement(trimmed)) {
      continue;
    }
    const match = trimmed.match(
      /^CREATE\s+(?:VIRTUAL\s+)?TABLE\s+"((?:""|[^"])+)"/i
    );
    if (match?.[1]) {
      temporaryTableNames.add(
        normalizeSQLiteIdentifier(match[1].replace(/""/g, '"'))
      );
    }
  }

  return statements.some(function (statement) {
    const match = statement.trim().match(
      /^ALTER\s+TABLE\s+"((?:""|[^"])+)"\s+RENAME\s+TO\s+/i
    );
    return Boolean(
      match?.[1] &&
        temporaryTableNames.has(
          normalizeSQLiteIdentifier(match[1].replace(/""/g, '"'))
        )
    );
  });
}
