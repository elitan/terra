import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "pg";
import { DatabaseInspector } from "../core/schema/inspector";
import { cleanDatabase } from "./utils";

type VersionTarget = {
  key: string;
  url?: string;
};

type SnapshotMap = Record<string, unknown>;

const SNAPSHOT_PATH =
  "src/test/fixtures/inspector-version-snapshots/postgres-14-17-core.json";

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeMaybeText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return normalizeSpace(value);
}

function normalizeObject<T extends Record<string, unknown>>(input: T): T {
  const keys = Object.keys(input).sort();
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    output[key] = input[key];
  }
  return output as T;
}

function toStringOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value);
}

function getVersionTargets(): VersionTarget[] {
  return [
    { key: "pg14", url: process.env.DATABASE_URL_PG14 },
    { key: "pg15", url: process.env.DATABASE_URL_PG15 },
    { key: "pg16", url: process.env.DATABASE_URL_PG16 },
    { key: "pg17", url: process.env.DATABASE_URL_PG17 },
  ];
}

function isConnectionUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message === "connection unavailable";
}

async function connectIfAvailable(connectionString: string): Promise<Client | null> {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 1500,
  });
  try {
    await client.connect();
    return client;
  } catch {
    try {
      await client.end();
    } catch {
    }
    return null;
  }
}

