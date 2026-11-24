import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // test/wrangler.test.jsonc serves the MCP endpoint without OAuth, against
      // local R2 buckets. Storage is isolated per test file.
      wrangler: { configPath: "./test/wrangler.test.jsonc" },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
