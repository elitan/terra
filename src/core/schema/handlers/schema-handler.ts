import type { SchemaDefinition } from "../../../types/schema";
import { Logger } from "../../../utils/logger";
import { SQLBuilder } from "../../../utils/sql-builder";

export class SchemaHandler {
  generateStatements(desiredSchemas: SchemaDefinition[], currentSchemas: SchemaDefinition[]): string[] {
    const statements: string[] = [];
    const currentSchemaNames = new Set(currentSchemas.map(s => s.name));

    for (const desiredSchema of desiredSchemas) {
      if (!currentSchemaNames.has(desiredSchema.name)) {
        const builder = new SQLBuilder().p("CREATE SCHEMA");
        if (desiredSchema.ifNotExists) {
          builder.p("IF NOT EXISTS");
        }
        builder.ident(desiredSchema.name);

        if (desiredSchema.owner) {
          builder.p("AUTHORIZATION").ident(desiredSchema.owner);
        }

        statements.push(builder.build() + ';');
        Logger.info(`Creating schema '${desiredSchema.name}'`);
      } else {
        Logger.info(`Schema '${desiredSchema.name}' already exists, skipping`);
      }
    }

    return statements;
  }
}
