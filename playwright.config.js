// @ts-check
import { defineConfig, devices } from '@playwright/test';

/* US-only traffic for ConnectWise:
   Set CW_PROXY to a US-exiting proxy/VPN (http(s)://[user:pass@]host:port) when
   the ConnectWise rollout is gated to a US audience and the test machine's own
   IP is non-US (e.g. the Marketo Country field geo-prefills "PH"). Unset →
   direct traffic, current behaviour. Credentials can also be supplied via
   CW_PROXY_USERNAME / CW_PROXY_PASSWORD. */
const CW_PROXY = process.env.CW_PROXY;
const CW_PROXY_CREDS = CW_PROXY
  ? { username: process.env.CW_PROXY_USERNAME, password: process.env.CW_PROXY_PASSWORD }
  : undefined;

if (CW_PROXY) {
  console.log(`ℹ CW_PROXY set — ConnectWise (cw) requests will use proxy: ${CW_PROXY}`);
}

export default defineConfig({
  testDir: './tests',

  /* Run tests in files sequentially – important for funnel journeys that share state */
  fullyParallel: false,

  /* Fail build on CI if test.only is left in */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only */
  retries: process.env.CI ? 1 : 0,

  /* Single worker keeps session cookies isolated per test */
  workers: 1,

  /* Rich HTML report + console output */
  reporter: [['html', { open: 'never' }], ['list']],

  use: {
    /* All tests run against live sailpoint.com */
    baseURL: 'https://www.sailpoint.com',

    /* Always collect trace so failures are easy to diagnose */
    trace: 'on',

    /* Record video of every test */
    video: 'on',

    /* Collect screenshot on failure */
    screenshot: 'only-on-failure',

    /* Slow down actions by 200ms so the site has time to react */
    actionTimeout: 15_000,
    navigationTimeout: 30_000,

    /* Cloudflare blocks default headless Chromium (HTTP 403 "Attention Required").
       Disable the automation fingerprint + use a real Chrome UA so the site
       serves the actual page (and SPZ) instead of a block page. */
    launchOptions: {
      args: ['--disable-blink-features=AutomationControlled'],
    },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  },

  projects: [
    {
      name: 'sp',
      testDir: './tests/sailpoint',
      use: { ...devices['Desktop Chrome'], headless: true },
    },
    {
      name: 'bhr',
      testDir: './tests/bamboohr',
      use: { ...devices['Desktop Chrome'], headless: false },
    },
    {
      name: 'iso',
      testDir: './tests/insightsoftware',
      use: { ...devices['Desktop Chrome'], headless: true },
    },
    {
      name: 'cw',
      testDir: './tests/connectwise',
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
        // Route ConnectWise traffic through a US-exiting proxy when CW_PROXY is set
        proxy: CW_PROXY ? { server: CW_PROXY, ...CW_PROXY_CREDS } : undefined,
      },
    },
    {
      name: 'goddard',
      testDir: './tests/goddard',
      use: { ...devices['Desktop Chrome'], headless: true },
    },
    // Uncomment to also run on Firefox / Safari
    // { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // { name: 'webkit',  use: { ...devices['Desktop Safari'] }  },
  ],
});
