import { Command } from "commander";
import { applyCommand } from "./commands/index";
import packageJson from "../../package.json";

function collectSchemas(value: string, previous: string[]) {
  return previous.concat([value]);
}

function getConnectionString(urlOption?: string): string {
  const url = urlOption || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Database connection required. Provide -u/--url or set DATABASE_URL environment variable.\n" +
      "Examples:\n" +
      "  PostgreSQL: postgres://user:pass@localhost:5432/dbname\n" +
      "  SQLite:     sqlite:///path/to/database.db or ./database.sqlite"
    );
  }
  return url;
}

export async function runCLI() {
  const program = new Command();

  program
    .name("dbterra")
    .description("Declarative schema management for PostgreSQL and SQLite")
    .version(packageJson.version, "-v, --version");

  program
    .command("apply")
    .description("Apply schema changes to database")
    .requiredOption("-f, --file <file>", "Schema file path")
    .option("-u, --url <url>", "Database connection string (overrides DATABASE_URL)")
    .option("-s, --schema <schema>", "Database schema to manage (can be specified multiple times, defaults to 'public')", collectSchemas, [])
    .option("--auto-approve", "Skip confirmation prompt")
    .option("--dry-run", "Show migration plan without executing changes")
    .option("--lock-name <name>", "Advisory lock name to prevent concurrent migrations", "dbterra_migrate_execute")
    .option("--lock-timeout <seconds>", "Maximum time to wait for advisory lock in seconds", "10")
    .action(async (options) => {
      const connectionString = getConnectionString(options.url);
      await applyCommand(options, connectionString);
    });

  await program.parseAsync();
}
