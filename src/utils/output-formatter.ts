import chalk from "chalk";
import boxen from "boxen";
import { Logger } from "./logger";

function maybeColor(
  colorFn: (text: string) => string,
  text: string
): string {
  if (!Logger.isColorEnabled()) {
    return text;
  }
  return colorFn(text);
}

export class OutputFormatter {
  /**
   * Format SQL statements in a clean box
   */
  static box(statements: string[]): string {
    if (Logger.isSilent()) return '';
    if (statements.length === 0) return '';

    const content = statements
      .map((stmt) => maybeColor(chalk.gray, stmt))
      .join('\n\n');

    return boxen(content, {
      padding: 0,
      margin: { left: 2 },
      borderStyle: 'round',
      borderColor: 'gray',
      dimBorder: true
    });
  }

  /**
   * Format section header
   */
  static section(title: string): string {
    if (Logger.isSilent()) return '';
    return `\n  ${title}`;
  }

  /**
   * Format warning section header
   */
  static warningSection(title: string): string {
    if (Logger.isSilent()) return '';
    return maybeColor(chalk.gray, `\n  ⚠ ${title}`);
  }

  /**
   * Format summary line
   */
  static summary(text: string): string {
    if (Logger.isSilent()) return '';
    return `→ ${text}`;
  }
}
