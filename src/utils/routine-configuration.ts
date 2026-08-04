const LIST_QUOTED_CONFIGURATION_NAMES = new Set([
  "local_preload_libraries",
  "oauth_validator_libraries",
  "search_path",
  "session_preload_libraries",
  "shared_preload_libraries",
  "temp_tablespaces",
  "unix_socket_directories",
]);

function isListQuotedConfiguration(name: string): boolean {
  return LIST_QUOTED_CONFIGURATION_NAMES.has(name.toLowerCase());
}

function quoteListElement(value: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

export function normalizeRoutineConfigurationValue(
  name: string,
  values: string[]
): string {
  if (!isListQuotedConfiguration(name)) {
    return values.join(", ");
  }
  return values.map(quoteListElement).join(", ");
}

function splitListConfiguration(value: string): string[] {
  const items: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === '"') {
      if (inQuotes && value[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (character === "," && !inQuotes) {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  items.push(current.trim());
  return items;
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function renderRoutineConfigurationValue(
  name: string,
  value: string
): string {
  if (!isListQuotedConfiguration(name)) {
    return quoteSqlLiteral(value);
  }
  return splitListConfiguration(value).map(quoteSqlLiteral).join(", ");
}
