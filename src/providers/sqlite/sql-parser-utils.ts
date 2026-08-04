import { normalizeSQLiteIdentifier } from "../../utils/sqlite-identifier";

function isIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_$]/u.test(character);
}

function quoteCanonicalSQLiteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

const SQLITE_TABLE_CONSTRAINT_KEYWORDS = new Set([
  "CHECK",
  "CONSTRAINT",
  "FOREIGN",
  "PRIMARY",
  "UNIQUE",
]);

function isKeywordAt(sql: string, index: number, keyword: string): boolean {
  const candidate = sql.slice(index, index + keyword.length);
  if (candidate.toUpperCase() !== keyword) {
    return false;
  }

  return !isIdentifierCharacter(sql[index - 1]) &&
    !isIdentifierCharacter(sql[index + keyword.length]);
}

function skipQuoted(sql: string, index: number, quote: string): number {
  let cursor = index + 1;

  while (cursor < sql.length) {
    if (sql[cursor] !== quote) {
      cursor += 1;
      continue;
    }

    if (sql[cursor + 1] === quote) {
      cursor += 2;
      continue;
    }

    return cursor + 1;
  }

  return sql.length;
}

function skipBracketIdentifier(sql: string, index: number): number {
  let cursor = index + 1;

  while (cursor < sql.length) {
    if (sql[cursor] !== "]") {
      cursor += 1;
      continue;
    }

    if (sql[cursor + 1] === "]") {
      cursor += 2;
      continue;
    }

    return cursor + 1;
  }

  return sql.length;
}

function skipLineComment(sql: string, index: number): number {
  const newline = sql.indexOf("\n", index + 2);
  return newline === -1 ? sql.length : newline + 1;
}

function skipBlockComment(sql: string, index: number): number {
  const end = sql.indexOf("*/", index + 2);
  return end === -1 ? sql.length : end + 2;
}

function skipQuotedOrComment(sql: string, index: number): number | undefined {
  const character = sql[index];

  if (character === "'" || character === '"' || character === "`") {
    return skipQuoted(sql, index, character);
  }
  if (character === "[") {
    return skipBracketIdentifier(sql, index);
  }
  if (sql.startsWith("--", index)) {
    return skipLineComment(sql, index);
  }
  if (sql.startsWith("/*", index)) {
    return skipBlockComment(sql, index);
  }

  return undefined;
}

function skipWhitespaceAndComments(sql: string, index: number): number {
  let cursor = index;

  while (cursor < sql.length) {
    if (/\s/u.test(sql[cursor] || "")) {
      cursor += 1;
      continue;
    }
    if (sql.startsWith("--", cursor)) {
      cursor = skipLineComment(sql, cursor);
      continue;
    }
    if (sql.startsWith("/*", cursor)) {
      cursor = skipBlockComment(sql, cursor);
      continue;
    }
    break;
  }

  return cursor;
}

type SQLiteTriggerTiming = "BEFORE" | "AFTER" | "INSTEAD OF";
type SQLiteTriggerEvent = "INSERT" | "UPDATE" | "DELETE";

interface SQLiteTriggerMetadata {
  timing: SQLiteTriggerTiming;
  events: SQLiteTriggerEvent[];
}

interface SQLiteToken {
  kind: "word" | "quoted" | "symbol";
  value: string;
  start: number;
  end: number;
}

function readSQLiteToken(sql: string, index: number): SQLiteToken | undefined {
  const start = skipWhitespaceAndComments(sql, index);
  if (start >= sql.length) {
    return undefined;
  }

  const character = sql[start];
  if (character === '"' || character === "'" || character === "`" || character === "[") {
    const end = character === "["
      ? skipBracketIdentifier(sql, start)
      : skipQuoted(sql, start, character);
    return { kind: "quoted", value: sql.slice(start, end), start, end };
  }

  if (isIdentifierCharacter(character)) {
    let end = start + 1;
    while (isIdentifierCharacter(sql[end])) {
      end += 1;
    }
    return { kind: "word", value: sql.slice(start, end).toUpperCase(), start, end };
  }

  return { kind: "symbol", value: character || "", start, end: start + 1 };
}

function isWord(
  token: SQLiteToken | undefined,
  word: string
): token is SQLiteToken & { kind: "word" } {
  return token?.kind === "word" && token.value === word;
}

