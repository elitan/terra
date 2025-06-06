/**
 * Comprehensive test data generators for PostgreSQL column types
 * Used for edge case testing, boundary value validation, and error scenario testing
 */

// PostgreSQL numeric limits
export const POSTGRES_LIMITS = {
  INT2_MIN: -32768,
  INT2_MAX: 32767,
  INT4_MIN: -2147483648,
  INT4_MAX: 2147483647,
  INT8_MIN: -9223372036854775808n,
  INT8_MAX: 9223372036854775807n,
  VARCHAR_MAX_LENGTH: 10485760, // Default PostgreSQL limit
  TEXT_MAX_LENGTH: 1073741823, // ~1GB limit
} as const;

/**
 * Boundary value generators for numeric types
 */
export const BoundaryValues = {
  /**
   * INTEGER (INT4) boundary values
   */
  integer: {
    valid: [
      POSTGRES_LIMITS.INT4_MIN,
      POSTGRES_LIMITS.INT4_MIN + 1,
      -1,
      0,
      1,
      POSTGRES_LIMITS.INT4_MAX - 1,
      POSTGRES_LIMITS.INT4_MAX,
    ],
    overflow: [POSTGRES_LIMITS.INT4_MAX + 1, POSTGRES_LIMITS.INT4_MIN - 1],
    asStrings: [
      `'${POSTGRES_LIMITS.INT4_MIN}'`,
      `'${POSTGRES_LIMITS.INT4_MAX}'`,
      `'0'`,
      `'-1'`,
      `'1'`,
    ],
  },

  /**
   * BIGINT (INT8) boundary values
   */
  bigint: {
    valid: [
      POSTGRES_LIMITS.INT8_MIN,
      POSTGRES_LIMITS.INT8_MIN + 1n,
      -1n,
      0n,
      1n,
      POSTGRES_LIMITS.INT8_MAX - 1n,
      POSTGRES_LIMITS.INT8_MAX,
    ],
    asStrings: [
      `'${POSTGRES_LIMITS.INT8_MIN}'`,
      `'${POSTGRES_LIMITS.INT8_MAX}'`,
      `'0'`,
      `'-1'`,
      `'1'`,
    ],
  },

  /**
   * SMALLINT (INT2) boundary values
   */
  smallint: {
    valid: [
      POSTGRES_LIMITS.INT2_MIN,
      POSTGRES_LIMITS.INT2_MIN + 1,
      -1,
      0,
      1,
      POSTGRES_LIMITS.INT2_MAX - 1,
      POSTGRES_LIMITS.INT2_MAX,
    ],
    overflow: [POSTGRES_LIMITS.INT2_MAX + 1, POSTGRES_LIMITS.INT2_MIN - 1],
  },

  /**
   * DECIMAL/NUMERIC precision and scale edge cases
   */
  decimal: {
    maxPrecision: Array.from(
      { length: 5 },
      (_, i) => `'${"9".repeat(1000 + i * 100)}.99'`
    ),
    maxScale: [
      `'123.${"9".repeat(50)}'`,
      `'0.${"1".repeat(100)}'`,
      `'999.${"0".repeat(127)}'`,
    ],
    precisionLoss: [
      `'123.999999999'`, // Will be rounded
      `'999.999999999'`,
      `'0.000000001'`,
    ],
  },
};

/**
 * String edge case generators
 */
