import type { SchemaDefinition } from "../../../types/schema";
import { Logger } from "../../../utils/logger";
import { SQLBuilder } from "../../../utils/sql-builder";

export class SchemaHandler {
  generateStatements(desiredSchemas: SchemaDefinition[], currentSchemas: SchemaDefinition[]): string[] {
    const statements: string[] = [];
    const currentSchemaMap = new Map(currentSchemas.map(s => [s.name, s]));

    for (const desiredSchema of desiredSchemas) {
      const currentSchema = currentSchemaMap.get(desiredSchema.name);

      if (!currentSchema) {
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
      } else if (desiredSchema.owner && desiredSchema.owner !== currentSchema.owner) {
        const builder = new SQLBuilder()
          .p("ALTER SCHEMA")
          .ident(desiredSchema.name)
          .p("OWNER TO")
          .ident(desiredSchema.owner);
        statements.push(builder.build() + ';');
        Logger.info(`Updating schema '${desiredSchema.name}' owner`);
      } else {
        Logger.info(`Schema '${desiredSchema.name}' already exists, skipping`);
      }
    }

    return statements;
  }
}
