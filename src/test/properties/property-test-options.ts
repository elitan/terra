import fc from "fast-check";

function parseSeed(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return undefined;
  return parsed;
}

export function configurePropertyTests(): void {
  const seed = parseSeed(process.env.FC_SEED);
  const path = process.env.FC_PATH;

  const config: Parameters<typeof fc.configureGlobal>[0] = {};

  if (seed !== undefined) {
    config.seed = seed;
  }

  if (path) {
    config.path = path;
  }

  if (Object.keys(config).length > 0) {
    fc.configureGlobal(config);
  }
}
