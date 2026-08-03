import { describe, expect, test } from "bun:test";
import { PostgresProvider } from "../providers/postgres";
import type { DatabaseClient } from "../providers/types";
import type { Table } from "../types/schema";

function makeTable(accessMethod: string): Table {
  return {
    name: "users",
    schema: "public",
    columns: [{ name: "id", type: "INTEGER", nullable: false }],
    accessMethod,
  };
}

describe("PostgresProvider migration context", function () {
  test("reads the server version and default table access method", async function () {
    const provider = new PostgresProvider();
    const client: DatabaseClient = {
      query: async function (sql: string) {
        expect(sql).toContain("server_version_num");
        expect(sql).toContain("default_table_access_method");
        return {
          rows: [
            {
              postgres_version_num: "170009",
              default_table_access_method: "custom_heap",
            },
          ],
        };
      },
      end: async function () {},
    };

    expect(await provider.getMigrationContext(client)).toEqual({
      postgresVersionNum: 170009,
      defaultTableAccessMethod: "custom_heap",
    });
  });

  test("forwards migration context to access method planning", function () {
    const provider = new PostgresProvider();

    expect(function rejectPostgres14Change() {
      provider.generateMigrationPlan(
        [makeTable("custom_heap")],
        [makeTable("heap")],
        {
          postgresVersionNum: 140023,
          defaultTableAccessMethod: "heap",
        }
      );
    }).toThrow("PostgreSQL 14 cannot change the access method");
  });
});
