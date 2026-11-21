import { SetMetadata } from '@nestjs/common';

/** Metadata key for {@link MoneyRoute}. */
export const MONEY_ROUTE = 'reef:money-route';

/**
 * Marks a route that moves money. CLAUDE.md: every money-moving operation carries an
 * idempotency key. The route then requires an `Idempotency-Key` header and an authenticated
 * caller, and a retry with the same key replays the first response instead of running again.
 *
 * @returns A method decorator.
 */
export const MoneyRoute = (): MethodDecorator => SetMetadata(MONEY_ROUTE, true);
