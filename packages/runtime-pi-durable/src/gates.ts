/**
 * One gate per tool call. A tool waits at its gate; the runtime opens it once the supervisor has consumed the
 * message that holds the call (persist before act). Closing rejects waiters so an abandoned run runs no tool.
 */
export class Gates {
  readonly #gates = new Map<string, PromiseWithResolvers<void>>();

  #gate(callId: string): PromiseWithResolvers<void> {
    let gate = this.#gates.get(callId);
    if (!gate) {
      gate = Promise.withResolvers<void>();
      // A gate nobody waits on must not become an unhandled rejection when closed.
      gate.promise.catch(() => {});
      this.#gates.set(callId, gate);
    }
    return gate;
  }

  wait(callId: string): Promise<void> {
    return this.#gate(callId).promise;
  }

  open(callId: string): void {
    this.#gate(callId).resolve();
  }

  closeAll(reason: Error): void {
    for (const gate of this.#gates.values()) gate.reject(reason);
  }
}
