#!/usr/bin/env node

import { runCLI } from "./cli/index";
import { CLI_OUTPUT_SCHEMA_VERSION } from "./types/cli-output";
import { TerraError } from "./types/errors";
import { ErrorFormatter } from "./utils/error-formatter";
import { Logger } from "./utils/logger";

function shouldDisableColor(args: string[]): boolean {
  return args.includes("--no-color");
}

function shouldOutputJson(args: string[]): boolean {
  const formatIndex = args.lastIndexOf("--format");
  if (formatIndex !== -1 && args[formatIndex + 1] === "json") {
    return true;
  }
  return args.includes("--format=json");
}

function getErrorCode(error: unknown): string {
  if (error instanceof TerraError) {
    return error.code;
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return "UNKNOWN_ERROR";
}

function getErrorName(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }
  return "Error";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

if (import.meta.main) {
  if (shouldDisableColor(process.argv)) {
    Logger.setColorEnabled(false);
  }
  runCLI().catch((error) => {
    if (shouldOutputJson(process.argv)) {
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: CLI_OUTPUT_SCHEMA_VERSION,
          error: {
            code: getErrorCode(error),
            name: getErrorName(error),
            message: getErrorMessage(error),
          },
        })}\n`
      );
      process.exit(1);
    }
    console.error(ErrorFormatter.format(error));
    process.exit(1);
  });
}
