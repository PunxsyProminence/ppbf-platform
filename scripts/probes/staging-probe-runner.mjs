#!/usr/bin/env node

const targetUrl = (process.env.TARGET_URL || 'http://localhost:3000').replace(/\/$/, '');
const endpoint = `${targetUrl}/api/pilot/auth/session`;

async function runProbe() {
  console.log(`Pinging TARGET_URL... ${endpoint}`);

  const controller = new AbortController();
  const timeoutMs = 10000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });

    clearTimeout(timeoutId);
    console.log(`Received status: ${response.status}`);

    if (response.status >= 500) {
      console.error('Probe Failed: endpoint returned a server error status.');
      process.exit(1);
      return;
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      console.error('Probe Failed: endpoint did not return valid JSON.');
      process.exit(1);
      return;
    }

    if (typeof payload !== 'object' || payload === null) {
      console.error('Probe Failed: JSON payload was not an object.');
      process.exit(1);
      return;
    }

    console.log('Probe Passed');
    process.exit(0);
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      console.error(`Probe Failed: request timed out after ${timeoutMs}ms.`);
    } else {
      console.error('Probe Failed: network error while calling endpoint.');
      if (error instanceof Error) {
        console.error(error.message);
      }
    }
    process.exit(1);
  }
}

void runProbe();