export const StringEdgeCases = {
  /**
   * Unicode and multi-byte character test data
   */
  unicode: [
    `'Hello 世界'`, // Mixed ASCII and Chinese
    `'🚀🎉💻'`, // Emojis (4-byte UTF-8)
    `'Ñañó'`, // Latin extended
    `'Здравствуй'`, // Cyrillic
    `'العربية'`, // Arabic (RTL)
    `'日本語'`, // Japanese
    `'🔥🌟✨'`, // More emojis
    `'à̲̅b̲̅c̲̅'`, // Combining diacritical marks
  ],

  /**
   * Get very long strings for performance testing
   */
  getVeryLongStrings(): string[] {
    return [
      "A".repeat(500),
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(10),
      "Unicode: 世界🌍🌎🌏 ".repeat(20),
      "Mixed: ABC123!@# ".repeat(30),
      "Special chars: àáâãäå∞≠±™® ".repeat(15),
    ];
  },

  /**
   * Get SQL special characters for testing escaping
   */
  getSQLSpecialCharacters(): string[] {
    return [
      "It's a test", // Single quote
      'Double "quotes" test', // Double quotes
      "Line1\nLine2", // Newline
      "Tab\tSeparated", // Tab
      "Backslash\\ Test", // Backslash
      "Special character test", // Replaced null byte
      "Carriage\rReturn", // Carriage return
      "Form\fFeed", // Form feed
      "Vertical\vTab", // Vertical tab
      "Semicolon; test", // Semicolon
      "Parentheses (test)", // Parentheses
      "Brackets [test]", // Brackets
      "Braces {test}", // Braces
    ];
  },

  /**
   * Get whitespace patterns for testing
   */
  getWhitespacePatterns(): string[] {
    return [
      " ", // Single space
      "   ", // Multiple spaces
      "\t", // Tab only
      "\n", // Newline only
      "\r", // Carriage return only
      " \t\n \r ", // Mixed whitespace
      "  \t  \n  ", // Complex mixed
      "\u00A0", // Non-breaking space
      "\u2000\u2001", // En quad, em quad
    ];
  },

  /**
   * Get SQL injection patterns for security testing
   */
  getSQLInjectionPatterns(): string[] {
    return [
      "'; DROP TABLE users; --",
      "1 OR 1=1",
      "UNION SELECT * FROM passwords",
      "<script>alert('xss')</script>",
      "' OR '1'='1",
      "admin'--",
      "' UNION SELECT NULL--",
      "1'; DELETE FROM users WHERE 1=1--",
      "' OR 1=1#",
      "')) OR 1=1--",
    ];
  },

  /**
   * Special characters and escape sequences
   */
  specialChars: [
    `'It''s a test'`, // Single quote escape
    `'"Double quotes"'`,
    `'Line1\nLine2'`, // Newline
    `'Tab\tSeparated'`, // Tab
    `'Backslash\\ Test'`, // Backslash
    `'NULL character\0test'`, // Null byte
    `'Carriage\rReturn'`, // Carriage return
    `'Form\fFeed'`, // Form feed
    `'Vertical\vTab'`, // Vertical tab
  ],

  /**
   * SQL injection patterns (should be safely handled)
   */
  sqlInjection: [
    `''; DROP TABLE users; --'`,
    `'1 OR 1=1'`,
    `'UNION SELECT * FROM passwords'`,
    `'<script>alert("xss")</script>'`,
    `'${Array(1000).fill("A").join("")}'`, // Buffer overflow attempt
  ],

  /**
   * Length boundary testing
   */
  lengthBoundaries: {
    empty: `''`,
    whitespace: [
      `' '`, // Single space
      `'   '`, // Multiple spaces
      `'\t'`, // Tab only
      `'\n'`, // Newline only
      `' \t\n '`, // Mixed whitespace
    ],
    long: (length: number) => `'${"A".repeat(length)}'`,
    veryLong: `'${Array(10000).fill("Lorem ipsum dolor sit amet").join(" ")}'`,
  },

  /**
   * Character encoding edge cases
   */
  encodings: [
    `'UTF-8: ℃ ™ ® © ¼ ½ ¾'`,
    `'Latin-1: àáâãäå'`,
    `'Extended: ←→↑↓'`,
    `'Math: ≤≥≠±∞'`,
    `'Currency: $€£¥₹₿'`,
  ],
};

/**
 * Boolean edge case generators
 */
export const BooleanEdgeCases = {
  /**
   * All PostgreSQL boolean representations
   */
  validTrue: [
    `'t'`,
    `'T'`,
    `'true'`,
    `'TRUE'`,
    `'True'`,
    `'tRuE'`,
    `'1'`,
    `'yes'`,
    `'YES'`,
    `'Yes'`,
    `'y'`,
    `'Y'`,
    `'on'`,
    `'ON'`,
    `'On'`,
  ],

  validFalse: [
    `'f'`,
    `'F'`,
    `'false'`,
    `'FALSE'`,
    `'False'`,
    `'fAlSe'`,
    `'0'`,
    `'no'`,
    `'NO'`,
    `'No'`,
    `'n'`,
    `'N'`,
    `'off'`,
    `'OFF'`,
    `'Off'`,
  ],

  /**
   * Invalid boolean strings that should cause conversion errors
   */
  invalid: [
    `'maybe'`,
    `'2'`,
    `'-1'`,
    `'TRUE_BUT_NOT_REALLY'`,
    `'yep'`,
    `'nope'`,
    `'null'`,
    `''`, // Empty string
    `' '`, // Space
  ],
};

