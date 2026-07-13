import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appRoot = path.resolve(__dirname, '..');
const outRoot = path.join(appRoot, 'out');

const boardMembers = [
  'president',
  'chair',
  'vice-chair',
  'treasurer',
  'secretary',
  'safety-director',
  'community-director',
  'at-large',
];

function ensureBoardIndexAliases() {
  for (const member of boardMembers) {
    const htmlFile = path.join(outRoot, 'board', `${member}.html`);
    const indexDir = path.join(outRoot, 'board', member);
    const indexFile = path.join(indexDir, 'index.html');

    if (!fs.existsSync(htmlFile)) {
      continue;
    }

    fs.mkdirSync(indexDir, { recursive: true });
    fs.copyFileSync(htmlFile, indexFile);
  }
}

function copySwaConfig() {
  const configFile = path.join(appRoot, 'staticwebapp.config.json');
  const outConfigFile = path.join(outRoot, 'staticwebapp.config.json');

  if (!fs.existsSync(configFile)) {
    return;
  }

  fs.copyFileSync(configFile, outConfigFile);
}

ensureBoardIndexAliases();
copySwaConfig();
