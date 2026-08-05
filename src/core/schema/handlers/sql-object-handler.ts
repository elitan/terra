import type {
  PostgresPolicyDefinition,
  PostgresPolicyRole,
  PostgresRoleDefinition,
  SqlObject,
  SqlObjectKind,
} from "../../../types/schema";
import { ValidationError } from "../../../types/errors";
import { deparseSync, parse } from "pgsql-parser";
import { expressionsEqual } from "../../../utils/expression-comparator";
import { parseCreateTable } from "../parser/tables/table-parser";
import {
  partitionParentsAreEquivalent,
  type PartitionParent,
} from "./partition-comparator";
import { buildPartitionKey } from "./partition-key-comparator";
import {
  addInferredTypeDependencies,
  assertRangePrerequisitesExist,
  assertTypeCanBeRemoved,
  assertTypeCanBeReplaced,
  domainDefinitionsRequireReplacement,
  generateDomainAlterStatements,
  rangeDefinitionsAreEqual,
  type PostgresTypeObjectContext,
} from "./postgres-type-object-handler";
import type { PostgresTypeStatement } from "./postgres-type-ordering";
import {
  effectivePostgresTriggerMode,
  renderPostgresEventTriggerMode,
  renderPostgresTableTriggerMode,
} from "../../../utils/postgres-trigger";
import {
  postgresReplicaIdentitiesEqual,
  renderPostgresReplicaIdentity,
} from "../../../utils/postgres-replica-identity";
import {
  renderPostgresForeignServerAlter,
  renderPostgresForeignServerOwnerAlter,
} from "../../../utils/postgres-foreign-server";
import {
  postgresRoleDefinitionsEqual,
  renderPostgresRoleAlter,
} from "../../../utils/postgres-role";
import { renderPostgresGrantOptionRevoke } from "../../../utils/postgres-grant";
import {
  postgresDefaultPrivilegeMatchesBaseline,
  renderPostgresDefaultPrivilegeTransition,
} from "../../../utils/postgres-default-privilege";

type SqlObjectPlan = {
  bootstrapCreate: string[];
  preSchemaCreate: string[];
  postSchemaCreate: string[];
  typeCreate: string[];
  preTableCreate: string[];
  postTableCreate: string[];
  postRoutineCreate: string[];
  finalCreate: string[];
  earlyDrop: string[];
  partitionDrop: string[];
  typeReplaceDrop: string[];
  typeAlter: string[];
  typeDrop: string[];
  typeCreateOperations: PostgresTypeStatement[];
  typeDropOperations: PostgresTypeStatement[];
  lateDrop: string[];
};

type SqlObjectStatementBucket = Exclude<
  keyof SqlObjectPlan,
  "typeCreateOperations" | "typeDropOperations"
>;

type CanonicalSqlObject = {
  normalized: string;
  comparisonNormalized: string;
  statement?: any;
  partitionParent?: PartitionParent;
};

type PartitionBoundReplacement = {
  detachStatement: string;
  attachStatement: string;
};

