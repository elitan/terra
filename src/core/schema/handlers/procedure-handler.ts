import type { Procedure } from "../../../types/schema";
import { Logger } from "../../../utils/logger";
import {
  generateCreateProcedureSQL,
  generateDropProcedureSQL,
} from "../../../utils/sql";

export class ProcedureHandler {
  generateStatements(desiredProcedures: Procedure[], currentProcedures: Procedure[]): string[] {
    const statements: string[] = [];
    const currentProcedureMap = new Map(currentProcedures.map(p => [p.name, p]));
    const desiredProcedureNames = new Set(desiredProcedures.map(p => p.name));

    for (const currentProc of currentProcedures) {
      if (!desiredProcedureNames.has(currentProc.name)) {
        statements.push(generateDropProcedureSQL(currentProc));
        Logger.info(`Dropping procedure '${currentProc.name}'`);
      }
    }

    for (const desiredProc of desiredProcedures) {
      const currentProc = currentProcedureMap.get(desiredProc.name);

      if (!currentProc) {
        statements.push(generateCreateProcedureSQL(desiredProc));
        Logger.info(`Creating procedure '${desiredProc.name}'`);
      } else {
        if (this.needsUpdate(desiredProc, currentProc)) {
          statements.push(generateDropProcedureSQL(currentProc));
          statements.push(generateCreateProcedureSQL(desiredProc));
          Logger.info(`Updating procedure '${desiredProc.name}'`);
        } else {
          Logger.info(`Procedure '${desiredProc.name}' is up to date, skipping`);
        }
      }
    }

    return statements;
  }

  private needsUpdate(desired: Procedure, current: Procedure): boolean {
    const normalizeBody = (body: string) => body.replace(/\s+/g, ' ').trim();
    return normalizeBody(desired.body) !== normalizeBody(current.body) ||
           desired.language !== current.language;
  }
}
