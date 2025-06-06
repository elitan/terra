import chalk from "chalk";

export class Logger {
  static info(message: string) {
    console.log(chalk.blue(message));
  }

  static success(message: string) {
    console.log(chalk.green(message));
  }

  static warning(message: string) {
    console.log(chalk.yellow(message));
  }

  static error(message: string) {
    console.error(chalk.red(message));
  }

  static cyan(message: string) {
    console.log(chalk.cyan(message));
  }
}
