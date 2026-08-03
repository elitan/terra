export function parseStorageParameterOptions(
  options: any[] | undefined
): Record<string, string> | undefined {
  if (!options || options.length === 0) return undefined;

  const parameters: Record<string, string> = {};
  for (const option of options) {
    const element = option?.DefElem;
    if (!element?.defname) continue;

    const namespace = element.defnamespace
      ? `${element.defnamespace}.`
      : "";
    const value = extractStorageParameterValue(element.arg);
    if (value !== undefined) {
      parameters[`${namespace}${element.defname}`] = value;
    }
  }

  return Object.keys(parameters).length > 0 ? parameters : undefined;
}

export function renderStorageParameterAssignments(
  parameters: Record<string, string>
): string {
  return Object.entries(parameters)
    .sort(function sortParameters([first], [second]) {
      return first.localeCompare(second);
    })
    .map(function renderParameter([name, value]) {
      return `${name}=${value}`;
    })
    .join(", ");
}

function extractStorageParameterValue(arg: any): string | undefined {
  if (!arg) return "true";
  if (arg.Integer) return String(arg.Integer.ival);
  if (arg.Float) return String(arg.Float.fval);
  if (arg.String) return String(arg.String.sval);
  if (arg.Boolean) return String(arg.Boolean.boolval);
  if (arg.TypeName?.names?.[0]?.String) {
    return String(arg.TypeName.names[0].String.sval);
  }
  if (arg.A_Const?.String) return String(arg.A_Const.String.sval);
  if (arg.A_Const?.Integer) return String(arg.A_Const.Integer.ival);
  if (arg.A_Const?.Float) return String(arg.A_Const.Float.fval);
  return undefined;
}
