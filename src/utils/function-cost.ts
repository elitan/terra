export function getDefaultFunctionCost(language: string): number {
  const normalizedLanguage = language.trim().toLowerCase();
  return normalizedLanguage === "c" || normalizedLanguage === "internal"
    ? 1
    : 100;
}
