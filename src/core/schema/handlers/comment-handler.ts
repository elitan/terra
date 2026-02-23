import type { Comment } from "../../../types/schema";
import { Logger } from "../../../utils/logger";
import { SQLBuilder } from "../../../utils/sql-builder";

export class CommentHandler {
  generateStatements(desiredComments: Comment[], currentComments: Comment[]): string[] {
    const statements: string[] = [];
    const currentCommentMap = new Map(
      currentComments.map(c => [this.getCommentKey(c), c])
    );
    const desiredCommentMap = new Map(
      desiredComments.map(c => [this.getCommentKey(c), c])
    );

    for (const currentComment of currentComments) {
      const key = this.getCommentKey(currentComment);
      if (!desiredCommentMap.has(key)) {
        const sql = this.generateDropCommentSQL(currentComment);
        statements.push(sql);
        Logger.info(`Dropping comment on ${currentComment.objectType} '${currentComment.objectName}'`);
      }
    }

    for (const desiredComment of desiredComments) {
      const key = this.getCommentKey(desiredComment);
      const currentComment = currentCommentMap.get(key);

      if (!currentComment || currentComment.comment !== desiredComment.comment) {
        const sql = this.generateCommentSQL(desiredComment);
        statements.push(sql);
        Logger.info(`${currentComment ? 'Updating' : 'Creating'} comment on ${desiredComment.objectType} '${desiredComment.objectName}'`);
      } else {
        Logger.info(`Comment on ${desiredComment.objectType} '${desiredComment.objectName}' is up to date, skipping`);
      }
    }

    return statements;
  }

  private getCommentKey(comment: Comment): string {
    if (comment.objectType === 'COLUMN') {
      const schemaPrefix = comment.schemaName || 'public';
      return `${comment.objectType}:${schemaPrefix}.${comment.objectName}.${comment.columnName}`;
    }
    return `${comment.objectType}:${comment.schemaName || 'public'}.${comment.objectName}`;
  }

  private generateCommentSQL(comment: Comment): string {
    const escapedComment = comment.comment.replace(/'/g, "''");
    const builder = this.buildCommentStatement(comment);
    builder.p(`IS '${escapedComment}'`);
    return builder.build() + ';';
  }

  private generateDropCommentSQL(comment: Comment): string {
    const builder = this.buildCommentStatement(comment);
    builder.p("IS NULL");
    return builder.build() + ';';
  }

  private buildCommentStatement(comment: Comment): SQLBuilder {
    const builder = new SQLBuilder().p("COMMENT ON");

    if (comment.objectType === 'SCHEMA') {
      builder.p("SCHEMA").ident(comment.objectName);
    } else if (comment.objectType === 'COLUMN') {
      builder.p("COLUMN").table(comment.objectName, comment.schemaName);
      builder.rewriteLastChar('.');
      builder.ident(comment.columnName!);
    } else {
      builder.p(comment.objectType).table(comment.objectName, comment.schemaName);
    }

    return builder;
  }
}
