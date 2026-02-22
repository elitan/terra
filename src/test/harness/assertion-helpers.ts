import type { CliApplyOutput, CliPlanOutput } from "../../types/cli-output";

export type CliJsonOutput = CliApplyOutput | CliPlanOutput;

export function parseCliJsonOutput(raw: string): CliJsonOutput {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.find((entry) => entry.startsWith("{") && entry.endsWith("}"));
  if (!line) {
    throw new Error(`No JSON payload found in output: ${raw}`);
  }
  return JSON.parse(line) as CliJsonOutput;
}

export function hasStatement(
  output: CliJsonOutput,
  fragment: string
): boolean {
  const statements = [
    ...output.statements.transactional,
    ...output.statements.deferred,
    ...output.statements.concurrent,
  ];
  return statements.some((statement) => statement.includes(fragment));
}

