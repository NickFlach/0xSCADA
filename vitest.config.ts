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
            "{server,cli,shared}/**/*.{test,spec}.{ts,tsx}",
            "test/**/*.{test,spec}.{ts,tsx}",
          ],
          // test/integration/** spawns a live server (DB-backed); it has its
          // own `npm run test:integration` script and is excluded from the
          // default in-process unit/integration run.
          exclude: ["**/node_modules/**", "**/dist/**", "test/integration/**"],
        },
      },
    ],
  },
});
