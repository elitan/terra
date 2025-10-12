import chalk from "chalk";
import boxen from "boxen";

export class OutputFormatter {
  /**
   * Format SQL statements in a clean box
   */
  static box(statements: string[]): string {
    if (statements.length === 0) return '';

    const content = statements
      .map(stmt => chalk.gray(stmt))
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
    return `\n  ${title}`;
  }

  /**
   * Format warning section header
   */
  static warningSection(title: string): string {
    return chalk.gray(`\n  ⚠ ${title}`);
  }

  /**
   * Format summary line
   */
  static summary(text: string): string {
    return `→ ${text}`;
  }
}
