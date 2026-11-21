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

/** Metadata key for {@link OptionalAuth}. */
export const IS_AUTH_OPTIONAL = 'reef:auth-optional';

/**
 * Authenticates the caller when credentials are sent, and lets anonymous callers through.
 * Credentials that are sent but invalid are still refused. The handler decides what anonymous
 * callers may do.
 *
 * @returns A method decorator.
 */
export const OptionalAuth = (): MethodDecorator => SetMetadata(IS_AUTH_OPTIONAL, true);
