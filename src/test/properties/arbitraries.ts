import fc from 'fast-check';

/**
 * Custom arbitraries (generators) for property-based testing of Terra's PostgreSQL schema management.
 * These generators create random but valid PostgreSQL schemas for testing properties like idempotency.
 */

/**
 * PostgreSQL base types (no aliases)
 */
export const pgBaseType = fc.oneof(
  fc.constant('TEXT'),
  fc.constant('BOOLEAN'),
  fc.constant('TIMESTAMP'),
  fc.constant('DATE'),
  fc.constant('JSONB'),
  fc.constant('UUID')
);

/**
 * PostgreSQL integer types with all their aliases
 */
export const pgIntegerType = fc.oneof(
  // INTEGER aliases
  fc.constant('INTEGER'),
  fc.constant('int'),
  fc.constant('int4'),
  // BIGINT aliases
  fc.constant('BIGINT'),
  fc.constant('int8'),
  // SMALLINT aliases
  fc.constant('SMALLINT'),
  fc.constant('int2')
);

/**
 * PostgreSQL VARCHAR types with various lengths
 */
export const pgVarcharType = fc.oneof(
  fc.constant('VARCHAR(50)'),
  fc.constant('VARCHAR(100)'),
  fc.constant('VARCHAR(255)'),
  fc.constant('VARCHAR(500)')
);

/**
 * All PostgreSQL types combined
 */
export const pgType = fc.oneof(
  pgBaseType,
  pgIntegerType,
  pgVarcharType
);

/**
 * Type alias pairs that should be treated as equivalent by Terra
 * Format: [type1, type2, canonical_name]
 */
export const typeAliasPair = fc.oneof(
  fc.constant(['INTEGER', 'int', 'integer'] as const),
  fc.constant(['INTEGER', 'int4', 'integer'] as const),
  fc.constant(['int', 'int4', 'integer'] as const),
  fc.constant(['BIGINT', 'int8', 'bigint'] as const),
  fc.constant(['SMALLINT', 'int2', 'smallint'] as const),
  fc.constant(['VARCHAR(100)', 'VARCHAR(100)', 'character varying'] as const),
  fc.constant(['TEXT', 'TEXT', 'text'] as const)
);

/**
 * Generate a default value appropriate for the given type
 */
export const defaultValue = (type: string): fc.Arbitrary<string | null> => {
  const lowerType = type.toLowerCase();

  // Integer types
  if (lowerType.includes('int') || lowerType.includes('serial')) {
    return fc.oneof(
      fc.constant(null),
      fc.integer({ min: 0, max: 1000 }).map(n => `${n}`)
    );
  }

  // String types
  if (lowerType.includes('varchar') || lowerType === 'text') {
    return fc.oneof(
      fc.constant(null),
      fc.stringMatching(/^[a-zA-Z0-9 ]{1,50}$/).map(s => `'${s}'`),
      fc.constant("'default'"),
      fc.constant("'test'")
    );
  }

  // Boolean type
  if (lowerType === 'boolean') {
    return fc.oneof(
      fc.constant(null),
      fc.constant('true'),
      fc.constant('false')
    );
  }

  // TIMESTAMP/DATE types
  if (lowerType.includes('timestamp')) {
    return fc.oneof(
      fc.constant(null),
      fc.constant('CURRENT_TIMESTAMP'),
      fc.constant("'2024-01-01 00:00:00'")
    );
  }

  if (lowerType === 'date') {
    return fc.oneof(
      fc.constant(null),
      fc.constant('CURRENT_DATE'),
      fc.constant("'2024-01-01'")
    );
  }

  // JSONB
  if (lowerType === 'jsonb') {
    return fc.oneof(
      fc.constant(null),
      fc.constant("'{}'::jsonb"),
      fc.constant("'[]'::jsonb")
    );
  }

  // UUID
  if (lowerType === 'uuid') {
    return fc.constant(null);
  }

  // Default: no default value
  return fc.constant(null);
};

/**
 * Column name generator (safe, common names)
 */
export const columnName = fc.constantFrom(
  'name',
  'email',
  'age',
  'status',
  'created_at',
  'updated_at',
  'description',
  'count',
  'value',
  'flag'
);

/**
 * Column definition generator
 * Generates a complete column definition with name, type, nullability, and optional default
 */
