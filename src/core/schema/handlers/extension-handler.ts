import type { Extension } from "../../../types/schema";
import { Logger } from "../../../utils/logger";
import { SQLBuilder } from "../../../utils/sql-builder";

export class ExtensionHandler {
  generateStatements(desiredExtensions: Extension[], currentExtensions: Extension[]): {
    create: string[];
    drop: string[];
  } {
    const createStatements: string[] = [];
    const dropStatements: string[] = [];
    const currentExtensionMap = new Map(currentExtensions.map(e => [e.name, e]));
    const desiredExtensionNames = new Set(desiredExtensions.map(e => e.name));

    for (const currentExt of currentExtensions) {
      if (!desiredExtensionNames.has(currentExt.name)) {
        const dropBuilder = new SQLBuilder().p("DROP EXTENSION IF EXISTS").ident(currentExt.name).p("CASCADE");
        dropStatements.push(dropBuilder.build() + ';');
        Logger.info(`Dropping extension '${currentExt.name}' (CASCADE will drop dependent objects)`);
      }
    }

    for (const desiredExt of desiredExtensions) {
      const currentExt = currentExtensionMap.get(desiredExt.name);

      if (!currentExt) {
        createStatements.push(this.generateCreateExtensionSQL(desiredExt));
        Logger.info(`Creating extension '${desiredExt.name}'`);
      } else {
        let changed = false;

        if (desiredExt.version && currentExt.version !== desiredExt.version) {
          createStatements.push(this.generateUpdateExtensionVersionSQL(desiredExt.name, desiredExt.version));
          Logger.info(
            `Updating extension '${desiredExt.name}' version (current: ${currentExt.version}, desired: ${desiredExt.version})`
          );
          changed = true;
        }

        if (desiredExt.schema && currentExt.schema !== desiredExt.schema) {
          createStatements.push(this.generateSetExtensionSchemaSQL(desiredExt.name, desiredExt.schema));
          Logger.info(
            `Updating extension '${desiredExt.name}' schema (current: ${currentExt.schema}, desired: ${desiredExt.schema})`
          );
          changed = true;
        }

        if (!changed) {
          Logger.info(`Extension '${desiredExt.name}' already exists, skipping`);
        }
      }
    }

    return { create: createStatements, drop: dropStatements };
  }

  private generateCreateExtensionSQL(extension: Extension): string {
    const builder = new SQLBuilder().p("CREATE EXTENSION IF NOT EXISTS").ident(extension.name);

    if (extension.schema) {
      builder.p("SCHEMA").ident(extension.schema);
    }

    if (extension.version) {
      builder.p(`VERSION '${extension.version}'`);
    }

    if (extension.cascade) {
      builder.p("CASCADE");
    }

    return builder.build() + ';';
  }

  private generateUpdateExtensionVersionSQL(name: string, version: string): string {
    const builder = new SQLBuilder().p("ALTER EXTENSION").ident(name).p(`UPDATE TO '${version}'`);
    return builder.build() + ';';
  }

  private generateSetExtensionSchemaSQL(name: string, schema: string): string {
    const builder = new SQLBuilder().p("ALTER EXTENSION").ident(name).p("SET SCHEMA").ident(schema);
    return builder.build() + ';';
  }
}
