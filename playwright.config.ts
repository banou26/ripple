import { defineConfig, devices } from '@playwright/test'

/**
 * The port the built app is served on for a test run.
 *
 * Overridable because 4560 is also the dev server's port, and `reuseExistingServer: false` means a
 * run started while `npm run dev` is up fails with "Timed out waiting from config.webServer" rather
 * than with anything that names the conflict. Set RIPPLE_TEST_PORT to run alongside one.
 */
const PORT = process.env.RIPPLE_TEST_PORT || '4560'

export default defineConfig({
  testDir: './tests',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: 'line',
  outputDir: 'test-results/ramp',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: process.env.RIPPLE_BENCH_TRACE === '1' ? 'retain-on-failure' : 'off',
  },
  webServer: {
    command: `npx serve -s -C -p ${PORT} build`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // --mute-audio because the torrent ramp runs headful and plays real video
        launchOptions: { args: ['--enable-experimental-web-platform-features', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: {
            'media.autoplay.default': 0,
            'media.autoplay.blocking_policy': 0,
            // headful ramp runs play real video
            'media.volume_scale': '0.0',
          },
        },
      },
    },
  ],
})
