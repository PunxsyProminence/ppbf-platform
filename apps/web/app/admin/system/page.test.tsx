/**
 * @jest-environment jsdom
 */

// /admin/system (WO-N7-03): a truthful, read-only inventory for the platform owner. What these pin:
// every audited route is listed and none claims a runtime status; the job list is exactly the
// workflow folder, each job's triggers are the file's own, and each says its status is unavailable
// with a link to its runs; the scripts no workflow runs say so; nothing on the page can run or
// change anything. Who may open it is pinned in page.guard.test.ts.

import fs from 'node:fs';
import path from 'node:path';

import { render, screen, within } from '@testing-library/react';

import inventory from '@/src/server/pilot/apiRouteInventory.json';
import type { PilotRole } from '@/src/server/pilot/contracts';

import AdminSystemPage from './page';

const principal: { role: PilotRole | null } = { role: 'platform_owner' };

// jsdom has no Request, so the real guard runs in page.guard.test.ts (node). Here it is faked.
jest.mock('@/src/server/pilot/pageGuard', () => ({
  requirePageRole: async () => ({ accountId: 'acct_1', organizationId: 'org_1', role: principal.role }),
}));

const WORKFLOWS_DIR = path.join(__dirname, '../../../../../.github/workflows');
const SCRIPTS_DIR = path.join(__dirname, '../../../scripts');

function workflowFiles(): string[] {
  return fs.readdirSync(WORKFLOWS_DIR).filter((file) => file.endsWith('.yml')).sort();
}

/** The triggers a workflow file declares under its top-level `on:` block. */
function fileTriggers(file: string): string[] {
  const lines = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8').split('\n');
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  const found: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = /^ {2}([a-z_]+):/.exec(line);
    if (match) found.push(match[1]);
  }
  const words: Record<string, string> = {
    schedule: 'schedule',
    workflow_dispatch: 'manual',
    pull_request: 'pull request',
    push: 'push',
  };
  return found.map((key) => words[key] ?? key).sort();
}

async function renderAs(role: PilotRole) {
  principal.role = role;
  render(await AdminSystemPage());
}

function tableRows(headingName: RegExp): HTMLElement[] {
  const section = screen.getByRole('heading', { name: headingName }).closest('section') as HTMLElement;
  return within(within(section).getByRole('table')).getAllByRole('row').slice(1);
}

beforeEach(() => {
  principal.role = 'platform_owner';
});

test('every audited route is listed, and none claims a runtime status', async () => {
  await renderAs('platform_owner');
  const rows = tableRows(/^Routes/);
  expect(rows).toHaveLength(inventory.length);
  expect(screen.getByRole('heading', { name: `Routes (${inventory.length})` })).toBeTruthy();
  inventory.forEach((route, index) => {
    const cells = within(rows[index]).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells[0]).toBe(`${route.method} ${route.path}`);
    expect(cells[1]).toBe(route.gate);
    expect(cells[3]).toBe(route.writes ? 'Yes' : 'No');
    expect(cells[4]).toBe(route.athleteData ? 'Yes' : 'No');
    expect(cells[5]).toBe(route.notes);
    expect(cells[6]).toBe('No runtime status recorded');
  });
});

test('the job list is exactly the workflow folder, with each file\'s own triggers', async () => {
  await renderAs('platform_owner');
  const rows = tableRows(/^Jobs/);
  const files = workflowFiles();
  expect(rows).toHaveLength(files.length);
  rows.forEach((row, index) => {
    const cells = within(row).getAllByRole('cell');
    expect(cells[0].textContent).toContain(files[index]);
    const shown = (cells[2].textContent ?? '').split(', ').sort();
    expect(shown).toEqual(fileTriggers(files[index]));
  });
});

test('every job says its status is unavailable and links to its runs on GitHub', async () => {
  await renderAs('platform_owner');
  const files = workflowFiles();
  tableRows(/^Jobs/).forEach((row, index) => {
    const status = within(row).getAllByRole('cell')[3];
    expect(status.textContent).toContain('Status unavailable.');
    expect(within(status).getByRole('link', { name: 'Runs on GitHub' }).getAttribute('href')).toBe(
      `https://github.com/PunxsyProminence/ppbf-platform/actions/workflows/${files[index]}`,
    );
  });
});

test('the scripts listed as hand-run exist, no workflow runs them, and the page says so', async () => {
  await renderAs('platform_owner');
  const items = within(screen.getByRole('list', { name: 'Scripts no workflow runs' })).getAllByRole('listitem');
  expect(items.length).toBeGreaterThan(0);
  const allWorkflows = workflowFiles().map((file) => fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8'));
  for (const item of items) {
    const script = (item.textContent ?? '').split(':')[0];
    expect(fs.existsSync(path.join(SCRIPTS_DIR, script))).toBe(true);
    expect(allWorkflows.some((text) => text.split('\n').some((line) => !line.trim().startsWith('#') && line.includes(`scripts/${script}`)))).toBe(false);
    expect(item.textContent).toContain('No workflow runs this.');
  }
});

test('the page can run or change nothing, and prints no audit confidence or flag column', async () => {
  await renderAs('platform_owner');
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(document.querySelector('form')).toBeNull();
  expect(document.querySelector('input, select, textarea')).toBeNull();
  const headers = screen.getAllByRole('columnheader').map((header) => header.textContent ?? '');
  expect(headers.some((header) => /confidence|missing gate|looks wrong|certainty/i.test(header))).toBe(false);
});
