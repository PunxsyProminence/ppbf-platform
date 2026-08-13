import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const entrypointDocuments = ['README.md', 'MASTER_INDEX.md'];
const noHttpDdlRule = /No\s+HTTP\s+route\s+changes\s+the\s+schema/;

const failures = entrypointDocuments.filter((document) => {
  const content = fs.readFileSync(path.join(repositoryRoot, document), 'utf8');
  return !noHttpDdlRule.test(content);
});

if (failures.length > 0) {
  console.error(
    'Critical entrypoint contract missing: "No HTTP route changes the schema."',
  );

  for (const document of failures) {
    console.error(`- ${document}`);
  }

  process.exit(1);
}

console.log(
  `Entrypoint contracts verified: ${entrypointDocuments.join(', ')}`,
);
