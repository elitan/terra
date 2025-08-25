#!/usr/bin/env bun
import { spawnSync } from "child_process";
import chalk from "chalk";

type VersionType = "patch" | "minor" | "major";

function runCommand(command: string, args: string[] = []): { success: boolean; output: string } {
  const result = spawnSync(command, args, { 
    encoding: "utf-8", 
    stdio: ["inherit", "pipe", "pipe"] 
  });
  
  return {
    success: result.status === 0,
    output: result.stdout || result.stderr || ""
  };
}

function getCurrentVersion(): string {
  const packageJson = require("../package.json");
  return packageJson.version;
}

function validateVersionType(type: string): type is VersionType {
  return ["patch", "minor", "major"].includes(type);
}

async function main() {
  const versionType = process.argv[2];
  
  if (!versionType || !validateVersionType(versionType)) {
    console.error(chalk.red("❌ Invalid version type. Use: patch, minor, or major"));
    process.exit(1);
  }

  console.log(chalk.blue(`🚀 Starting ${versionType} release...`));
  
  // Check if we're on main branch
  const branchResult = runCommand("git", ["branch", "--show-current"]);
  if (!branchResult.success || branchResult.output.trim() !== "main") {
    console.error(chalk.red("❌ Please run releases from the main branch"));
    process.exit(1);
  }
  
  // Check if working directory is clean
  const statusResult = runCommand("git", ["status", "--porcelain"]);
  if (!statusResult.success || statusResult.output.trim() !== "") {
    console.error(chalk.red("❌ Working directory must be clean before release"));
    process.exit(1);
  }
  
  // Pull latest changes
  console.log(chalk.yellow("📥 Pulling latest changes..."));
  const pullResult = runCommand("git", ["pull", "origin", "main"]);
  if (!pullResult.success) {
    console.error(chalk.red("❌ Failed to pull latest changes"));
    process.exit(1);
  }
  
  // Run tests
  console.log(chalk.yellow("🧪 Running tests..."));
  const testResult = runCommand("bun", ["test"]);
  if (!testResult.success) {
    console.error(chalk.red("❌ Tests failed. Cannot proceed with release."));
    process.exit(1);
  }
  
  // Build
  console.log(chalk.yellow("🔨 Building package..."));
  const buildResult = runCommand("bun", ["run", "build"]);
  if (!buildResult.success) {
    console.error(chalk.red("❌ Build failed. Cannot proceed with release."));
    process.exit(1);
  }
  
  const currentVersion = getCurrentVersion();
  console.log(chalk.blue(`📦 Current version: ${currentVersion}`));
  
  // Bump version using bun
  console.log(chalk.yellow(`⬆️ Bumping ${versionType} version...`));
  const versionResult = runCommand("bun", ["version", `--${versionType}`]);
  if (!versionResult.success) {
    console.error(chalk.red(`❌ Failed to bump ${versionType} version`));
    process.exit(1);
  }
  
  const newVersion = getCurrentVersion();
  console.log(chalk.green(`✅ Version bumped: ${currentVersion} → ${newVersion}`));
  
  // Create git tag
  const tag = `v${newVersion}`;
  console.log(chalk.yellow(`🏷️ Creating git tag: ${tag}`));
  const tagResult = runCommand("git", ["tag", tag]);
  if (!tagResult.success) {
    console.error(chalk.red(`❌ Failed to create git tag: ${tag}`));
    process.exit(1);
  }
  
  // Push changes and tags
  console.log(chalk.yellow("📤 Pushing changes and tags..."));
  const pushResult = runCommand("git", ["push", "origin", "main", "--tags"]);
  if (!pushResult.success) {
    console.error(chalk.red("❌ Failed to push changes and tags"));
    process.exit(1);
  }
  
  console.log(chalk.green("✅ Release process completed successfully!"));
  console.log(chalk.blue(`🎉 Release ${tag} has been created and pushed to GitHub`));
  console.log(chalk.gray("GitHub Actions will now handle publishing to npm automatically."));
  console.log(chalk.gray(`Monitor the release at: https://github.com/elitan/pgterra/releases/tag/${tag}`));
}

main().catch((error) => {
  console.error(chalk.red("❌ Release failed:"), error);
  process.exit(1);
});