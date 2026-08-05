import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { DatabaseService } from "../../core/database/client";
import { createTestClient, cleanDatabase, getTestDbConfig, createTestSchemaService } from "../utils";

async function cleanPublicQualificationTypes(client: Client): Promise<void> {
  await client.query(
    `DROP TABLE IF EXISTS public.qualification_partitioned CASCADE`
  );
  await client.query(`DROP TABLE IF EXISTS public.qualification_values CASCADE`);
  await client.query(`DROP TYPE IF EXISTS public.qualification_composite CASCADE`);
  await client.query(`DROP TYPE IF EXISTS public.qualification_range CASCADE`);
  await client.query(`DROP DOMAIN IF EXISTS public.qualification_domain CASCADE`);
  await client.query(`DROP TYPE IF EXISTS public.qualification_enum CASCADE`);
}

describe("ENUM Types", () => {
  let client: Client;
  let schemaService: SchemaService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanPublicQualificationTypes(client);
    await cleanDatabase(client, ['public', 'myapp', 'app', 'tenant_a']);
    const databaseService = new DatabaseService(getTestDbConfig());
    schemaService = createTestSchemaService();
  });

  afterEach(async () => {
    await cleanPublicQualificationTypes(client);
    await client?.end();
  });

  describe("Basic ENUM Type Creation", () => {
    it("should create a simple ENUM type", async () => {
      const schema = `
        CREATE TYPE status AS ENUM ('active', 'inactive', 'pending');
        
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status status NOT NULL
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify ENUM type exists
      const result = await client.query(`
        SELECT typname, typtype 
        FROM pg_type 
        WHERE typname = 'status' AND typtype = 'e'
      `);
      expect(result.rows).toHaveLength(1);

      // Verify table with ENUM column exists
      const tableResult = await client.query(`
        SELECT column_name, data_type, udt_name
        FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'status'
      `);
      expect(tableResult.rows[0].udt_name).toBe('status');
    });

    it("should create multiple ENUM types", async () => {
      const schema = `
        CREATE TYPE user_role AS ENUM ('admin', 'user', 'guest');
        CREATE TYPE order_status AS ENUM ('pending', 'processing', 'shipped', 'delivered');
        
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          role user_role NOT NULL DEFAULT 'user'
        );
        
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          status order_status NOT NULL DEFAULT 'pending'
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify both ENUM types exist
      const result = await client.query(`
        SELECT typname 
        FROM pg_type 
        WHERE typname IN ('user_role', 'order_status') AND typtype = 'e'
        ORDER BY typname
      `);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].typname).toBe('order_status');
      expect(result.rows[1].typname).toBe('user_role');
    });

    it("should handle ENUM values with special characters", async () => {
      const schema = `
        CREATE TYPE priority AS ENUM ('low', 'medium', 'high', 'critical!!!', 'super-urgent');
        
        CREATE TABLE tasks (
          id SERIAL PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          priority priority NOT NULL
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify ENUM type exists with correct values
      const result = await client.query(`
        SELECT enumlabel 
        FROM pg_enum 
        WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'priority')
        ORDER BY enumsortorder
      `);
      
      const values = result.rows.map(row => row.enumlabel);
      expect(values).toEqual(['low', 'medium', 'high', 'critical!!!', 'super-urgent']);
    });
  });

  describe("ENUM Value Usage", () => {
    it("should allow inserting valid ENUM values", async () => {
      const schema = `
        CREATE TYPE status AS ENUM ('active', 'inactive', 'pending');
        
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status status NOT NULL
        );
      `;

      await schemaService.apply(schema, ['public'], true);

			// Test that we can insert valid ENUM values
			await client.query(`INSERT INTO users (name, status) VALUES ('John', 'active')`);
			await client.query(`INSERT INTO users (name, status) VALUES ('Jane', 'inactive')`);
			await client.query(`INSERT INTO users (name, status) VALUES ('Bob', 'pending')`);

			const result = await client.query(`SELECT name, status FROM users ORDER BY name`);
			expect(result.rows).toHaveLength(3);
			expect(result.rows[0]).toEqual({ name: 'Bob', status: 'pending' });
			expect(result.rows[1]).toEqual({ name: 'Jane', status: 'inactive' });
			expect(result.rows[2]).toEqual({ name: 'John', status: 'active' });
    });

    it("should reject invalid ENUM values", async () => {
      const schema = `
        CREATE TYPE status AS ENUM ('active', 'inactive', 'pending');
        
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status status NOT NULL
        );
      `;

      await schemaService.apply(schema, ['public'], true);

			// Test that invalid ENUM values are rejected
			await expect(
				client.query(`INSERT INTO users (name, status) VALUES ('John', 'invalid')`)
			).rejects.toThrow();
    });

    it("should work with ENUM default values", async () => {
      const schema = `
        CREATE TYPE priority AS ENUM ('low', 'medium', 'high');
        
        CREATE TABLE tasks (
          id SERIAL PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          priority priority NOT NULL DEFAULT 'medium'
        );
      `;

      await schemaService.apply(schema, ['public'], true);

			// Insert without specifying priority (should use default)
			await client.query(`INSERT INTO tasks (title) VALUES ('Test task')`);

			const result = await client.query(`SELECT title, priority FROM tasks`);
			expect(result.rows[0]).toEqual({ title: 'Test task', priority: 'medium' });
    });
  });

  describe("ENUM Type Dependencies", () => {
    it("should create ENUM types before tables that use them", async () => {
      const schema = `
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          status order_status NOT NULL
        );
        
        CREATE TYPE order_status AS ENUM ('pending', 'shipped', 'delivered');
      `;

      // This should work because the dependency resolver should create ENUMs first
      await schemaService.apply(schema, ['public'], true);

      const result = await client.query(`
        SELECT typname 
        FROM pg_type 
        WHERE typname = 'order_status' AND typtype = 'e'
      `);
      expect(result.rows).toHaveLength(1);
    });

    it("should handle multiple tables using the same ENUM type", async () => {
      const schema = `
        CREATE TYPE status AS ENUM ('active', 'inactive');
        
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status status NOT NULL
        );
        
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status status NOT NULL
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify both tables use the same ENUM type
      const result = await client.query(`
        SELECT table_name, column_name, udt_name
        FROM information_schema.columns
        WHERE udt_name = 'status'
        ORDER BY table_name
      `);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].table_name).toBe('products');
      expect(result.rows[1].table_name).toBe('users');
    });
  });

  describe("ENUM Type Modifications", () => {
    it("should safely add ENUM values using ALTER TYPE ADD VALUE", async () => {
      const initialSchema = `
        CREATE TYPE status AS ENUM ('active', 'inactive');
        
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status status NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      const updatedSchema = `
        CREATE TYPE status AS ENUM ('active', 'inactive', 'pending');
        
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status status NOT NULL
        );
      `;

      await schemaService.apply(updatedSchema, ['public'], true);

      // Verify the new value was added
      const result = await client.query(`
        SELECT enumlabel 
        FROM pg_enum 
        WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'status')
        ORDER BY enumsortorder
      `);
      
      const values = result.rows.map(row => row.enumlabel);
      expect(values).toEqual(['active', 'inactive', 'pending']);
    });

    it("should reject ENUM value removal as unsafe", async () => {
      const initialSchema = `
        CREATE TYPE status AS ENUM ('active', 'inactive', 'pending');
        
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status status NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      const updatedSchema = `
        CREATE TYPE status AS ENUM ('active', 'inactive');
        
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status status NOT NULL
        );
      `;

      // Should throw an error about unsafe value removal
      await expect(schemaService.apply(updatedSchema, ['public'], true)).rejects.toThrow(
        /ENUM type 'status' modification requires manual intervention.*removing values.*pending/
      );
    });

    it("should reject ENUM value reordering as unsafe", async () => {
      const initialSchema = `
        CREATE TYPE priority AS ENUM ('low', 'medium', 'high');
        
        CREATE TABLE tasks (
          id SERIAL PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          priority priority NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      const updatedSchema = `
        CREATE TYPE priority AS ENUM ('high', 'medium', 'low');
        
        CREATE TABLE tasks (
          id SERIAL PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          priority priority NOT NULL
        );
      `;

      // Should throw an error about unsafe reordering
      await expect(schemaService.apply(updatedSchema, ['public'], true)).rejects.toThrow(
        /ENUM type 'priority' modification requires manual intervention.*reordering values/
      );
    });

    it("should insert an ENUM value in the middle without reordering existing values", async () => {
      const initialSchema = `
        CREATE TYPE priority AS ENUM ('low', 'medium', 'high');

        CREATE TABLE tasks (
          id SERIAL PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          priority priority NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      const updatedSchema = `
        CREATE TYPE priority AS ENUM ('low', 'urgent', 'medium', 'high');

        CREATE TABLE tasks (
          id SERIAL PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          priority priority NOT NULL
        );
      `;

      await schemaService.apply(updatedSchema, ['public'], true);

      const values = await client.query<{ enumlabel: string }>(`
        SELECT enumlabel
        FROM pg_enum
        WHERE enumtypid = 'priority'::regtype
        ORDER BY enumsortorder
      `);
      expect(values.rows.map(function getLabel(row) {
        return row.enumlabel;
      })).toEqual(['low', 'urgent', 'medium', 'high']);
    });
  });

  describe("ENUM Type Removal", () => {
    it("should remove unused ENUM types", async () => {
      const initialSchema = `
        CREATE TYPE status AS ENUM ('active', 'inactive');
        CREATE TYPE priority AS ENUM ('low', 'high');
        
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status status NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      const updatedSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status VARCHAR(20) NOT NULL
        );
      `;

      await schemaService.apply(updatedSchema, ['public'], true);

      // Verify unused ENUM types were removed
      const result = await client.query(`
        SELECT typname 
        FROM pg_type 
        WHERE typname IN ('status', 'priority') AND typtype = 'e'
      `);
      expect(result.rows).toHaveLength(0);
    });

    it("should not remove ENUM types that are still in use", async () => {
      const initialSchema = `
        CREATE TYPE status AS ENUM ('active', 'inactive');
        
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status status NOT NULL
        );
        
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status status NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      const updatedSchema = `
        CREATE TYPE status AS ENUM ('active', 'inactive');
        
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status VARCHAR(20) NOT NULL
        );
        
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status status NOT NULL
        );
      `;

      await schemaService.apply(updatedSchema, ['public'], true);

      // Verify ENUM type is still there since products table uses it
      const result = await client.query(`
        SELECT typname
        FROM pg_type
        WHERE typname = 'status' AND typtype = 'e'
      `);
      expect(result.rows).toHaveLength(1);
    });

    it("should fail atomically when trying to drop enum still in use", async () => {
      const initialSchema = `
        CREATE TYPE status AS ENUM ('active', 'inactive');
        CREATE TYPE priority AS ENUM ('low', 'high');

        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          status status NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      await client.query(`ALTER TABLE users ADD COLUMN p priority`);

      const updatedSchema = `
        CREATE TYPE status AS ENUM ('active', 'inactive');

        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          status status NOT NULL,
          p priority NOT NULL
        );
      `;

      await expect(
        schemaService.apply(updatedSchema, ['public'], true)
      ).rejects.toThrow(/enum 'public\.priority'.*public\.users\.p/i);

      const result = await client.query(`
        SELECT typname FROM pg_type WHERE typname = 'priority' AND typtype = 'e'
      `);
      expect(result.rows).toHaveLength(1);
    });
  });

  describe("Complex ENUM Scenarios", () => {
    it("should handle ENUM types with foreign key relationships", async () => {
      const schema = `
        CREATE TYPE user_role AS ENUM ('admin', 'user', 'guest');
        CREATE TYPE order_status AS ENUM ('pending', 'shipped', 'delivered');
        
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          role user_role NOT NULL DEFAULT 'user'
        );
        
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          status order_status NOT NULL DEFAULT 'pending',
          CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify both tables and ENUM types exist
      const enumResult = await client.query(`
        SELECT typname 
        FROM pg_type 
        WHERE typname IN ('user_role', 'order_status') AND typtype = 'e'
        ORDER BY typname
      `);
      expect(enumResult.rows).toHaveLength(2);

      // Test the relationship works
      await client.query(`INSERT INTO users (name, role) VALUES ('Admin User', 'admin')`);
      await client.query(`INSERT INTO orders (user_id, status) VALUES (1, 'shipped')`);

      const result = await client.query(`
        SELECT u.name, u.role, o.status 
        FROM users u 
        JOIN orders o ON u.id = o.user_id
      `);
      expect(result.rows[0]).toEqual({ 
        name: 'Admin User', 
        role: 'admin', 
        status: 'shipped' 
      });
    });

    it("should handle multiple ENUM columns in the same table", async () => {
      const schema = `
        CREATE TYPE user_role AS ENUM ('admin', 'user', 'guest');
        CREATE TYPE account_status AS ENUM ('active', 'suspended', 'deleted');
        
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          role user_role NOT NULL DEFAULT 'user',
          status account_status NOT NULL DEFAULT 'active'
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Test inserting with both ENUM values
      await client.query(`
        INSERT INTO users (name, role, status) 
        VALUES ('Test User', 'admin', 'suspended')
      `);

      const result = await client.query(`SELECT name, role, status FROM users`);
      expect(result.rows[0]).toEqual({ 
        name: 'Test User', 
        role: 'admin', 
        status: 'suspended' 
      });
    });
  });

  describe("Error Handling", () => {
    it("should reject duplicate ENUM type names", async () => {
      const schema = `
        CREATE TYPE status AS ENUM ('active', 'inactive');
        CREATE TYPE status AS ENUM ('pending', 'complete');

        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );
      `;

      await expect(schemaService.apply(schema, ['public'], true)).rejects.toThrow();
    });

    it("should reject ENUM types with duplicate values", async () => {
      const schema = `
        CREATE TYPE status AS ENUM ('active', 'inactive', 'active');

        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status status NOT NULL
        );
      `;

      await expect(schemaService.apply(schema, ['public'], true)).rejects.toThrow();
    });

    it("should support empty ENUM types", async () => {
      const schema = `
        CREATE TYPE empty_enum AS ENUM ();

        CREATE TABLE test (
          id SERIAL PRIMARY KEY,
          empty_field empty_enum
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      const result = await client.query(`
        SELECT t.typname, count(e.enumlabel)::int AS value_count
        FROM pg_type t
        LEFT JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typnamespace = 'public'::regnamespace
          AND t.typname = 'empty_enum'
        GROUP BY t.typname
      `);
      expect(result.rows).toEqual([{ typname: "empty_enum", value_count: 0 }]);
    });
  });

  describe("Schema-Qualified ENUM Types", () => {
    it("preserves enum type identities that collide with serial aliases", async function () {
      const schema = `
        CREATE TYPE public.smallserial AS ENUM ('value');
        CREATE TYPE public.serial2 AS ENUM ('value');
        CREATE TYPE public.serial AS ENUM ('value');
        CREATE TYPE public.serial4 AS ENUM ('value');
        CREATE TYPE public.bigserial AS ENUM ('value');
        CREATE TYPE public.serial8 AS ENUM ('value');
        CREATE TYPE public.serial_payload AS (
          scalar_value public.serial,
          serial_values public.serial[]
        );

        CREATE TABLE serial_type_collisions (
          small_value public.smallserial,
          serial2_value public.serial2,
          serial_value public.serial,
          serial4_value public.serial4,
          big_value public.bigserial,
          serial8_value public.serial8,
          serial_values public.serial[]
        );
      `;

      await schemaService.apply(schema, ["public"], true);
      await client.query(`
        INSERT INTO serial_type_collisions VALUES (
          'value', 'value', 'value', 'value', 'value', 'value',
          ARRAY['value']::public.serial[]
        )
      `);
      const before = await client.query(`
        SELECT
          'public.serial_type_collisions'::regclass::oid::text AS table_oid,
          json_object_agg(type.typname, type.oid::text ORDER BY type.typname)
            AS type_oids
        FROM pg_type type
        WHERE type.typnamespace = 'public'::regnamespace
          AND type.typname IN (
            'smallserial', 'serial2', 'serial', 'serial4', 'bigserial', 'serial8',
            'serial_payload'
          )
      `);

      const plan = await schemaService.plan(schema, ["public"]);
      expect(plan.hasChanges).toBe(false);
      await schemaService.apply(schema, ["public"], true);

      const after = await client.query(`
        SELECT
          'public.serial_type_collisions'::regclass::oid::text AS table_oid,
          json_object_agg(type.typname, type.oid::text ORDER BY type.typname)
            AS type_oids
        FROM pg_type type
        WHERE type.typnamespace = 'public'::regnamespace
          AND type.typname IN (
            'smallserial', 'serial2', 'serial', 'serial4', 'bigserial', 'serial8',
            'serial_payload'
          )
      `);
      expect(after.rows).toEqual(before.rows);
      const rows = await client.query(`
        SELECT
          small_value::text,
          serial2_value::text,
          serial_value::text,
          serial4_value::text,
          big_value::text,
          serial8_value::text,
          serial_values::text
        FROM serial_type_collisions
      `);
      expect(rows.rows).toEqual([
        {
          small_value: "value",
          serial2_value: "value",
          serial_value: "value",
          serial4_value: "value",
          big_value: "value",
          serial8_value: "value",
          serial_values: "{value}",
        },
      ]);
    });

    it("treats explicit public custom type references as their catalog identities", async function () {
      const schema = `
        CREATE TYPE public.qualification_enum AS ENUM ('first', 'second');
        CREATE DOMAIN public.qualification_domain
          AS public."qualification_enum";
        CREATE TYPE public.qualification_range AS RANGE (
          subtype = "public".qualification_enum
        );
        CREATE TYPE public.qualification_composite AS (
          enum_value public."qualification_enum",
          enum_values public.qualification_enum[],
          domain_value public."qualification_domain",
          domain_values public.qualification_domain[],
          range_value public."qualification_range",
          range_values public.qualification_range[]
        );

        CREATE TABLE public.qualification_values (
          id integer PRIMARY KEY,
          enum_value public.qualification_enum,
          enum_values public.qualification_enum[],
          domain_value public.qualification_domain,
          domain_values public.qualification_domain[],
          range_value public.qualification_range,
          range_values public.qualification_range[],
          composite_value public."qualification_composite",
          composite_values public.qualification_composite[]
        );

        CREATE TABLE public.qualification_partitioned (
          enum_value public.qualification_enum NOT NULL
        ) PARTITION BY LIST (enum_value);
        CREATE TABLE public.qualification_first
          PARTITION OF public.qualification_partitioned
          FOR VALUES IN ('first');
      `;

      await schemaService.apply(schema, ["public"], true);
      await client.query(`
        INSERT INTO public.qualification_values VALUES (
          1,
          'first',
          ARRAY['first', 'second']::public.qualification_enum[],
          'second',
          ARRAY['first']::public.qualification_domain[],
          '[first,second]',
          ARRAY['[first,second]']::public.qualification_range[],
          ROW(
            'first',
            ARRAY['second']::public.qualification_enum[],
            'second',
            ARRAY['first']::public.qualification_domain[],
            '[first,second]',
            ARRAY['[first,second]']::public.qualification_range[]
          )::public.qualification_composite,
          ARRAY[
            ROW(
              'second',
              ARRAY['first']::public.qualification_enum[],
              'first',
              ARRAY['second']::public.qualification_domain[],
              '[first,second]',
              ARRAY['[first,second]']::public.qualification_range[]
            )::public.qualification_composite
          ]
        )
      `);
      await client.query(`
        INSERT INTO public.qualification_partitioned VALUES ('first')
      `);
      const before = await client.query(`
        SELECT
          (SELECT json_object_agg(class.relname, class.oid::text ORDER BY class.relname)
           FROM pg_class class
           WHERE class.relnamespace = 'public'::regnamespace
             AND class.relname IN (
               'qualification_values',
               'qualification_partitioned',
               'qualification_first'
             )) AS table_oids,
          json_object_agg(type.typname, type.oid::text ORDER BY type.typname)
            AS type_oids,
          json_build_object(
            'ordinary',
            (SELECT json_agg(value ORDER BY id)
             FROM public.qualification_values value),
            'partitioned',
            (SELECT json_agg(value ORDER BY enum_value)
             FROM public.qualification_partitioned value)
          ) AS rows
        FROM pg_type type
        WHERE type.typnamespace = 'public'::regnamespace
          AND type.typname IN (
            'qualification_enum',
            'qualification_domain',
            'qualification_range',
            'qualification_composite'
          )
      `);

      const plan = await schemaService.plan(schema, ["public"]);
      expect(plan.hasChanges).toBe(false);
      await schemaService.apply(schema, ["public"], true);

      const after = await client.query(`
        SELECT
          (SELECT json_object_agg(class.relname, class.oid::text ORDER BY class.relname)
           FROM pg_class class
           WHERE class.relnamespace = 'public'::regnamespace
             AND class.relname IN (
               'qualification_values',
               'qualification_partitioned',
               'qualification_first'
             )) AS table_oids,
          json_object_agg(type.typname, type.oid::text ORDER BY type.typname)
            AS type_oids,
          json_build_object(
            'ordinary',
            (SELECT json_agg(value ORDER BY id)
             FROM public.qualification_values value),
            'partitioned',
            (SELECT json_agg(value ORDER BY enum_value)
             FROM public.qualification_partitioned value)
          ) AS rows
        FROM pg_type type
        WHERE type.typnamespace = 'public'::regnamespace
          AND type.typname IN (
            'qualification_enum',
            'qualification_domain',
            'qualification_range',
            'qualification_composite'
          )
      `);
      expect(after.rows).toEqual(before.rows);
    });

    it("should handle schema-qualified ENUM types in column definitions", async () => {
      const schema = `
        CREATE SCHEMA myapp;

        CREATE TYPE myapp.status AS ENUM ('active', 'inactive', 'pending');

        CREATE TABLE myapp.users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status myapp.status NOT NULL
        );
      `;

      await schemaService.apply(schema, ['myapp'], true);

      const result = await client.query(`
        SELECT column_name, udt_schema, udt_name
        FROM information_schema.columns
        WHERE table_schema = 'myapp' AND table_name = 'users' AND column_name = 'status'
      `);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].udt_schema).toBe('myapp');
      expect(result.rows[0].udt_name).toBe('status');
    });

    it("should handle schema-qualified ENUM types with default values", async () => {
      const schema = `
        CREATE SCHEMA app;

        CREATE TYPE app.priority AS ENUM ('low', 'medium', 'high');

        CREATE TABLE app.tasks (
          id SERIAL PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          priority app.priority NOT NULL DEFAULT 'medium'
        );
      `;

      await schemaService.apply(schema, ['app'], true);

      await client.query(`INSERT INTO app.tasks (title) VALUES ('Test task')`);
      const result = await client.query(`SELECT title, priority FROM app.tasks`);
      expect(result.rows[0]).toEqual({ title: 'Test task', priority: 'medium' });
    });

    it("should handle schema-qualified ENUM types with multiple constraints", async () => {
      const schema = `
        CREATE SCHEMA myapp;

        CREATE TYPE myapp.user_role AS ENUM ('admin', 'user', 'guest');

        CREATE TABLE myapp.users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          role myapp.user_role NOT NULL,
          UNIQUE (name, role)
        );
      `;

      await schemaService.apply(schema, ['myapp'], true);

      await client.query(`INSERT INTO myapp.users (name, role) VALUES ('John', 'admin')`);
      await expect(
        client.query(`INSERT INTO myapp.users (name, role) VALUES ('John', 'admin')`)
      ).rejects.toThrow();
    });

    it("should append only target schema enum values when names match across schemas", async () => {
      const initialSchema = `
        CREATE SCHEMA app;
        CREATE SCHEMA tenant_a;

        CREATE TYPE app.status AS ENUM ('active', 'inactive');
        CREATE TYPE tenant_a.status AS ENUM ('queued', 'done');

        CREATE TABLE app.users (
          id SERIAL PRIMARY KEY,
          status app.status NOT NULL
        );

        CREATE TABLE tenant_a.jobs (
          id SERIAL PRIMARY KEY,
          status tenant_a.status NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, ['app', 'tenant_a'], true);

      const updatedSchema = `
        CREATE SCHEMA app;
        CREATE SCHEMA tenant_a;

        CREATE TYPE app.status AS ENUM ('active', 'inactive', 'pending');
        CREATE TYPE tenant_a.status AS ENUM ('queued', 'done');

        CREATE TABLE app.users (
          id SERIAL PRIMARY KEY,
          status app.status NOT NULL
        );

        CREATE TABLE tenant_a.jobs (
          id SERIAL PRIMARY KEY,
          status tenant_a.status NOT NULL
        );
      `;

      await schemaService.apply(updatedSchema, ['app', 'tenant_a'], true);

      const result = await client.query(`
        SELECT n.nspname AS enum_schema, e.enumlabel
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname = 'status' AND n.nspname IN ('app', 'tenant_a')
        ORDER BY n.nspname, e.enumsortorder
      `);

      const appValues = result.rows
        .filter(row => row.enum_schema === 'app')
        .map(row => row.enumlabel);
      const tenantValues = result.rows
        .filter(row => row.enum_schema === 'tenant_a')
        .map(row => row.enumlabel);

      expect(appValues).toEqual(['active', 'inactive', 'pending']);
      expect(tenantValues).toEqual(['queued', 'done']);
    });
  });
});
