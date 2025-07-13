#!/usr/bin/env bun

import { runCLI } from "./cli/index";

if (import.meta.main) {
  runCLI().catch(console.error);
}
