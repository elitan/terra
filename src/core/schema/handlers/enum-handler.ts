import type { EnumType } from "../../../types/schema";
import { Logger } from "../../../utils/logger";
import { SQLBuilder } from "../../../utils/sql-builder";
import {
  generateCreateTypeSQL,
  generateDropTypeSQL,
  quotePostgresStringLiteral,
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
    preTransactional: string[];
  } {
    const transactional: string[] = [];
    const preTransactional: string[] = [];
    const currentEnumMap = new Map(currentEnums.map((enumType) => [getEnumKey(enumType), enumType]));

    for (const desiredEnum of desiredEnums) {
      this.validateDesiredEnum(desiredEnum);
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
          preTransactional.push(...modificationStatements);
        }
      }
    }

    return { transactional, preTransactional };
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
    const currentValues = new Set(currentEnum.values);
    const desiredValues = new Set(desiredEnum.values);

    const valuesToRemove = currentEnum.values.filter(function findRemoved(value) {
      return !desiredValues.has(value);
    });
    const retainedValues = desiredEnum.values.filter(function findRetained(value) {
      return currentValues.has(value);
    });
    const currentRetainedValues = currentEnum.values.filter(function findCurrentRetained(
      value
    ) {
      return desiredValues.has(value);
    });
    const hasRelativeOrderChange = retainedValues.some(function compareOrder(
      value,
      index
    ) {
      return currentRetainedValues[index] !== value;
    });

    if (valuesToRemove.length > 0 || hasRelativeOrderChange) {
      const changeDescription = [];
      if (valuesToRemove.length > 0) {
        changeDescription.push(`removing values [${valuesToRemove.join(', ')}]`);
      }
      if (hasRelativeOrderChange) {
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

    for (let index = 0; index < desiredEnum.values.length; index += 1) {
      const value = desiredEnum.values[index];
      if (value === undefined) {
        continue;
      }
      if (currentValues.has(value)) {
        continue;
      }
      const nextValue = desiredEnum.values
        .slice(index + 1)
        .find(function findExisting(candidate) {
          return currentValues.has(candidate);
        });
      statements.push(this.generateAddValueStatement(desiredEnum, value, nextValue));
      currentValues.add(value);
      Logger.info(`Adding value '${value}' to ENUM type '${desiredEnum.name}'`);
    }

    return statements;
  }

  private validateDesiredEnum(enumType: EnumType): void {
    const duplicateValues = getDuplicateValues(enumType.values);
    if (duplicateValues.length > 0) {
      throw new Error(
        `ENUM type '${enumType.name}' has duplicate values in desired schema: [${duplicateValues.join(", ")}]`
      );
    }
  }

  private generateAddValueStatement(
    enumType: EnumType,
    value: string,
    before: string | undefined
  ): string {
    const builder = new SQLBuilder().p("ALTER TYPE");
    if (enumType.schema) {
      builder.ident(enumType.schema).rewriteLastChar('.');
    }
    builder.ident(enumType.name).p("ADD VALUE").p(quotePostgresStringLiteral(value));
    if (before !== undefined) {
      builder.p("BEFORE").p(quotePostgresStringLiteral(before));
    }
    return builder.rewriteLastChar(";").build();
  }
}
