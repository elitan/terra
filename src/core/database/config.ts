import type { DatabaseConfig } from "../../types/config";
import { parseConnectionString } from "../../providers";

function parseDatabaseUrl(url: string): DatabaseConfig {
  const parsed = parseConnectionString(url);
  if (parsed.dialect !== "postgres") {
    throw new Error("DatabaseService requires a PostgreSQL connection URL");
  }
  const { dialect: _dialect, ...config } = parsed;
  return config;
}

export function loadConfig(urlOverride?: string): DatabaseConfig {
  // Priority: command-line URL > DATABASE_URL > individual vars
  const databaseUrl = urlOverride || process.env.DATABASE_URL;
  if (databaseUrl && databaseUrl.trim()) {
    return parseDatabaseUrl(databaseUrl);
  }

  // Fallback to individual environment variables
  return {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME || "postgres",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "postgres",
  };
}