async function prepareSchema(client: Client): Promise<void> {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS tenant_a;

    CREATE TYPE public.user_status AS ENUM ('active', 'disabled');

    CREATE TABLE public.users (
      id integer GENERATED ALWAYS AS IDENTITY,
      email text NOT NULL,
      display_name text COLLATE "C",
      status public.user_status NOT NULL DEFAULT 'active',
      score integer NOT NULL DEFAULT 0,
      created_at timestamp without time zone DEFAULT now(),
      CONSTRAINT users_pkey PRIMARY KEY (id),
      CONSTRAINT users_email_unique UNIQUE (email) DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT users_score_check CHECK (score >= 0) NO INHERIT
    ) WITH (fillfactor=80, toast.autovacuum_enabled=false);

    CREATE TABLE tenant_a.users (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      email text NOT NULL
    );

    ALTER TABLE public.users
      ALTER COLUMN display_name SET STORAGE EXTERNAL,
      ALTER COLUMN display_name SET COMPRESSION pglz;

    ALTER TABLE public.users
      ADD CONSTRAINT users_created_at_check
      CHECK (created_at IS NOT NULL) NOT VALID;

    CREATE UNLOGGED TABLE public.audit_log (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id integer NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      CONSTRAINT audit_log_user_fk
        FOREIGN KEY (user_id)
        REFERENCES public.users(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE INDEX users_email_pattern_idx
      ON public.users USING btree (email text_pattern_ops);

    CREATE INDEX users_score_partial_idx
      ON public.users USING btree (score DESC)
      WHERE score > 0;

    CREATE INDEX users_expr_idx
      ON public.users USING btree ((lower(email)));

    CREATE VIEW public.active_users AS
      SELECT id, email
      FROM public.users
      WHERE status = 'active'::public.user_status;

    CREATE MATERIALIZED VIEW public.active_user_ids AS
      SELECT id
      FROM public.users;

    CREATE MATERIALIZED VIEW tenant_a.pending_user_ids AS
      SELECT id
      FROM tenant_a.users
      WITH NO DATA;

    CREATE FUNCTION public.touch_user(p_id integer)
      RETURNS integer
      LANGUAGE sql
      AS $$ SELECT p_id $$;

    CREATE PROCEDURE public.touch_user_proc(p_id integer)
      LANGUAGE sql
      AS $$ SELECT p_id $$;

    CREATE FUNCTION public.users_guard_fn()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        NEW.score := COALESCE(NEW.score, 0);
        RETURN NEW;
      END
      $$;

    CREATE TRIGGER users_guard
      BEFORE INSERT OR UPDATE
      ON public.users
      FOR EACH ROW
      WHEN ((NEW.score >= 0))
      EXECUTE FUNCTION public.users_guard_fn('arg1', '2');

    CREATE SEQUENCE public.audit_seq
      AS integer
      INCREMENT BY 2
      MINVALUE 1
      MAXVALUE 200
      START WITH 10
      CACHE 5
      CYCLE;

    COMMENT ON SCHEMA public IS 'public schema';
    COMMENT ON TABLE public.users IS 'users table';
    COMMENT ON COLUMN public.users.email IS 'email column';
    COMMENT ON VIEW public.active_users IS 'active users';
    COMMENT ON INDEX public.users_email_pattern_idx IS 'users email pattern';
  `);
}

function normalizeSnapshot(input: any): unknown {
  const tables = (input.tables || []).map(function mapTable(table: any) {
    return {
      schema: table.schema,
      name: table.name,
      unlogged: table.unlogged,
      accessMethod: table.accessMethod,
      inherits: table.inherits,
      storageParameters: table.storageParameters
        ? normalizeObject(table.storageParameters)
        : undefined,
      tablespace: table.tablespace,
      columns: (table.columns || []).map(function mapColumn(column: any) {
        return {
          name: column.name,
          type: normalizeSpace(String(column.type)),
          nullable: Boolean(column.nullable),
          default: normalizeMaybeText(column.default),
          collation: column.collation
            ? {
                schema: column.collation.schema,
                name: column.collation.name,
              }
            : undefined,
          storage: column.storage,
          compression: column.compression,
          identity: column.identity
            ? {
                generation: column.identity.generation,
                sequenceName: column.identity.sequenceName
                  ? {
                      schema: column.identity.sequenceName.schema,
                      name: column.identity.sequenceName.name,
                    }
                  : undefined,
                start: toStringOrUndefined(column.identity.start),
                increment: toStringOrUndefined(column.identity.increment),
                minValue: toStringOrUndefined(column.identity.minValue),
                maxValue: toStringOrUndefined(column.identity.maxValue),
                cache: toStringOrUndefined(column.identity.cache),
                cycle: Boolean(column.identity.cycle),
              }
            : undefined,
          generated: column.generated
            ? {
                always: Boolean(column.generated.always),
                expression: normalizeSpace(String(column.generated.expression || "")),
                stored: Boolean(column.generated.stored),
              }
            : undefined,
        };
      }),
      primaryKey: table.primaryKey
        ? {
            name: table.primaryKey.name,
            columns: [...(table.primaryKey.columns || [])],
            include: table.primaryKey.include
              ? [...table.primaryKey.include]
              : undefined,
            storageParameters: table.primaryKey.storageParameters,
            tablespace: table.primaryKey.tablespace,
            deferrable: table.primaryKey.deferrable,
            initiallyDeferred: table.primaryKey.initiallyDeferred,
          }
        : undefined,
      foreignKeys: (table.foreignKeys || []).map(function mapForeignKey(foreignKey: any) {
        return {
          name: foreignKey.name,
          columns: [...(foreignKey.columns || [])],
          referencedTable: foreignKey.referencedTable,
          referencedColumns: [...(foreignKey.referencedColumns || [])],
          matchType: foreignKey.matchType,
          onDelete: foreignKey.onDelete,
          onDeleteColumns: foreignKey.onDeleteColumns,
          onUpdate: foreignKey.onUpdate,
          deferrable: foreignKey.deferrable,
          initiallyDeferred: foreignKey.initiallyDeferred,
          notValid: foreignKey.notValid,
        };
      }),
      checkConstraints: (table.checkConstraints || []).map(function mapCheck(check: any) {
        return {
          name: check.name,
          expression: normalizeSpace(String(check.expression || "")),
          noInherit: check.noInherit,
          notValid: check.notValid,
        };
      }),
      uniqueConstraints: (table.uniqueConstraints || []).map(function mapUnique(unique: any) {
        return {
          name: unique.name,
          columns: [...(unique.columns || [])],
          include: unique.include ? [...unique.include] : undefined,
          storageParameters: unique.storageParameters,
          tablespace: unique.tablespace,
          nullsNotDistinct: unique.nullsNotDistinct,
          deferrable: unique.deferrable,
          initiallyDeferred: unique.initiallyDeferred,
        };
      }),
      exclusionConstraints: table.exclusionConstraints?.map(
        function mapExclusion(exclusion: any) {
          return {
            name: exclusion.name,
            method: exclusion.method,
            elements: exclusion.elements,
            include: exclusion.include,
            storageParameters: exclusion.storageParameters
              ? normalizeObject(exclusion.storageParameters)
              : undefined,
            tablespace: exclusion.tablespace,
            where: normalizeMaybeText(exclusion.where),
            deferrable: exclusion.deferrable,
            initiallyDeferred: exclusion.initiallyDeferred,
          };
        }
      ),
      indexes: (table.indexes || []).map(function mapIndex(index: any) {
        return {
          name: index.name,
          type: index.type,
          unique: Boolean(index.unique),
          nullsNotDistinct: index.nullsNotDistinct,
          columns: [...(index.columns || [])],
          include: index.include ? [...index.include] : undefined,
          collations: index.collations ? [...index.collations] : undefined,
          sortOrders: index.sortOrders ? [...index.sortOrders] : undefined,
          nullsOrders: index.nullsOrders ? [...index.nullsOrders] : undefined,
          where: normalizeMaybeText(index.where),
          expression: normalizeMaybeText(index.expression),
          opclasses: index.opclasses ? normalizeObject(index.opclasses) : undefined,
          storageParameters: index.storageParameters
            ? normalizeObject(index.storageParameters)
            : undefined,
          tablespace: index.tablespace,
        };
      }),
    };
  });

  const views = (input.views || []).map(function mapView(view: any) {
    return {
      schema: view.schema,
      name: view.name,
      materialized: Boolean(view.materialized),
      columnNames: view.columnNames
        ? [...view.columnNames]
        : undefined,
      populated: view.populated,
      accessMethod: view.accessMethod,
      storageParameters: view.storageParameters
        ? normalizeObject(view.storageParameters)
        : undefined,
      tablespace: view.tablespace,
      definition: normalizeSpace(String(view.definition || "")),
      checkOption: view.checkOption,
      securityBarrier: view.securityBarrier,
      indexes: (view.indexes || []).map(function mapViewIndex(index: any) {
        return {
          name: index.name,
          type: index.type,
          columns: [...(index.columns || [])],
        };
      }),
    };
  });

  const enumTypes = (input.enumTypes || []).map(function mapEnum(enumType: any) {
    return {
      schema: enumType.schema,
      name: enumType.name,
      values: [...(enumType.values || [])],
    };
  });

  const functions = (input.functions || []).map(function mapFunction(fn: any) {
    return {
      schema: fn.schema,
      name: fn.name,
      parameters: (fn.parameters || []).map(function mapFunctionParam(parameter: any) {
        return {
          name: parameter.name,
          mode: parameter.mode,
          type: normalizeSpace(String(parameter.type || "")),
          default: normalizeMaybeText(parameter.default),
        };
      }),
      returnType: normalizeSpace(String(fn.returnType || "")),
      language: fn.language,
      body: normalizeSpace(String(fn.body || "")),
      volatility: fn.volatility,
      parallel: fn.parallel,
      securityDefiner: fn.securityDefiner,
      strict: fn.strict,
      cost: fn.cost,
      rows: fn.rows,
    };
  });

  const procedures = (input.procedures || []).map(function mapProcedure(procedure: any) {
    return {
      schema: procedure.schema,
      name: procedure.name,
      parameters: (procedure.parameters || []).map(function mapProcedureParam(parameter: any) {
        return {
          name: parameter.name,
          mode: parameter.mode,
          type: normalizeSpace(String(parameter.type || "")),
          default: normalizeMaybeText(parameter.default),
        };
      }),
      language: procedure.language,
      body: normalizeSpace(String(procedure.body || "")),
      securityDefiner: procedure.securityDefiner,
    };
  });

  const triggers = (input.triggers || []).map(function mapTrigger(trigger: any) {
    return {
      schema: trigger.schema,
      name: trigger.name,
      tableName: trigger.tableName,
      timing: trigger.timing,
      events: [...(trigger.events || [])],
      forEach: trigger.forEach,
      when: normalizeMaybeText(trigger.when),
      functionSchema: trigger.functionSchema,
      functionName: trigger.functionName,
      functionArgs: trigger.functionArgs ? [...trigger.functionArgs] : undefined,
    };
  });

  const sequences = (input.sequences || []).map(function mapSequence(sequence: any) {
    return {
      schema: sequence.schema,
      name: sequence.name,
      dataType: sequence.dataType,
      increment: toStringOrUndefined(sequence.increment),
      minValue: toStringOrUndefined(sequence.minValue),
      maxValue: toStringOrUndefined(sequence.maxValue),
      start: toStringOrUndefined(sequence.start),
      cache: toStringOrUndefined(sequence.cache),
      cycle: sequence.cycle,
      ownedBy: sequence.ownedBy,
    };
  });

  const extensions = (input.extensions || []).map(function mapExtension(extension: any) {
    return {
      schema: extension.schema,
      name: extension.name,
      version: extension.version,
    };
  });

  const schemas = (input.schemas || []).map(function mapSchema(schema: any) {
    return {
      name: schema.name,
    };
  });

  const comments = (input.comments || []).map(function mapComment(comment: any) {
    return {
      objectType: comment.objectType,
      objectName: comment.objectName,
      schemaName: comment.schemaName,
      columnName: comment.columnName,
      comment: comment.comment,
    };
  });

  return {
    tables,
    views,
    enumTypes,
    functions,
    procedures,
    triggers,
    sequences,
    extensions,
    schemas,
    comments,
  };
}

function sortSnapshot(input: any): unknown {
  input.tables.sort(function sortTables(a: any, b: any) {
    return `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`);
  });
  for (const table of input.tables) {
    table.columns.sort(function sortColumns(a: any, b: any) {
      return a.name.localeCompare(b.name);
    });
    table.foreignKeys.sort(function sortForeignKeys(a: any, b: any) {
      return (a.name || "").localeCompare(b.name || "");
    });
    table.checkConstraints.sort(function sortChecks(a: any, b: any) {
      return (a.name || "").localeCompare(b.name || "");
    });
    table.uniqueConstraints.sort(function sortUniques(a: any, b: any) {
      return (a.name || "").localeCompare(b.name || "");
    });
    table.exclusionConstraints?.sort(function sortExclusions(a: any, b: any) {
      return (a.name || "").localeCompare(b.name || "");
    });
    table.indexes.sort(function sortIndexes(a: any, b: any) {
      return a.name.localeCompare(b.name);
    });
  }

  input.views.sort(function sortViews(a: any, b: any) {
    return `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`);
  });
  input.enumTypes.sort(function sortEnums(a: any, b: any) {
    return `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`);
  });
  input.functions.sort(function sortFunctions(a: any, b: any) {
    return `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`);
  });
  input.procedures.sort(function sortProcedures(a: any, b: any) {
    return `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`);
  });
  input.triggers.sort(function sortTriggers(a: any, b: any) {
    return `${a.schema}.${a.tableName}.${a.name}`.localeCompare(
      `${b.schema}.${b.tableName}.${b.name}`
    );
  });
  input.sequences.sort(function sortSequences(a: any, b: any) {
    return `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`);
  });
  input.extensions.sort(function sortExtensions(a: any, b: any) {
    return `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`);
  });
  input.schemas.sort(function sortSchemas(a: any, b: any) {
    return a.name.localeCompare(b.name);
  });
  input.comments.sort(function sortComments(a: any, b: any) {
    const left = `${a.objectType}.${a.schemaName || ""}.${a.objectName}.${a.columnName || ""}`;
    const right = `${b.objectType}.${b.schemaName || ""}.${b.objectName}.${b.columnName || ""}`;
    return left.localeCompare(right);
  });

  return input;
}

function normalizeViewDefinitionForParity(definition: string): string {
  return definition.replace(/(?<!:)\b[a-z_][a-z0-9_]*\./g, "");
}

function normalizeSnapshotForParity(input: any): unknown {
  const clone = JSON.parse(JSON.stringify(input));
  if (!Array.isArray(clone.views)) {
    return clone;
  }
  clone.views = clone.views.map(function mapView(view: any) {
    return {
      ...view,
      definition: typeof view.definition === "string"
        ? normalizeViewDefinitionForParity(view.definition)
        : view.definition,
    };
  });
  return clone;
}

async function captureSnapshot(connectionString: string): Promise<unknown> {
  const client = await connectIfAvailable(connectionString);
  if (!client) {
    throw new Error("connection unavailable");
  }
  try {
    await cleanDatabase(client, ["public", "tenant_a"]);
    await prepareSchema(client);
    const inspector = new DatabaseInspector();
    const complete = await inspector.getCompleteSchema(client, ["public", "tenant_a"]);
    const normalized = normalizeSnapshot(complete);
    return sortSnapshot(normalized as any);
  } finally {
    await cleanDatabase(client, ["public", "tenant_a"]);
    await client.end();
  }
}

function readExpectedSnapshot(): SnapshotMap {
  const content = readFileSync(SNAPSHOT_PATH, "utf8");
  return JSON.parse(content);
}

function writeExpectedSnapshot(snapshot: SnapshotMap): void {
  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

const hasConfiguredVersionTargets = getVersionTargets().some(function hasConfiguredUrl(version) {
  return Boolean(version.url);
});

describe("inspector version snapshots", function () {
  test.skipIf(!hasConfiguredVersionTargets)(
    "captures deterministic normalized snapshots for configured postgres versions",
    async function () {
      const versions = getVersionTargets().filter(function hasUrl(version) {
        return Boolean(version.url);
      });

      const snapshots: SnapshotMap = {};
      for (const version of versions) {
        if (!version.url) {
          continue;
        }
        let snapshot: unknown;
        try {
          snapshot = await captureSnapshot(version.url);
        } catch (error) {
          if (isConnectionUnavailableError(error)) {
            continue;
          }
          throw error;
        }
        if (snapshot) {
          snapshots[version.key] = snapshot;
        }
      }

      expect(Object.keys(snapshots).length).toBeGreaterThan(0);

      if (process.env.TERRADB_WRITE_INSPECTOR_SNAPSHOTS === "1") {
        writeExpectedSnapshot(snapshots);
      } else {
        const expected = readExpectedSnapshot();
        const expectedSubset: SnapshotMap = {};
        for (const version of Object.keys(snapshots)) {
          expectedSubset[version] = expected[version];
        }

        expect(snapshots).toEqual(expectedSubset);
      }

      const keys = Object.keys(snapshots).sort();
      if (keys.length > 1) {
        const baseline = normalizeSnapshotForParity(snapshots[keys[0]]);
        for (const key of keys.slice(1)) {
          const current = normalizeSnapshotForParity(snapshots[key]);
          expect(current).toEqual(baseline);
        }
      }

      if (process.env.TERRADB_REQUIRE_FULL_PG_MATRIX === "1") {
        const required = getVersionTargets().map(function mapKey(version) {
          return version.key;
        });
        expect(Object.keys(snapshots).sort()).toEqual(required.sort());
      }
    },
    180000
  );
});
