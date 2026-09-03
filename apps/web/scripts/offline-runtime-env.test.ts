import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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
    })})`);

    for (const key of keys) {
      expect(env).toHaveProperty(key, '');
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