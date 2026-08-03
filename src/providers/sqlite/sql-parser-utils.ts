function isIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_$]/u.test(character);
}

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
    return { kind: "quoted", value: sql.slice(start, end), end };
  }

  if (isIdentifierCharacter(character)) {
    let end = start + 1;
    while (isIdentifierCharacter(sql[end])) {
      end += 1;
    }
    return { kind: "word", value: sql.slice(start, end).toUpperCase(), end };
  }

  return { kind: "symbol", value: character || "", end: start + 1 };
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
  const openParenthesis = findFirstUnquotedParenthesis(sql);
  if (openParenthesis === undefined) {
    return [];
  }

  const definitions: string[] = [];
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
        definitions.push(sql.slice(start, cursor).trim());
        break;
      }
    } else if (sql[cursor] === "," && depth === 1) {
      definitions.push(sql.slice(start, cursor).trim());
      start = cursor + 1;
    }

    cursor += 1;
  }

  return definitions;
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
