/**
 * SQLBuilder provides a fluent API for building SQL statements with automatic
 * identifier quoting and consistent formatting.
 *
 * @example
 * ```typescript
 * const sql = new SQLBuilder()
 *   .p('ALTER TABLE')
 *   .table('users')
 *   .p('ADD COLUMN')
 *   .ident('email')
 *   .p('VARCHAR(255)')
 *   .build();
 * // Result: ALTER TABLE "users" ADD COLUMN "email" VARCHAR(255)
 * ```
 */
export class SQLBuilder {
  private buffer: string[] = [];
  private quoteChar = '"'; // PostgreSQL uses double quotes for identifiers
  public schema?: string; // Optional schema qualifier
  public indent = "  "; // Indentation string
  private level = 0; // Current indentation level

  /**
   * P writes phrases to the builder separated and suffixed with whitespace.
   * Automatically handles spacing between elements.
   */
  p(...phrases: string[]): this {
    for (const phrase of phrases) {
      if (!phrase) continue;

      // Add space before phrase if buffer is not empty and doesn't end with space/newline/open paren
      if (this.buffer.length > 0) {
        const last = this.lastChar();
        if (last !== ' ' && last !== '(' && last !== '\n') {
          this.buffer.push(' ');
        }
      }

      this.buffer.push(phrase);

      // Add space after phrase if it doesn't already end with one
      if (phrase[phrase.length - 1] !== ' ') {
        this.buffer.push(' ');
      }
    }
    return this;
  }

  /**
   * Ident writes the given string as a quoted SQL identifier.
   * Escapes double quotes by doubling them per PostgreSQL rules.
   *
   * @example
   * ident('my"table') // "my""table"
   * ident('users') // "users"
   */
  ident(name: string): this {
    if (!name) return this;

    // Escape double quotes by doubling them
    const escaped = name.replace(/"/g, '""');

    this.buffer.push(this.quoteChar);
    this.buffer.push(escaped);
    this.buffer.push(this.quoteChar);
    this.buffer.push(' ');

    return this;
  }

  /**
   * Table writes a table identifier, optionally qualified with schema.
   * If schema is provided, uses it. Otherwise uses the builder's default schema.
   *
   * @example
   * table('users') // "users" (or "public"."users" if schema is set)
   * table('users', 'myschema') // "myschema"."users"
   */
  table(name: string, schema?: string): this {
    const schemaName = schema ?? this.schema;

    if (schemaName) {
      this.ident(schemaName);
      this.rewriteLastChar('.');
    }

    this.ident(name);
    return this;
  }

  /**
   * Column writes a column identifier (same as ident, but semantically clearer).
   */
  column(name: string): this {
    return this.ident(name);
  }

  /**
   * Comma writes a comma separator.
   * Replaces trailing space if present, otherwise appends.
   */
  comma(): this {
    if (this.buffer.length > 0 && this.lastChar() === ' ') {
      this.rewriteLastChar(',');
      this.buffer.push(' ');
    } else {
      this.buffer.push(', ');
    }
    return this;
  }

  /**
   * NL adds a line break and indents the next line if indentation is enabled.
   */
  nl(): this {
    if (this.indent) {
      if (this.lastChar() === ' ') {
        this.rewriteLastChar('\n');
      } else {
        this.buffer.push('\n');
      }
      // Add indentation
      for (let i = 0; i < this.level; i++) {
        this.buffer.push(this.indent);
      }
    }
    return this;
  }

  /**
   * Indent increases indentation level.
   */
  indentIn(): this {
    this.level++;
    return this;
  }

  /**
   * Unindent decreases indentation level.
   */
  indentOut(): this {
    this.level--;
    return this;
  }

  /**
   * Build returns the final SQL string with trailing whitespace trimmed.
   */
  build(): string {
    let result = this.buffer.join('').trim();
    // Clean up space before semicolon
    result = result.replace(/\s+;/g, ';');
    return result;
  }

  /**
   * toString is an alias for build() for convenience.
   */
  toString(): string {
    return this.build();
  }

  /**
   * Helper to get the last character in the buffer.
   */
  private lastChar(): string {
    if (this.buffer.length === 0) return '';
    const last = this.buffer[this.buffer.length - 1];
    if (!last) return '';
    return last[last.length - 1] || '';
  }

  /**
   * Helper to rewrite the last character in the buffer.
   */
  rewriteLastChar(char: string): this {
    if (this.buffer.length === 0) return this;

    const last = this.buffer[this.buffer.length - 1];
    if (!last) return this;
    this.buffer[this.buffer.length - 1] = last.slice(0, -1) + char;

    return this;
  }
}

/**
 * Helper function to create a new SQLBuilder instance.
 * Convenient for one-liners.
 *
 * @example
 * sql('ALTER TABLE').table('users').p('DROP COLUMN').ident('email').build()
 */
export function sql(...phrases: string[]): SQLBuilder {
  const builder = new SQLBuilder();
  if (phrases.length > 0) {
    builder.p(...phrases);
  }
  return builder;
}
