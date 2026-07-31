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

// \s* spans newlines: a call whose URL sat on its own line ("fetch(\n  '/api/...")
// slipped through a line-by-line scan for a year. The scan below is whole-file
// for that reason.
const BARE_API_FETCH = /fetch\(\s*['"`]\/api\//g;

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
      const source = fs.readFileSync(filePath, 'utf8');
      for (const match of source.matchAll(BARE_API_FETCH)) {
        const matchIndex = match.index ?? 0;
        const lineNumber = source.slice(0, matchIndex).split('\n').length;
        const relative = path.relative(WEB_ROOT, filePath).split(path.sep).join('/');
        offenders.push(`${relative}:${lineNumber}: ${match[0].replace(/\s+/g, ' ')}`);
      }
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

// Prefixing with apiBase() is necessary but not sufficient: cross-origin, a
// fetch without credentials never sends the session cookie (and never stores
// one from a response), so the call 401s no matter how correct the URL is.
// This is how /admin/shadow failed in production (#39) and how the PIN page
// failed (#79), and a behavioral audit then found 31 more sites. Every
// apiBase() fetch must state credentials; deliberately public endpoints are
// allowlisted here BY FILE with the reason recorded.
const PUBLIC_FETCH_ALLOWLIST = new Set([
  // The public-interest form is submitted by signed-out visitors by design.
  'app/public/page.tsx',
]);

test('every apiBase() fetch states credentials (public endpoints allowlisted)', () => {
  const offenders: string[] = [];
  const API_BASE_FETCH = /fetch\(\s*`\$\{apiBase\(\)\}[^`]*`/g;

  for (const scanRoot of SCAN_ROOTS) {
    const absoluteRoot = path.join(WEB_ROOT, scanRoot);
    if (!fs.existsSync(absoluteRoot)) continue;

    for (const filePath of collectSourceFiles(absoluteRoot)) {
      // Normalized to forward slashes before the allowlist check. path.relative
      // returns backslashes on Windows, so 'app/public/page.tsx' never matched
      // there and the deliberately-public form was reported as an offender --
      // green in CI (ubuntu), failing on every Windows run.
      const relative = path.relative(WEB_ROOT, filePath).split(path.sep).join('/');
      if (PUBLIC_FETCH_ALLOWLIST.has(relative)) continue;
      const source = fs.readFileSync(filePath, 'utf8');
      for (const match of source.matchAll(API_BASE_FETCH)) {
        const matchIndex = match.index ?? 0;
        const optionsEnd = matchIndex + match[0].length;
        const optionsWindow = source.slice(optionsEnd, optionsEnd + 240).split(');')[0];
        if (!optionsWindow.includes('credentials')) {
          const lineNumber = source.slice(0, matchIndex).split('\n').length;
          offenders.push(`${relative}:${lineNumber}`);
        }
      }
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      "apiBase() fetches without credentials: 'include' found. Cross-origin these "
      + 'never carry the session cookie and always 401 (#39, #79). Add credentials, '
      + 'or allowlist the file here with a reason if the endpoint is deliberately public:\n'
      + offenders.join('\n'),
    );
  }
});