function readExpectedWord(
  sql: string,
  index: number,
  word: string
): SQLiteToken | undefined {
  const token = readSQLiteToken(sql, index);
  return isWord(token, word) ? token : undefined;
}

export function parseSQLiteTriggerMetadata(sql: string): SQLiteTriggerMetadata {
  const fallback: SQLiteTriggerMetadata = { timing: "BEFORE", events: [] };
  let token = readExpectedWord(sql, 0, "CREATE");
  if (!token) {
    return fallback;
  }

  token = readSQLiteToken(sql, token.end);
  if (isWord(token, "TEMP") || isWord(token, "TEMPORARY")) {
    token = readSQLiteToken(sql, token.end);
  }
  if (!isWord(token, "TRIGGER")) {
    return fallback;
  }

  token = readSQLiteToken(sql, token.end);
  if (isWord(token, "IF")) {
    const notToken = readExpectedWord(sql, token.end, "NOT");
    const existsToken = notToken
      ? readExpectedWord(sql, notToken.end, "EXISTS")
      : undefined;
    if (!existsToken) {
      return fallback;
    }
    token = readSQLiteToken(sql, existsToken.end);
  }

  if (!token || token.kind === "symbol") {
    return fallback;
  }

  token = readSQLiteToken(sql, token.end);
  if (token?.kind === "symbol" && token.value === ".") {
    const triggerName = readSQLiteToken(sql, token.end);
    if (!triggerName || triggerName.kind === "symbol") {
      return fallback;
    }
    token = readSQLiteToken(sql, triggerName.end);
  }

  let timing: SQLiteTriggerTiming = "BEFORE";
  if (isWord(token, "BEFORE") || isWord(token, "AFTER")) {
    timing = token.value as "BEFORE" | "AFTER";
    token = readSQLiteToken(sql, token.end);
  } else if (isWord(token, "INSTEAD")) {
    const ofToken = readExpectedWord(sql, token.end, "OF");
    if (!ofToken) {
      return fallback;
    }
    timing = "INSTEAD OF";
    token = readSQLiteToken(sql, ofToken.end);
  }

  if (
    !isWord(token, "INSERT") &&
    !isWord(token, "UPDATE") &&
    !isWord(token, "DELETE")
  ) {
    return fallback;
  }

  return { timing, events: [token.value as SQLiteTriggerEvent] };
}

export function extractSQLiteViewDefinition(sql: string): string {
  let token = readExpectedWord(sql, 0, "CREATE");
  if (!token) {
    return "";
  }

  token = readSQLiteToken(sql, token.end);
  if (isWord(token, "TEMP") || isWord(token, "TEMPORARY")) {
    token = readSQLiteToken(sql, token.end);
  }
  if (!isWord(token, "VIEW")) {
    return "";
  }

  token = readSQLiteToken(sql, token.end);
  if (isWord(token, "IF")) {
    const notToken = readExpectedWord(sql, token.end, "NOT");
    const existsToken = notToken
      ? readExpectedWord(sql, notToken.end, "EXISTS")
      : undefined;
    if (!existsToken) {
      return "";
    }
    token = readSQLiteToken(sql, existsToken.end);
  }

  if (!token || token.kind === "symbol") {
    return "";
  }

  token = readSQLiteToken(sql, token.end);
  if (token?.kind === "symbol" && token.value === ".") {
    const viewName = readSQLiteToken(sql, token.end);
    if (!viewName || viewName.kind === "symbol") {
      return "";
    }
    token = readSQLiteToken(sql, viewName.end);
  }

  if (token?.kind === "symbol" && token.value === "(") {
    const columns = readParenthesizedExpression(sql, token.end - 1);
    if (!columns) {
      return "";
    }
    token = readSQLiteToken(sql, columns.end);
  }

  if (!isWord(token, "AS")) {
    return "";
  }

  const definitionStart = skipWhitespaceAndComments(sql, token.end);
  return sql.slice(definitionStart).trim().replace(/;+\s*$/g, "");
}

interface ParenthesizedExpression {
  expression: string;
  end: number;
}

