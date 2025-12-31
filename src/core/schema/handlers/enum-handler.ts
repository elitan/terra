import { Client } from "pg";
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

  async generateRemovalStatements(
    desiredEnums: EnumType[],
    currentEnums: EnumType[],
    client: Client,
    schemas: string[]
  ): Promise<string[]> {
    const statements: string[] = [];
    const desiredEnumNames = new Set(desiredEnums.map(e => e.name));

    for (const currentEnum of currentEnums) {
      if (!desiredEnumNames.has(currentEnum.name)) {
        const isUsed = await this.isTypeUsed(currentEnum.name, client, schemas);

        if (!isUsed) {
          statements.push(generateDropTypeSQL(currentEnum.name, currentEnum.schema));
          Logger.info(`Dropping unused ENUM type '${currentEnum.name}'`);
        } else {
          Logger.warning(
            `ENUM type '${currentEnum.name}' is not in schema but is still referenced by table columns. ` +
            `Cannot auto-drop. Remove column references first.`
          );
        }
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

  private async isTypeUsed(enumName: string, client: Client, schemas: string[]): Promise<boolean> {
    const result = await client.query(`
      SELECT COUNT(*) as usage_count
      FROM information_schema.columns
      WHERE udt_name = $1 AND table_schema = ANY($2::text[])
    `, [enumName, schemas]);

    return parseInt(result.rows[0].usage_count) > 0;
  }
}
