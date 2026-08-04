import type {
  SqlObject,
  SqlObjectKind,
} from "../../../types/schema";
import { ValidationError } from "../../../types/errors";
import { deparseSync, parse } from "pgsql-parser";
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

type SqlObjectPlan = {
  bootstrapCreate: string[];
  typeCreate: string[];
  preTableCreate: string[];
  postTableCreate: string[];
  postRoutineCreate: string[];
  finalCreate: string[];
  earlyDrop: string[];
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

function normalizeSql(statement: string): string {
  return statement
    .replace(/;\s*$/g, "")
    .replace(/\bEXECUTE\s+PROCEDURE\b/gi, "EXECUTE FUNCTION")
    .replace(/\bPASSWORD\s+'(?:[^']|'')*'/gi, "PASSWORD '<redacted>'")
    .replace(/\s+/g, " ")
    .trim();
}

function terminateStatement(statement: string): string {
  const trimmed = statement.trim();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
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
  if (kind === "role" || kind === "user") {
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
  if (
    kind === "grant" ||
    kind === "policy" ||
    kind === "constraint-trigger" ||
    kind === "event-trigger" ||
    kind === "row-level-security" ||
    kind === "partition"
  ) {
    return "earlyDrop";
  }
  return "lateDrop";
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
    operations.push({
      name: item.name,
      schema: item.schema,
      statement,
    });
  }
  return operations;
}

export class SqlObjectHandler {
  async generateStatements(
    desiredObjects: SqlObject[],
    currentObjects: SqlObject[],
    context: PostgresTypeObjectContext = {}
  ): Promise<SqlObjectPlan> {
    const plan: SqlObjectPlan = {
      bootstrapCreate: [],
      typeCreate: [],
      preTableCreate: [],
      postTableCreate: [],
      postRoutineCreate: [],
      finalCreate: [],
      earlyDrop: [],
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
        addToBucket(dropsByBucket, getDropBucket(currentObject.kind), currentObject);
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

      const currentCanonical = canonicalObjects.get(currentObject)!;
      const desiredCanonical = canonicalObjects.get(desiredObject)!;
      if (
        currentCanonical.comparisonNormalized ===
        desiredCanonical.comparisonNormalized
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
          continue;
        }

        throw new ValidationError(
          `Changing partition '${currentObject.key}' beyond its bound is not supported because recreating it could lose data`,
          "partition",
          currentObject.key,
          desiredObject.createStatement
        );
      }

      addToBucket(dropsByBucket, getDropBucket(currentObject.kind), currentObject);
      addToBucket(createsByBucket, getCreateBucket(desiredObject.kind), desiredObject);
    }

    for (const desiredObject of desiredObjects) {
      if (
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
      addToBucket(createsByBucket, getCreateBucket(desiredObject.kind), desiredObject);
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

    plan.earlyDrop = dedupeStatements(plan.earlyDrop);
    plan.typeReplaceDrop = dedupeStatements(plan.typeReplaceDrop);
    plan.typeAlter = dedupeStatements(plan.typeAlter);
    plan.typeDrop = dedupeStatements(plan.typeDrop);
    plan.lateDrop = dedupeStatements(plan.lateDrop);
    plan.bootstrapCreate = dedupeStatements(plan.bootstrapCreate);
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