function findQuotedSqlTokenEnd(
  statement: string,
  start: number,
  delimiter: "'" | '"',
  backslashEscapes: boolean
): number {
  let index = start + 1;
  while (index < statement.length) {
    if (backslashEscapes && statement[index] === "\\") {
      index += 2;
      continue;
    }
    if (statement[index] !== delimiter) {
      index += 1;
      continue;
    }
    if (statement[index + 1] === delimiter) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return statement.length;
}

function findDollarQuotedSqlTokenEnd(
  statement: string,
  start: number
): number | undefined {
  const delimiter = statement
    .slice(start)
    .match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
  if (!delimiter) {
    return undefined;
  }
  const end = statement.indexOf(delimiter, start + delimiter.length);
  return end === -1 ? statement.length : end + delimiter.length;
}

function findSqlBlockCommentEnd(statement: string, start: number): number {
  let depth = 1;
  let index = start + 2;
  while (index < statement.length && depth > 0) {
    if (statement.slice(index, index + 2) === "/*") {
      depth += 1;
      index += 2;
    } else if (statement.slice(index, index + 2) === "*/") {
      depth -= 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  return index;
}

function sqlStringUsesBackslashEscapes(
  statement: string,
  quoteIndex: number
): boolean {
  const prefix = statement[quoteIndex - 1];
  const beforePrefix = statement[quoteIndex - 2] || "";
  if (
    (prefix === "E" || prefix === "e") &&
    !/[A-Za-z0-9_$]/.test(beforePrefix)
  ) {
    return true;
  }
  return (
    prefix === "&" &&
    (beforePrefix === "U" || beforePrefix === "u") &&
    !/[A-Za-z0-9_$]/.test(statement[quoteIndex - 3] || "")
  );
}

function normalizeSql(statement: string): string {
  const output: string[] = [];
  let index = 0;
  let separator = "";
  let previousWord: string | undefined;

  function append(value: string): void {
    if (output.length > 0) {
      output.push(separator);
    }
    output.push(value);
    separator = "";
  }

  while (index < statement.length) {
    const character = statement[index]!;
    if (/\s/.test(character)) {
      separator = output.length > 0 ? " " : "";
      index += 1;
      continue;
    }
    if (statement.slice(index, index + 2) === "--") {
      const lineEnd = statement.indexOf("\n", index + 2);
      index = lineEnd === -1 ? statement.length : lineEnd + 1;
      separator = output.length > 0 ? " " : "";
      continue;
    }
    if (statement.slice(index, index + 2) === "/*") {
      index = findSqlBlockCommentEnd(statement, index);
      separator = output.length > 0 ? " " : "";
      continue;
    }
    if (character === "'" || character === '"') {
      const end = findQuotedSqlTokenEnd(
        statement,
        index,
        character,
        character === "'" && sqlStringUsesBackslashEscapes(statement, index)
      );
      append(statement.slice(index, end));
      previousWord = undefined;
      index = end;
      continue;
    }
    if (character === "$") {
      const end = findDollarQuotedSqlTokenEnd(statement, index);
      if (end !== undefined) {
        append(statement.slice(index, end));
        previousWord = undefined;
        index = end;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(character)) {
      let end = index + 1;
      while (/[A-Za-z0-9_$]/.test(statement[end] || "")) {
        end += 1;
      }
      const word = statement.slice(index, end);
      const normalizedWord = word.toUpperCase();
      let outputWord = word;
      if (previousWord === "EXECUTE" && normalizedWord === "PROCEDURE") {
        outputWord = "FUNCTION";
      }
      append(outputWord);
      previousWord = normalizedWord;
      index = end;
      continue;
    }

    append(character);
    previousWord = undefined;
    index += 1;
  }

  const normalized = output.join("").trim();
  if (normalized.endsWith(";")) {
    return normalized.slice(0, -1).trimEnd();
  }
  return normalized;
}

function terminateStatement(statement: string): string {
  const trimmed = statement.trim();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}

function resolvePolicyRole(
  role: PostgresPolicyRole,
  context: PostgresTypeObjectContext
): string {
  if (role.kind === "public") {
    return "public:";
  }
  if (role.kind === "name") {
    return `name:${role.name}`;
  }
  if (role.kind === "session_user" && context.sessionUser) {
    return `name:${context.sessionUser}`;
  }
  if (
    (role.kind === "current_role" || role.kind === "current_user") &&
    context.currentUser
  ) {
    return `name:${context.currentUser}`;
  }
  return `context:${role.kind}`;
}

function normalizePolicyRoles(
  roles: PostgresPolicyRole[],
  context: PostgresTypeObjectContext
): string[] {
  const normalized = Array.from(
    new Set(
      roles.map(function mapPolicyRole(role) {
        return resolvePolicyRole(role, context);
      })
    )
  );
  if (normalized.includes("public:")) {
    return ["public:"];
  }
  return normalized.sort();
}

function optionalPolicyExpressionsAreEqual(
  desired: string | undefined,
  current: string | undefined
): boolean {
  if (!desired || !current) {
    return desired === current;
  }
  return expressionsEqual(desired, current);
}

function getEffectivePolicyUsing(
  definition: PostgresPolicyDefinition
): string | undefined {
  if (definition.command === "insert") {
    return undefined;
  }
  return definition.using || "true";
}

function getEffectivePolicyCheck(
  definition: PostgresPolicyDefinition
): string | undefined {
  if (definition.withCheck) {
    return definition.withCheck;
  }
  if (definition.command === "all" || definition.command === "update") {
    return definition.using || "true";
  }
  if (definition.command === "insert") {
    return "true";
  }
  return undefined;
}

function policyDefinitionsAreEqual(
  desired: PostgresPolicyDefinition,
  current: PostgresPolicyDefinition,
  context: PostgresTypeObjectContext
): boolean {
  return (
    desired.command === current.command &&
    desired.permissive === current.permissive &&
    JSON.stringify(normalizePolicyRoles(desired.roles, context)) ===
      JSON.stringify(normalizePolicyRoles(current.roles, context)) &&
    optionalPolicyExpressionsAreEqual(
      getEffectivePolicyUsing(desired),
      getEffectivePolicyUsing(current)
    ) &&
    optionalPolicyExpressionsAreEqual(
      getEffectivePolicyCheck(desired),
      getEffectivePolicyCheck(current)
    )
  );
}

function sortPartitionTableConstraints(elements: any[] | undefined): any[] | undefined {
  if (!elements) {
    return undefined;
  }

  const otherElements = elements.filter(function isNotConstraint(element) {
    return !element?.Constraint;
  });
  const constraints = elements
    .filter(function isConstraint(element) {
      return Boolean(element?.Constraint);
    })
    .sort(function sortConstraint(left, right) {
      const leftName = left.Constraint.conname || "";
      const rightName = right.Constraint.conname || "";
      return leftName.localeCompare(rightName);
    });
  return [...otherElements, ...constraints];
}

function qualifyPartitionCreateAst(object: SqlObject, statement: any): any {
  const createStatement = statement?.CreateStmt;
  if (!createStatement?.relation) {
    return statement;
  }

  const defaultSchema = object.schema || "public";
  const relation = createStatement.relation.schemaname
    ? createStatement.relation
    : { ...createStatement.relation, schemaname: defaultSchema };
  const inheritedRelations = createStatement.inhRelations?.map(function (item: any) {
    if (!item?.RangeVar || item.RangeVar.schemaname) {
      return item;
    }
    return {
      RangeVar: { ...item.RangeVar, schemaname: defaultSchema },
    };
  });

  return {
    ...statement,
    CreateStmt: {
      ...createStatement,
      relation,
      ...(!createStatement.partbound
        ? { tableElts: sortPartitionTableConstraints(createStatement.tableElts) }
        : {}),
      ...(inheritedRelations ? { inhRelations: inheritedRelations } : {}),
    },
  };
}

function canonicalizePartitionBoundConstant(datum: any): any {
  const constant = datum?.A_Const;
  if (!constant) {
    return datum;
  }

  const value =
    constant.ival?.ival ??
    constant.fval?.fval ??
    constant.boolval?.boolval ??
    constant.sval?.sval;
  if (value === undefined) {
    return datum;
  }
  return { A_Const: { sval: { sval: String(value) } } };
}

function canonicalizePartitionCreateForComparison(createStatement: any): any {
  if (!createStatement?.partbound) {
    return createStatement;
  }

  const partbound = createStatement.partbound;
  return {
    ...createStatement,
    partbound: {
      ...partbound,
      lowerdatums: partbound.lowerdatums?.map(canonicalizePartitionBoundConstant),
      upperdatums: partbound.upperdatums?.map(canonicalizePartitionBoundConstant),
      listdatums: partbound.listdatums?.map(canonicalizePartitionBoundConstant),
    },
  };
}

function normalizePartitionStatementForComparison(statement: any): string {
  return normalizeSql(
    deparseSync([
      {
        ...statement,
        CreateStmt: canonicalizePartitionCreateForComparison(
          statement.CreateStmt
        ),
      },
    ] as any)
  );
}

async function canonicalizeSqlObject(object: SqlObject): Promise<CanonicalSqlObject> {
  if (isSqlTriggerObject(object)) {
    return canonicalizeSqlTriggerObject(object);
  }
  if (object.kind !== "partition") {
    const normalized = normalizeSql(object.createStatement);
    return { normalized, comparisonNormalized: normalized };
  }

  try {
    const parsed = await parse(object.createStatement);
    const statements = (parsed.stmts || []).flatMap(function (item) {
      return item.stmt ? [qualifyPartitionCreateAst(object, item.stmt)] : [];
    });
    if (statements.length === 0) {
      const normalized = normalizeSql(object.createStatement);
      return { normalized, comparisonNormalized: normalized };
    }

    const statement = statements.length === 1 ? statements[0] : undefined;
    const createStatement = statement?.CreateStmt;
    const partitionTable =
      createStatement?.partspec && !createStatement.partbound
        ? parseCreateTable(createStatement)
        : null;
    const partitionKey = partitionTable
      ? buildPartitionKey(
          createStatement.partspec,
          partitionTable,
          object.partitionKeyOperatorClasses
        )
      : undefined;

    const normalized = normalizeSql(deparseSync(statements));
    return {
      normalized,
      comparisonNormalized: statement
        ? normalizePartitionStatementForComparison(statement)
        : normalized,
      statement,
      ...(partitionTable && partitionKey
        ? {
            partitionParent: {
              key: partitionKey,
              table: partitionTable,
            },
          }
        : {}),
    };
  } catch {
    const normalized = normalizeSql(object.createStatement);
    return { normalized, comparisonNormalized: normalized };
  }
}

async function canonicalizeSqlTriggerObject(
  object: SqlObject
): Promise<CanonicalSqlObject> {
  try {
    const parsed = await parse(object.createStatement);
    const statements = (parsed.stmts || []).flatMap(function (item) {
      if (!item.stmt) {
        return [];
      }
      const statement: any = item.stmt;
      const trigger = statement.CreateTrigStmt;
      if (trigger) {
        trigger.relation = {
          ...trigger.relation,
          schemaname:
            object.triggerTable?.schema || object.schema || "public",
        };
        const functionName = qualifiedNameToStringNodes(
          object.triggerFunction
        );
        if (functionName) {
          trigger.funcname = functionName;
        }
      }
      const eventTrigger = statement.CreateEventTrigStmt;
      if (eventTrigger) {
        const functionName = qualifiedNameToStringNodes(
          object.triggerFunction
        );
        if (functionName) {
          eventTrigger.funcname = functionName;
        }
      }
      return [statement];
    });
    if (statements.length === 0) {
      const normalized = normalizeSql(object.createStatement);
      return { normalized, comparisonNormalized: normalized };
    }
    const normalized = normalizeSql(deparseSync(statements));
    return { normalized, comparisonNormalized: normalized };
  } catch {
    const normalized = normalizeSql(object.createStatement);
    return { normalized, comparisonNormalized: normalized };
  }
}

function qualifiedNameToStringNodes(
  name: SqlObject["triggerFunction"]
): Array<{ String: { sval: string } }> | undefined {
  if (!name) {
    return undefined;
  }
  return [name.schema, name.name]
    .filter(function isName(value): value is string {
      return typeof value === "string";
    })
    .map(function makeStringNode(value) {
      return { String: { sval: value } };
    });
}

function getDirectPartitionCreate(statement: any): any | undefined {
  const createStatement = statement?.CreateStmt;
  if (
    !createStatement?.relation ||
    !createStatement?.partbound ||
    createStatement.inhRelations?.length !== 1 ||
    !createStatement.inhRelations[0]?.RangeVar
  ) {
    return undefined;
  }
  return createStatement;
}

function deparseCreateStatement(createStatement: any): string {
  return normalizeSql(deparseSync([{ CreateStmt: createStatement }] as any));
}

function deparseCreateStatementForComparison(createStatement: any): string {
  return deparseCreateStatement(
    canonicalizePartitionCreateForComparison(createStatement)
  );
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function qualifyRangeVariable(rangeVariable: any): string {
  const relation = quoteIdentifier(rangeVariable.relname);
  return rangeVariable.schemaname
    ? `${quoteIdentifier(rangeVariable.schemaname)}.${relation}`
    : relation;
}

function getPartitionBoundReplacement(
  current: CanonicalSqlObject,
  desired: CanonicalSqlObject
): PartitionBoundReplacement | undefined {
  const currentCreate = getDirectPartitionCreate(current.statement);
  const desiredCreate = getDirectPartitionCreate(desired.statement);
  if (!currentCreate || !desiredCreate) {
    return undefined;
  }

  const desiredWithCurrentBound = {
    ...desiredCreate,
    partbound: currentCreate.partbound,
  };
  if (
    deparseCreateStatementForComparison(desiredWithCurrentBound) !==
    current.comparisonNormalized
  ) {
    return undefined;
  }

  const parent = desiredCreate.inhRelations[0].RangeVar;
  const child = desiredCreate.relation;
  const boundMatch = desired.normalized.match(/\s(FOR VALUES .+|DEFAULT)$/i);
  if (!boundMatch) {
    return undefined;
  }

  const parentName = qualifyRangeVariable(parent);
  const childName = qualifyRangeVariable(child);
  return {
    detachStatement: terminateStatement(
      `ALTER TABLE ${parentName} DETACH PARTITION ${childName}`
    ),
    attachStatement: terminateStatement(
      `ALTER TABLE ${parentName} ATTACH PARTITION ${childName} ${boundMatch[1]}`
    ),
  };
}

function getCreateBucket(kind: SqlObjectKind): SqlObjectStatementBucket {
  if (kind === "role") {
    return "bootstrapCreate";
  }
  if (kind === "domain-type" || kind === "range-type") {
    return "typeCreate";
  }
  if (kind === "foreign-server" || kind === "partition") {
    return "preTableCreate";
  }
  if (kind === "row-level-security") {
    return "postTableCreate";
  }
  if (kind === "policy" || kind === "constraint-trigger" || kind === "event-trigger") {
    return "postRoutineCreate";
  }
  return "finalCreate";
}

function getDropBucket(kind: SqlObjectKind): SqlObjectStatementBucket {
  if (kind === "domain-type" || kind === "range-type") {
    return "typeDrop";
  }
  if (kind === "partition") {
    return "partitionDrop";
  }
  if (
    kind === "foreign-server" ||
    kind === "grant" ||
    kind === "policy" ||
    kind === "constraint-trigger" ||
    kind === "event-trigger" ||
    kind === "row-level-security"
  ) {
    return "earlyDrop";
  }
  return "lateDrop";
}

function getCreateBucketForObject(
  object: SqlObject
): SqlObjectStatementBucket {
  if (object.kind === "default-privilege") {
    return object.defaultPrivilegeDefinition?.schema
      ? "postSchemaCreate"
      : "preSchemaCreate";
  }
  return getCreateBucket(object.kind);
}

function getDropBucketForObject(
  object: SqlObject
): SqlObjectStatementBucket {
  if (object.kind === "default-privilege") {
    return object.defaultPrivilegeDefinition?.schema
      ? "postSchemaCreate"
      : "preSchemaCreate";
  }
  return getDropBucket(object.kind);
}

function sortKeys(objects: SqlObject[], reverse: boolean): SqlObject[] {
  const byKey = new Map(objects.map(function (item) {
    return [item.key, item] as const;
  }));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: SqlObject[] = [];

  function visit(key: string): void {
    if (visited.has(key)) {
      return;
    }
    if (visiting.has(key)) {
      throw new ValidationError(
        `PostgreSQL SQL object dependency cycle includes '${key}'`,
        "sql-object",
        key
      );
    }

    const item = byKey.get(key);
    if (!item) {
      return;
    }

    visiting.add(key);
    const deps = [...(item.dependencies || [])].sort();
    for (const dep of deps) {
      visit(dep);
    }
    visiting.delete(key);
    visited.add(key);
    ordered.push(item);
  }

  for (const key of [...byKey.keys()].sort()) {
    visit(key);
  }

  return reverse ? ordered.reverse() : ordered;
}

function pushStatements(
  target: SqlObjectPlan,
  bucket: SqlObjectStatementBucket,
  objects: SqlObject[],
  useDrop: boolean
): PostgresTypeStatement[] {
  const operations: PostgresTypeStatement[] = [];
  const ordered = sortKeys(addInferredTypeDependencies(objects), useDrop);
  for (const item of ordered) {
    const statement = useDrop ? item.dropStatement : item.createStatement;
    if (!statement) {
      continue;
    }
    target[bucket].push(statement);
    if (!useDrop) {
      const modeStatement = renderNonDefaultSqlTriggerMode(item);
      if (modeStatement) {
        target[bucket].push(modeStatement);
      }
      const replicaIdentityStatement =
        renderNonDefaultPartitionReplicaIdentity(item);
      if (replicaIdentityStatement) {
        target[bucket].push(replicaIdentityStatement);
      }
    }
    operations.push({
      name: item.name,
      schema: item.schema,
      statement,
    });
  }
  return operations;
}

function isSqlTriggerObject(object: SqlObject): boolean {
  return object.kind === "constraint-trigger" ||
    object.kind === "event-trigger";
}

function sqlTriggerModesAreEqual(
  desired: SqlObject,
  current: SqlObject
): boolean {
  if (!isSqlTriggerObject(desired) || !isSqlTriggerObject(current)) {
    return true;
  }
  return effectivePostgresTriggerMode(desired.triggerEnabled) ===
    effectivePostgresTriggerMode(current.triggerEnabled);
}

function renderSqlTriggerMode(object: SqlObject): string {
  const mode = effectivePostgresTriggerMode(object.triggerEnabled);
  if (object.kind === "event-trigger") {
    return renderPostgresEventTriggerMode(object.name, mode);
  }
  if (object.kind === "constraint-trigger" && object.triggerTable) {
    return renderPostgresTableTriggerMode(
      object.triggerTable,
      object.name,
      mode
    );
  }
  throw new ValidationError(
    `PostgreSQL constraint trigger '${object.key}' is missing its table identity`,
    "constraint-trigger",
    object.key
  );
}

function renderNonDefaultSqlTriggerMode(
  object: SqlObject
): string | undefined {
  if (
    !isSqlTriggerObject(object) ||
    effectivePostgresTriggerMode(object.triggerEnabled) === "origin"
  ) {
    return undefined;
  }
  return renderSqlTriggerMode(object);
}

function renderPartitionReplicaIdentity(object: SqlObject): string {
  return renderPostgresReplicaIdentity(
    { name: object.name, schema: object.schema },
    object.replicaIdentity
  );
}

function renderNonDefaultPartitionReplicaIdentity(
  object: SqlObject
): string | undefined {
  return object.kind === "partition" && object.replicaIdentity
    ? renderPartitionReplicaIdentity(object)
    : undefined;
}

function partitionReplicaIdentityChanged(
  desired: SqlObject,
  current: SqlObject
): boolean {
  return desired.kind === "partition" &&
    current.kind === "partition" &&
    !postgresReplicaIdentitiesEqual(
      desired.replicaIdentity,
      current.replicaIdentity
    );
}

function generateForeignServerAlterPlan(
  desired: SqlObject,
  current: SqlObject
): { state: string[]; changesOwner: boolean } {
  const desiredDefinition = desired.foreignServerDefinition;
  const currentDefinition = current.foreignServerDefinition;
  if (!desiredDefinition || !currentDefinition) {
    throw new ValidationError(
      `Foreign server '${desired.name}' is missing its lossless canonical definition`,
      "foreign-server",
      desired.key,
      desired.createStatement
    );
  }
  if (
    desiredDefinition.foreignDataWrapper !==
    currentDefinition.foreignDataWrapper
  ) {
    throw new ValidationError(
      `Changing foreign server '${desired.name}' to a different foreign-data wrapper is not supported because PostgreSQL cannot alter that dependency in place; create a new server with a different name`,
      "foreign-server",
      desired.key,
      desired.createStatement
    );
  }
  if (desiredDefinition.type !== currentDefinition.type) {
    throw new ValidationError(
      `Changing foreign server '${desired.name}' server type is not supported because PostgreSQL cannot alter it in place; create a new server with a different name`,
      "foreign-server",
      desired.key,
      desired.createStatement
    );
  }
  const state: string[] = [];
  const stateStatement = renderPostgresForeignServerAlter(
    desired.name,
    currentDefinition,
    desiredDefinition
  );
  if (stateStatement) {
    state.push(stateStatement);
  }
  return {
    state,
    changesOwner:
      desiredDefinition.owner !== undefined &&
      desiredDefinition.owner !== currentDefinition.owner,
  };
}

export class SqlObjectHandler {
  async generateStatements(
    desiredObjects: SqlObject[],
    currentObjects: SqlObject[],
    context: PostgresTypeObjectContext = {}
  ): Promise<SqlObjectPlan> {
    const plan: SqlObjectPlan = {
      bootstrapCreate: [],
      preSchemaCreate: [],
      postSchemaCreate: [],
      typeCreate: [],
      preTableCreate: [],
      postTableCreate: [],
      postRoutineCreate: [],
      finalCreate: [],
      earlyDrop: [],
      partitionDrop: [],
      typeReplaceDrop: [],
      typeAlter: [],
      typeDrop: [],
      typeCreateOperations: [],
      typeDropOperations: [],
      lateDrop: [],
    };

    const currentMap = new Map(currentObjects.map(function (item) {
      return [item.key, item] as const;
    }));
    const desiredMap = new Map(desiredObjects.map(function (item) {
      return [item.key, item] as const;
    }));
    const desiredTypesByName = new Map(
      desiredObjects
        .filter(function isPostgresType(item) {
          return item.typeDefinition !== undefined;
        })
        .map(function mapType(item) {
          return [`${item.schema || "public"}.${item.name}`, item] as const;
        })
    );
    const replacementDesiredKeys = new Set<string>();
    const newForeignServerOwners: SqlObject[] = [];
    const alteredRoles: Array<{
      key: string;
      name: string;
      current: PostgresRoleDefinition;
      desired: PostgresRoleDefinition;
    }> = [];

    const dropsByBucket = new Map<SqlObjectStatementBucket, SqlObject[]>();
    const createsByBucket = new Map<SqlObjectStatementBucket, SqlObject[]>();
    const canonicalObjects = new Map<SqlObject, CanonicalSqlObject>();

    await Promise.all(
      [...currentObjects, ...desiredObjects].map(async function (item) {
        canonicalObjects.set(item, await canonicalizeSqlObject(item));
      })
    );

    function addToBucket(
      buckets: Map<SqlObjectStatementBucket, SqlObject[]>,
      bucket: SqlObjectStatementBucket,
      item: SqlObject
    ): void {
      const list = buckets.get(bucket) || [];
      list.push(item);
      buckets.set(bucket, list);
    }

    for (const currentObject of currentObjects) {
      const desiredObject = desiredMap.get(currentObject.key);
      if (!desiredObject) {
        if (
          currentObject.kind === "domain-type" ||
          currentObject.kind === "range-type"
        ) {
          const replacement = desiredTypesByName.get(
            `${currentObject.schema || "public"}.${currentObject.name}`
          );
          if (replacement && replacement.kind !== currentObject.kind) {
            assertTypeCanBeReplaced(currentObject);
            if (replacement.typeDefinition?.kind === "range") {
              assertRangePrerequisitesExist(
                replacement,
                replacement.typeDefinition,
                context
              );
            }
            addToBucket(dropsByBucket, "typeReplaceDrop", currentObject);
            addToBucket(createsByBucket, "typeCreate", replacement);
            replacementDesiredKeys.add(replacement.key);
            continue;
          }
          assertTypeCanBeRemoved(currentObject, desiredObjects, context);
        }
        addToBucket(
          dropsByBucket,
          getDropBucketForObject(currentObject),
          currentObject
        );
        continue;
      }
      if (desiredObject.desiredAbsent === true) {
        addToBucket(
          dropsByBucket,
          getDropBucketForObject(currentObject),
          currentObject
        );
        continue;
      }

      const currentTypeDefinition = currentObject.typeDefinition;
      const desiredTypeDefinition = desiredObject.typeDefinition;
      if (
        currentTypeDefinition?.kind === "domain" &&
        desiredTypeDefinition?.kind === "domain"
      ) {
        if (
          domainDefinitionsRequireReplacement(
            desiredTypeDefinition,
            currentTypeDefinition
          )
        ) {
          assertTypeCanBeReplaced(currentObject);
          addToBucket(dropsByBucket, "typeReplaceDrop", currentObject);
          addToBucket(createsByBucket, "typeCreate", desiredObject);
        } else {
          plan.typeAlter.push(
            ...generateDomainAlterStatements(
              desiredObject,
              currentTypeDefinition,
              desiredTypeDefinition,
              currentObject.hasContainerColumnDependents === true
            )
          );
        }
        continue;
      }
      if (
        currentTypeDefinition?.kind === "range" &&
        desiredTypeDefinition?.kind === "range"
      ) {
        if (
          rangeDefinitionsAreEqual(
            desiredTypeDefinition,
            currentTypeDefinition,
            desiredObject.schema || "public",
            desiredObject.name
          )
        ) {
          continue;
        }
        assertTypeCanBeReplaced(currentObject);
        assertRangePrerequisitesExist(
          desiredObject,
          desiredTypeDefinition,
          context
        );
        addToBucket(dropsByBucket, "typeReplaceDrop", currentObject);
        addToBucket(createsByBucket, "typeCreate", desiredObject);
        continue;
      }

      if (
        currentObject.kind === "foreign-server" &&
        desiredObject.kind === "foreign-server"
      ) {
        const foreignServerAlter = generateForeignServerAlterPlan(
          desiredObject,
          currentObject
        );
        plan.preTableCreate.push(...foreignServerAlter.state);
        if (foreignServerAlter.changesOwner) {
          newForeignServerOwners.push(desiredObject);
        }
        continue;
      }

      if (currentObject.kind === "role") {
        if (desiredObject.kind !== "role") {
          throw new ValidationError(
            `PostgreSQL SQL object key '${currentObject.key}' collides between role and ${desiredObject.kind} definitions`,
            "role",
            currentObject.key,
            desiredObject.createStatement
          );
        }
        if (
          !currentObject.roleDefinition ||
          !desiredObject.roleDefinition
        ) {
          throw new ValidationError(
            `PostgreSQL role '${desiredObject.name}' is missing its lossless canonical definition`,
            "role",
            desiredObject.key,
            desiredObject.createStatement
          );
        }
        if (
          !postgresRoleDefinitionsEqual(
            currentObject.roleDefinition,
            desiredObject.roleDefinition
          )
        ) {
          alteredRoles.push({
            key: desiredObject.key,
            name: desiredObject.name,
            current: currentObject.roleDefinition,
            desired: desiredObject.roleDefinition,
          });
        }
        continue;
      }
      if (desiredObject.kind === "role") {
        throw new ValidationError(
          `PostgreSQL SQL object key '${desiredObject.key}' collides between ${currentObject.kind} and role definitions`,
          "role",
          desiredObject.key,
          desiredObject.createStatement
        );
      }

      if (currentObject.kind === "grant" || desiredObject.kind === "grant") {
        if (currentObject.kind !== "grant" || desiredObject.kind !== "grant") {
          throw new ValidationError(
            `PostgreSQL SQL object key '${currentObject.key}' collides between ${currentObject.kind} and ${desiredObject.kind} definitions`,
            "grant",
            currentObject.key,
            desiredObject.createStatement
          );
        }
        if (!currentObject.grantDefinition || !desiredObject.grantDefinition) {
          throw new ValidationError(
            `PostgreSQL privilege grant '${desiredObject.key}' is missing its lossless canonical definition`,
            "grant",
            desiredObject.key,
            desiredObject.createStatement
          );
        }
        if (
          currentObject.grantDefinition.grantable !==
          desiredObject.grantDefinition.grantable
        ) {
          if (desiredObject.grantDefinition.grantable) {
            plan.finalCreate.push(desiredObject.createStatement);
          } else {
            plan.earlyDrop.push(
              renderPostgresGrantOptionRevoke(desiredObject.grantDefinition)
            );
          }
        }
        continue;
      }

      if (
        currentObject.kind === "default-privilege" ||
        desiredObject.kind === "default-privilege"
      ) {
        if (
          currentObject.kind !== "default-privilege" ||
          desiredObject.kind !== "default-privilege"
        ) {
          throw new ValidationError(
            `PostgreSQL SQL object key '${currentObject.key}' collides between ${currentObject.kind} and ${desiredObject.kind} definitions`,
            "default-privilege",
            currentObject.key,
            desiredObject.createStatement
          );
        }
        const currentDefinition = currentObject.defaultPrivilegeDefinition;
        const desiredDefinition = desiredObject.defaultPrivilegeDefinition;
        if (!currentDefinition || !desiredDefinition) {
          throw new ValidationError(
            `PostgreSQL default privilege '${desiredObject.key}' is missing its lossless canonical definition`,
            "default-privilege",
            desiredObject.key,
            desiredObject.createStatement
          );
        }
        if (
          currentDefinition.baselineGranted !==
          desiredDefinition.baselineGranted
        ) {
          throw new ValidationError(
            `PostgreSQL default privilege '${desiredObject.key}' has inconsistent hard-wired baseline state`,
            "default-privilege",
            desiredObject.key,
            desiredObject.createStatement
          );
        }
        const statement = renderPostgresDefaultPrivilegeTransition(
          currentDefinition,
          desiredDefinition
        );
        if (statement) {
          addToBucket(
            createsByBucket,
            getCreateBucketForObject(desiredObject),
            { ...desiredObject, createStatement: statement }
          );
        }
        continue;
      }

      const currentCanonical = canonicalObjects.get(currentObject)!;
      const desiredCanonical = canonicalObjects.get(desiredObject)!;
      const replicaIdentityChanged = partitionReplicaIdentityChanged(
        desiredObject,
        currentObject
      );
      if (
        currentCanonical.comparisonNormalized ===
        desiredCanonical.comparisonNormalized
      ) {
        if (!sqlTriggerModesAreEqual(desiredObject, currentObject)) {
          plan.postRoutineCreate.push(
            renderSqlTriggerMode(desiredObject)
          );
        }
        if (replicaIdentityChanged) {
          plan.postTableCreate.push(
            renderPartitionReplicaIdentity(desiredObject)
          );
        }
        continue;
      }

      if (
        currentObject.kind === "row-level-security" &&
        desiredObject.kind === "row-level-security"
      ) {
        continue;
      }

      if (
        currentObject.kind === "policy" &&
        desiredObject.kind === "policy" &&
        currentObject.policyDefinition &&
        desiredObject.policyDefinition &&
        policyDefinitionsAreEqual(
          desiredObject.policyDefinition,
          currentObject.policyDefinition,
          context
        )
      ) {
        continue;
      }

      if (
        currentObject.kind === "partition" &&
        desiredObject.kind === "partition" &&
        partitionParentsAreEquivalent(
          desiredCanonical.partitionParent,
          currentCanonical.partitionParent
        )
      ) {
        if (replicaIdentityChanged) {
          plan.postTableCreate.push(
            renderPartitionReplicaIdentity(desiredObject)
          );
        }
        continue;
      }

      if (currentObject.kind === "partition" && desiredObject.kind === "partition") {
        const replacement = getPartitionBoundReplacement(
          currentCanonical,
          desiredCanonical
        );
        if (replacement) {
          addToBucket(dropsByBucket, "earlyDrop", {
            ...currentObject,
            dropStatement: replacement.detachStatement,
          });
          addToBucket(createsByBucket, "preTableCreate", {
            ...desiredObject,
            createStatement: replacement.attachStatement,
          });
          if (replicaIdentityChanged) {
            plan.postTableCreate.push(
              renderPartitionReplicaIdentity(desiredObject)
            );
          }
          continue;
        }

        throw new ValidationError(
          `Changing partition '${currentObject.key}' beyond its bound is not supported because recreating it could lose data`,
          "partition",
          currentObject.key,
          desiredObject.createStatement
        );
      }

      addToBucket(
        dropsByBucket,
        getDropBucketForObject(currentObject),
        currentObject
      );
      addToBucket(
        createsByBucket,
        getCreateBucketForObject(desiredObject),
        desiredObject
      );
    }

    for (const desiredObject of desiredObjects) {
      if (
        desiredObject.desiredAbsent === true ||
        currentMap.has(desiredObject.key) ||
        replacementDesiredKeys.has(desiredObject.key)
      ) {
        continue;
      }
      if (desiredObject.typeDefinition?.kind === "range") {
        assertRangePrerequisitesExist(
          desiredObject,
          desiredObject.typeDefinition,
          context
        );
      }
      if (
        desiredObject.defaultPrivilegeDefinition &&
        postgresDefaultPrivilegeMatchesBaseline(
          desiredObject.defaultPrivilegeDefinition
        )
      ) {
        continue;
      }
      addToBucket(
        createsByBucket,
        getCreateBucketForObject(desiredObject),
        desiredObject
      );
      if (
        desiredObject.kind === "foreign-server" &&
        desiredObject.foreignServerDefinition?.owner !== undefined
      ) {
        newForeignServerOwners.push(desiredObject);
      }
    }

    for (const [bucket, objects] of dropsByBucket) {
      const operations = pushStatements(plan, bucket, objects, true);
      if (bucket === "typeDrop") {
        plan.typeDropOperations.push(...operations);
      }
    }

    for (const [bucket, objects] of createsByBucket) {
      const operations = pushStatements(plan, bucket, objects, false);
      if (bucket === "typeCreate") {
        plan.typeCreateOperations.push(...operations);
      }
    }
    const sortedAlteredRoles = [...alteredRoles].sort(
      function sortRoleAlters(left, right) {
        return left.key.localeCompare(right.key);
      }
    );
    for (const role of sortedAlteredRoles) {
      const statement = renderPostgresRoleAlter(
        role.name,
        role.current,
        role.desired
      );
      if (statement) {
        plan.bootstrapCreate.push(statement);
      }
    }
    for (const server of sortKeys(newForeignServerOwners, false)) {
      const owner = server.foreignServerDefinition?.owner;
      if (owner === undefined) {
        continue;
      }
      plan.preTableCreate.push(
        renderPostgresForeignServerOwnerAlter(server.name, owner)
      );
    }

    plan.earlyDrop = dedupeStatements(plan.earlyDrop);
    plan.partitionDrop = dedupeStatements(plan.partitionDrop);
    plan.typeReplaceDrop = dedupeStatements(plan.typeReplaceDrop);
    plan.typeAlter = dedupeStatements(plan.typeAlter);
    plan.typeDrop = dedupeStatements(plan.typeDrop);
    plan.lateDrop = dedupeStatements(plan.lateDrop);
    plan.bootstrapCreate = dedupeStatements(plan.bootstrapCreate);
    plan.preSchemaCreate = dedupeStatements(plan.preSchemaCreate);
    plan.postSchemaCreate = dedupeStatements(plan.postSchemaCreate);
    plan.typeCreate = dedupeStatements(plan.typeCreate);
    plan.preTableCreate = dedupeStatements(plan.preTableCreate);
    plan.postTableCreate = dedupeStatements(plan.postTableCreate);
    plan.postRoutineCreate = dedupeStatements(plan.postRoutineCreate);
    plan.finalCreate = dedupeStatements(plan.finalCreate);
    plan.typeCreateOperations = dedupeTypeStatements(
      plan.typeCreateOperations
    );
    plan.typeDropOperations = dedupeTypeStatements(plan.typeDropOperations);

    return plan;
  }
}

function dedupeTypeStatements(
  statements: PostgresTypeStatement[]
): PostgresTypeStatement[] {
  const seen = new Set<string>();
  return statements.filter(function isFirst(item) {
    if (seen.has(item.statement)) return false;
    seen.add(item.statement);
    return true;
  });
}

function dedupeStatements(statements: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const statement of statements) {
    const key = normalizeSql(statement);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(statement);
  }

  return result;
}
