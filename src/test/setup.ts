#!/usr/bin/env bun

import { createTestClient, waitForDb } from "./utils";

async function setupTests() {
  console.log("🔧 Setting up test environment...");

  try {
    console.log("⏳ Waiting for PostgreSQL to be ready...");
    await waitForDb(30000); // Wait up to 30 seconds

    console.log("🔗 Testing database connection...");
    const client = await createTestClient();
    await client.query("SELECT 1");
    await client.end();

    console.log("✅ Test environment is ready!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Failed to setup test environment:", error);
    process.exit(1);
  }
}

if (import.meta.main) {
  setupTests();
}
