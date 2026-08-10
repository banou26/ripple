import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: 'line',
  outputDir: 'test-results/ramp',
  use: {
    baseURL: 'http://127.0.0.1:4560',
    trace: process.env.RIPPLE_BENCH_TRACE === '1' ? 'retain-on-failure' : 'off',
  },
  webServer: {
    command: 'npm run serve',
    url: 'http://127.0.0.1:4560',
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
