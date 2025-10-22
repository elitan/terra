import { describe, test, expect } from "bun:test";
import { SQLBuilder, sql } from "../../utils/sql-builder";

describe("SQLBuilder", () => {
  describe("Identifier Quoting", () => {
    test("should quote simple identifier", () => {
      const builder = new SQLBuilder();
      builder.ident("users");
      expect(builder.build()).toBe('"users"');
    });

    test("should escape double quotes by doubling them", () => {
      const builder = new SQLBuilder();
      builder.ident('my"table');
      expect(builder.build()).toBe('"my""table"');
    });

    test("should handle multiple double quotes", () => {
      const builder = new SQLBuilder();
      builder.ident('my"special"table');
      expect(builder.build()).toBe('"my""special""table"');
    });

    test("should handle empty string", () => {
      const builder = new SQLBuilder();
      builder.ident("");
      expect(builder.build()).toBe("");
    });

    test("should quote reserved keywords", () => {
      const builder = new SQLBuilder();
      builder.ident("user").ident("table").ident("select");
      expect(builder.build()).toBe('"user" "table" "select"');
    });

    test("should quote identifiers with special characters", () => {
      const builder = new SQLBuilder();
      builder.ident("my-table");
      expect(builder.build()).toBe('"my-table"');

      const builder2 = new SQLBuilder();
      builder2.ident("table$name");
      expect(builder2.build()).toBe('"table$name"');
    });
  });

  describe("Phrase Builder (p method)", () => {
    test("should add phrases with automatic spacing", () => {
      const builder = new SQLBuilder();
      builder.p("ALTER TABLE");
      expect(builder.build()).toBe("ALTER TABLE");
    });

    test("should handle multiple phrases", () => {
      const builder = new SQLBuilder();
      builder.p("ALTER", "TABLE", "users");
      expect(builder.build()).toBe("ALTER TABLE users");
    });

    test("should add space between separate calls", () => {
      const builder = new SQLBuilder();
      builder.p("ALTER TABLE");
      builder.p("users");
      expect(builder.build()).toBe("ALTER TABLE users");
    });

    test("should skip empty phrases", () => {
      const builder = new SQLBuilder();
      builder.p("ALTER", "", "TABLE");
      expect(builder.build()).toBe("ALTER TABLE");
    });

    test("should handle phrases ending with space", () => {
      const builder = new SQLBuilder();
      builder.p("ALTER TABLE ");
      builder.p("users");
      expect(builder.build()).toBe("ALTER TABLE users");
    });
  });

  describe("Table References", () => {
    test("should quote table name", () => {
      const builder = new SQLBuilder();
      builder.table("users");
      expect(builder.build()).toBe('"users"');
    });

    test("should handle schema qualification", () => {
      const builder = new SQLBuilder();
      builder.table("users", "public");
      expect(builder.build()).toBe('"public"."users"');
    });

    test("should use builder default schema", () => {
      const builder = new SQLBuilder();
      builder.schema = "myschema";
      builder.table("users");
      expect(builder.build()).toBe('"myschema"."users"');
    });

    test("should prefer explicit schema over default", () => {
      const builder = new SQLBuilder();
      builder.schema = "default_schema";
      builder.table("users", "explicit_schema");
      expect(builder.build()).toBe('"explicit_schema"."users"');
    });
  });

  describe("Column References", () => {
    test("should quote column name", () => {
      const builder = new SQLBuilder();
      builder.column("email");
      expect(builder.build()).toBe('"email"');
    });

    test("should be equivalent to ident", () => {
      const builder1 = new SQLBuilder();
      builder1.column("name");

      const builder2 = new SQLBuilder();
      builder2.ident("name");

      expect(builder1.build()).toBe(builder2.build());
    });
  });

  describe("Comma Separator", () => {
    test("should add comma separator", () => {
      const builder = new SQLBuilder();
      builder.ident("col1").comma().ident("col2");
      expect(builder.build()).toBe('"col1", "col2"');
    });

    test("should replace trailing space with comma", () => {
      const builder = new SQLBuilder();
      builder.p("SELECT").comma().p("FROM");
      expect(builder.build()).toBe("SELECT, FROM");
    });

    test("should work with multiple columns", () => {
      const builder = new SQLBuilder();
      builder.ident("id").comma().ident("name").comma().ident("email");
      expect(builder.build()).toBe('"id", "name", "email"');
    });
  });

  describe("Fluent API / Chaining", () => {
    test("should chain methods together", () => {
      const result = new SQLBuilder()
        .p("ALTER TABLE")
        .table("users")
        .p("ADD COLUMN")
        .ident("email")
        .p("VARCHAR(255)")
        .build();

      expect(result).toBe('ALTER TABLE "users" ADD COLUMN "email" VARCHAR(255)');
    });

    test("should support complex chaining", () => {
      const result = new SQLBuilder()
        .p("CREATE TABLE")
        .table("posts")
        .p("(")
        .ident("id")
        .p("SERIAL PRIMARY KEY")
        .comma()
        .ident("title")
        .p("VARCHAR(255)")
        .p(")")
        .build();

      expect(result).toBe(
        'CREATE TABLE "posts" ( "id" SERIAL PRIMARY KEY, "title" VARCHAR(255) )'
      );
    });
  });

  describe("ALTER TABLE Statements", () => {
    test("should generate ADD COLUMN statement", () => {
      const result = new SQLBuilder()
        .p("ALTER TABLE")
        .table("users")
        .p("ADD COLUMN")
        .ident("age")
        .p("INTEGER")
        .build();

      expect(result).toBe('ALTER TABLE "users" ADD COLUMN "age" INTEGER');
    });

    test("should generate DROP COLUMN statement", () => {
      const result = new SQLBuilder()
        .p("ALTER TABLE")
        .table("users")
        .p("DROP COLUMN")
        .ident("age")
        .build();

      expect(result).toBe('ALTER TABLE "users" DROP COLUMN "age"');
    });

    test("should generate ALTER COLUMN TYPE statement", () => {
      const result = new SQLBuilder()
        .p("ALTER TABLE")
        .table("users")
        .p("ALTER COLUMN")
        .ident("age")
        .p("TYPE VARCHAR(50)")
        .build();

      expect(result).toBe('ALTER TABLE "users" ALTER COLUMN "age" TYPE VARCHAR(50)');
    });

    test("should generate SET NOT NULL statement", () => {
      const result = new SQLBuilder()
        .p("ALTER TABLE")
        .table("users")
        .p("ALTER COLUMN")
        .ident("email")
        .p("SET NOT NULL")
        .build();

      expect(result).toBe('ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL');
    });

    test("should generate SET DEFAULT statement", () => {
      const result = new SQLBuilder()
        .p("ALTER TABLE")
        .table("users")
        .p("ALTER COLUMN")
        .ident("status")
        .p("SET DEFAULT 'active'")
        .build();

      expect(result).toBe(
        'ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT \'active\''
      );
    });
  });

  describe("CREATE Statements", () => {
    test("should generate CREATE TABLE statement", () => {
      const result = new SQLBuilder()
        .p("CREATE TABLE")
        .table("users")
        .p("(")
        .ident("id")
        .p("SERIAL PRIMARY KEY")
        .p(")")
        .build();

      expect(result).toBe('CREATE TABLE "users" ( "id" SERIAL PRIMARY KEY )');
    });

    test("should generate CREATE INDEX statement", () => {
      const result = new SQLBuilder()
        .p("CREATE INDEX")
        .ident("idx_users_email")
        .p("ON")
        .table("users")
        .p("(")
        .ident("email")
        .p(")")
        .build();

      expect(result).toBe(
        'CREATE INDEX "idx_users_email" ON "users" ( "email" )'
      );
    });

    test("should generate CREATE UNIQUE INDEX statement", () => {
      const result = new SQLBuilder()
        .p("CREATE UNIQUE INDEX")
        .ident("idx_users_email")
        .p("ON")
        .table("users")
        .p("(")
        .ident("email")
        .p(")")
        .build();

      expect(result).toBe(
        'CREATE UNIQUE INDEX "idx_users_email" ON "users" ( "email" )'
      );
    });
  });

  describe("DROP Statements", () => {
    test("should generate DROP TABLE statement", () => {
      const result = new SQLBuilder()
        .p("DROP TABLE")
        .table("users")
        .p("CASCADE")
        .build();

      expect(result).toBe('DROP TABLE "users" CASCADE');
    });

    test("should generate DROP INDEX statement", () => {
      const result = new SQLBuilder()
        .p("DROP INDEX")
        .ident("idx_users_email")
        .build();

      expect(result).toBe('DROP INDEX "idx_users_email"');
    });

    test("should generate DROP INDEX CONCURRENTLY statement", () => {
      const result = new SQLBuilder()
        .p("DROP INDEX CONCURRENTLY")
        .ident("idx_users_email")
        .build();

      expect(result).toBe('DROP INDEX CONCURRENTLY "idx_users_email"');
    });
  });

  describe("Constraint Statements", () => {
    test("should generate ADD CONSTRAINT PRIMARY KEY", () => {
      const result = new SQLBuilder()
        .p("ALTER TABLE")
        .table("users")
        .p("ADD CONSTRAINT")
        .ident("pk_users")
        .p("PRIMARY KEY (")
        .ident("id")
        .p(")")
        .build();

      expect(result).toBe(
        'ALTER TABLE "users" ADD CONSTRAINT "pk_users" PRIMARY KEY ( "id" )'
      );
    });

    test("should generate ADD CONSTRAINT FOREIGN KEY", () => {
      const result = new SQLBuilder()
        .p("ALTER TABLE")
        .table("posts")
        .p("ADD CONSTRAINT")
        .ident("fk_posts_user")
        .p("FOREIGN KEY (")
        .ident("user_id")
        .p(") REFERENCES")
        .table("users")
        .p("(")
        .ident("id")
        .p(")")
        .build();

      expect(result).toBe(
        'ALTER TABLE "posts" ADD CONSTRAINT "fk_posts_user" FOREIGN KEY ( "user_id" ) REFERENCES "users" ( "id" )'
      );
    });

    test("should generate DROP CONSTRAINT", () => {
      const result = new SQLBuilder()
        .p("ALTER TABLE")
        .table("users")
        .p("DROP CONSTRAINT")
        .ident("pk_users")
        .build();

      expect(result).toBe('ALTER TABLE "users" DROP CONSTRAINT "pk_users"');
    });
  });

  describe("Helper Function", () => {
    test("should create builder with initial phrases", () => {
      const result = sql("ALTER TABLE").table("users").p("DROP COLUMN").ident("age").build();

      expect(result).toBe('ALTER TABLE "users" DROP COLUMN "age"');
    });

    test("should create empty builder when no phrases", () => {
      const result = sql().table("users").build();

      expect(result).toBe('"users"');
    });
  });

  describe("Edge Cases", () => {
    test("should handle empty builder", () => {
      const builder = new SQLBuilder();
      expect(builder.build()).toBe("");
    });

    test("should trim trailing whitespace", () => {
      const builder = new SQLBuilder();
      builder.p("SELECT");
      expect(builder.build()).toBe("SELECT");
    });

    test("should handle consecutive spaces correctly", () => {
      const builder = new SQLBuilder();
      builder.p("ALTER  TABLE");
      expect(builder.build()).toBe("ALTER  TABLE");
    });

    test("toString should work", () => {
      const builder = new SQLBuilder();
      builder.p("SELECT").p("*");
      expect(builder.toString()).toBe("SELECT *");
    });
  });

  describe("Schema Qualification with Complex Queries", () => {
    test("should handle schema qualification in complex ALTER", () => {
      const builder = new SQLBuilder();
      builder.schema = "myschema";

      const result = builder
        .p("ALTER TABLE")
        .table("users")
        .p("ADD COLUMN")
        .ident("email")
        .p("VARCHAR(255)")
        .build();

      expect(result).toBe(
        'ALTER TABLE "myschema"."users" ADD COLUMN "email" VARCHAR(255)'
      );
    });

    test("should handle cross-schema foreign key", () => {
      const result = new SQLBuilder()
        .p("ALTER TABLE")
        .table("posts", "public")
        .p("ADD CONSTRAINT")
        .ident("fk_user")
        .p("FOREIGN KEY (")
        .ident("user_id")
        .p(") REFERENCES")
        .table("users", "auth")
        .p("(")
        .ident("id")
        .p(")")
        .build();

      expect(result).toBe(
        'ALTER TABLE "public"."posts" ADD CONSTRAINT "fk_user" FOREIGN KEY ( "user_id" ) REFERENCES "auth"."users" ( "id" )'
      );
    });
  });

  describe("Indentation", () => {
    test("should support basic newline", () => {
      const result = new SQLBuilder()
        .p("CREATE TABLE")
        .table("users")
        .p("(")
        .nl()
        .ident("id")
        .p("SERIAL")
        .nl()
        .p(")")
        .build();

      expect(result).toContain("\n");
    });

    test("should support indentation levels", () => {
      const result = new SQLBuilder()
        .p("CREATE TABLE")
        .table("users")
        .p("(")
        .nl()
        .indentIn()
        .ident("id")
        .p("SERIAL")
        .nl()
        .indentOut()
        .p(")")
        .build();

      expect(result).toContain("\n  "); // Should have indentation
    });
  });
});
