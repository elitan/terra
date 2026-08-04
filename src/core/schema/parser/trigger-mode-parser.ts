import type {
  PostgresTriggerEnabledMode,
  SqlObject,
  Trigger,
} from "../../../types/schema";
import { ParserError } from "../../../types/errors";
import { postgresTriggerModeFromCatalogCode } from "../../../utils/postgres-trigger";

export type PendingTriggerMode =
  | {
      target: "table";
      schemaName?: string;
      tableName: string;
      triggerName: string;
      mode: PostgresTriggerEnabledMode;
    }
  | {
      target: "event";
      triggerName: string;
      mode: PostgresTriggerEnabledMode;
    };

const TABLE_TRIGGER_MODE_BY_SUBTYPE: Record<
  string,
  PostgresTriggerEnabledMode
> = {
  AT_EnableTrig: "origin",
  AT_DisableTrig: "disabled",
  AT_EnableReplicaTrig: "replica",
  AT_EnableAlwaysTrig: "always",
};

const BULK_TRIGGER_MODE_SUBTYPES = new Set([
  "AT_EnableTrigAll",
  "AT_DisableTrigAll",
  "AT_EnableTrigUser",
  "AT_DisableTrigUser",
]);

export function isTableTriggerModeSubtype(subtype: unknown): boolean {
  return typeof subtype === "string" &&
    TABLE_TRIGGER_MODE_BY_SUBTYPE[subtype] !== undefined;
}

export function rejectUnsupportedBulkTriggerAlter(
  stmt: any,
  filePath?: string
): void {
  const hasBulkMode = (stmt?.cmds || []).some(
    function isBulkTriggerMode(item: any) {
      return BULK_TRIGGER_MODE_SUBTYPES.has(item?.AlterTableCmd?.subtype);
    }
  );
  if (hasBulkMode) {
    throw new ParserError(
      "PostgreSQL bulk trigger firing mutations for ALL or USER are not supported in desired schemas; declare one named ALTER TABLE ... [ENABLE|DISABLE] TRIGGER statement for each CREATE TRIGGER",
      filePath
    );
  }
}

export function parseAlterTableTriggerModes(
  stmt: any,
  filePath?: string
): PendingTriggerMode[] {
  const relation = stmt?.relation;
  const commands = (stmt?.cmds || []).filter(
    function isTriggerModeCommand(item: any) {
      return isTableTriggerModeSubtype(item?.AlterTableCmd?.subtype);
    }
  );
  if (commands.length === 0) {
    return [];
  }
  if (!relation?.relname || relation.inh !== true) {
    throw new ParserError(
      "Named trigger firing modes require an inheriting ALTER TABLE target; ALTER TABLE ONLY could leave partition trigger clones with unmodeled state",
      filePath
    );
  }

  return commands.map(function mapTriggerMode(item: any) {
    const command = item.AlterTableCmd;
    if (!command.name) {
      throw new ParserError(
        "Named trigger firing mode is missing a trigger name",
        filePath
      );
    }
    return {
      target: "table" as const,
      schemaName: relation.schemaname,
      tableName: relation.relname,
      triggerName: command.name,
      mode: TABLE_TRIGGER_MODE_BY_SUBTYPE[command.subtype]!,
    };
  });
}

export function parseAlterEventTriggerMode(
  stmt: any,
  filePath?: string
): PendingTriggerMode {
  const mode = postgresTriggerModeFromCatalogCode(stmt?.tgenabled);
  if (!stmt?.trigname || !mode) {
    throw new ParserError(
      "PostgreSQL ALTER EVENT TRIGGER is supported in desired schemas only for ENABLE, ENABLE REPLICA, ENABLE ALWAYS, or DISABLE firing modes",
      filePath
    );
  }
  return {
    target: "event",
    triggerName: stmt.trigname,
    mode,
  };
}

export function rejectDuplicateTriggerDeclarations(
  triggers: Trigger[],
  sqlObjects: SqlObject[],
  filePath?: string
): void {
  const keys = new Set<string>();
  for (const trigger of triggers) {
    addUniqueTriggerKey(keys, tableTriggerKey(trigger), filePath);
  }
  for (const object of sqlObjects) {
    if (object.kind === "event-trigger") {
      addUniqueTriggerKey(keys, `event:${object.name}`, filePath);
    } else if (object.kind === "constraint-trigger") {
      addUniqueTriggerKey(keys, sqlObjectTableTriggerKey(object), filePath);
    }
  }
}

export function mergePendingTriggerModes(
  triggers: Trigger[],
  sqlObjects: SqlObject[],
  pending: PendingTriggerMode[],
  filePath?: string
): void {
  const seen = new Set<string>();
  for (const item of pending) {
    const key = pendingTriggerKey(item);
    if (seen.has(key)) {
      throw new ParserError(
        `PostgreSQL trigger firing mode for '${displayTriggerKey(key)}' is declared more than once`,
        filePath
      );
    }
    seen.add(key);

    const target = findTriggerModeTarget(triggers, sqlObjects, item);
    if (!target) {
      throw new ParserError(
        `PostgreSQL target trigger '${displayTriggerKey(key)}' is not declared in the desired schema; pair each firing-mode statement with its CREATE TRIGGER or CREATE EVENT TRIGGER definition`,
        filePath
      );
    }
    if ("tableName" in target) {
      target.enabled = item.mode;
    } else {
      target.triggerEnabled = item.mode;
    }
  }
}

function findTriggerModeTarget(
  triggers: Trigger[],
  sqlObjects: SqlObject[],
  pending: PendingTriggerMode
): Trigger | SqlObject | undefined {
  if (pending.target === "event") {
    return sqlObjects.find(function findEventTrigger(candidate) {
      return candidate.kind === "event-trigger" &&
        candidate.name === pending.triggerName;
    });
  }

  const key = pendingTriggerKey(pending);
  return triggers.find(function findOrdinaryTrigger(candidate) {
    return tableTriggerKey(candidate) === key;
  }) || sqlObjects.find(function findConstraintTrigger(candidate) {
    return candidate.kind === "constraint-trigger" &&
      sqlObjectTableTriggerKey(candidate) === key;
  });
}

function addUniqueTriggerKey(
  keys: Set<string>,
  key: string,
  filePath?: string
): void {
  if (keys.has(key)) {
    throw new ParserError(
      `PostgreSQL trigger '${displayTriggerKey(key)}' is declared more than once in the desired schema`,
      filePath
    );
  }
  keys.add(key);
}

function pendingTriggerKey(pending: PendingTriggerMode): string {
  return pending.target === "event"
    ? `event:${pending.triggerName}`
    : `table:${pending.schemaName || "public"}.${pending.tableName}.${pending.triggerName}`;
}

function tableTriggerKey(trigger: Trigger): string {
  return `table:${trigger.schema || "public"}.${trigger.tableName}.${trigger.name}`;
}

function sqlObjectTableTriggerKey(object: SqlObject): string {
  const schema = object.triggerTable?.schema || object.schema || "public";
  return `table:${schema}.${object.triggerTable?.name || ""}.${object.name}`;
}

function displayTriggerKey(key: string): string {
  return key.replace(/^(?:table|event):/, "");
}
