import { describe, expect, test } from "bun:test";
import { loadConfig } from "../core/database/config";
import { parseConnectionString } from "../providers";
import { parsePostgresClientConfig } from "../providers/postgres/connection";
import { PostgresProvider } from "../providers/postgres";
import type { PostgresConnectionConfig } from "../providers/types";

function encodeFirstCharacter(value: string): string {
  const [first, ...rest] = [...value];
  if (!first) {
    return "";
  }
  const encodedFirst = Buffer.from(first, "utf8")
    .toString("hex")
    .match(/.{2}/g)!
    .map(function prefixPercent(byte) {
      return `%${byte.toUpperCase()}`;
    })
    .join("");
  return `${encodedFirst}${encodeURIComponent(rest.join(""))}`;
}

function encodeConnectionIdentity(connectionString: string): {
  connectionString: string;
  database: string;
  user: string;
} {
  const url = new URL(connectionString);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.slice(1));
  const credentials = password
    ? `${encodeFirstCharacter(user)}:${encodeFirstCharacter(password)}`
    : encodeFirstCharacter(user);
  const encoded =
    `${url.protocol}//${credentials}@${url.host}/` +
    `${encodeFirstCharacter(database)}${url.search}${url.hash}`;

  return { connectionString: encoded, database, user };
}

describe("PostgreSQL connection strings", function () {
  test("decodes URI components and preserves the source string", function () {
    const connectionString =
      "postgresql://user%40tenant:p%40ss%3Aword@db.example.com:5440/my%2Fdatabase";

    expect(parseConnectionString(connectionString)).toEqual({
      dialect: "postgres",
      connectionString,
      host: "db.example.com",
      port: 5440,
      database: "my/database",
      user: "user@tenant",
      password: "p@ss:word",
    });
  });

  test("uses node-postgres SSL mode semantics", function () {
    const expected = new Map<string, PostgresConnectionConfig["ssl"]>([
      ["disable", false],
      ["prefer", {}],
      ["require", {}],
      ["verify-ca", {}],
      ["verify-full", {}],
      ["no-verify", { rejectUnauthorized: false }],
    ]);

    for (const [sslmode, ssl] of expected) {
      const config = parseConnectionString(
        `postgres://localhost/database?sslmode=${sslmode}`
      ) as PostgresConnectionConfig;
      expect(config.ssl).toEqual(ssl);
    }

    const withoutSslMode = parseConnectionString(
      "postgres://localhost/database"
    ) as PostgresConnectionConfig;
    expect(withoutSslMode.ssl).toBeUndefined();
    expect(
      (parseConnectionString(
        "postgres://localhost/database?ssl=false"
      ) as PostgresConnectionConfig).ssl
    ).toBe(false);
  });

  test("rejects unsupported SSL modes before connecting", function () {
    expect(function parseAllowMode() {
      parseConnectionString("postgres://localhost/database?sslmode=allow");
    }).toThrow("Unsupported PostgreSQL sslmode: allow");
  });

  test("rejects unsupported multi-host URLs before connecting", function () {
    expect(function parseMultiHostUrl() {
      parseConnectionString(
        "postgres://host-one:5432,host-two:5433/database"
      );
    }).toThrow("Multi-host PostgreSQL connection URLs are not supported");

    expect(
      parseConnectionString(
        "postgres://localhost/database?application_name=terra,db"
      )
    ).toMatchObject({ host: "localhost", database: "database" });
  });

  test("rejects PostgreSQL URLs without an explicit supported scheme", function () {
    expect(function parseBareConnectionString() {
      parseConnectionString("localhost/database");
    }).toThrow("must use postgres:// or postgresql://");
    expect(function parseDifferentScheme() {
      parseConnectionString("mysql://localhost/database");
    }).toThrow("must use postgres:// or postgresql://");
  });

  test("honors query parameter host overrides for Unix sockets", function () {
    const connectionString =
      "postgres://user@localhost/database?host=%2Fvar%2Frun%2Fpostgresql";

    expect(parseConnectionString(connectionString)).toMatchObject({
      dialect: "postgres",
      connectionString,
      host: "/var/run/postgresql",
      database: "database",
      user: "user",
    });
  });

  test("normalizes libpq timeout, keepalive, and database parameters", function () {
    const config = parsePostgresClientConfig(
      "postgres://localhost/path%2Fdatabase?dbname=query%2Fdatabase" +
        "&connect_timeout=4&keepalives=0&keepalives_idle=9"
    );

    expect(config).toMatchObject({
      database: "query/database",
      connectionTimeoutMillis: 4000,
      keepAlive: false,
      keepAliveInitialDelayMillis: 9000,
    });
  });

  test("rejects invalid timeout and keepalive values before connecting", function () {
    expect(function parseInvalidTimeout() {
      parseConnectionString(
        "postgres://localhost/database?connect_timeout=eventually"
      );
    }).toThrow("connect_timeout: expected a non-negative integer");
    expect(function parseUnsafeTimeout() {
      parseConnectionString(
        "postgres://localhost/database?connect_timeout=9999999999999999"
      );
    }).toThrow("connect_timeout: expected a non-negative integer");
    expect(function parseInvalidKeepalive() {
      parseConnectionString("postgres://localhost/database?keepalives=2");
    }).toThrow("keepalives: expected 0 or 1");
  });

  test("preserves URI semantics through the legacy config loader", function () {
    const connectionString =
      "postgres://user%40tenant:p%3Aword@localhost/my%20database?application_name=terra%20db";

    expect(loadConfig(connectionString)).toMatchObject({
      connectionString,
      user: "user@tenant",
      password: "p:word",
      database: "my database",
    });
  });

  test("connects with encoded identity and retained driver parameters", async function () {
    const source = process.env.DATABASE_URL;
    if (!source) {
      throw new Error("DATABASE_URL is required for PostgreSQL connection tests");
    }
    const encoded = encodeConnectionIdentity(source);
    const url = new URL(encoded.connectionString);
    url.searchParams.set("application_name", "terradb uri regression");
    url.searchParams.set("sslmode", "disable");
    const connectionString = url.toString();
    const config = parseConnectionString(
      connectionString
    ) as PostgresConnectionConfig;
    const provider = new PostgresProvider();
    const client = await provider.createClient(config);

    try {
      const result = await client.query<{
        application_name: string;
        database_name: string;
        user_name: string;
      }>(`
        SELECT
          current_setting('application_name') AS application_name,
          current_database() AS database_name,
          current_user AS user_name
      `);

      expect(result.rows).toEqual([
        {
          application_name: "terradb uri regression",
          database_name: encoded.database,
          user_name: encoded.user,
        },
      ]);
    } finally {
      await client.end();
    }
  });
});
