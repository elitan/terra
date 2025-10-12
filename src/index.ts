#!/usr/bin/env node

import { runCLI } from "./cli/index";
import { ErrorFormatter } from "./utils/error-formatter";

if (import.meta.main) {
  runCLI().catch((error) => {
    // Format and display the error
    console.error(ErrorFormatter.format(error));
    process.exit(1);
  });
}
