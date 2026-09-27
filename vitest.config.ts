import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration suites rebuild shared forks and use local network fixtures.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html"],
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/*.test.ts"],
          setupFiles: ["tests/setup.ts"],
        },
      },
      {
        extends: true,
        test: { name: "go", include: ["tests/*.integration.ts"] },
      },
      { extends: true, test: { name: "browser", include: ["tests/*.e2e.ts"] } },
      {
        extends: true,
        test: { name: "benchmark", include: ["tests/*.benchmark.ts"] },
      },
    ],
  },
});
