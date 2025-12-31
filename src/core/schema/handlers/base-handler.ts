import { Logger } from "../../../utils/logger";

export interface HandlerConfig<T> {
  name: string;
  getKey: (obj: T) => string;
  generateDrop: (obj: T) => string;
  generateCreate: (obj: T) => string;
  needsUpdate: (desired: T, current: T) => boolean;
  shouldManage?: (obj: T) => boolean;
  generateUpdate?: (desired: T) => string;
  getLogName?: (obj: T) => string;
}

export function generateStatements<T>(
  desired: T[],
  current: T[],
  config: HandlerConfig<T>
): string[] {
  const statements: string[] = [];
  const currentMap = new Map(current.map(obj => [config.getKey(obj), obj]));
  const desiredKeys = new Set(desired.map(obj => config.getKey(obj)));
  const getLogName = config.getLogName ?? config.getKey;

  for (const curr of current) {
    const shouldManage = config.shouldManage?.(curr) ?? true;
    if (!desiredKeys.has(config.getKey(curr)) && shouldManage) {
      statements.push(config.generateDrop(curr));
      Logger.info(`Dropping ${config.name} '${getLogName(curr)}'`);
    }
  }

  for (const des of desired) {
    const key = config.getKey(des);
    const curr = currentMap.get(key);
    const shouldManage = config.shouldManage?.(curr ?? des) ?? true;

    if (!shouldManage) {
      Logger.info(`${config.name} '${getLogName(des)}' is owned by a table column, skipping`);
      continue;
    }

    if (!curr) {
      statements.push(config.generateCreate(des));
      Logger.info(`Creating ${config.name} '${getLogName(des)}'`);
    } else if (config.needsUpdate(des, curr)) {
      if (config.generateUpdate) {
        statements.push(config.generateUpdate(des));
      } else {
        statements.push(config.generateDrop(curr));
        statements.push(config.generateCreate(des));
      }
      Logger.info(`Updating ${config.name} '${getLogName(des)}'`);
    } else {
      Logger.info(`${config.name} '${getLogName(des)}' is up to date, skipping`);
    }
  }

  return statements;
}
