import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Flush promise continuations without relying on wall-clock delays.
export const tick = () => setImmediate();

export class Inbox<T> {
  readonly messages: T[] = [];
  private waiters = new Set<() => void>();

  push(message: T) {
    this.messages.push(message);
    for (const notify of this.waiters) notify();
  }

  async wait(predicate: (message: T) => boolean): Promise<T> {
    let found = this.messages.find(predicate);
    if (found) return found;
    let notify!: () => void;
    const received = new Promise<void>((resolve) => {
      notify = () => {
        found = this.messages.find(predicate);
        if (found) resolve();
      };
      this.waiters.add(notify);
    });
    // Bound a failed test even if a runtime regression loses a response.
    let timer!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        received,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Missing worker response")),
            2000,
          );
        }),
      ]);
      assert(found);
      return found;
    } finally {
      clearTimeout(timer);
      this.waiters.delete(notify);
    }
  }
}
