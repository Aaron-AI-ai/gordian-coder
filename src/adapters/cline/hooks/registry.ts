/**
 * Hook registry for the Gordian Coder hook system
 */

import type { HookEvent, HookResult, HookHandler, HookName } from "./types";

export class HookRegistry {
  private handlers: Map<HookName, HookHandler[]> = new Map();

  /**
   * Register a handler for a specific hook name.
   */
  register(hookName: HookName, handler: HookHandler): void {
    const existing = this.handlers.get(hookName) ?? [];
    this.handlers.set(hookName, [...existing, handler]);
  }

  /**
   * Unregister a previously registered handler.
   * If the handler is not registered, this is a no-op.
   */
  unregister(hookName: HookName, handler: HookHandler): void {
    const existing = this.handlers.get(hookName) ?? [];
    const filtered = existing.filter((h) => h !== handler);
    this.handlers.set(hookName, filtered);
  }

  /**
   * Dispatch an event to all registered handlers for its hook name.
   * Merges results:
   *   - cancel: logical OR across all handlers
   *   - errorMessage: last non-empty value wins
   *   - contextModification: concatenated with newline separator
   * If a handler throws, the error is caught and stored in errorMessage.
   */
  async dispatch(event: HookEvent): Promise<HookResult> {
    const handlers = this.handlers.get(event.hookName) ?? [];
    let cancel = false;
    let errorMessage = "";
    const contextParts: string[] = [];

    for (const handler of handlers) {
      try {
        const handlerResult = await handler(event);

        // cancel is a logical OR
        if (handlerResult.cancel) {
          cancel = true;
        }

        // last non-empty errorMessage wins
        if (handlerResult.errorMessage) {
          errorMessage = handlerResult.errorMessage;
        }

        // contextModification is concatenated
        if (handlerResult.contextModification) {
          contextParts.push(handlerResult.contextModification);
        }
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      cancel,
      errorMessage,
      contextModification: contextParts.join("\n"),
    };
  }

  /**
   * Returns true if there is at least one handler registered for the hook name.
   */
  hasHandlers(hookName: HookName): boolean {
    return (this.handlers.get(hookName) ?? []).length > 0;
  }

  /**
   * Returns the number of handlers registered for the hook name.
   */
  getHandlerCount(hookName: HookName): number {
    return (this.handlers.get(hookName) ?? []).length;
  }
}

/** Singleton default registry shared across the application */
export const defaultRegistry = new HookRegistry();

/**
 * Convenience function to register a hook handler on the default registry.
 */
export function registerHook(hookName: HookName, handler: HookHandler): void {
  defaultRegistry.register(hookName, handler);
}
