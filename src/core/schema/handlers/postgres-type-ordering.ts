import type {
  CompositeType,
  EnumType,
  SqlObject,
} from "../../../types/schema";
import { ValidationError } from "../../../types/errors";
import { parseTypeReference } from "./composite-type-dependencies";

export interface PostgresTypeStatement {
  name: string;
  schema?: string;
  statement: string;
}

interface PostgresTypeNode {
  key: string;
  label: string;
  references: string[];
  aliases: Array<{ name: string; schema: string }>;
}

function getTypeKey(name: string, schema?: string): string {
  return `${schema || "public"}.${name}`;
}

export function getAutomaticMultirangeName(rangeName: string): string {
  return rangeName.includes("range")
    ? rangeName.replace("range", "multirange")
    : `${rangeName}_multirange`;
}

function getSqlObjectReferences(object: SqlObject): string[] {
  const definition = object.typeDefinition;
  if (!definition) return [];
  return [definition.kind === "domain" ? definition.baseType : definition.subtype];
}

function getSqlObjectAliases(
  object: SqlObject
): Array<{ name: string; schema: string }> {
  const schema = object.schema || "public";
  const aliases = [{ name: object.name, schema }];
  if (object.typeDefinition?.kind !== "range") return aliases;

  const multirange = object.typeDefinition.multirangeTypeName;
  aliases.push(
    multirange
      ? {
          name: multirange.name,
          schema: multirange.schema || "public",
        }
      : {
          name: getAutomaticMultirangeName(object.name),
          schema,
        }
  );
  return aliases;
}

function buildTypeNodes(
  enums: EnumType[],
  compositeTypes: CompositeType[],
  sqlObjects: SqlObject[]
): PostgresTypeNode[] {
  const nodes: PostgresTypeNode[] = [
    ...enums.map(function mapEnum(enumType) {
      const schema = enumType.schema || "public";
      return {
        key: getTypeKey(enumType.name, schema),
        label: `enum ${schema}.${enumType.name}`,
        references: [],
        aliases: [{ name: enumType.name, schema }],
      };
    }),
    ...compositeTypes.map(function mapComposite(compositeType) {
      const schema = compositeType.schema || "public";
      return {
        key: getTypeKey(compositeType.name, schema),
        label: `composite ${schema}.${compositeType.name}`,
        references: compositeType.attributes.map(function getType(attribute) {
          return attribute.type;
        }),
        aliases: [{ name: compositeType.name, schema }],
      };
    }),
    ...sqlObjects
      .filter(function isTypeObject(object) {
        return object.typeDefinition !== undefined;
      })
      .map(function mapTypeObject(object) {
        const schema = object.schema || "public";
        return {
          key: getTypeKey(object.name, schema),
          label: `${object.typeDefinition?.kind} ${schema}.${object.name}`,
          references: getSqlObjectReferences(object),
          aliases: getSqlObjectAliases(object),
        };
      }),
  ];

  const keys = nodes.map(function getKey(node) {
    return node.key;
  });
  if (new Set(keys).size !== keys.length) {
    throw new ValidationError(
      "Desired PostgreSQL schema declares more than one type with the same schema-qualified name",
      "type",
      "postgres-type-graph"
    );
  }
  const aliasOwners = new Map<string, string>();
  for (const node of nodes) {
    for (const alias of node.aliases) {
      const aliasKey = getTypeKey(alias.name, alias.schema);
      const owner = aliasOwners.get(aliasKey);
      if (owner && owner !== node.key) {
        throw new ValidationError(
          `Desired PostgreSQL type names collide at '${aliasKey}', including generated multirange names`,
          "type",
          aliasKey
        );
      }
      aliasOwners.set(aliasKey, node.key);
    }
  }
  return nodes;
}

function resolveReference(
  referenceText: string,
  nodes: PostgresTypeNode[]
): PostgresTypeNode | undefined {
  const reference = parseTypeReference(referenceText);
  if (!reference || reference.length > 2) return undefined;

  const matches = nodes.filter(function matchesNode(node) {
    return node.aliases.some(function matchesAlias(alias) {
      if (reference.length === 2) {
        return reference[0] === alias.schema && reference[1] === alias.name;
      }
      return reference[0] === alias.name;
    });
  });
  if (matches.length > 1) {
    throw new ValidationError(
      `PostgreSQL type reference '${referenceText}' is ambiguous across desired schemas; schema-qualify it`,
      "type",
      "postgres-type-graph"
    );
  }
  return matches[0];
}

function sortTypeNodes(nodes: PostgresTypeNode[]): PostgresTypeNode[] {
  const state = new Map<string, "visiting" | "visited">();
  const ordered: PostgresTypeNode[] = [];
  const stack: PostgresTypeNode[] = [];

  function visit(node: PostgresTypeNode): void {
    const currentState = state.get(node.key);
    if (currentState === "visited") return;
    if (currentState === "visiting") {
      const cycleStart = stack.findIndex(function findCycle(item) {
        return item.key === node.key;
      });
      const cycle = [...stack.slice(cycleStart), node]
        .map(function getLabel(item) {
          return item.label;
        })
        .join(" -> ");
      throw new ValidationError(
        `PostgreSQL type dependency cycle requires a manual shell-type migration: ${cycle}`,
        "type",
        node.key
      );
    }

    state.set(node.key, "visiting");
    stack.push(node);
    for (const reference of node.references) {
      const dependency = resolveReference(reference, nodes);
      if (dependency) visit(dependency);
    }
    stack.pop();
    state.set(node.key, "visited");
    ordered.push(node);
  }

  for (const node of nodes) visit(node);
  return ordered;
}

export function orderPostgresTypeStatements(
  statements: PostgresTypeStatement[],
  enums: EnumType[],
  compositeTypes: CompositeType[],
  sqlObjects: SqlObject[],
  reverse: boolean = false
): string[] {
  const nodes = buildTypeNodes(enums, compositeTypes, sqlObjects);
  const nodesByKey = new Map(
    nodes.map(function mapNode(node) {
      return [node.key, node] as const;
    })
  );
  const statementsByKey = new Map<string, string[]>();
  for (const item of statements) {
    const key = getTypeKey(item.name, item.schema);
    if (!nodesByKey.has(key)) {
      throw new ValidationError(
        `PostgreSQL type statement target '${key}' is missing from the canonical type graph`,
        "type",
        key,
        item.statement
      );
    }
    const values = statementsByKey.get(key) || [];
    if (!values.includes(item.statement)) values.push(item.statement);
    statementsByKey.set(key, values);
  }

  const orderedNodes = sortTypeNodes(nodes);
  if (reverse) orderedNodes.reverse();
  return orderedNodes.flatMap(function getStatements(node) {
    return statementsByKey.get(node.key) || [];
  });
}
