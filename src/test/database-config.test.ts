import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../core/database/config";

describe("Database Configuration", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe("DATABASE_URL parsing", () => {
    test("should parse standard PostgreSQL connection URL", () => {
      process.env.DATABASE_URL = "postgres://user:password@localhost:5432/mydb";

      const config = loadConfig();

      expect(config.host).toBe("localhost");
      expect(config.port).toBe(5432);
      expect(config.database).toBe("mydb");
      expect(config.user).toBe("user");
      expect(config.password).toBe("password");
    });

    test("should parse URL with postgresql:// protocol", () => {
      process.env.DATABASE_URL = "postgresql://admin:secret@db.example.com:5433/production";

      const config = loadConfig();

      expect(config.host).toBe("db.example.com");
      expect(config.port).toBe(5433);
      expect(config.database).toBe("production");
      expect(config.user).toBe("admin");
      expect(config.password).toBe("secret");
    });

    test("should handle URL without port (use default 5432)", () => {
      process.env.DATABASE_URL = "postgres://user:pass@example.com/testdb";

      const config = loadConfig();

      expect(config.host).toBe("example.com");
      expect(config.port).toBe(5432);
      expect(config.database).toBe("testdb");
      expect(config.user).toBe("user");
      expect(config.password).toBe("pass");
    });

    test("should handle URL with special characters in password", () => {
      process.env.DATABASE_URL = "postgres://user:p@ssw0rd!@localhost:5432/db";

      const config = loadConfig();

      expect(config.host).toBe("localhost");
      expect(config.port).toBe(5432);
      expect(config.database).toBe("db");
      expect(config.user).toBe("user");
      expect(config.password).toBe("p@ssw0rd!");
    });

    test("should handle URL with URL-encoded password", () => {
      // Password with special chars: p@ss:word/test
      process.env.DATABASE_URL = "postgres://user:p%40ss%3Aword%2Ftest@localhost:5432/db";

      const config = loadConfig();

      expect(config.password).toBe("p@ss:word/test");
    });

    test("should handle Heroku-style DATABASE_URL", () => {
      process.env.DATABASE_URL = "postgres://abc123:xyz789@ec2-1-2-3-4.compute-1.amazonaws.com:5432/d1a2b3c4";

      const config = loadConfig();

      expect(config.host).toBe("ec2-1-2-3-4.compute-1.amazonaws.com");
      expect(config.port).toBe(5432);
      expect(config.database).toBe("d1a2b3c4");
      expect(config.user).toBe("abc123");
      expect(config.password).toBe("xyz789");
    });

    test("should handle Railway-style DATABASE_URL", () => {
      process.env.DATABASE_URL = "postgresql://postgres:password@containers-us-west-1.railway.app:5432/railway";

      const config = loadConfig();

      expect(config.host).toBe("containers-us-west-1.railway.app");
      expect(config.port).toBe(5432);
      expect(config.database).toBe("railway");
      expect(config.user).toBe("postgres");
    });

    test("should handle localhost URL", () => {
      process.env.DATABASE_URL = "postgres://testuser:testpass@localhost:5487/testdb";

      const config = loadConfig();

      expect(config.host).toBe("localhost");
      expect(config.port).toBe(5487);
      expect(config.database).toBe("testdb");
      expect(config.user).toBe("testuser");
      expect(config.password).toBe("testpass");
    });
  });

  describe("Individual environment variables (fallback)", () => {
    test("should use individual env vars when DATABASE_URL is not set", () => {
      delete process.env.DATABASE_URL;
      process.env.DB_HOST = "custom-host";
      process.env.DB_PORT = "5433";
      process.env.DB_NAME = "custom-db";
      process.env.DB_USER = "custom-user";
      process.env.DB_PASSWORD = "custom-pass";

      const config = loadConfig();

      expect(config.host).toBe("custom-host");
      expect(config.port).toBe(5433);
      expect(config.database).toBe("custom-db");
      expect(config.user).toBe("custom-user");
      expect(config.password).toBe("custom-pass");
    });

    test("should use default values when no env vars are set", () => {
      delete process.env.DATABASE_URL;
      delete process.env.DB_HOST;
      delete process.env.DB_PORT;
      delete process.env.DB_NAME;
      delete process.env.DB_USER;
      delete process.env.DB_PASSWORD;

      const config = loadConfig();

      expect(config.host).toBe("localhost");
      expect(config.port).toBe(5432);
      expect(config.database).toBe("postgres");
      expect(config.user).toBe("postgres");
      expect(config.password).toBe("postgres");
    });

    test("should use defaults for missing individual env vars", () => {
      delete process.env.DATABASE_URL;
      process.env.DB_HOST = "myhost";
      // Other vars not set - should use defaults

      const config = loadConfig();

      expect(config.host).toBe("myhost");
      expect(config.port).toBe(5432); // default
      expect(config.database).toBe("postgres"); // default
      expect(config.user).toBe("postgres"); // default
      expect(config.password).toBe("postgres"); // default
    });
  });

  describe("Priority", () => {
    test("should prioritize DATABASE_URL over individual env vars", () => {
      process.env.DATABASE_URL = "postgres://urluser:urlpass@urlhost:5433/urldb";
      process.env.DB_HOST = "ignored-host";
      process.env.DB_PORT = "9999";
      process.env.DB_NAME = "ignored-db";
      process.env.DB_USER = "ignored-user";
      process.env.DB_PASSWORD = "ignored-pass";

      const config = loadConfig();

      // Should use DATABASE_URL values, not individual vars
      expect(config.host).toBe("urlhost");
      expect(config.port).toBe(5433);
      expect(config.database).toBe("urldb");
      expect(config.user).toBe("urluser");
      expect(config.password).toBe("urlpass");
    });

    test("should prioritize URL override over DATABASE_URL", () => {
      process.env.DATABASE_URL = "postgres://envuser:envpass@envhost:5433/envdb";
      const urlOverride = "postgres://cliuser:clipass@clihost:5434/clidb";

      const config = loadConfig(urlOverride);

      // Should use URL override values, not DATABASE_URL
      expect(config.host).toBe("clihost");
      expect(config.port).toBe(5434);
      expect(config.database).toBe("clidb");
      expect(config.user).toBe("cliuser");
      expect(config.password).toBe("clipass");
    });

    test("should prioritize URL override over individual env vars", () => {
      process.env.DB_HOST = "ignored-host";
      process.env.DB_PORT = "9999";
      process.env.DB_NAME = "ignored-db";
      process.env.DB_USER = "ignored-user";
      process.env.DB_PASSWORD = "ignored-pass";
      const urlOverride = "postgres://cliuser:clipass@clihost:5434/clidb";

      const config = loadConfig(urlOverride);

      // Should use URL override values
      expect(config.host).toBe("clihost");
      expect(config.port).toBe(5434);
      expect(config.database).toBe("clidb");
      expect(config.user).toBe("cliuser");
      expect(config.password).toBe("clipass");
    });

    test("should fall back to DATABASE_URL when URL override is undefined", () => {
      process.env.DATABASE_URL = "postgres://envuser:envpass@envhost:5433/envdb";

      const config = loadConfig(undefined);

      // Should use DATABASE_URL values
      expect(config.host).toBe("envhost");
      expect(config.port).toBe(5433);
      expect(config.database).toBe("envdb");
      expect(config.user).toBe("envuser");
      expect(config.password).toBe("envpass");
    });

    test("should fall back to DATABASE_URL when URL override is empty string", () => {
      process.env.DATABASE_URL = "postgres://envuser:envpass@envhost:5433/envdb";

      const config = loadConfig("");

      // Should use DATABASE_URL values
      expect(config.host).toBe("envhost");
      expect(config.port).toBe(5433);
      expect(config.database).toBe("envdb");
      expect(config.user).toBe("envuser");
      expect(config.password).toBe("envpass");
    });
  });

  describe("SSL mode parsing", () => {
    test("should parse sslmode=require", () => {
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db?sslmode=require";

      const config = loadConfig();

      expect(config.ssl).toEqual({ rejectUnauthorized: false });
    });

    test("should parse sslmode=prefer", () => {
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db?sslmode=prefer";

      const config = loadConfig();

      expect(config.ssl).toEqual({ rejectUnauthorized: false });
    });

    test("should parse sslmode=disable", () => {
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db?sslmode=disable";

      const config = loadConfig();

      expect(config.ssl).toBe(false);
    });

    test("should parse sslmode=verify-ca", () => {
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db?sslmode=verify-ca";

      const config = loadConfig();

      expect(config.ssl).toEqual({ rejectUnauthorized: true });
    });

    test("should parse sslmode=verify-full", () => {
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db?sslmode=verify-full";

      const config = loadConfig();

      expect(config.ssl).toEqual({ rejectUnauthorized: true });
    });

    test("should not set ssl when sslmode is not specified", () => {
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";

      const config = loadConfig();

      expect(config.ssl).toBeUndefined();
    });

    test("should handle Neon-style URL with sslmode", () => {
      process.env.DATABASE_URL = "postgresql://user:pass@ep-twilight-moon.eu-central-1.aws.neon.tech/neondb?sslmode=require";

      const config = loadConfig();

      expect(config.host).toBe("ep-twilight-moon.eu-central-1.aws.neon.tech");
      expect(config.database).toBe("neondb");
      expect(config.ssl).toEqual({ rejectUnauthorized: false });
    });
  });

  describe("Edge cases", () => {
    test("should handle empty DATABASE_URL by falling back to individual vars", () => {
      process.env.DATABASE_URL = "";
      process.env.DB_HOST = "fallback-host";

      const config = loadConfig();

      expect(config.host).toBe("fallback-host");
    });

    test("should handle database name with dashes", () => {
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/my-test-db";

      const config = loadConfig();

      expect(config.database).toBe("my-test-db");
    });

    test("should handle database name with underscores", () => {
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/my_test_db";

      const config = loadConfig();

      expect(config.database).toBe("my_test_db");
    });

    test("should handle IPv4 address as host", () => {
      process.env.DATABASE_URL = "postgres://user:pass@192.168.1.100:5432/db";

      const config = loadConfig();

      expect(config.host).toBe("192.168.1.100");
    });

    test("should handle username without password", () => {
      process.env.DATABASE_URL = "postgres://user@localhost:5432/db";

      const config = loadConfig();

      expect(config.user).toBe("user");
      expect(config.password).toBe("");
    });
  });
});
