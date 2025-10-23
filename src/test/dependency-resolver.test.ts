import { describe, test, expect } from "bun:test";
import { DependencyResolver } from "../core/schema/dependency-resolver";
import type { Table } from "../types/schema";

describe("DependencyResolver", () => {
  describe("Simple Dependencies", () => {
    test("should order tables with no dependencies", () => {
      const tables: Table[] = [
        { name: "users", schema: "public", columns: [], constraints: [] },
        { name: "products", schema: "public", columns: [], constraints: [] },
      ];

      const resolver = new DependencyResolver(tables);
      const order = resolver.getCreationOrder();

      expect(order).toHaveLength(2);
      expect(order).toContain("users");
      expect(order).toContain("products");
    });

    test("should order tables with simple dependency", () => {
      const tables: Table[] = [
        {
          name: "orders",
          schema: "public",
          columns: [],
          constraints: [],
          foreignKeys: [
            {
              name: "fk_customer",
              columns: ["customer_id"],
              referencedTable: "customers",
              referencedColumns: ["id"],
            },
          ],
        },
        { name: "customers", schema: "public", columns: [], constraints: [] },
      ];

      const resolver = new DependencyResolver(tables);
      const order = resolver.getCreationOrder();

      expect(order).toEqual(["customers", "orders"]);
    });

    test("should order tables with multi-level dependencies", () => {
      const tables: Table[] = [
        {
          name: "order_items",
          schema: "public",
          columns: [],
          constraints: [],
          foreignKeys: [
            {
              name: "fk_order",
              columns: ["order_id"],
              referencedTable: "orders",
              referencedColumns: ["id"],
            },
          ],
        },
        {
          name: "orders",
          schema: "public",
          columns: [],
          constraints: [],
          foreignKeys: [
            {
              name: "fk_customer",
              columns: ["customer_id"],
              referencedTable: "customers",
              referencedColumns: ["id"],
            },
          ],
        },
        { name: "customers", schema: "public", columns: [], constraints: [] },
      ];

      const resolver = new DependencyResolver(tables);
      const order = resolver.getCreationOrder();

      expect(order).toEqual(["customers", "orders", "order_items"]);
    });
  });

  describe("Deletion Order", () => {
    test("should reverse order for deletion", () => {
      const tables: Table[] = [
        {
          name: "orders",
          schema: "public",
          columns: [],
          constraints: [],
          foreignKeys: [
            {
              name: "fk_customer",
              columns: ["customer_id"],
              referencedTable: "customers",
              referencedColumns: ["id"],
            },
          ],
        },
        { name: "customers", schema: "public", columns: [], constraints: [] },
      ];

      const resolver = new DependencyResolver(tables);
      const deletionOrder = resolver.getDeletionOrder();

      expect(deletionOrder).toEqual(["orders", "customers"]);
    });
  });

  describe("Cycle Detection", () => {
    test("should detect simple two-table cycle", () => {
      const tables: Table[] = [
        {
          name: "authors",
          schema: "public",
          columns: [],
          constraints: [],
          foreignKeys: [
            {
              name: "fk_latest_book",
              columns: ["latest_book_id"],
              referencedTable: "books",
              referencedColumns: ["id"],
            },
          ],
        },
        {
          name: "books",
          schema: "public",
          columns: [],
          constraints: [],
          foreignKeys: [
            {
              name: "fk_author",
              columns: ["author_id"],
              referencedTable: "authors",
              referencedColumns: ["id"],
            },
          ],
        },
      ];

      const resolver = new DependencyResolver(tables);
      expect(resolver.hasCircularDependencies()).toBe(true);

      const cycles = resolver.getCircularDependencies();
      expect(cycles.length).toBeGreaterThan(0);

      // Check that both tables are in the cycle
      const cycle = cycles[0];
      expect(cycle).toContain("authors");
      expect(cycle).toContain("books");
    });

    test("should throw clear error for two-table cycle on creation order", () => {
      const tables: Table[] = [
        {
          name: "authors",
          schema: "public",
          columns: [],
          constraints: [],
          foreignKeys: [
            {
              name: "fk_latest_book",
              columns: ["latest_book_id"],
              referencedTable: "books",
              referencedColumns: ["id"],
            },
          ],
        },
        {
          name: "books",
          schema: "public",
          columns: [],
          constraints: [],
          foreignKeys: [
            {
              name: "fk_author",
              columns: ["author_id"],
              referencedTable: "authors",
              referencedColumns: ["id"],
            },
          ],
        },
      ];

      const resolver = new DependencyResolver(tables);

      try {
        resolver.getCreationOrder();
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain("Circular dependency detected");
        expect(error.message).toContain("authors");
        expect(error.message).toContain("books");
        expect(error.message).toContain("→");
      }
    });

    test("should detect three-table cycle", () => {
      const tables: Table[] = [
        {
          name: "table_a",
          schema: "public",
          columns: [],
          constraints: [],
          foreignKeys: [
            {
              name: "fk_b",
              columns: ["b_id"],
              referencedTable: "table_b",
              referencedColumns: ["id"],
            },
          ],
        },
        {
          name: "table_b",
          schema: "public",
          columns: [],
          constraints: [],
          foreignKeys: [
            {
              name: "fk_c",
              columns: ["c_id"],
              referencedTable: "table_c",
              referencedColumns: ["id"],
            },
          ],
        },
        {
          name: "table_c",
          schema: "public",
          columns: [],
          constraints: [],
          foreignKeys: [
            {
              name: "fk_a",
              columns: ["a_id"],
              referencedTable: "table_a",
              referencedColumns: ["id"],
            },
          ],
        },
      ];

      const resolver = new DependencyResolver(tables);
      expect(resolver.hasCircularDependencies()).toBe(true);

      try {
        resolver.getCreationOrder();
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error.message).toContain("Circular dependency detected");
        expect(error.message).toContain("table_a");
        expect(error.message).toContain("table_b");
        expect(error.message).toContain("table_c");
      }
    });

    test("should throw clear error on deletion order with cycle", () => {
      const tables: Table[] = [
        {
          name: "users",
          schema: "public",
          columns: [],
          constraints: [],
          foreignKeys: [
            {
              name: "fk_profile",
              columns: ["profile_id"],
              referencedTable: "profiles",
              referencedColumns: ["id"],
            },
          ],
        },
        {
          name: "profiles",
          schema: "public",
          columns: [],
          constraints: [],
          foreignKeys: [
            {
              name: "fk_user",
              columns: ["user_id"],
              referencedTable: "users",
              referencedColumns: ["id"],
            },
          ],
        },
      ];

      const resolver = new DependencyResolver(tables);

      try {
        resolver.getDeletionOrder();
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error.message).toContain("Circular dependency detected");
        expect(error.message).toContain("deletion order");
        expect(error.message).toContain("users");
        expect(error.message).toContain("profiles");
      }
    });
  });

  describe("Self-Referential Tables", () => {
    test("should handle self-referential table", () => {
      const tables: Table[] = [
        {
          name: "categories",
          schema: "public",
          columns: [],
          constraints: [],
          foreignKeys: [
            {
              name: "fk_parent",
              columns: ["parent_id"],
              referencedTable: "categories",
              referencedColumns: ["id"],
            },
          ],
        },
      ];

      const resolver = new DependencyResolver(tables);
      const order = resolver.getCreationOrder();

      expect(order).toEqual(["categories"]);
      expect(resolver.hasCircularDependencies()).toBe(false);
    });

    test("should handle mix of self-referential and normal dependencies", () => {
      const tables: Table[] = [
        {
          name: "employees",
          schema: "public",
          columns: [],
          constraints: [],
          foreignKeys: [
            {
              name: "fk_manager",
              columns: ["manager_id"],
              referencedTable: "employees",
              referencedColumns: ["id"],
            },
            {
              name: "fk_department",
              columns: ["department_id"],
              referencedTable: "departments",
              referencedColumns: ["id"],
            },
          ],
        },
        { name: "departments", schema: "public", columns: [], constraints: [] },
      ];

      const resolver = new DependencyResolver(tables);
      const order = resolver.getCreationOrder();

      expect(order).toEqual(["departments", "employees"]);
    });
  });
});
