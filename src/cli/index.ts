import { Command } from "commander";
import { loadConfig } from "../core/database/config";
import { applyCommand } from "./commands/index";
import packageJson from "../../package.json";

function collectSchemas(value: string, previous: string[]) {
  return previous.concat([value]);
}

export async function runCLI() {
  const program = new Command();

  program
    .name("pgterra")
    .description("Declarative schema management for Postgres")
    .version(packageJson.version, "-v, --version");

  program
    .command("apply")
    .description("Apply schema changes to database")
    .requiredOption("-f, --file <file>", "Schema file path")
    .option("-u, --url <url>", "Database connection string (overrides DATABASE_URL)")
    .option("-s, --schema <schema>", "Database schema to manage (can be specified multiple times, defaults to 'public')", collectSchemas, [])
    .option("--auto-approve", "Skip confirmation prompt")
    .option("--dry-run", "Show migration plan without executing changes")
    .option("--lock-name <name>", "Advisory lock name to prevent concurrent migrations", "pgterra_migrate_execute")
    .option("--lock-timeout <seconds>", "Maximum time to wait for advisory lock in seconds", "10")
    .action(async (options) => {
      const config = loadConfig(options.url);
      await applyCommand(options, config);
    });

  await program.parseAsync();
}
