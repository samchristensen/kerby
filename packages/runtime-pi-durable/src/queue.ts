/** An unbounded FIFO a producer pushes to and one consumer awaits. */
export class AsyncQueue<T> {
  readonly #items: T[] = [];
  #waiting: ((item: T) => void) | undefined;

  push(item: T): void {
    if (this.#waiting) {
      const waiting = this.#waiting;
      this.#waiting = undefined;
      waiting(item);
    } else this.#items.push(item);
  }

  next(): Promise<T> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve(item);
    const { promise, resolve } = Promise.withResolvers<T>();
    this.#waiting = resolve;
    return promise;
  }
}
