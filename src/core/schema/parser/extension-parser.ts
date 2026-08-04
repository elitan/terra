/**
 * Extension Parser
 *
 * Handles parsing of PostgreSQL CREATE EXTENSION statements from pgsql-parser AST.
 */

import type { Extension } from "../../../types/schema";
import { ParserError } from "../../../types/errors";

/**
 * Parse CREATE EXTENSION statement from pgsql-parser AST
 */
export function parseCreateExtension(
  stmt: any,
  filePath?: string
): Extension {
  const name = stmt?.extname;
  if (typeof name !== "string" || name.length === 0) {
    throw new ParserError(
      "PostgreSQL CREATE EXTENSION has no concrete extension name",
      filePath
    );
  }

  let schema: string | undefined;
  let version: string | undefined;
  let cascade = false;
  const seenOptions = new Set<string>();

  for (const wrapper of stmt.options || []) {
    const option = wrapper?.DefElem;
    const optionName = option?.defname;
    if (typeof optionName !== "string") {
      throw unsupportedExtensionOption("unknown", filePath);
    }
    if (seenOptions.has(optionName)) {
      throw new ParserError(
        `PostgreSQL CREATE EXTENSION option ${optionName} is declared more than once`,
        filePath
      );
    }
    seenOptions.add(optionName);

    if (optionName === "schema") {
      schema = readStringOption(option, "SCHEMA", filePath);
    } else if (optionName === "new_version") {
      version = readStringOption(option, "VERSION", filePath);
    } else if (optionName === "cascade") {
      if (option.arg?.Boolean?.boolval !== true) {
        throw unsupportedExtensionOption("CASCADE", filePath);
      }
      cascade = true;
    } else {
      throw unsupportedExtensionOption(optionName, filePath);
    }
  }

  return { name, schema, version, cascade };
}

function readStringOption(
  option: any,
  name: string,
  filePath?: string
): string {
  const value = option.arg?.String?.sval;
  if (typeof value !== "string" || value.length === 0) {
    throw unsupportedExtensionOption(name, filePath);
  }
  return value;
}

function unsupportedExtensionOption(
  name: string,
  filePath?: string
): ParserError {
  return new ParserError(
    `PostgreSQL CREATE EXTENSION option ${name} cannot be represented losslessly`,
    filePath
  );
}
