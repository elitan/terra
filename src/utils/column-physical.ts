import type { Column, ColumnStorage } from "../types/schema";

export interface ColumnPhysicalChanges {
  storage?: ColumnStorage | "DEFAULT";
  compression?: string;
}

const STORAGE_BY_CATALOG_CODE: Record<string, ColumnStorage> = {
  p: "PLAIN",
  e: "EXTERNAL",
  x: "EXTENDED",
  m: "MAIN",
};

const COMPRESSION_BY_CATALOG_CODE: Record<string, string> = {
  p: "pglz",
  l: "lz4",
};

export function normalizeColumnStorage(
  storage: string | undefined
): ColumnStorage | undefined {
  if (!storage || storage.toUpperCase() === "DEFAULT") return undefined;
  const normalized = storage.toUpperCase();
  if (
    normalized === "PLAIN" ||
    normalized === "EXTERNAL" ||
    normalized === "EXTENDED" ||
    normalized === "MAIN"
  ) {
    return normalized;
  }
  return undefined;
}

export function normalizeColumnCompression(
  compression: string | undefined
): string | undefined {
  if (!compression || compression.toLowerCase() === "default") return undefined;
  return compression.toLowerCase();
}

export function columnStorageFromCatalog(
  storageCode: unknown
): ColumnStorage | undefined {
  if (typeof storageCode !== "string") return undefined;
  return STORAGE_BY_CATALOG_CODE[storageCode];
}

export function columnCompressionFromCatalog(
  compressionCode: unknown
): string | undefined {
  if (typeof compressionCode !== "string" || compressionCode.length === 0) {
    return undefined;
  }
  return COMPRESSION_BY_CATALOG_CODE[compressionCode] ?? compressionCode;
}

export function columnStorageIsDifferent(
  desired: string | undefined,
  current: string | undefined,
  currentDefault: string | undefined
): boolean {
  const desiredStorage = normalizeColumnStorage(desired);
  const currentStorage = normalizeColumnStorage(current);
  const defaultStorage = normalizeColumnStorage(currentDefault);

  if (!desiredStorage) return currentStorage !== undefined;
  if (currentStorage) return desiredStorage !== currentStorage;
  return desiredStorage !== defaultStorage;
}

export function getColumnPhysicalChanges(
  desired: Column,
  current?: Column,
  typeIsChanging: boolean = false
): ColumnPhysicalChanges {
  const desiredStorage = normalizeColumnStorage(desired.storage);
  const storageIsChanging = current
    ? columnStorageIsDifferent(
        desired.storage,
        current.storage,
        current.storageDefault
      )
    : desiredStorage !== undefined;

  let storage: ColumnPhysicalChanges["storage"];
  if (typeIsChanging) {
    storage = desiredStorage;
  } else if (storageIsChanging) {
    storage = desiredStorage ?? current?.storageDefault ?? "DEFAULT";
  }

  const desiredCompression = normalizeColumnCompression(desired.compression);
  const currentCompression = normalizeColumnCompression(current?.compression);
  let compression: string | undefined;
  if (typeIsChanging) {
    compression = desiredCompression;
  } else if (desiredCompression !== currentCompression) {
    compression = desiredCompression ?? "default";
  }

  return { storage, compression };
}
