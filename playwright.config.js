// @ts-check
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8123',
    viewport: { width: 1400, height: 900 },
    screenshot: 'off',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'python3 -m http.server 8123',
    url: 'http://127.0.0.1:8123',
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
