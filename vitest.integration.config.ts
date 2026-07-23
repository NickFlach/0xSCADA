import { defineConfig } from "vitest/config";
import path from "path";

const alias = {
  "@": path.resolve(__dirname, "client/src"),
  "@shared": path.resolve(__dirname, "shared"),
};

// Keep DB-backed process tests out of the default unit-test projects while
// giving the Integration Tests CI job an explicit discovery boundary.
export default defineConfig({
  resolve: { alias },
  test: {
    name: "integration",
    environment: "node",
    globals: true,
    include: ["test/integration/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
