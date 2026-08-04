import type {
  PostgresForeignServerDefinition,
  PostgresForeignServerOption,
} from "../types/schema";
import { ValidationError } from "../types/errors";

export function sortPostgresForeignServerOptions(
  options: PostgresForeignServerOption[]
): PostgresForeignServerOption[] {
  return [...options].sort(function sortOptions(left, right) {
    return left.name.localeCompare(right.name) ||
      left.value.localeCompare(right.value);
  });
}

export function parsePostgresForeignServerCatalogOptions(
  options: string[] | null,
  serverName: string
): PostgresForeignServerOption[] {
  if (!options) {
    return [];
  }

  const optionNames = new Set<string>();
  const parsed = options.map(function parseOption(option) {
    const separator = option.indexOf("=");
    if (separator <= 0) {
      throw new ValidationError(
        `PostgreSQL foreign server '${serverName}' has malformed catalog option '${option}'`,
        "foreign-server",
        serverName
      );
    }
    const name = option.slice(0, separator);
    if (optionNames.has(name)) {
      throw new ValidationError(
        `PostgreSQL foreign server '${serverName}' has duplicate catalog option '${name}'`,
        "foreign-server",
        serverName
      );
    }
    optionNames.add(name);
    return {
      name,
      value: option.slice(separator + 1),
    };
  });
  return sortPostgresForeignServerOptions(parsed);
}

export function renderPostgresForeignServerCreate(
  name: string,
  definition: PostgresForeignServerDefinition
): string {
  const typeClause = definition.type === undefined
    ? ""
    : ` TYPE ${quoteLiteral(definition.type)}`;
  const versionClause = definition.version === undefined
    ? ""
    : ` VERSION ${quoteLiteral(definition.version)}`;
  const sortedOptions = sortPostgresForeignServerOptions(definition.options);
  const optionsClause = sortedOptions.length === 0
    ? ""
    : ` OPTIONS (${sortedOptions.map(renderCreateOption).join(", ")})`;
  return `CREATE SERVER ${quoteIdentifier(name)}${typeClause}${versionClause} ` +
    `FOREIGN DATA WRAPPER ${quoteIdentifier(definition.foreignDataWrapper)}` +
    `${optionsClause};`;
}

export function renderPostgresForeignServerAlter(
  serverName: string,
  current: PostgresForeignServerDefinition,
  desired: PostgresForeignServerDefinition
): string | undefined {
  const clauses: string[] = [];
  if (current.version !== desired.version) {
    clauses.push(
      desired.version === undefined
        ? "VERSION NULL"
        : `VERSION ${quoteLiteral(desired.version)}`
    );
  }

  const currentOptions = new Map(
    current.options.map(function mapOption(option) {
      return [option.name, option.value] as const;
    })
  );
  const desiredOptions = new Map(
    desired.options.map(function mapOption(option) {
      return [option.name, option.value] as const;
    })
  );
  const optionChanges: string[] = [];

  for (const optionName of [...currentOptions.keys()].sort()) {
    if (!desiredOptions.has(optionName)) {
      optionChanges.push(`DROP ${quoteIdentifier(optionName)}`);
    }
  }
  for (const optionName of [...desiredOptions.keys()].sort()) {
    const desiredValue = desiredOptions.get(optionName)!;
    if (
      currentOptions.has(optionName) &&
      currentOptions.get(optionName) !== desiredValue
    ) {
      optionChanges.push(
        `SET ${quoteIdentifier(optionName)} ${quoteLiteral(desiredValue)}`
      );
    }
  }
  for (const optionName of [...desiredOptions.keys()].sort()) {
    if (!currentOptions.has(optionName)) {
      optionChanges.push(
        `ADD ${quoteIdentifier(optionName)} ` +
        `${quoteLiteral(desiredOptions.get(optionName)!)}`
      );
    }
  }

  if (optionChanges.length > 0) {
    clauses.push(`OPTIONS (${optionChanges.join(", ")})`);
  }
  if (clauses.length === 0) {
    return undefined;
  }
  return `ALTER SERVER ${quoteIdentifier(serverName)} ${clauses.join(" ")};`;
}

function renderCreateOption(option: PostgresForeignServerOption): string {
  return `${quoteIdentifier(option.name)} ${quoteLiteral(option.value)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
