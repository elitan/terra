import type { DatabaseConfig } from "../../types/config";

function parseDatabaseUrl(url: string): DatabaseConfig {
  const parsed = new URL(url);

  return {
    host: parsed.hostname || "localhost",
    port: parseInt(parsed.port || "5432"),
    database: parsed.pathname.slice(1) || "postgres",
    user: parsed.username ? decodeURIComponent(parsed.username) : "postgres",
    password: parsed.password ? decodeURIComponent(parsed.password) : "",
  };
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
