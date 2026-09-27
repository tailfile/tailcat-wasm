import { beforeEach, vi } from "vitest";

// Restore before the next test so fixture onTestFinished callbacks can still
// close resources with the clock and spies used to create them.
beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
