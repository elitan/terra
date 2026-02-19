import { describe, expect, test } from "bun:test";
import { ProcedureHandler } from "../core/schema/handlers/procedure-handler";
import { SequenceHandler } from "../core/schema/handlers/sequence-handler";
import { SchemaHandler } from "../core/schema/handlers/schema-handler";
import type { Procedure, SchemaDefinition, Sequence } from "../types/schema";

function makeSequence(overrides: Partial<Sequence> = {}): Sequence {
  return {
    name: "invoice_seq",
    increment: 1,
    minValue: 1,
    maxValue: 1000,
    start: 1,
    cache: 10,
    cycle: false,
    ...overrides,
  };
}

function makeProcedure(overrides: Partial<Procedure> = {}): Procedure {
  return {
    name: "refresh_stats",
    parameters: [],
    language: "sql",
    body: "BEGIN SELECT 1; END",
    ...overrides,
  };
}

describe("Handler module coverage", () => {
  describe("schema handler", () => {
    test("creates schemas with options and skips existing schemas", () => {
      const handler = new SchemaHandler();
      const desired: SchemaDefinition[] = [
        { name: "analytics", ifNotExists: true, owner: "reporter" },
        { name: "public" },
      ];
      const current: SchemaDefinition[] = [{ name: "public" }];

      const statements = handler.generateStatements(desired, current);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("CREATE SCHEMA");
      expect(statements[0]).toContain("IF NOT EXISTS");
      expect(statements[0]).toContain("\"analytics\"");
      expect(statements[0]).toContain("AUTHORIZATION");
      expect(statements[0]).toContain("\"reporter\"");
    });
  });

  describe("sequence handler", () => {
    test("creates unmanaged sequences", () => {
      const handler = new SequenceHandler();
      const statements = handler.generateStatements([makeSequence({ name: "orders_seq" })], []);

      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("CREATE SEQUENCE");
      expect(statements[0]).toContain("\"orders_seq\"");
    });

    test("skips owned sequences", () => {
      const handler = new SequenceHandler();
      const statements = handler.generateStatements(
        [makeSequence({ name: "owned_seq", ownedBy: "public.users.id" })],
        []
      );

      expect(statements).toEqual([]);
    });

    test("drops removed unmanaged sequences", () => {
      const handler = new SequenceHandler();
      const statements = handler.generateStatements([], [makeSequence({ name: "legacy_seq" })]);

      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("DROP SEQUENCE IF EXISTS");
      expect(statements[0]).toContain("\"legacy_seq\"");
    });

    test("does not drop removed owned sequences", () => {
      const handler = new SequenceHandler();
      const statements = handler.generateStatements(
        [],
        [makeSequence({ name: "owned_seq", ownedBy: "public.users.id" })]
      );

      expect(statements).toEqual([]);
    });

    test("recreates sequence when managed attributes change", () => {
      const handler = new SequenceHandler();
      const statements = handler.generateStatements(
        [makeSequence({ increment: 2 })],
        [makeSequence({ increment: 1 })]
      );

      expect(statements).toHaveLength(2);
      expect(statements[0]).toContain("DROP SEQUENCE IF EXISTS");
      expect(statements[1]).toContain("CREATE SEQUENCE");
      expect(statements[1]).toContain("INCREMENT 2");
    });

    test("keeps sequence when managed attributes match", () => {
      const handler = new SequenceHandler();
      const current = makeSequence();
      const desired = makeSequence();
      const statements = handler.generateStatements([desired], [current]);

      expect(statements).toEqual([]);
    });
  });

  describe("procedure handler", () => {
    test("creates procedures", () => {
      const handler = new ProcedureHandler();
      const statements = handler.generateStatements([makeProcedure({ name: "sync_data" })], []);

      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("CREATE PROCEDURE");
      expect(statements[0]).toContain("\"sync_data\"");
    });

    test("drops removed procedures", () => {
      const handler = new ProcedureHandler();
      const statements = handler.generateStatements([], [makeProcedure({ name: "old_proc" })]);

      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("DROP PROCEDURE IF EXISTS");
      expect(statements[0]).toContain("\"old_proc\"");
    });

    test("does not update for body whitespace only changes", () => {
      const handler = new ProcedureHandler();
      const current = makeProcedure({ body: "BEGIN\n  SELECT 1;\nEND" });
      const desired = makeProcedure({ body: "BEGIN SELECT 1; END" });
      const statements = handler.generateStatements([desired], [current]);

      expect(statements).toEqual([]);
    });

    test("updates when body changes", () => {
      const handler = new ProcedureHandler();
      const current = makeProcedure({ body: "BEGIN SELECT 1; END" });
      const desired = makeProcedure({ body: "BEGIN SELECT 2; END" });
      const statements = handler.generateStatements([desired], [current]);

      expect(statements).toHaveLength(2);
      expect(statements[0]).toContain("DROP PROCEDURE IF EXISTS");
      expect(statements[1]).toContain("CREATE PROCEDURE");
    });

    test("updates when language changes", () => {
      const handler = new ProcedureHandler();
      const current = makeProcedure({ language: "sql" });
      const desired = makeProcedure({ language: "plpgsql" });
      const statements = handler.generateStatements([desired], [current]);

      expect(statements).toHaveLength(2);
      expect(statements[0]).toContain("DROP PROCEDURE IF EXISTS");
      expect(statements[1]).toContain("LANGUAGE plpgsql");
    });
  });
});
