import type { ClientConfig } from "pg";

export interface DatabaseConfig {
  connectionString?: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: ClientConfig["ssl"];
}
