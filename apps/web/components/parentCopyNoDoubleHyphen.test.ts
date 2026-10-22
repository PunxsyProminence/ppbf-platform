import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * PARENT PORTAL WALK 2026-10-19, ITEM 12: a parent read "--" in the safety and
 * SHADOW copy. In source, " -- " is how this repo writes a dash in a comment,
 * and it was copied into strings a family reads. The characters in rendered
 * text are an em dash.
 *
 * This reads the string literals and JSX text of the screens a guardian sees
 * (comments are not strings, so they are free to keep their style) and fails on
 * a standalone "--". BEM class names ("btn--ghost") and CSS variables
 * ("var(--s4)") have no space around the hyphens and do not match.
 */
const WEB_ROOT = path.resolve(__dirname, '..');

const FILES = [
  'app/parent/safety/page.tsx',
  'app/parent/consent/page.tsx',
  'app/parent/video/page.tsx',
  'app/parent/development-blocks/page.tsx',
  'app/parent/mental-skills/page.tsx',
  'app/parent/progression-visibility/page.tsx',
  'components/ParentHub.tsx',
  'components/ParentObservations.tsx',
  'components/ParentDigest.tsx',
  'components/ParentFamilyGoals.tsx',
  'components/ParentAssignmentList.tsx',
  'components/ParentProgressSummary.tsx',
  'components/ParentResources.tsx',
  'components/RoleSummaryPanels.tsx',
  'components/MyInjuries.tsx',
];

const STANDALONE_DOUBLE_HYPHEN = /(^|\s)--(\s|$)/;

function renderedStrings(source: string): Array<{ line: number; text: string }> {
  const sf = ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node): void => {
    let text: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) text = node.text;
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) text = node.text;
    if (text !== null) {
      found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

test.each(FILES)('%s prints no standalone "--" in text a guardian reads', (file) => {
  const offenders = renderedStrings(fs.readFileSync(path.join(WEB_ROOT, file), 'utf8'))
    .filter(({ text }) => STANDALONE_DOUBLE_HYPHEN.test(text))
    .map(({ line, text }) => `${file}:${line}: ${text.replace(/\s+/g, ' ').slice(0, 80)}`);
  expect(offenders).toEqual([]);
});

test('the scan sees a doubled hyphen in a string and in JSX text, and leaves class names and comments alone', () => {
  const sample = [
    'const a = "x -- y";',
    'const b = <p>x -- y</p>;',
    'const c = <p className="btn--ghost p-[var(--s4)]">ok</p>;',
    '// a comment -- is free to keep the style',
  ].join(String.fromCharCode(10));
  const hits = renderedStrings(sample).filter(({ text }) => STANDALONE_DOUBLE_HYPHEN.test(text));
  expect(hits.map(({ line }) => line)).toEqual([1, 2]);
});
