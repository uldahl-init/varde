// Smoke test config (see "Smoke test" in CLAUDE.md). Not part of the app.
const { defineConfig, devices } = require('@playwright/test');
const PORT = 4173;
module.exports = defineConfig({
  testDir: 'tests',
  timeout: 120000,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', {open:'never'}]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    serviceWorkers: 'block',
    actionTimeout: 15000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [{
    name: 'chromium-phone',
    use: {
      ...devices['Desktop Chrome'],
      viewport: {width:390, height:780},
      hasTouch: true,
      // CHROMIUM_PATH lets a machine with its own Chromium run the tests without downloading one.
      launchOptions: process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {}
    }
  }],
  webServer: {
    command: `node tests/server.js`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    env: {PORT: String(PORT)},
    reuseExistingServer: !process.env.CI
  }
});
