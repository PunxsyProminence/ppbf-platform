import fs from 'node:fs';
import path from 'node:path';

/**
 * A literal athlete PIN once sat in deploy-staging.yml -- in a PUBLIC
 * repository, against a publicly reachable staging login, on an account the
 * fixture provisioner writes as active. That is a working credential published
 * in source (audit finding PPBF-SEC-002).
 *
 * The gate PIN is now minted per run and masked. This test exists so the
 * literal cannot come back: any *_PIN / *_PASSWORD / *_SECRET / *_KEY in a
 * workflow must be an expression (secrets.*, env.*, vars.*), never a literal.
 */
const WORKFLOW_DIR = path.resolve(__dirname, '../../../../../.github/workflows');

function workflowFiles(): string[] {
  if (!fs.existsSync(WORKFLOW_DIR)) return [];
  return fs.readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
}

describe('workflow credential hygiene', () => {
  const files = workflowFiles();

  test('the workflow directory is found (guard against a silently vacuous test)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files)('%s sets no literal credential value', (file) => {
    const contents = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    const offenders: string[] = [];

    contents.split('\n').forEach((line, index) => {
      // env-style assignment of a credential-looking key
      const match = /^\s*([A-Z0-9_]*(?:PIN|PASSWORD|SECRET|TOKEN|APIKEY|API_KEY|KEY))\s*:\s*(.+?)\s*$/.exec(line);
      if (!match) return;
      const [, key, rawValue] = match;
      const value = rawValue.replace(/^["']|["']$/g, '').trim();

      // Allowed: GitHub expressions, secretref indirection, empty, and the
      // *_NAME/*_REF style keys that name a secret rather than carry one.
      if (
        value.startsWith('${{')
        || value.startsWith('secretref:')
        || value === ''
        || /_(NAME|REF|ID)$/.test(key)
      ) return;

      offenders.push(`${file}:${index + 1} ${key}: ${value.slice(0, 12)}…`);
    });

    expect(offenders).toEqual([]);
  });
});
