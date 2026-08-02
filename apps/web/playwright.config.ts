import { defineConfig, devices } from '@playwright/test';

/* Some sandboxes and dev containers ship a Chromium that is already built and
   pinned to a different revision than this workspace's @playwright/test wants,
   and cannot download the matching one. Pointing PPBF_CHROMIUM_PATH at that
   binary lets the suite run there. CI installs the matching revision and leaves
   this unset, so it changes nothing in the pipeline. */
const localChromium = process.env.PPBF_CHROMIUM_PATH;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'on-first-retry',
    ...(localChromium ? { launchOptions: { executablePath: localChromium } } : {}),
  },
  /* Screenshot baselines are committed per-platform, but Chromium's text
     rasterisation shifts slightly between revisions, so a baseline recorded on
     one build shows a thin halo of changed pixels against another even when
     nothing about the page moved. A small ratio absorbs that without absorbing
     anything real: a font size change, a padding change or a colour change all
     move far more than 2% of a full-page shot. */
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: {
    command: 'npm run dev -- --port 3100',
    url: 'http://localhost:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
