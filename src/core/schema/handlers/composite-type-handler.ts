import type { CompositeType } from "../../../types/schema";
import {
  generateCreateCompositeTypeSQL,
  generateDropTypeSQL,
  normalizeType,
} from "../../../utils/sql";

function getCompositeTypeKey(compositeType: CompositeType): string {
  return `${compositeType.schema || "public"}.${compositeType.name}`;
}

function attributesAreEqual(
  desiredAttributes: CompositeType["attributes"],
  currentAttributes: CompositeType["attributes"]
): boolean {
  if (desiredAttributes.length !== currentAttributes.length) {
    return false;
  }

  for (let index = 0; index < desiredAttributes.length; index++) {
    const desired = desiredAttributes[index];
    const current = currentAttributes[index];

    if (!desired || !current) {
      return false;
    }

    if (desired.name !== current.name) {
      return false;
    }

    if (normalizeType(desired.type) !== normalizeType(current.type)) {
      return false;
    }
  }

  return true;
}

export class CompositeTypeHandler {
  generateStatements(
    desiredCompositeTypes: CompositeType[],
    currentCompositeTypes: CompositeType[]
  ): {
    transactional: string[];
    concurrent: string[];
  } {
    const transactional: string[] = [];
    const currentCompositeTypeMap = new Map(
      currentCompositeTypes.map(function (compositeType) {
        return [getCompositeTypeKey(compositeType), compositeType];
      })
    );

    for (const desiredCompositeType of desiredCompositeTypes) {
      const currentCompositeType = currentCompositeTypeMap.get(
        getCompositeTypeKey(desiredCompositeType)
      );

      if (!currentCompositeType) {
        transactional.push(generateCreateCompositeTypeSQL(desiredCompositeType));
        continue;
      }

      if (
        !attributesAreEqual(
          desiredCompositeType.attributes,
          currentCompositeType.attributes
        )
      ) {
        throw new Error(
          `Composite type '${desiredCompositeType.name}' modification requires manual intervention`
        );
      }
    }

    return { transactional, concurrent: [] };
  }

  generateRemovalStatements(
    desiredCompositeTypes: CompositeType[],
    currentCompositeTypes: CompositeType[]
  ): string[] {
    const desiredCompositeTypeNames = new Set(
      desiredCompositeTypes.map(function (compositeType) {
        return getCompositeTypeKey(compositeType);
      })
    );

    return currentCompositeTypes
      .filter(function (compositeType) {
        return !desiredCompositeTypeNames.has(getCompositeTypeKey(compositeType));
      })
      .map(function (compositeType) {
        return generateDropTypeSQL(compositeType.name, compositeType.schema);
      });
  }
}
