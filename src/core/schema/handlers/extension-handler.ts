import type { Extension } from "../../../types/schema";
import { ValidationError } from "../../../types/errors";
import { Logger } from "../../../utils/logger";
import { SQLBuilder } from "../../../utils/sql-builder";
import { quotePostgresStringLiteral } from "../../../utils/sql";

export class ExtensionHandler {
  generateStatements(desiredExtensions: Extension[], currentExtensions: Extension[]): {
    create: string[];
    drop: string[];
  } {
    const createStatements: string[] = [];
    const dropStatements: string[] = [];
    const currentExtensionMap = new Map(currentExtensions.map(function mapExtension(extension) {
      return [extension.name, extension] as const;
    }));
    const desiredExtensionNames = new Set(desiredExtensions.map(function mapName(extension) {
      return extension.name;
    }));
    const retainedExtensionNames = collectRetainedExtensionNames(
      desiredExtensionNames,
      currentExtensionMap
    );
    const removedExtensions = currentExtensions.filter(function isRemoved(extension) {
      return !retainedExtensionNames.has(extension.name);
    });

    for (const currentExt of orderExtensionDrops(removedExtensions)) {
      const dropBuilder = new SQLBuilder()
        .p("DROP EXTENSION")
        .ident(currentExt.name)
        .p("RESTRICT");
      dropStatements.push(dropBuilder.build() + ';');
      Logger.info(`Dropping extension '${currentExt.name}' with dependency protection`);
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
    const builder = new SQLBuilder().p("CREATE EXTENSION").ident(extension.name);

    if (extension.schema) {
      builder.p("SCHEMA").ident(extension.schema);
    }

    if (extension.version) {
      builder.p("VERSION").p(quotePostgresStringLiteral(extension.version));
    }

    if (extension.cascade) {
      builder.p("CASCADE");
    }

    return builder.build() + ';';
  }

  private generateUpdateExtensionVersionSQL(name: string, version: string): string {
    const builder = new SQLBuilder()
      .p("ALTER EXTENSION")
      .ident(name)
      .p("UPDATE TO")
      .p(quotePostgresStringLiteral(version));
    return builder.build() + ';';
  }

  private generateSetExtensionSchemaSQL(name: string, schema: string): string {
    const builder = new SQLBuilder().p("ALTER EXTENSION").ident(name).p("SET SCHEMA").ident(schema);
    return builder.build() + ';';
  }
}

function collectRetainedExtensionNames(
  desiredNames: Set<string>,
  currentExtensions: Map<string, Extension>
): Set<string> {
  const retained = new Set(desiredNames);

  function includeDependencies(name: string): void {
    const extension = currentExtensions.get(name);
    if (!extension) {
      return;
    }
    for (const dependency of extension.dependencies || []) {
      if (retained.has(dependency)) {
        continue;
      }
      retained.add(dependency);
      includeDependencies(dependency);
    }
  }

  for (const desiredName of desiredNames) {
    includeDependencies(desiredName);
  }
  return retained;
}

function orderExtensionDrops(extensions: Extension[]): Extension[] {
  const byName = new Map(extensions.map(function mapExtension(extension) {
    return [extension.name, extension] as const;
  }));
  const dependentCounts = new Map<string, number>(
    extensions.map(function initializeCount(extension) {
      return [extension.name, 0] as const;
    })
  );

  for (const extension of extensions) {
    for (const dependency of extension.dependencies || []) {
      if (byName.has(dependency)) {
        dependentCounts.set(
          dependency,
          (dependentCounts.get(dependency) || 0) + 1
        );
      }
    }
  }

  const ready = extensions
    .filter(function hasNoDependent(extension) {
      return dependentCounts.get(extension.name) === 0;
    })
    .sort(compareExtensionNames);
  const ordered: Extension[] = [];

  while (ready.length > 0) {
    const extension = ready.shift();
    if (!extension) {
      break;
    }
    ordered.push(extension);
    for (const dependency of extension.dependencies || []) {
      const dependencyExtension = byName.get(dependency);
      if (!dependencyExtension) {
        continue;
      }
      const nextCount = (dependentCounts.get(dependency) || 0) - 1;
      dependentCounts.set(dependency, nextCount);
      if (nextCount === 0) {
        ready.push(dependencyExtension);
        ready.sort(compareExtensionNames);
      }
    }
  }

  if (ordered.length !== extensions.length) {
    const names = extensions.map(function mapName(extension) {
      return extension.name;
    }).sort();
    throw new ValidationError(
      `PostgreSQL extension dependency cycle cannot be ordered safely: ${names.join(", ")}`,
      "extension",
      "dependencies",
      names
    );
  }

  return ordered;
}

function compareExtensionNames(left: Extension, right: Extension): number {
  return left.name.localeCompare(right.name);
}
