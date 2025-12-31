import type { EnumType } from "../../../types/schema";
import { Logger } from "../../../utils/logger";
import { SQLBuilder } from "../../../utils/sql-builder";
import {
  generateCreateTypeSQL,
  generateDropTypeSQL,
} from "../../../utils/sql";

export class EnumHandler {
  generateStatements(desiredEnums: EnumType[], currentEnums: EnumType[]): {
    transactional: string[];
    concurrent: string[];
  } {
    const transactional: string[] = [];
    const concurrent: string[] = [];
    const currentEnumMap = new Map(currentEnums.map(e => [e.name, e]));

    for (const desiredEnum of desiredEnums) {
      const currentEnum = currentEnumMap.get(desiredEnum.name);

      if (!currentEnum) {
        transactional.push(generateCreateTypeSQL(desiredEnum));
      } else {
        const currentValues = currentEnum.values;
        const desiredValues = desiredEnum.values;

        if (JSON.stringify(currentValues) === JSON.stringify(desiredValues)) {
          Logger.info(`ENUM type '${desiredEnum.name}' already exists with matching values, skipping creation`);
        } else {
          const modificationStatements = this.generateModificationStatements(desiredEnum, currentEnum);
          concurrent.push(...modificationStatements);
        }
      }
    }

    return { transactional, concurrent };
  }

  generateRemovalStatements(
    desiredEnums: EnumType[],
    currentEnums: EnumType[]
  ): string[] {
    const statements: string[] = [];
    const desiredEnumNames = new Set(desiredEnums.map(e => e.name));

    for (const currentEnum of currentEnums) {
      if (!desiredEnumNames.has(currentEnum.name)) {
        statements.push(generateDropTypeSQL(currentEnum.name, currentEnum.schema));
        Logger.info(`Dropping ENUM type '${currentEnum.name}'`);
      }
    }

    return statements;
  }

  private generateModificationStatements(desiredEnum: EnumType, currentEnum: EnumType): string[] {
    const statements: string[] = [];
    const currentValues = new Set(currentEnum.values);
    const desiredValues = new Set(desiredEnum.values);

    const valuesToAdd = desiredEnum.values.filter(value => !currentValues.has(value));
    const valuesToRemove = currentEnum.values.filter(value => !desiredValues.has(value));
    const valuesIdentical = JSON.stringify(currentEnum.values) === JSON.stringify(desiredEnum.values);
    const isOnlyAppending = valuesToRemove.length === 0 && valuesToAdd.length > 0 &&
                           currentEnum.values.every((value, index) => desiredEnum.values[index] === value);

    if (valuesIdentical) {
      Logger.info(`ENUM type '${desiredEnum.name}' values already match, no changes needed`);
    } else if (isOnlyAppending) {
      for (const value of valuesToAdd) {
        const builder = new SQLBuilder().p("ALTER TYPE");
        if (desiredEnum.schema) {
          builder.ident(desiredEnum.schema).rewriteLastChar('.');
        }
        builder.ident(desiredEnum.name);
        builder.p(`ADD VALUE '${value}';`);
        statements.push(builder.build());
        Logger.info(`Adding value '${value}' to ENUM type '${desiredEnum.name}'`);
      }
    } else {
      const changeDescription = [];
      if (valuesToRemove.length > 0) {
        changeDescription.push(`removing values [${valuesToRemove.join(', ')}]`);
      }
      if (valuesToRemove.length === 0 && valuesToAdd.length === 0) {
        changeDescription.push(`reordering values`);
      }

      throw new Error(
        `ENUM type '${desiredEnum.name}' modification requires manual intervention. ` +
        `Cannot safely perform: ${changeDescription.join(' and ')}. ` +
        `Current values: [${currentEnum.values.join(', ')}], ` +
        `Desired values: [${desiredEnum.values.join(', ')}]. ` +
        `Removing ENUM values or changing their order can cause data loss and is not supported by Terra. ` +
        `Please handle this migration manually or create a new ENUM type with a different name.`
      );
    }

    return statements;
  }
}
