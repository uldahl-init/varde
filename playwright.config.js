// Smoke test config (see "Smoke test" in CLAUDE.md). Not part of the app.
const { defineConfig, devices } = require('@playwright/test');
const PORT = 4173;
module.exports = defineConfig({
  testDir: 'tests',
  timeout: 120000,
  forbidOnly: !!process.env.CI,
  // Build 104: on GitHub a test that fails is run once more, since several pull requests went red and then green on
  // «Re-run failed jobs» with no change. A test that passes the second time is reported as flaky in the log, not hidden.
  retries: process.env.CI ? 1 : 0,
  // Build 84: every test in parallel (one file would otherwise run one test at a time); GitHub gives public repositories 4 cores.
  fullyParallel: true,
  workers: process.env.CI ? 4 : undefined,
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
