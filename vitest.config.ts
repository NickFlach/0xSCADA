import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

const alias = {
  "@": path.resolve(__dirname, "client/src"),
  "@shared": path.resolve(__dirname, "shared"),
};

// Tests span two runtimes: React components need a DOM, while the server/CLI
// suites are plain Node. vite.config.ts pins `root: "client"` for the dev
// server, which would otherwise hide every test outside client/ — so test
// discovery is configured here at the repo root instead.
export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    projects: [
      {
        resolve: { alias },
        plugins: [react()],
        test: {
          name: "client",
          environment: "jsdom",
          globals: true,
          include: ["client/**/*.{test,spec}.{ts,tsx}"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "node",
          environment: "node",
          globals: true,
          include: [
            "{server,cli,shared,gateway}/**/*.{test,spec}.{ts,tsx}",
            "test/**/*.{test,spec}.{ts,tsx}",
          ],
          // Excluded from the default unit run (they belong to the separate
          // Integration Tests job): test/integration/** spawns a live
          // DB-backed server; cli/__tests__/e2e/** spawns the CLI binary
          // against a mock server (skipIf(isWindows), so Windows-skipped
          // locally) and needs the full CLI surface.
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "test/integration/**",
            "cli/__tests__/e2e/**",
            "cli/__tests__/integration/**",
          ],
        },
      },
    ],
  },
});
