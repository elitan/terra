import type {
  DatabaseDialect,
  DatabaseProvider,
  ConnectionConfig,
  PostgresConnectionConfig,
  SQLiteConnectionConfig,
} from "./types";

export * from "./types";

export function detectDialect(connectionString: string): DatabaseDialect {
  if (/^postgres(?:ql)?:\/\//i.test(connectionString)) {
    return "postgres";
  }
  if (
    /^sqlite:/i.test(connectionString) ||
    /^file:/i.test(connectionString) ||
    /\.(?:db|sqlite|sqlite3)$/i.test(connectionString) ||
    connectionString === ":memory:"
  ) {
    return "sqlite";
  }
  return "postgres";
}

export function parseConnectionString(connectionString: string): ConnectionConfig {
  const dialect = detectDialect(connectionString);

  if (dialect === "sqlite") {
    let filename = connectionString;
    if (/^sqlite:\/\/\//i.test(filename)) {
      const path = filename.slice("sqlite:///".length);
      filename = path.startsWith("/") ? path : `/${path}`;
    } else if (/^sqlite:\/\//i.test(filename)) {
      filename = filename.slice("sqlite://".length);
    } else if (/^sqlite:/i.test(filename)) {
      filename = filename.slice("sqlite:".length);
    } else if (/^file:/i.test(filename)) {
      filename = `file:${filename.slice("file:".length)}`;
    }
    return {
      dialect: "sqlite",
      filename,
    } as SQLiteConnectionConfig;
  }

  const url = new URL(connectionString);
  return {
    dialect: "postgres",
    host: url.hostname,
    port: parseInt(url.port, 10) || 5432,
    database: url.pathname.slice(1),
    user: url.username,
    password: url.password,
    ssl: url.searchParams.get("sslmode") === "require",
  } as PostgresConnectionConfig;
}

export async function createProvider(
  dialect: DatabaseDialect
): Promise<DatabaseProvider> {
  switch (dialect) {
    case "postgres": {
      const { PostgresProvider } = await import("./postgres");
      return new PostgresProvider();
    }
    case "sqlite": {
      const { SQLiteProvider } = await import("./sqlite");
      return new SQLiteProvider();
    }
    default:
      throw new Error(`Unsupported database dialect: ${dialect}`);
  }
}

export async function createProviderFromConfig(
  config: ConnectionConfig
): Promise<DatabaseProvider> {
  return createProvider(config.dialect);
}

export async function createProviderFromConnectionString(
  connectionString: string
): Promise<DatabaseProvider> {
  const dialect = detectDialect(connectionString);
  return createProvider(dialect);
}
