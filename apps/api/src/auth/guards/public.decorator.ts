import { SetMetadata } from '@nestjs/common';

/** Metadata key for {@link Public}. */
export const IS_PUBLIC = 'reef:public';

/**
 * Opts a route out of authentication. Every other route requires a valid session: the global
 * auth guard denies by default (CLAUDE.md).
 *
 * @returns A method or class decorator.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
