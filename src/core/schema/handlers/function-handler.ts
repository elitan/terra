import type { Function } from "../../../types/schema";
import { Logger } from "../../../utils/logger";
import {
  generateCreateFunctionSQL,
  generateDropFunctionSQL,
} from "../../../utils/sql";

export class FunctionHandler {
  generateStatements(desiredFunctions: Function[], currentFunctions: Function[]): string[] {
    const statements: string[] = [];
    const currentFunctionMap = new Map(currentFunctions.map(f => [f.name, f]));
    const desiredFunctionNames = new Set(desiredFunctions.map(f => f.name));

    for (const currentFunc of currentFunctions) {
      if (!desiredFunctionNames.has(currentFunc.name)) {
        statements.push(generateDropFunctionSQL(currentFunc));
        Logger.info(`Dropping function '${currentFunc.name}'`);
      }
    }

    for (const desiredFunc of desiredFunctions) {
      const currentFunc = currentFunctionMap.get(desiredFunc.name);

      if (!currentFunc) {
        statements.push(generateCreateFunctionSQL(desiredFunc));
        Logger.info(`Creating function '${desiredFunc.name}'`);
      } else {
        if (this.needsUpdate(desiredFunc, currentFunc)) {
          statements.push(generateDropFunctionSQL(currentFunc));
          statements.push(generateCreateFunctionSQL(desiredFunc));
          Logger.info(`Updating function '${desiredFunc.name}'`);
        } else {
          Logger.info(`Function '${desiredFunc.name}' is up to date, skipping`);
        }
      }
    }

    return statements;
  }

  private needsUpdate(desired: Function, current: Function): boolean {
    const normalizeBody = (body: string) => body.replace(/\s+/g, ' ').trim();
    return normalizeBody(desired.body) !== normalizeBody(current.body) ||
           desired.returnType !== current.returnType ||
           desired.language !== current.language ||
           desired.volatility !== current.volatility;
  }
}
