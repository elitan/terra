import type { SqlObject, SqlObjectKind } from "../../../types/schema";

type SqlObjectPlan = {
  bootstrapCreate: string[];
  typeCreate: string[];
  preTableCreate: string[];
  postTableCreate: string[];
  postRoutineCreate: string[];
  finalCreate: string[];
  earlyDrop: string[];
  lateDrop: string[];
};

function normalizeSql(statement: string): string {
  return statement
    .replace(/;\s*$/g, "")
    .replace(/\bEXECUTE\s+PROCEDURE\b/gi, "EXECUTE FUNCTION")
    .replace(/\bPASSWORD\s+'(?:[^']|'')*'/gi, "PASSWORD '<redacted>'")
    .replace(/\s+/g, " ")
    .trim();
}

function getCreateBucket(kind: SqlObjectKind): keyof SqlObjectPlan {
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

function getDropBucket(kind: SqlObjectKind): keyof SqlObjectPlan {
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
    if (visited.has(key) || visiting.has(key)) {
      return;
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
  bucket: keyof SqlObjectPlan,
  objects: SqlObject[],
  useDrop: boolean
): void {
  const ordered = sortKeys(objects, useDrop);
  for (const item of ordered) {
    const statement = useDrop ? item.dropStatement : item.createStatement;
    if (!statement) {
      continue;
    }
    target[bucket].push(statement);
  }
}

export class SqlObjectHandler {
  generateStatements(desiredObjects: SqlObject[], currentObjects: SqlObject[]): SqlObjectPlan {
    const plan: SqlObjectPlan = {
      bootstrapCreate: [],
      typeCreate: [],
      preTableCreate: [],
      postTableCreate: [],
      postRoutineCreate: [],
      finalCreate: [],
      earlyDrop: [],
      lateDrop: [],
    };

    const currentMap = new Map(currentObjects.map(function (item) {
      return [item.key, item] as const;
    }));
    const desiredMap = new Map(desiredObjects.map(function (item) {
      return [item.key, item] as const;
    }));

    const dropsByBucket = new Map<keyof SqlObjectPlan, SqlObject[]>();
    const createsByBucket = new Map<keyof SqlObjectPlan, SqlObject[]>();

    function addToBucket(
      buckets: Map<keyof SqlObjectPlan, SqlObject[]>,
      bucket: keyof SqlObjectPlan,
      item: SqlObject
    ): void {
      const list = buckets.get(bucket) || [];
      list.push(item);
      buckets.set(bucket, list);
    }

    for (const currentObject of currentObjects) {
      const desiredObject = desiredMap.get(currentObject.key);
      if (!desiredObject) {
        addToBucket(dropsByBucket, getDropBucket(currentObject.kind), currentObject);
        continue;
      }

      if (normalizeSql(currentObject.createStatement) === normalizeSql(desiredObject.createStatement)) {
        continue;
      }

      addToBucket(dropsByBucket, getDropBucket(currentObject.kind), currentObject);
      addToBucket(createsByBucket, getCreateBucket(desiredObject.kind), desiredObject);
    }

    for (const desiredObject of desiredObjects) {
      if (currentMap.has(desiredObject.key)) {
        continue;
      }
      addToBucket(createsByBucket, getCreateBucket(desiredObject.kind), desiredObject);
    }

    for (const [bucket, objects] of dropsByBucket) {
      pushStatements(plan, bucket, objects, true);
    }

    for (const [bucket, objects] of createsByBucket) {
      pushStatements(plan, bucket, objects, false);
    }

    plan.earlyDrop = dedupeStatements(plan.earlyDrop);
    plan.lateDrop = dedupeStatements(plan.lateDrop);
    plan.bootstrapCreate = dedupeStatements(plan.bootstrapCreate);
    plan.typeCreate = dedupeStatements(plan.typeCreate);
    plan.preTableCreate = dedupeStatements(plan.preTableCreate);
    plan.postTableCreate = dedupeStatements(plan.postTableCreate);
    plan.postRoutineCreate = dedupeStatements(plan.postRoutineCreate);
    plan.finalCreate = dedupeStatements(plan.finalCreate);

    return plan;
  }
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