function readParenthesizedExpression(
  sql: string,
  openParenthesis: number
): ParenthesizedExpression | undefined {
  let depth = 1;
  let cursor = openParenthesis + 1;

  while (cursor < sql.length) {
    const skipped = skipQuotedOrComment(sql, cursor);
    if (skipped !== undefined) {
      cursor = skipped;
      continue;
    }

    if (sql[cursor] === "(") {
      depth += 1;
    } else if (sql[cursor] === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          expression: sql.slice(openParenthesis + 1, cursor).trim(),
          end: cursor + 1,
        };
      }
    }

    cursor += 1;
  }

  return undefined;
}

interface SQLiteIdentifier {
  name: string;
  end: number;
}

function readSQLiteIdentifier(sql: string): SQLiteIdentifier | undefined {
  const start = skipWhitespaceAndComments(sql, 0);
  const quote = sql[start];

  if (quote === '"' || quote === "'" || quote === "`") {
    const end = skipQuoted(sql, start, quote);
    const escapedQuote = quote + quote;
    return {
      name: sql.slice(start + 1, end - 1).split(escapedQuote).join(quote),
      end,
    };
  }

  if (quote === "[") {
    const end = skipBracketIdentifier(sql, start);
    return {
      name: sql.slice(start + 1, end - 1).replace(/]]/g, "]"),
      end,
    };
  }

  let end = start;
  while (end < sql.length && !/[\s(),]/u.test(sql[end] || "")) {
    end += 1;
  }
  if (end === start) {
    return undefined;
  }

  return { name: sql.slice(start, end), end };
}

function findFirstUnquotedParenthesis(sql: string): number | undefined {
  let cursor = 0;

  while (cursor < sql.length) {
    const skipped = skipQuotedOrComment(sql, cursor);
    if (skipped !== undefined) {
      cursor = skipped;
      continue;
    }
    if (sql[cursor] === "(") {
      return cursor;
    }
    cursor += 1;
  }

  return undefined;
}

function splitSQLiteTableDefinitions(sql: string): string[] {
  return readSQLiteParenthesizedList(sql)?.items || [];
}

interface SQLiteParenthesizedList {
  items: string[];
  end: number;
}

function readSQLiteParenthesizedList(sql: string): SQLiteParenthesizedList | undefined {
  const openParenthesis = findFirstUnquotedParenthesis(sql);
  if (openParenthesis === undefined) {
    return undefined;
  }

  const items: string[] = [];
  let depth = 1;
  let start = openParenthesis + 1;
  let cursor = start;

  while (cursor < sql.length) {
    const skipped = skipQuotedOrComment(sql, cursor);
    if (skipped !== undefined) {
      cursor = skipped;
      continue;
    }

    if (sql[cursor] === "(") {
      depth += 1;
    } else if (sql[cursor] === ")") {
      depth -= 1;
      if (depth === 0) {
        items.push(sql.slice(start, cursor).trim());
        return { items, end: cursor + 1 };
      }
    } else if (sql[cursor] === "," && depth === 1) {
      items.push(sql.slice(start, cursor).trim());
      start = cursor + 1;
    }

    cursor += 1;
  }

  return undefined;
}

function getTopLevelSQLiteTokens(sql: string): SQLiteToken[] {
  const tokens: SQLiteToken[] = [];
  let depth = 0;
  let cursor = 0;

  while (cursor < sql.length) {
    const token = readSQLiteToken(sql, cursor);
    if (!token) {
      break;
    }

    if (token.kind === "symbol" && token.value === "(") {
      depth += 1;
    } else if (token.kind === "symbol" && token.value === ")") {
      depth -= 1;
    } else if (depth === 0) {
      tokens.push(token);
    }
    cursor = token.end;
  }

  return tokens;
}

function stripSQLiteIndexTermModifiers(term: string): string {
  const tokens = getTopLevelSQLiteTokens(term);
  let end = term.length;
  let lastIndex = tokens.length - 1;

  if (
    isWord(tokens[lastIndex], "ASC") ||
    isWord(tokens[lastIndex], "DESC")
  ) {
    end = tokens[lastIndex]!.start;
    lastIndex -= 1;
  }

  if (lastIndex >= 1 && isWord(tokens[lastIndex - 1], "COLLATE")) {
    end = Math.min(end, tokens[lastIndex - 1]!.start);
  }

  return term.slice(0, end).trim();
}

export interface SQLiteIndexDefinition {
  expressions: string[];
  where?: string;
}

