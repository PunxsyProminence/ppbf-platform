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
  /* There is deliberately no toHaveScreenshot tolerance here because there are
     no screenshot baselines left to tolerate. The reasoning is written out at
     the top of e2e/public-homepage.spec.ts; the short version is that Chromium
     shaping moves wrap points between revisions by roughly the same number of
     pixels a real regression does, so no ratio separates them. Re-adding a
     baseline means pinning the browser revision in the container first. */
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
