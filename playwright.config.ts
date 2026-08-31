import { defineConfig, devices } from '@playwright/test'

/**
 * The port the built app is served on for a test run.
 *
 * Overridable because 4560 is also the dev server's port, and `reuseExistingServer: false` means a
 * run started while `npm run dev` is up fails with "Timed out waiting from config.webServer" rather
 * than with anything that names the conflict. Set RIPPLE_TEST_PORT to run alongside one.
 */
const PORT = process.env.RIPPLE_TEST_PORT || '4560'

/**
 * A full base URL to run against instead of a locally served build, for verifying a DEPLOY.
 *
 * The point is that a build marker changing proves bytes arrived and nothing else. Pointing the real
 * specs at the deployed origin is what proves the change is reachable, and it needs no webServer,
 * so setting this turns that off rather than leaving a server nothing talks to.
 */
const BASE_URL = process.env.RIPPLE_TEST_BASE_URL

export default defineConfig({
  testDir: './tests',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: 'line',
  outputDir: 'test-results/ramp',
  use: {
    baseURL: BASE_URL ?? `http://127.0.0.1:${PORT}`,
    trace: process.env.RIPPLE_BENCH_TRACE === '1' ? 'retain-on-failure' : 'off',
  },
  webServer: BASE_URL
    ? undefined
    : {
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
