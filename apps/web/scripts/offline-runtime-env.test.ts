import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const helperUrl = pathToFileURL(
  path.resolve(__dirname, 'lib/offline-runtime-env.mjs'),
).href;

function evaluate(expression: string) {
  const script = `
    import * as m from ${JSON.stringify(helperUrl)};
    const value = await (${expression});
    process.stdout.write(JSON.stringify(value ?? null));
  `;

  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }));
}

describe('offline runtime environment boundary', () => {
  test('inherits only operating-system execution variables', () => {
    const env = evaluate(`m.buildOfflineChildEnv(${JSON.stringify({
      Path: 'C:\\Windows\\System32',
      TEMP: 'C:\\Temp',
      USERPROFILE: 'C:\\Users\\offline',
      SOME_APPLICATION_SECRET: 'must-not-survive',
      NODE_OPTIONS: '--require malicious-preload.cjs',
    })})`);

    expect(env.Path).toBe('C:\\Windows\\System32');
    expect(env.TEMP).toBe('C:\\Temp');
    expect(env.USERPROFILE).toBe('C:\\Users\\offline');
    expect(env.SOME_APPLICATION_SECRET).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  test('all known external-service keys are explicitly blank', () => {
    const keys = evaluate('[...m.BLOCKED_EXTERNAL_ENV_KEYS]');
    const env = evaluate(`m.buildOfflineChildEnv(${JSON.stringify({
      PPBF_MS_CLIENT_SECRET: 'real-ms-secret',
      GOOGLE_SERVICE_ACCOUNT_JSON: '{"private_key":"real-google-secret"}',
      DATAVERSE_ORG_URL: 'https://example.crm.dynamics.com',
      GRAPH_CLIENT_SECRET: 'real-graph-secret',
      AZURE_AI_ENDPOINT: 'https://example.openai.azure.com',
      PAYMENT_PLATFORM_SECRET_KEY: 'real-payment-secret',
      // F1: a browser-facing value, not a credential, but the same escape
      // shape -- an external NEXT_PUBLIC_API_BASE inherited here would route
      // offline browser traffic to that origin.
      NEXT_PUBLIC_API_BASE: 'https://app-ppbf-production.example.invalid',
    })})`);

    for (const key of keys) {
      expect(env).toHaveProperty(key, '');
    }

    // Explicit beyond the generic loop above: this is the exact property F1
    // depends on, named directly so a future reader does not have to infer
    // it from BLOCKED_EXTERNAL_ENV_KEYS's contents.
    expect(env).toHaveProperty('NEXT_PUBLIC_API_BASE', '');
  });

  test('a real .env.local cannot repopulate NEXT_PUBLIC_API_BASE once the offline child environment blanks it', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-offline-env-f1-'));
    try {
      fs.writeFileSync(
        path.join(tempDir, '.env.local'),
        'NEXT_PUBLIC_API_BASE=https://app-ppbf-production.example.invalid\n',
      );

      const script = `
        import { buildOfflineChildEnv } from ${JSON.stringify(helperUrl)};
        import nextEnv from '@next/env';
        const { loadEnvConfig } = nextEnv;

        // Exactly what the offline child receives at spawn: buildOfflineChildEnv's
        // output becomes this process's own process.env, the same way Node's
        // child_process.spawn({ env }) replaces a child's entire environment.
        const childEnv = buildOfflineChildEnv({ PATH: process.env.PATH });
        for (const [key, value] of Object.entries(childEnv)) {
          process.env[key] = value;
        }

        loadEnvConfig(${JSON.stringify(tempDir)}, true, console, true);
        process.stdout.write(JSON.stringify({ finalValue: process.env.NEXT_PUBLIC_API_BASE }));
      `;

      const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      }));

      // The real, installed @next/env loader read the disposable .env.local
      // above and still could not adopt its value: NEXT_PUBLIC_API_BASE was
      // already present (blank) in process.env before loadEnvConfig ran, and
      // @next/env's own precedence rule never overrides an already-defined key.
      expect(result.finalValue).toBe('');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('launcher uses the fail-closed environment and does not inherit NODE_OPTIONS', () => {
    const launcher = fs.readFileSync(path.resolve(__dirname, 'offline-runtime.mjs'), 'utf8');

    expect(launcher).toContain("import { buildOfflineChildEnv } from './lib/offline-runtime-env.mjs';");
    expect(launcher).toContain('...buildOfflineChildEnv(process.env),');
    expect(launcher).not.toContain('...process.env,');
    expect(launcher).not.toContain('process.env.NODE_OPTIONS');
    expect(launcher).toContain("AZURE_POSTGRES_CONNECTION_STRING: connectionString");
    expect(launcher).toContain("PPBF_OFFLINE_RUNTIME: 'true'");
  });
});