/**
 * Invalid data generators for error testing
 */
export const InvalidData = {
  /**
   * Non-numeric strings for numeric type conversion testing
   */
  nonNumeric: [
    `'abc'`,
    `'not_a_number'`,
    `'123abc'`,
    `'12.34.56'`, // Multiple decimal points
    `'--123'`, // Double negative
    `'1e'`, // Incomplete scientific notation
    `'∞'`, // Infinity symbol
    `'NaN'`,
    `'1,234'`, // Comma separator
    `'$123.45'`, // Currency symbol
    `'123%'`, // Percentage
  ],

  /**
   * Malformed date/time strings (for future date type testing)
   */
  malformedDates: [
    `'2023-13-45'`, // Invalid month/day
    `'not-a-date'`,
    `'2023/02/29'`, // Non-leap year Feb 29
    `'25:61:99'`, // Invalid time
  ],

  /**
   * NULL and empty value edge cases
   */
  nullAndEmpty: [
    `NULL`,
    `''`,
    `'   '`, // Whitespace only
    `'\t'`,
    `'\n'`,
  ],
};

/**
 * Large dataset generators for performance testing
 */
export const LargeDatasetGenerators = {
  /**
   * Generate large number of VARCHAR values
   */
  generateVarcharDataset(size: number, valueLength: number = 50): string[] {
    return Array.from(
      { length: size },
      (_, i) =>
        `'Record_${i.toString().padStart(10, "0")}_${"x".repeat(valueLength)}'`
    );
  },

  /**
   * Generate large number of INTEGER values
   */
  generateIntegerDataset(size: number): number[] {
    return Array.from({ length: size }, (_, i) =>
      Math.floor(Math.random() * POSTGRES_LIMITS.INT4_MAX)
    );
  },

  /**
   * Generate large number of DECIMAL values
   */
  generateDecimalDataset(size: number): string[] {
    return Array.from(
      { length: size },
      (_, i) => `'${(Math.random() * 10000).toFixed(2)}'`
    );
  },

  /**
   * Generate mixed data types for complex testing
   */
  generateMixedDataset(size: number): Array<{
    varchar_col: string;
    int_col: number;
    decimal_col: string;
    boolean_col: string;
  }> {
    return Array.from({ length: size }, (_, i) => ({
      varchar_col: `'Mixed_Record_${i}'`,
      int_col: Math.floor(Math.random() * 1000),
      decimal_col: `'${(Math.random() * 100).toFixed(4)}'`,
      boolean_col: Math.random() > 0.5 ? `'true'` : `'false'`,
    }));
  },

  /**
   * Generate very long strings for VARCHAR length testing
   */
  generateLongStrings(count: number, lengths: number[]): string[] {
    return lengths.flatMap((length) =>
      Array.from(
        { length: count },
        (_, i) => `'Long_String_${i}_${"x".repeat(length)}'`
      )
    );
  },

  /**
   * Generate edge case combinations
   */
  generateEdgeCaseCombinations(): Array<{
    description: string;
    varchar_value: string;
    numeric_value: string;
    boolean_value: string;
  }> {
    return [
      {
        description: "Unicode with max integer",
        varchar_value: `'Unicode: 🚀'`,
        numeric_value: `'${POSTGRES_LIMITS.INT4_MAX}'`,
        boolean_value: `'TRUE'`,
      },
      {
        description: "Empty string with zero",
        varchar_value: `''`,
        numeric_value: `'0'`,
        boolean_value: `'false'`,
      },
      {
        description: "Special chars with negative",
        varchar_value: `'Special: \t\n\r'`,
        numeric_value: `'${POSTGRES_LIMITS.INT4_MIN}'`,
        boolean_value: `'f'`,
      },
      {
        description: "Long string with decimal",
        varchar_value: StringEdgeCases.lengthBoundaries.long(1000),
        numeric_value: `'999999.99999'`,
        boolean_value: `'1'`,
      },
    ];
  },
};

/**
 * Performance test data generators
 */
