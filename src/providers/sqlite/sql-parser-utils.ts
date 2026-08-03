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
