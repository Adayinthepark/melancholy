import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  use: { baseURL: "http://127.0.0.1:3017", headless: true },
  workers: 1,
  webServer: {
    command: "npm run db:local && npm run dev -- --host 127.0.0.1 --port 3017",
    url: "http://127.0.0.1:3017/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 90000,
  },
});
