// Convention gate: no bare-path /api fetches in client code.
//
// The web app deploys two ways, and only one of them forgives a bare path.
// Behind the Container App, fetch('/api/...') resolves same-origin and works.
// On the SWA static export, the page is served from the static host while the
// API lives on the Container App FQDN -- a bare path hits the static host and
// fails. That split is exactly how /admin/shadow returned 401 on every call
// in production (#39) while working locally, and an audit pass later found 39
// more calls across 13 files with the same latent failure. Those were swept
// onto `${apiBase()}/api/...`; this test is what keeps the count at zero.
//
// Scope: production client source under app/, components/, and src/client.
// Test files are excluded -- fixtures may assert on literal '/api/...' URLs.

import fs from 'node:fs';
import path from 'node:path';

const WEB_ROOT = path.resolve(__dirname, '../..');
const SCAN_ROOTS = ['app', 'components', 'src/client'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

const BARE_API_FETCH = /fetch\(\s*['"`]\/api\//;

function isTestFile(filePath: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(filePath);
}

function collectSourceFiles(root: string): string[] {
  const collected: string[] = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collected.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !isTestFile(entry.name)) {
      collected.push(fullPath);
    }
  }
  return collected;
}

test('every client /api fetch goes through apiBase()', () => {
  const offenders: string[] = [];

  for (const scanRoot of SCAN_ROOTS) {
    const absoluteRoot = path.join(WEB_ROOT, scanRoot);
    if (!fs.existsSync(absoluteRoot)) continue;

    for (const filePath of collectSourceFiles(absoluteRoot)) {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (BARE_API_FETCH.test(line)) {
          offenders.push(`${path.relative(WEB_ROOT, filePath)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      'Bare-path /api fetches found. These work same-origin but fail on the SWA '
      + 'static deployment (see #39). Use fetch(`${apiBase()}/api/...`) with '
      + "credentials: 'include' for session-gated routes:\n"
      + offenders.join('\n'),
    );
  }
});
