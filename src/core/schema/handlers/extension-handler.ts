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
        if (desiredExt.version && currentExt.version !== desiredExt.version) {
          Logger.warning(`Extension '${desiredExt.name}' version differs (current: ${currentExt.version}, desired: ${desiredExt.version}). Manual update may be required.`);
        } else {
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
}
