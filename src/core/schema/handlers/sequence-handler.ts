import type { Sequence } from "../../../types/schema";
import { Logger } from "../../../utils/logger";
import {
  generateCreateSequenceSQL,
  generateDropSequenceSQL,
} from "../../../utils/sql";

export class SequenceHandler {
  generateStatements(desiredSequences: Sequence[], currentSequences: Sequence[]): string[] {
    const statements: string[] = [];
    const currentSequenceMap = new Map(currentSequences.map(s => [s.name, s]));
    const desiredSequenceNames = new Set(desiredSequences.map(s => s.name));

    for (const currentSeq of currentSequences) {
      if (!desiredSequenceNames.has(currentSeq.name) && !currentSeq.ownedBy) {
        statements.push(generateDropSequenceSQL(currentSeq.name));
        Logger.info(`Dropping sequence '${currentSeq.name}'`);
      }
    }

    for (const desiredSeq of desiredSequences) {
      const currentSeq = currentSequenceMap.get(desiredSeq.name);

      if (!currentSeq) {
        statements.push(generateCreateSequenceSQL(desiredSeq));
        Logger.info(`Creating sequence '${desiredSeq.name}'`);
      } else if (!currentSeq.ownedBy) {
        if (this.needsUpdate(desiredSeq, currentSeq)) {
          statements.push(generateDropSequenceSQL(currentSeq.name));
          statements.push(generateCreateSequenceSQL(desiredSeq));
          Logger.info(`Updating sequence '${desiredSeq.name}'`);
        } else {
          Logger.info(`Sequence '${desiredSeq.name}' is up to date, skipping`);
        }
      } else {
        Logger.info(`Sequence '${desiredSeq.name}' is owned by a table column, skipping`);
      }
    }

    return statements;
  }

  private needsUpdate(desired: Sequence, current: Sequence): boolean {
    return desired.increment !== current.increment ||
           desired.minValue !== current.minValue ||
           desired.maxValue !== current.maxValue ||
           desired.start !== current.start ||
           desired.cache !== current.cache ||
           desired.cycle !== current.cycle;
  }
}
