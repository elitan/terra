import type { EnumType } from "../../../types/schema";
import { Logger } from "../../../utils/logger";
import { SQLBuilder } from "../../../utils/sql-builder";
import {
  generateCreateTypeSQL,
  generateDropTypeSQL,
} from "../../../utils/sql";

function getEnumKey(enumType: EnumType): string {
  return `${enumType.schema || "public"}.${enumType.name}`;
}

function getDuplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }

  return Array.from(duplicates);
}

export class EnumHandler {
  generateStatements(desiredEnums: EnumType[], currentEnums: EnumType[]): {
    transactional: string[];
    concurrent: string[];
  } {
    const transactional: string[] = [];
    const concurrent: string[] = [];
    const currentEnumMap = new Map(currentEnums.map((enumType) => [getEnumKey(enumType), enumType]));

    for (const desiredEnum of desiredEnums) {
      const currentEnum = currentEnumMap.get(getEnumKey(desiredEnum));

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
    const desiredEnumNames = new Set(desiredEnums.map((enumType) => getEnumKey(enumType)));

    for (const currentEnum of currentEnums) {
      if (!desiredEnumNames.has(getEnumKey(currentEnum))) {
        statements.push(generateDropTypeSQL(currentEnum.name, currentEnum.schema));
        Logger.info(`Dropping ENUM type '${currentEnum.name}'`);
      }
    }

    return statements;
  }

  private generateModificationStatements(desiredEnum: EnumType, currentEnum: EnumType): string[] {
    const statements: string[] = [];
    const duplicateValues = getDuplicateValues(desiredEnum.values);
    if (duplicateValues.length > 0) {
      throw new Error(
        `ENUM type '${desiredEnum.name}' has duplicate values in desired schema: [${duplicateValues.join(", ")}]`
      );
    }

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
      const hasRelativeOrderChange = currentEnum.values.some((value, index) => {
        const desiredIndex = desiredEnum.values.indexOf(value);
        return desiredIndex !== -1 && desiredIndex !== index;
      });
      if (valuesToRemove.length > 0) {
        changeDescription.push(`removing values [${valuesToRemove.join(', ')}]`);
      }
      if (hasRelativeOrderChange) {
        changeDescription.push(`reordering values`);
      }
      if (changeDescription.length === 0) {
        changeDescription.push(`unsupported enum transition`);
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
