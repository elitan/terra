import { describe, test, expect } from "bun:test";
import { 
  generateCreateViewSQL, 
  generateDropViewSQL, 
  generateCreateOrReplaceViewSQL,
  generateRefreshMaterializedViewSQL 
} from "../../utils/sql";
import type { View } from "../../types/schema";

describe("View SQL Generation", () => {
  describe("CREATE VIEW SQL", () => {
    test("should generate simple CREATE VIEW statement", () => {
      const view: View = {
        name: "active_users",
        definition: "SELECT id, email FROM users WHERE active = true",
        materialized: false
      };

      const sql = generateCreateViewSQL(view);
      expect(sql).toBe("CREATE VIEW active_users AS SELECT id, email FROM users WHERE active = true;");
    });

    test("should generate CREATE MATERIALIZED VIEW statement", () => {
      const view: View = {
        name: "user_stats",
        definition: "SELECT COUNT(*) as total FROM users",
        materialized: true
      };

      const sql = generateCreateViewSQL(view);
      expect(sql).toBe("CREATE MATERIALIZED VIEW user_stats AS SELECT COUNT(*) as total FROM users;");
    });

    test("should include WITH CHECK OPTION for regular views", () => {
      const view: View = {
        name: "active_users",
        definition: "SELECT id, email FROM users WHERE active = true",
        materialized: false,
        checkOption: 'CASCADED'
      };

      const sql = generateCreateViewSQL(view);
      expect(sql).toBe("CREATE VIEW active_users AS SELECT id, email FROM users WHERE active = true WITH CASCADED CHECK OPTION;");
    });

    test("should include WITH LOCAL CHECK OPTION", () => {
      const view: View = {
        name: "local_view",
        definition: "SELECT * FROM base_view",
        materialized: false,
        checkOption: 'LOCAL'
      };

      const sql = generateCreateViewSQL(view);
      expect(sql).toBe("CREATE VIEW local_view AS SELECT * FROM base_view WITH LOCAL CHECK OPTION;");
    });

    test("should NOT include CHECK OPTION for materialized views", () => {
      const view: View = {
        name: "mat_view",
        definition: "SELECT * FROM users",
        materialized: true,
        checkOption: 'CASCADED' // Should be ignored
      };

      const sql = generateCreateViewSQL(view);
      expect(sql).toBe("CREATE MATERIALIZED VIEW mat_view AS SELECT * FROM users;");
    });
  });

  describe("DROP VIEW SQL", () => {
    test("should generate DROP VIEW statement", () => {
      const sql = generateDropViewSQL("test_view");
      expect(sql).toBe('DROP VIEW IF EXISTS "test_view" ;');
    });

    test("should generate DROP MATERIALIZED VIEW statement", () => {
      const sql = generateDropViewSQL("test_mat_view", true);
      expect(sql).toBe('DROP MATERIALIZED VIEW IF EXISTS "test_mat_view" ;');
    });
  });

  describe("CREATE OR REPLACE VIEW SQL", () => {
    test("should generate CREATE OR REPLACE VIEW for regular views", () => {
      const view: View = {
        name: "replaceable_view",
        definition: "SELECT id, name FROM users",
        materialized: false
      };

      const sql = generateCreateOrReplaceViewSQL(view);
      expect(sql).toBe("CREATE OR REPLACE VIEW replaceable_view AS SELECT id, name FROM users;");
    });

    test("should generate CREATE OR REPLACE with CHECK OPTION", () => {
      const view: View = {
        name: "replaceable_view",
        definition: "SELECT id, name FROM users WHERE active = true",
        materialized: false,
        checkOption: 'CASCADED'
      };

      const sql = generateCreateOrReplaceViewSQL(view);
      expect(sql).toBe("CREATE OR REPLACE VIEW replaceable_view AS SELECT id, name FROM users WHERE active = true WITH CASCADED CHECK OPTION;");
    });

    test("should generate DROP + CREATE for materialized views", () => {
      const view: View = {
        name: "mat_view",
        definition: "SELECT COUNT(*) FROM users",
        materialized: true
      };

      const sql = generateCreateOrReplaceViewSQL(view);
      expect(sql).toContain('DROP MATERIALIZED VIEW IF EXISTS "mat_view" ;');
      expect(sql).toContain("CREATE MATERIALIZED VIEW mat_view AS SELECT COUNT(*) FROM users;");
    });
  });

  describe("REFRESH MATERIALIZED VIEW SQL", () => {
    test("should generate REFRESH MATERIALIZED VIEW statement", () => {
      const sql = generateRefreshMaterializedViewSQL("test_mat_view");
      expect(sql).toBe("REFRESH MATERIALIZED VIEW test_mat_view;");
    });

    test("should generate REFRESH MATERIALIZED VIEW CONCURRENTLY", () => {
      const sql = generateRefreshMaterializedViewSQL("test_mat_view", true);
      expect(sql).toBe("REFRESH MATERIALIZED VIEW CONCURRENTLY test_mat_view;");
    });
  });

  describe("Complex View Definitions", () => {
    test("should handle complex SELECT statements", () => {
      const view: View = {
        name: "complex_view",
        definition: `SELECT 
          u.id,
          u.name,
          COUNT(p.id) as post_count,
          AVG(p.rating) as avg_rating
        FROM users u
        LEFT JOIN posts p ON u.id = p.user_id
        WHERE u.active = true
        GROUP BY u.id, u.name
        HAVING COUNT(p.id) > 0
        ORDER BY avg_rating DESC`,
        materialized: false
      };

      const sql = generateCreateViewSQL(view);
      expect(sql).toContain("CREATE VIEW complex_view AS");
      expect(sql).toContain("LEFT JOIN posts p");
      expect(sql).toContain("GROUP BY u.id, u.name");
      expect(sql).toContain("HAVING COUNT(p.id) > 0");
    });

    test("should handle views with CTEs", () => {
      const view: View = {
        name: "cte_view",
        definition: `WITH RECURSIVE category_tree AS (
          SELECT id, name, parent_id, 1 as level
          FROM categories
          WHERE parent_id IS NULL
          UNION ALL
          SELECT c.id, c.name, c.parent_id, ct.level + 1
          FROM categories c
          JOIN category_tree ct ON c.parent_id = ct.id
        )
        SELECT * FROM category_tree ORDER BY level, name`,
        materialized: true
      };

      const sql = generateCreateViewSQL(view);
      expect(sql).toContain("CREATE MATERIALIZED VIEW cte_view AS");
      expect(sql).toContain("WITH RECURSIVE category_tree");
      expect(sql).toContain("UNION ALL");
    });

    test("should handle views with window functions", () => {
      const view: View = {
        name: "window_func_view",
        definition: `SELECT 
          id,
          name,
          salary,
          ROW_NUMBER() OVER (ORDER BY salary DESC) as salary_rank,
          PERCENT_RANK() OVER (ORDER BY salary) as salary_percentile,
          LAG(salary) OVER (ORDER BY hire_date) as prev_hire_salary
        FROM employees`,
        materialized: false
      };

      const sql = generateCreateViewSQL(view);
      expect(sql).toContain("CREATE VIEW window_func_view AS");
      expect(sql).toContain("ROW_NUMBER() OVER");
      expect(sql).toContain("PERCENT_RANK() OVER");
      expect(sql).toContain("LAG(salary) OVER");
    });
  });

  describe("Edge Cases", () => {
    test("should handle view names with special characters", () => {
      const view: View = {
        name: '"user-summary"',
        definition: 'SELECT id, email FROM "user_profiles"',
        materialized: false
      };

      const sql = generateCreateViewSQL(view);
      expect(sql).toBe('CREATE VIEW "user-summary" AS SELECT id, email FROM "user_profiles";');
    });

    test("should handle empty or minimal definitions", () => {
      const view: View = {
        name: "minimal_view",
        definition: "SELECT 1",
        materialized: false
      };

      const sql = generateCreateViewSQL(view);
      expect(sql).toBe("CREATE VIEW minimal_view AS SELECT 1;");
    });

    test("should handle very long view definitions", () => {
      const longDefinition = `SELECT 
        ${"column" + Array(100).fill(0).map((_, i) => i).join(", column")}
        FROM very_wide_table`;
      
      const view: View = {
        name: "wide_view",
        definition: longDefinition,
        materialized: true
      };

      const sql = generateCreateViewSQL(view);
      expect(sql).toContain("CREATE MATERIALIZED VIEW wide_view AS");
      expect(sql).toContain("column0, column1");
      expect(sql).toContain("column99");
    });

    test("should handle view definitions with quotes and special characters", () => {
      const view: View = {
        name: "special_chars_view",
        definition: `SELECT 
          'It''s a string with quotes' as quoted_string,
          $tag$Dollar quoted string$tag$ as dollar_quoted,
          regexp_replace(name, '[^a-zA-Z0-9]', '_', 'g') as sanitized_name
        FROM users`,
        materialized: false
      };

      const sql = generateCreateViewSQL(view);
      expect(sql).toContain("CREATE VIEW special_chars_view AS");
      expect(sql).toContain("'It''s a string with quotes'");
      expect(sql).toContain("$tag$Dollar quoted string$tag$");
    });
  });
});