export function parseSQLiteIndexDefinition(sql: string): SQLiteIndexDefinition {
  const list = readSQLiteParenthesizedList(sql);
  if (!list) {
    return { expressions: [] };
  }

  let token = readSQLiteToken(sql, list.end);
  while (token && !isWord(token, "WHERE")) {
    token = readSQLiteToken(sql, token.end);
  }

  const where = token
    ? sql.slice(token.end).trim().replace(/;+\s*$/g, "")
    : undefined;

  return {
    expressions: list.items.map(stripSQLiteIndexTermModifiers),
    where: where || undefined,
  };
}

function extractGeneratedExpression(columnDefinition: string, start: number): string | undefined {
  let depth = 0;
  let cursor = start;

  while (cursor < columnDefinition.length) {
    const skipped = skipQuotedOrComment(columnDefinition, cursor);
    if (skipped !== undefined) {
      cursor = skipped;
      continue;
    }

    if (columnDefinition[cursor] === "(") {
      depth += 1;
    } else if (columnDefinition[cursor] === ")") {
      depth -= 1;
    } else if (depth === 0 && isKeywordAt(columnDefinition, cursor, "AS")) {
      const openParenthesis = skipWhitespaceAndComments(
        columnDefinition,
        cursor + "AS".length
      );
      if (columnDefinition[openParenthesis] === "(") {
        return readParenthesizedExpression(columnDefinition, openParenthesis)?.expression;
      }
    }

    cursor += 1;
  }

  return undefined;
}

export function extractSQLiteGeneratedExpressions(sql: string): Map<string, string> {
  const expressions = new Map<string, string>();

  for (const definition of splitSQLiteTableDefinitions(sql)) {
    if (isSQLiteTableConstraint(definition)) {
      continue;
    }
    const identifier = readSQLiteIdentifier(definition);
    if (!identifier) {
      continue;
    }

    const expression = extractGeneratedExpression(definition, identifier.end);
    if (expression !== undefined) {
      expressions.set(identifier.name, expression);
    }
  }

  return expressions;
}

export function extractSQLiteColumnCollations(sql: string): Map<string, string> {
  const collations = new Map<string, string>();

  for (const definition of splitSQLiteTableDefinitions(sql)) {
    if (isSQLiteTableConstraint(definition)) {
      continue;
    }
    const column = readSQLiteIdentifier(definition);
    if (!column) {
      continue;
    }

    let depth = 0;
    let cursor = column.end;
    while (cursor < definition.length) {
      const skipped = skipQuotedOrComment(definition, cursor);
      if (skipped !== undefined) {
        cursor = skipped;
        continue;
      }
      if (definition[cursor] === "(") {
        depth += 1;
      } else if (definition[cursor] === ")") {
        depth -= 1;
      } else if (
        depth === 0 &&
        isKeywordAt(definition, cursor, "COLLATE")
      ) {
        const collation = readSQLiteIdentifier(
          definition.slice(cursor + "COLLATE".length)
        );
        if (collation) {
          collations.set(column.name, collation.name);
        }
        break;
      }
      cursor += 1;
    }
  }

  return collations;
}

export function extractSQLiteAutoincrementColumns(sql: string): string[] {
  const columns: string[] = [];

  for (const definition of splitSQLiteTableDefinitions(sql)) {
    if (isSQLiteTableConstraint(definition)) {
      continue;
    }
    const identifier = readSQLiteIdentifier(definition);
    if (!identifier) {
      continue;
    }

    let cursor = identifier.end;
    while (cursor < definition.length) {
      const skipped = skipQuotedOrComment(definition, cursor);
      if (skipped !== undefined) {
        cursor = skipped;
        continue;
      }
      if (isKeywordAt(definition, cursor, "AUTOINCREMENT")) {
        columns.push(identifier.name);
        break;
      }
      cursor += 1;
    }
  }

  return columns;
}

export function extractSQLiteColumnDefinition(
  sql: string,
  columnName: string
): string | undefined {
  for (const definition of splitSQLiteTableDefinitions(sql)) {
    if (isSQLiteTableConstraint(definition)) {
      continue;
    }
    const identifier = readSQLiteIdentifier(definition);
    if (identifier?.name === columnName) {
      return definition;
    }
  }

  return undefined;
}

export function replaceSQLiteColumnDefinitionName(
  definition: string,
  columnName: string
): string | undefined {
  const identifier = readSQLiteIdentifier(definition);
  if (!identifier) {
    return undefined;
  }

  const start = skipWhitespaceAndComments(definition, 0);
  const quotedName = `"${columnName.replace(/"/g, '""')}"`;
  return definition.slice(0, start) + quotedName + definition.slice(identifier.end);
}

