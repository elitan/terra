#!/usr/bin/env node

import { runCLI } from "./cli/index";

if (import.meta.main) {
  runCLI().catch(console.error);
}
