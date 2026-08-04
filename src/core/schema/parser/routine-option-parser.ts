import { ParserError } from "../../../types/errors";
import { normalizeRoutineConfigurationValue } from "../../../utils/routine-configuration";

type RoutineKind = "function" | "procedure";

function routineError(
  message: string,
  originalSql: string,
  filePath?: string
): ParserError {
  return new ParserError(
    message,
    filePath,
    undefined,
    undefined,
    originalSql
  );
}

function extractSettingValue(node: any): string | undefined {
  const constant = node?.A_Const;
  const stringValue = constant?.sval?.sval ??
    constant?.String?.sval ??
    node?.String?.sval;
  if (typeof stringValue === "string") {
    return stringValue;
  }

  const integerValue = constant?.ival?.ival ?? constant?.Integer?.ival;
  if (typeof integerValue === "number") {
    return String(integerValue);
  }

  const floatValue = constant?.fval?.fval ?? constant?.Float?.fval;
  if (typeof floatValue === "string" || typeof floatValue === "number") {
    return String(floatValue);
  }

  const booleanValue = constant?.boolval?.boolval ?? constant?.Boolean?.boolval;
  if (typeof booleanValue === "boolean") {
    return booleanValue ? "true" : "false";
  }

  return undefined;
}

export function validateRoutineDefinition(
  node: any,
  kind: RoutineKind,
  supportedOptions: ReadonlySet<string>,
  originalSql: string,
  filePath?: string
): void {
  if (node.sql_body) {
    throw routineError(
      `PostgreSQL ${kind} SQL-standard body syntax is not supported in desired schemas because its parsed dependency semantics are not modeled; use a quoted AS body instead`,
      originalSql,
      filePath
    );
  }

  if (!Array.isArray(node.options)) {
    return;
  }
  const options = node.options;

  let language: string | undefined;
  for (const option of options) {
    const defElem = option.DefElem;
    if (defElem?.defname === "language") {
      language = defElem.arg?.String?.sval;
      break;
    }
  }

  for (const option of options) {
    const defElem = option.DefElem;
    const optionName = defElem?.defname;
    if (!optionName) {
      continue;
    }
    if (!supportedOptions.has(optionName)) {
      throw routineError(
        `PostgreSQL ${kind} ${optionName.toUpperCase()} is not supported in desired schemas because its persistent semantics are not modeled`,
        originalSql,
        filePath
      );
    }
    if (
      optionName === "as" &&
      Array.isArray(defElem.arg?.List?.items) &&
      (
        defElem.arg.List.items.length > 1 ||
        (language === "c" && defElem.arg.List.items.length > 0)
      )
    ) {
      throw routineError(
        `PostgreSQL ${kind} linked object AS syntax is not supported in desired schemas because the object file and optional link symbol are not modeled separately`,
        originalSql,
        filePath
      );
    }
  }
}

export function extractRoutineConfiguration(
  node: any,
  kind: RoutineKind,
  originalSql: string,
  filePath?: string
): Record<string, string> | undefined {
  const configuration: Record<string, string> = {};
  let options: any;
  try {
    options = node.options;
  } catch {
    return undefined;
  }
  if (!Array.isArray(options)) {
    return undefined;
  }

  for (const option of options) {
    const defElem = option.DefElem;
    if (defElem?.defname !== "set") {
      continue;
    }

    const setting = defElem.arg?.VariableSetStmt;
    const name = setting?.name;
    if (typeof name !== "string" || !name) {
      throw routineError(
        `PostgreSQL ${kind} SET option is missing a configuration parameter name`,
        originalSql,
        filePath
      );
    }
    if (setting.kind === "VAR_SET_CURRENT") {
      throw routineError(
        `PostgreSQL ${kind} SET FROM CURRENT is not supported in desired schemas because it captures environment-dependent state at apply time; specify the value explicitly`,
        originalSql,
        filePath
      );
    }
    if (setting.kind === "VAR_SET_DEFAULT") {
      delete configuration[name];
      continue;
    }
    if (setting.kind !== "VAR_SET_VALUE" || !Array.isArray(setting.args)) {
      throw routineError(
        `PostgreSQL ${kind} SET option for ${name} uses an unsupported value form`,
        originalSql,
        filePath
      );
    }

    const values: string[] = [];
    for (const argument of setting.args) {
      const value = extractSettingValue(argument);
      if (value === undefined) {
        throw routineError(
          `PostgreSQL ${kind} SET option for ${name} contains a value that cannot be represented safely`,
          originalSql,
          filePath
        );
      }
      values.push(value);
    }
    configuration[name] = normalizeRoutineConfigurationValue(name, values);
  }

  return Object.keys(configuration).length > 0 ? configuration : undefined;
}
