// Playwright Test configuration. Run with `npm test` (or `npx playwright test`).
// The app has no build step; the tests load it from a local static server.
const { defineConfig } = require('@playwright/test');

const PORT = 8140;

module.exports = defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    // "localhost", not 127.0.0.1: same origin the launcher uses, and a secure
    // context (needed for the service worker and the file system API).
    baseURL: `http://localhost:${PORT}/`,
    browserName: 'chromium',
    colorScheme: 'light',
    viewport: { width: 1000, height: 700 },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1 --directory app`,
    url: `http://localhost:${PORT}/`,
    cwd: __dirname,
    reuseExistingServer: false,
    stderr: 'ignore',
    timeout: 20_000,
  },
});
