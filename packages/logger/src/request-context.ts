import { AsyncLocalStorage } from 'node:async_hooks';

/** Values tracked for the lifetime of one request, job, or WebSocket message. */
export interface RequestScope {
  /** Correlates every log line produced while handling the request. */
  readonly requestId: string;
}

/**
 * Holds the current {@link RequestScope} across async boundaries. Create one per process and
 * pass it to both the request middleware and {@link createLogger}.
 */
export class RequestContext {
  readonly #storage = new AsyncLocalStorage<RequestScope>();

  /**
   * Runs `fn` with `scope` as the current request scope.
   *
   * @param scope Scope visible to everything `fn` calls, including async continuations.
   * @param fn Work to run.
   * @returns Whatever `fn` returns.
   */
  run<T>(scope: RequestScope, fn: () => T): T {
    return this.#storage.run(scope, fn);
  }

  /**
   * Makes `scope` current for the rest of the current async execution and everything it
   * starts. For frameworks that expose request hooks rather than a wrapping callback.
   *
   * @param scope Scope to enter.
   */
  enter(scope: RequestScope): void {
    this.#storage.enterWith(scope);
  }

  /**
   * @returns The current request ID, or undefined outside a request scope.
   */
  getRequestId(): string | undefined {
    return this.#storage.getStore()?.requestId;
  }
}