export const columnDefinition = fc.record({
  name: columnName,
  type: pgType,
  nullable: fc.boolean()
}).chain(col =>
  defaultValue(col.type).map(def => ({
    name: col.name,
    type: col.type,
    nullable: col.nullable,
    // Only set defaults for NOT NULL columns to avoid issues, or don't set defaults at all for complex types
    default: (!col.nullable && def !== null && !col.type.toLowerCase().includes('uuid') &&
              !col.type.toLowerCase().includes('jsonb') && !col.type.toLowerCase().includes('timestamp'))
              ? def : null
  }))
);

/**
 * Table name generator
 */
export const tableName = fc.constantFrom(
  'users',
  'products',
  'orders',
  'items',
  'posts',
  'comments',
  'categories',
  'tags'
);

/**
 * Generate a complete table schema as a CREATE TABLE statement
 * Ensures unique column names within a table
 */
export const tableSchema = fc.record({
  tableName: tableName,
  columns: fc.array(columnDefinition, { minLength: 1, maxLength: 5 })
}).map(({ tableName, columns }) => {
  // Ensure unique column names
  const uniqueColumns = Array.from(
    new Map(columns.map(c => [c.name, c])).values()
  );

  // Build column definitions
  const columnDefs = uniqueColumns.map(col => {
    let def = `${col.name} ${col.type}`;
    if (!col.nullable) {
      def += ' NOT NULL';
    }
    if (col.default) {
      def += ` DEFAULT ${col.default}`;
    }
    return def;
  }).join(',\n      ');

  return `
    CREATE TABLE ${tableName} (
      id SERIAL PRIMARY KEY,
      ${columnDefs}
    );
  `.trim();
});

/**
 * Generate a table schema with a specific column type
 * Useful for testing specific type conversions
 */
export const tableSchemaWithType = (type: string) => {
  return fc.record({
    tableName: tableName,
    columnName: columnName,
    nullable: fc.boolean()
  }).chain(({ tableName, columnName, nullable }) =>
    defaultValue(type).map(def => {
      let colDef = `${columnName} ${type}`;
      if (!nullable) {
        colDef += ' NOT NULL';
      }
      if (def && nullable) {
        colDef += ` DEFAULT ${def}`;
      }

      return `
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          ${colDef}
        );
      `.trim();
    })
  );
};

/**
 * Generate two schemas that differ only in type alias
 * Useful for testing type alias equivalence
 */
export const schemaWithTypeAlias = fc.record({
  tableName: tableName,
  columnName: columnName,
  aliasPair: typeAliasPair,
  nullable: fc.boolean()
}).chain(({ tableName, columnName, aliasPair, nullable }) => {
  const [type1, type2] = aliasPair;

  // Generate a default value if nullable
  return (nullable ? defaultValue(type1) : fc.constant(null)).map(def => {
    const buildSchema = (type: string) => {
      let colDef = `${columnName} ${type}`;
      if (!nullable) {
        colDef += ' NOT NULL';
      }
      if (def) {
        colDef += ` DEFAULT ${def}`;
      }

      return `
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          ${colDef}
        );
      `.trim();
    };

    return {
      schema1: buildSchema(type1),
      schema2: buildSchema(type2),
      tableName,
      columnName,
      type1,
      type2
    };
  });
});

/**
 * Generate test data for a given type
 * Used for data preservation property tests
 */
export const testDataForType = (type: string): fc.Arbitrary<any> => {
  const lowerType = type.toLowerCase();

  if (lowerType.includes('int')) {
    return fc.integer({ min: 0, max: 1000 });
  }

  if (lowerType.includes('varchar') || lowerType === 'text') {
    return fc.stringMatching(/^[a-zA-Z0-9 ]{1,50}$/);
  }

  if (lowerType === 'boolean') {
    return fc.boolean();
  }

  if (lowerType.includes('timestamp')) {
    return fc.constant('2024-01-01 00:00:00');
  }

  if (lowerType === 'date') {
    return fc.constant('2024-01-01');
  }

  if (lowerType === 'jsonb') {
    return fc.oneof(
      fc.constant('{}'),
      fc.constant('[]'),
      fc.constant('{"key": "value"}')
    );
  }

  return fc.constant(null);
};

/**
 * Generate an array of test data for a given type
 */
export const testDataArray = (type: string) => {
  return fc.array(testDataForType(type), { minLength: 5, maxLength: 20 });
};
