import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { DatabaseService } from "../../core/database/client";
import { createTestClient, cleanDatabase, TEST_DB_CONFIG } from "../utils";

describe("ENUM Types", () => {
  let client: Client;
  let schemaService: SchemaService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    const databaseService = new DatabaseService(TEST_DB_CONFIG);
    schemaService = new SchemaService(databaseService);
  });

  afterEach(async () => {
    await client.end();
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

    it("should reject empty ENUM types", async () => {
      const schema = `
        CREATE TYPE empty_enum AS ENUM ();
        
        CREATE TABLE test (
          id SERIAL PRIMARY KEY,
          empty_field empty_enum
        );
      `;

      await expect(schemaService.apply(schema, ['public'], true)).rejects.toThrow();
    });
  });
});