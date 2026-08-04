import type { ClientConfig } from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import { ValidationError } from "../../types/errors";

const SUPPORTED_SSL_MODES = new Set([
  "disable",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
  "no-verify",
]);

function lastParameter(url: URL, name: string): string | undefined {
  return url.searchParams.getAll(name).at(-1);
}

function parseSeconds(value: string, parameter: string): number {
  const seconds = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(seconds)) {
    throw new ValidationError(
      `Invalid PostgreSQL connection parameter ${parameter}: expected a non-negative integer`,
      "connection",
      parameter,
      value
    );
  }
  return seconds;
}

function hasMultipleHosts(connectionString: string): boolean {
  const schemeEnd = connectionString.indexOf("://");
  const authorityStart = schemeEnd + 3;
  const remainder = connectionString.slice(authorityStart);
  const pathStart = remainder.search(/[/?#]/);
  const authority = remainder.slice(0, pathStart === -1 ? undefined : pathStart);
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  return host.includes(",");
}

export function parsePostgresClientConfig(
  connectionString: string
): ClientConfig {
  if (!/^postgres(?:ql)?:\/\//i.test(connectionString)) {
    throw new ValidationError(
      "PostgreSQL connection URLs must use postgres:// or postgresql://",
      "connection",
      "url"
    );
  }
  if (hasMultipleHosts(connectionString)) {
    throw new ValidationError(
      "Multi-host PostgreSQL connection URLs are not supported; use a single endpoint",
      "connection",
      "host"
    );
  }
  const url = new URL(connectionString);

  const sslmode = lastParameter(url, "sslmode");
  if (sslmode && !SUPPORTED_SSL_MODES.has(sslmode)) {
    throw new ValidationError(
      `Unsupported PostgreSQL sslmode: ${sslmode}`,
      "connection",
      "sslmode",
      sslmode
    );
  }

  const config = parseIntoClientConfig(connectionString);
  const databaseParameter = lastParameter(url, "dbname");
  const databasePath = url.pathname.slice(1);
  if (databaseParameter !== undefined) {
    config.database = databaseParameter;
  } else if (databasePath) {
    config.database = decodeURIComponent(databasePath);
  }

  const ssl = lastParameter(url, "ssl");
  if (!sslmode && ssl === "false") {
    config.ssl = false;
  }

  const connectTimeout = lastParameter(url, "connect_timeout");
  if (connectTimeout !== undefined) {
    config.connectionTimeoutMillis =
      parseSeconds(connectTimeout, "connect_timeout") * 1000;
  }

  const keepalives = lastParameter(url, "keepalives");
  if (keepalives !== undefined) {
    if (keepalives !== "0" && keepalives !== "1") {
      throw new ValidationError(
        "Invalid PostgreSQL connection parameter keepalives: expected 0 or 1",
        "connection",
        "keepalives",
        keepalives
      );
    }
    config.keepAlive = keepalives === "1";
  }

  const keepalivesIdle = lastParameter(url, "keepalives_idle");
  if (keepalivesIdle !== undefined) {
    config.keepAliveInitialDelayMillis =
      parseSeconds(keepalivesIdle, "keepalives_idle") * 1000;
  }

  return config;
}