export interface SQLiteTableDefinition {
  columns: Array<{ name: string; definition: string }>;
  constraints: string[];
}

interface SQLiteForeignKeyMatchClause {
  name: string;
  start: number;
  end: number;
}

function findSQLiteForeignKeyMatchClauses(
  definition: string
): SQLiteForeignKeyMatchClause[] {
  const clauses: SQLiteForeignKeyMatchClause[] = [];
  let cursor = 0;

  while (cursor < definition.length) {
    const skipped = skipQuotedOrComment(definition, cursor);
    if (skipped !== undefined) {
      cursor = skipped;
      continue;
    }
    if (!isKeywordAt(definition, cursor, "REFERENCES")) {
      cursor += 1;
      continue;
    }

    const tableStart = cursor + "REFERENCES".length;
    const referencedTable = readSQLiteIdentifier(
      definition.slice(tableStart)
    );
    if (!referencedTable) {
      cursor = tableStart;
      continue;
    }

    let clauseCursor = tableStart + referencedTable.end;
    const openParenthesis = skipWhitespaceAndComments(
      definition,
      clauseCursor
    );
    if (definition[openParenthesis] === "(") {
      const referencedColumns = readParenthesizedExpression(
        definition,
        openParenthesis
      );
      clauseCursor = referencedColumns?.end || openParenthesis + 1;
    }

    while (clauseCursor < definition.length) {
      const token = readSQLiteToken(definition, clauseCursor);
      if (!token) {
        break;
      }
      if (token.kind === "symbol" && token.value === "(") {
        const expression = readParenthesizedExpression(
          definition,
          token.start
        );
        clauseCursor = expression?.end || token.end;
        continue;
      }
      if (isWord(token, "CONSTRAINT") || isWord(token, "COLLATE")) {
        clauseCursor = readSQLiteToken(definition, token.end)?.end || token.end;
        continue;
      }
      if (isWord(token, "MATCH")) {
        const matchName = readSQLiteIdentifier(definition.slice(token.end));
        if (matchName) {
          clauses.push({
            name: matchName.name.toUpperCase(),
            start: token.start,
            end: token.end + matchName.end,
          });
          clauseCursor = token.end + matchName.end;
          continue;
        }
      }
      clauseCursor = token.end;
    }

    cursor = definition.length;
  }

  return clauses;
}

export function extractSQLiteForeignKeyMatchClauses(sql: string): string[] {
  return splitSQLiteTableDefinitions(sql).flatMap(function (definition) {
    return findSQLiteForeignKeyMatchClauses(definition).map(function (clause) {
      return clause.name;
    });
  });
}

export function removeSQLiteForeignKeyMatchSimpleClauses(
  definition: string
): string {
  const ranges = findSQLiteForeignKeyMatchClauses(definition)
    .filter(function (clause) {
      return clause.name === "SIMPLE";
    });
  let result = definition;
  for (const range of ranges.reverse()) {
    result = result.slice(0, range.start) + result.slice(range.end);
  }
  return result;
}

export function canonicalizeSQLiteForeignKeyDefinition(
  definition: string
): string {
  return removeSQLiteForeignKeyMatchSimpleClauses(
    removeSQLiteForeignKeyTargetColumns(definition)
  );
}

