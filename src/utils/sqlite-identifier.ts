export function normalizeSQLiteIdentifier(identifier: string): string {
  return identifier.replace(/[A-Z]/g, function (character) {
    return character.toLowerCase();
  });
}
