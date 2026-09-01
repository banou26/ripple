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
  /*
   * ONLY the .spec.ts files, because the unit tests moved in here too.
   *
   * Playwright's default testMatch takes BOTH suffixes, spec and test alike, so with both kinds of
   * test under one directory it would pick up all 72 vitest files and fail them on an import of
   * vitest.
   * The two suites are told apart by their suffix: .spec.ts is driven through a browser here,
   * .test.ts runs under vitest.
   */
  testMatch: '**/*.spec.ts',
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
        launchOptions: {
          args: ['--enable-experimental-web-platform-features', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
          /*
           * The system Chrome, when one is named, for the same reason vite.config.ts finds one.
           *
           * Playwright's own browser download does not work on NixOS, so the browsers come from the
           * store instead, and a store built for one playwright version carries a build number the
           * next one does not ask for: 1.58 looks for chromium-1208 beside a store holding 1228 and
           * fails with "Executable doesn't exist", which reads like a missing install rather than a
           * version skew. Env-gated, so a runner with its own browsers is untouched.
           */
          executablePath: process.env.RIPPLE_CHROME || undefined,
        },
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
