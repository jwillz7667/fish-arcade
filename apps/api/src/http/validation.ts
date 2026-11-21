import { StandardSchemaValidationPipe } from '@nestjs/common';
import { ValidationError, type ValidationIssue } from '@reef/errors';

interface StandardIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

function pathOf(issue: StandardIssue): string {
  return (issue.path ?? [])
    .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
    .join('.');
}

/**
 * Turns Standard Schema issues into a ValidationError. Messages come from zod and describe the
 * expected shape, never the submitted value.
 *
 * @param issues Issues from the schema.
 * @returns The error to throw.
 */
export function validationErrorFrom(issues: readonly StandardIssue[]): ValidationError {
  const mapped: ValidationIssue[] = issues.map((issue) => ({
    path: pathOf(issue),
    message: issue.message,
  }));
  return new ValidationError({ message: 'Request validation failed', issues: mapped });
}

/**
 * The global validation pipe (playbook Step 5). Routes declare schemas with
 * `@Body({ schema })` / `@Query({ schema })`; values arrive parsed and typed.
 *
 * @returns The pipe to register globally.
 */
export function createValidationPipe(): StandardSchemaValidationPipe {
  return new StandardSchemaValidationPipe({ exceptionFactory: validationErrorFrom });
}
