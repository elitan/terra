import type { Sequence } from "../../../types/schema";
import {
  generateCreateSequenceSQL,
  generateDropSequenceSQL,
} from "../../../utils/sql";
import { generateStatements, type HandlerConfig } from "./base-handler";

const config: HandlerConfig<Sequence> = {
  name: "sequence",
  getKey: (s) => s.name,
  generateDrop: (s) => generateDropSequenceSQL(s.name),
  generateCreate: generateCreateSequenceSQL,
  shouldManage: (s) => !s.ownedBy,
  needsUpdate: (desired, current) =>
    desired.increment !== current.increment ||
    desired.minValue !== current.minValue ||
    desired.maxValue !== current.maxValue ||
    desired.start !== current.start ||
    desired.cache !== current.cache ||
    desired.cycle !== current.cycle,
};

export class SequenceHandler {
  generateStatements(desiredSequences: Sequence[], currentSequences: Sequence[]): string[] {
    return generateStatements(desiredSequences, currentSequences, config);
  }
}
