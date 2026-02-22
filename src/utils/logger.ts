import chalk from "chalk";

function formatWithColor(
  colorFn: (text: string) => string,
  text: string
): string {
  if (!Logger.isColorEnabled()) {
    return text;
  }
  return colorFn(text);
}

export class Logger {
  private static silentOutput =
    process.env.TERRADB_TEST_SILENT === "1" ||
    process.env.TERRADB_SILENT_OUTPUT === "1";

  private static colorOutput =
    process.env.NO_COLOR !== "1" && process.env.FORCE_COLOR !== "0";

  static setSilent(value: boolean) {
    Logger.silentOutput = value;
  }

  static isSilent(): boolean {
    return Logger.silentOutput;
  }

  static setColorEnabled(value: boolean) {
    Logger.colorOutput = value;
    if (!value) {
      process.env.NO_COLOR = "1";
      process.env.FORCE_COLOR = "0";
      chalk.level = 0;
    }
  }

  static isColorEnabled(): boolean {
    return Logger.colorOutput;
  }

  static info(message: string) {
    if (Logger.silentOutput) {
      return;
    }
    console.log(formatWithColor(chalk.blue, message));
  }

  static success(message: string) {
    if (Logger.silentOutput) {
      return;
    }
    console.log(formatWithColor(chalk.green, message));
  }

  static warning(message: string) {
    if (Logger.silentOutput) {
      return;
    }
    console.log(formatWithColor(chalk.yellow, message));
  }

  static error(message: string) {
    if (Logger.silentOutput) {
      return;
    }
    console.error(formatWithColor(chalk.red, message));
  }

  static cyan(message: string) {
    if (Logger.silentOutput) {
      return;
    }
    console.log(formatWithColor(chalk.cyan, message));
  }

  static print(message: string) {
    if (Logger.silentOutput) {
      return;
    }
    console.log(message);
  }
}