export function canonicalizeSQLiteDefinitionIdentifiers(
  definition: string,
  identifiers: readonly string[]
): string {
  const normalizedIdentifiers = new Set(
    identifiers.map(normalizeSQLiteIdentifier)
  );
  let result = "";
  let cursor = 0;

  while (cursor < definition.length) {
    if (definition[cursor] === "'") {
      const end = skipQuoted(definition, cursor, "'");
      result += definition.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (
      definition.startsWith("--", cursor) ||
      definition.startsWith("/*", cursor)
    ) {
      const end = definition.startsWith("--", cursor)
        ? skipLineComment(definition, cursor)
        : skipBlockComment(definition, cursor);
      result += definition.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (
      definition[cursor] === '"' ||
      definition[cursor] === "`" ||
      definition[cursor] === "["
    ) {
      const identifier = readSQLiteIdentifier(definition.slice(cursor));
      if (identifier) {
        const normalized = normalizeSQLiteIdentifier(identifier.name);
        result += normalizedIdentifiers.has(normalized)
          ? quoteCanonicalSQLiteIdentifier(normalized)
          : definition.slice(cursor, cursor + identifier.end);
        cursor += identifier.end;
        continue;
      }
    }
    if (isIdentifierCharacter(definition[cursor])) {
      let end = cursor + 1;
      while (isIdentifierCharacter(definition[end])) {
        end += 1;
      }
      const token = definition.slice(cursor, end);
      const normalized = normalizeSQLiteIdentifier(token);
      result += normalizedIdentifiers.has(normalized)
        ? quoteCanonicalSQLiteIdentifier(normalized)
        : normalized;
      cursor = end;
      continue;
    }
    result += definition[cursor];
    cursor += 1;
  }

  return result;
}

export function normalizeSQLiteSchemaDefinition(
  definition: string,
  identifiers: readonly string[]
): string {
  const cleaned = definition.trim().replace(/;+\s*$/g, "");
  const canonical = canonicalizeSQLiteDefinitionIdentifiers(
    cleaned,
    identifiers
  );
  let result = "";
  let cursor = 0;

  function appendSeparator(): void {
    if (result.length > 0 && !result.endsWith(" ")) {
      result += " ";
    }
  }

  while (cursor < canonical.length) {
    if (canonical[cursor] === "'") {
      const end = skipQuoted(canonical, cursor, "'");
      result += canonical.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (
      canonical.startsWith("--", cursor) ||
      canonical.startsWith("/*", cursor)
    ) {
      cursor = canonical.startsWith("--", cursor)
        ? skipLineComment(canonical, cursor)
        : skipBlockComment(canonical, cursor);
      appendSeparator();
      continue;
    }
    if (
      canonical[cursor] === '"' ||
      canonical[cursor] === "`" ||
      canonical[cursor] === "["
    ) {
      const identifier = readSQLiteIdentifier(canonical.slice(cursor));
      if (identifier) {
        result += canonical.slice(cursor, cursor + identifier.end);
        cursor += identifier.end;
        continue;
      }
    }
    if (/\s/u.test(canonical[cursor] || "")) {
      appendSeparator();
      cursor += 1;
      continue;
    }
    result += canonical[cursor];
    cursor += 1;
  }

  return result.trim();
}

export function removeSQLiteForeignKeyTargetColumns(
  definition: string
): string {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;

  while (cursor < definition.length) {
    const skipped = skipQuotedOrComment(definition, cursor);
    if (skipped !== undefined) {
      cursor = skipped;
      continue;
    }
    if (!isKeywordAt(definition, cursor, "REFERENCES")) {
      cursor += 1;
      continue;
    }

    const tableStart = cursor + "REFERENCES".length;
    const referencedTable = readSQLiteIdentifier(
      definition.slice(tableStart)
    );
    if (!referencedTable) {
      cursor = tableStart;
      continue;
    }

    const tableEnd = tableStart + referencedTable.end;
    const openParenthesis = skipWhitespaceAndComments(definition, tableEnd);
    if (definition[openParenthesis] !== "(") {
      cursor = tableEnd;
      continue;
    }

    const referencedColumns = readParenthesizedExpression(
      definition,
      openParenthesis
    );
    if (!referencedColumns) {
      cursor = openParenthesis + 1;
      continue;
    }
    ranges.push({ start: tableEnd, end: referencedColumns.end });
    cursor = referencedColumns.end;
  }

  let result = definition;
  for (const range of ranges.reverse()) {
    result = result.slice(0, range.start) + result.slice(range.end);
  }
  return result;
}

function isSQLiteTableConstraint(definition: string): boolean {
  const token = readSQLiteToken(definition, 0);
  return token?.kind === "word" &&
    SQLITE_TABLE_CONSTRAINT_KEYWORDS.has(token.value);
}

export function parseSQLiteTableDefinition(sql: string): SQLiteTableDefinition {
  const columns: SQLiteTableDefinition["columns"] = [];
  const constraints: string[] = [];

  for (const definition of splitSQLiteTableDefinitions(sql)) {
    if (isSQLiteTableConstraint(definition)) {
      constraints.push(definition);
      continue;
    }

    const identifier = readSQLiteIdentifier(definition);
    if (identifier) {
      columns.push({ name: identifier.name, definition });
    }
  }

  return { columns, constraints };
}

export function replaceSQLiteCreateTableName(
  sql: string,
  tableName: string
): string | undefined {
  let token = readExpectedWord(sql, 0, "CREATE");
  if (!token) {
    return undefined;
  }

  token = readSQLiteToken(sql, token.end);
  if (isWord(token, "TEMP") || isWord(token, "TEMPORARY")) {
    token = readSQLiteToken(sql, token.end);
  }
  if (isWord(token, "VIRTUAL")) {
    token = readSQLiteToken(sql, token.end);
  }
  if (!isWord(token, "TABLE")) {
    return undefined;
  }

  token = readSQLiteToken(sql, token.end);
  if (isWord(token, "IF")) {
    const notToken = readExpectedWord(sql, token.end, "NOT");
    const existsToken = notToken
      ? readExpectedWord(sql, notToken.end, "EXISTS")
      : undefined;
    if (!existsToken) {
      return undefined;
    }
    token = readSQLiteToken(sql, existsToken.end);
  }
  if (!token || token.kind === "symbol") {
    return undefined;
  }

  const dot = readSQLiteToken(sql, token.end);
  if (dot?.kind === "symbol" && dot.value === ".") {
    token = readSQLiteToken(sql, dot.end);
    if (!token || token.kind === "symbol") {
      return undefined;
    }
  }

  const quotedName = `"${tableName.replace(/"/g, '""')}"`;
  return sql.slice(0, token.start) + quotedName + sql.slice(token.end);
}

export function extractSQLiteCheckExpressions(sql: string): string[] {
  const expressions: string[] = [];
  let cursor = 0;

  while (cursor < sql.length) {
    const skipped = skipQuotedOrComment(sql, cursor);
    if (skipped !== undefined) {
      cursor = skipped;
      continue;
    }

    if (!isKeywordAt(sql, cursor, "CHECK")) {
      cursor += 1;
      continue;
    }

    const openParenthesis = skipWhitespaceAndComments(sql, cursor + "CHECK".length);
    if (sql[openParenthesis] !== "(") {
      cursor += "CHECK".length;
      continue;
    }

    const parsed = readParenthesizedExpression(sql, openParenthesis);
    if (!parsed) {
      cursor = openParenthesis + 1;
      continue;
    }

    expressions.push(parsed.expression);
    cursor = parsed.end;
  }

  return expressions;
}

export function findSQLiteStatementStartKeyword(
  sql: string,
  keywords: string[]
): string | undefined {
  const candidates = new Set(keywords.map(function (keyword) {
    return keyword.toUpperCase();
  }));
  let cursor = 0;
  let atStatementStart = true;
  let awaitingCreateObject = false;
  let triggerStatement = false;
  let inTriggerBody = false;
  let triggerCaseDepth = 0;
  let triggerEndSeen = false;

  while (cursor < sql.length) {
    const token = readSQLiteToken(sql, cursor);
    if (!token) {
      break;
    }
    cursor = token.end;

    if (token.kind === "symbol" && token.value === ";") {
      if (inTriggerBody && !triggerEndSeen) {
        continue;
      }
      atStatementStart = true;
      awaitingCreateObject = false;
      triggerStatement = false;
      inTriggerBody = false;
      triggerCaseDepth = 0;
      triggerEndSeen = false;
      continue;
    }

    if (token.kind === "word") {
      const keyword = token.value;
      if (inTriggerBody) {
        if (keyword === "CASE") {
          triggerCaseDepth += 1;
        } else if (keyword === "END") {
          if (triggerCaseDepth > 0) {
            triggerCaseDepth -= 1;
          } else {
            triggerEndSeen = true;
          }
        }
        continue;
      }
      if (atStatementStart) {
        if (candidates.has(keyword)) {
          return keyword;
        }
        awaitingCreateObject = keyword === "CREATE";
        atStatementStart = false;
        continue;
      }
      if (awaitingCreateObject) {
        if (keyword === "TEMP" || keyword === "TEMPORARY") {
          continue;
        }
        triggerStatement = keyword === "TRIGGER";
        awaitingCreateObject = false;
      } else if (triggerStatement && keyword === "BEGIN") {
        inTriggerBody = true;
      }
      continue;
    }

    if (!inTriggerBody) {
      atStatementStart = false;
    }
  }

  return undefined;
}