export const PerformanceTestData = {
  /**
   * Small dataset for quick tests
   */
  small: {
    size: 100,
    get varchar() {
      return LargeDatasetGenerators.generateVarcharDataset(this.size);
    },
    get integer() {
      return LargeDatasetGenerators.generateIntegerDataset(this.size);
    },
    get decimal() {
      return LargeDatasetGenerators.generateDecimalDataset(this.size);
    },
  },

  /**
   * Medium dataset for standard performance testing
   */
  medium: {
    size: 10000,
    get varchar() {
      return LargeDatasetGenerators.generateVarcharDataset(this.size);
    },
    get integer() {
      return LargeDatasetGenerators.generateIntegerDataset(this.size);
    },
    get decimal() {
      return LargeDatasetGenerators.generateDecimalDataset(this.size);
    },
  },

  /**
   * Large dataset for stress testing
   */
  large: {
    size: 100000,
    get varchar() {
      return LargeDatasetGenerators.generateVarcharDataset(this.size);
    },
    get integer() {
      return LargeDatasetGenerators.generateIntegerDataset(this.size);
    },
    get decimal() {
      return LargeDatasetGenerators.generateDecimalDataset(this.size);
    },
  },
};

/**
 * Test scenario builders
 */
export const ScenarioBuilders = {
  /**
   * Build a comprehensive type conversion test scenario
   */
  buildTypeConversionScenario(
    fromType: string,
    toType: string,
    testData: string[],
    shouldFail: boolean = false
  ) {
    return {
      fromType,
      toType,
      testData,
      shouldFail,
      description: `${fromType} → ${toType} conversion ${
        shouldFail ? "(should fail)" : "(should succeed)"
      }`,
    };
  },

  /**
   * Build boundary value test scenarios
   */
  buildBoundaryTestScenario(dataType: string, boundaryValues: any[]) {
    return {
      dataType,
      boundaryValues,
      description: `${dataType} boundary value testing`,
    };
  },

  /**
   * Build data integrity verification scenario
   */
  buildDataIntegrityScenario(
    originalData: string[],
    expectedData: string[],
    conversionType: string
  ) {
    return {
      originalData,
      expectedData,
      conversionType,
      description: `Data integrity verification for ${conversionType}`,
    };
  },
};

/**
 * Unicode test data generator for comprehensive Unicode testing
 */
export const UnicodeTestData = {
  /**
   * Get comprehensive Unicode test set
   */
  getComprehensiveSet(): Array<[string, string]> {
    return [
      ["Basic ASCII", "Hello World"],
      ["Mixed ASCII and Chinese", "Hello 世界"],
      ["Emojis", "🚀🎉💻"],
      ["Latin Extended", "Ñañó àáâãäå"],
      ["Cyrillic", "Здравствуй мир"],
      ["Arabic RTL", "العربية"],
      ["Japanese", "こんにちは世界"],
      ["Complex Emojis", "🔥🌟✨🎭🎪"],
      ["Combining Marks", "à̲̅b̲̅c̲̅"],
      ["Mathematical", "∑∞≠±√π"],
      ["Currency", "$€£¥₹₿"],
      ["Arrows", "←→↑↓↔↕"],
      ["Symbols", "™®©℃℉"],
      ["Thai", "สวัสดี"],
      ["Korean", "안녕하세요"],
      ["Hebrew", "שלום עולם"],
      ["Greek", "Γεια σου κόσμε"],
      ["Mixed Scripts", "Hello世界🌍مرحبا"],
    ];
  },

  /**
   * Get multi-byte characters for length testing
   */
  getMultiByteCharacters(): string[] {
    return [
      "ñ",
      "ö",
      "ü",
      "ß", // 2-byte UTF-8
      "世",
      "界",
      "中",
      "文", // 3-byte UTF-8
      "🌍",
      "🎉",
      "💻",
      "🚀", // 4-byte UTF-8
      "𝔘",
      "𝔫",
      "𝔦",
      "𝔠", // Mathematical script
      "🏳️‍🌈", // Complex emoji sequence
    ];
  },

  /**
   * Get emoji test set
   */
  getEmojiTestSet(): string[] {
    return [
      "😀",
      "😃",
      "😄",
      "😁", // Basic smileys
      "🚀",
      "🛸",
      "✈️",
      "🚁", // Transportation
      "🌍",
      "🌎",
      "🌏",
      "🌕", // Earth and space
      "💻",
      "📱",
      "⌚",
      "🖥️", // Technology
      "🎭",
      "🎪",
      "🎨",
      "🎬", // Arts
      "🔥",
      "💧",
      "🌟",
      "⚡", // Elements
      "👨‍💻",
      "👩‍🚀",
      "🧑‍🎨", // Profession emojis
      "🏳️‍🌈",
      "🏴‍☠️", // Flag sequences
      "👨‍👩‍👧‍👦", // Family emoji
      "🤝🏽",
      "👋🏿", // Skin tone modifiers
    ];
  },
};
