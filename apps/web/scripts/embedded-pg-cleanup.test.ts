import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Decision logic of scripts/lib/embedded-pg-cleanup.mjs, without a Postgres.
 * The module is native ESM and this suite runs under the plain `jest` of
 * `npm test` (no --experimental-vm-modules), so the module is exercised in a
 * child node process the way offline-runtime-lifecycle.test.ts does it. The
 * end-to-end behaviour -- a hard-killed helper still tearing its cluster down
 * -- is embedded-pg-server-cleanup.pg.test.ts.
 */

const moduleUrl = pathToFileURL(path.resolve(__dirname, 'lib/embedded-pg-cleanup.mjs')).href;

function evaluateScript(body: string) {
  const script = `
    import * as m from ${JSON.stringify(moduleUrl)};
    ${body}
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
}

/** A PID no process has: a child that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '0']);
  if (!child.pid) throw new Error('could not spawn a throwaway process');
  return child.pid;
}

/** A live process that is NOT this test runner, so the kill path can be exercised. */
function liveDummy(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function baseName(fullPath: string): string {
  return fullPath.split(/[\\/]/).pop() ?? fullPath;
}

describe('embedded-pg-cleanup: parsers and predicates', () => {
  it('recognises exactly the suite data-directory convention', () => {
    const result = evaluateScript(`
      process.stdout.write(JSON.stringify([
        'ppbf-activity-log-pg-test-1790169016285',
        'ppbf-a-pg-test-1',
        'ppbf-cls-abc123',
        'ppbf-activity-log-pg-test-',
        'ppbf-activity-log-pg-test-17x',
        'other-pg-test-1',
        'ppbf-Activity-pg-test-1',
      ].map((name) => m.isTestDataDirName(name))));
    `);
    expect(result).toEqual([true, true, false, false, false, false, false]);
  });

  it('reads the PID and data directory out of postmaster.pid', () => {
    const result = evaluateScript(`
      process.stdout.write(JSON.stringify([
        m.parsePostmasterPid('12345\\nC:/Users/x/AppData/Local/Temp/ppbf-a-pg-test-1\\n1790169016\\n5432\\n'),
        m.parsePostmasterPid('777\\r\\n/tmp/ppbf-a-pg-test-1\\r\\n'),
        m.parsePostmasterPid('12345'),
        m.parsePostmasterPid(''),
        m.parsePostmasterPid('-4\\n/tmp/x'),
        m.parsePostmasterPid('abc\\n/tmp/x'),
      ]));
    `);
    expect(result).toEqual([
      { pid: 12345, dataDir: 'C:/Users/x/AppData/Local/Temp/ppbf-a-pg-test-1' },
      { pid: 777, dataDir: '/tmp/ppbf-a-pg-test-1' },
      { pid: 12345, dataDir: '' },
      null,
      null,
      null,
    ]);
  });

  it('parses tasklist CSV and ps output into pid -> image maps', () => {
    const result = evaluateScript(`
      const tasks = m.parseTaskList('"System Idle Process","0","Services","0","8 K"\\r\\n"postgres.exe","4242","Console","1","23,456 K"\\r\\n"node.exe","99","Console","1","1 K"\\r\\nINFO: nothing\\r\\n');
      const ps = m.parsePsList(' 1 /sbin/init\\n4242 postgres\\n  99 node\\n');
      process.stdout.write(JSON.stringify({
        tasks: [...tasks.entries()],
        ps: [...ps.entries()],
        images: ['postgres.exe', 'POSTGRES.EXE', '/usr/lib/postgresql/16/bin/postgres', 'postgres', 'node.exe', 'pg_ctl.exe', 'postgres-old.exe']
          .map((name) => m.isPostgresImage(name)),
      }));
    `);
    expect(result).toEqual({
      tasks: [
        [0, 'System Idle Process'],
        [4242, 'postgres.exe'],
        [99, 'node.exe'],
      ],
      ps: [
        [1, '/sbin/init'],
        [4242, 'postgres'],
        [99, 'node'],
      ],
      images: [true, true, true, true, false, false, false],
    });
  });

  it('parses the postgres process listings that carry a parent PID', () => {
    const result = evaluateScript(`
      process.stdout.write(JSON.stringify({
        windows: m.parsePostgresProcessLines('15808 43288 0\\r\\n14548 15808 1\\r\\n  16256 15808 1 \\r\\nbad line\\r\\n'),
        posix: m.parsePsPostgresProcesses([
          '    1     0 /sbin/init',
          ' 1200  1100 /usr/lib/postgresql/16/bin/postgres -D /tmp/ppbf-a-pg-test-1 -p 5433',
          ' 1201  1200 postgres: checkpointer ',
          ' 1202  1200 postgres: walwriter ',
          ' 1300  1000 node /x/test-embedded-pg-server.mjs /tmp/ppbf-b-pg-test-2 5434',
          ' 1301  1300 postgres -D /tmp/ppbf-b-pg-test-2 -p 5434',
        ].join('\\n')),
      }));
    `);
    expect(result).toEqual({
      windows: [
        { pid: 15808, ppid: 43288, forked: false },
        { pid: 14548, ppid: 15808, forked: true },
        { pid: 16256, ppid: 15808, forked: true },
      ],
      posix: [
        { pid: 1200, ppid: 1100, forked: false },
        { pid: 1201, ppid: 1200, forked: true },
        { pid: 1202, ppid: 1200, forked: true },
        { pid: 1301, ppid: 1300, forked: false },
      ],
    });
  });

  it('classifies a postmaster PID by liveness first, then by image', () => {
    const gone = deadPid();
    const result = evaluateScript(`
      const listed = new Map([[${process.pid}, 'node.exe'], [${gone}, 'postgres.exe']]);
      process.stdout.write(JSON.stringify({
        deadEvenIfListed: m.classifyPid(${gone}, listed),
        aliveButNotPostgres: m.classifyPid(${process.pid}, listed),
        aliveUnlisted: m.classifyPid(${process.pid}, new Map()),
        aliveNoList: m.classifyPid(${process.pid}, null),
        alivePostgres: m.classifyPid(${process.pid}, new Map([[${process.pid}, 'postgres.exe']])),
      }));
    `);
    expect(result).toEqual({
      deadEvenIfListed: 'dead',
      aliveButNotPostgres: 'reused',
      aliveUnlisted: 'dead',
      aliveNoList: 'unknown',
      alivePostgres: 'postgres',
    });
  });
});

describe('embedded-pg-cleanup: sweep decisions', () => {
  let root: string;
  const dummies: ChildProcess[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-cleanup-unit-'));
  });

  afterEach(() => {
    for (const dummy of dummies.splice(0)) {
      try {
        dummy.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  function cluster(name: string, files: Record<string, string>, ageMs = 0): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'PG_VERSION'), '16\n');
    for (const [file, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, file), content);
    }
    if (ageMs > 0) {
      const then = new Date(Date.now() - ageMs);
      fs.utimesSync(dir, then, then);
    }
    return dir;
  }

  /** postmaster.pid as Postgres writes it: PID, then the data directory with forward slashes. */
  function postmasterPid(pid: number, dir: string): string {
    return `${pid}\n${dir.replace(/\\/g, '/')}\n`;
  }

  it('removes only what is provably abandoned and keeps everything owned or uncertain', async () => {
    const gone = deadPid();
    // Three stand-ins for a postmaster. The process list handed to the sweep
    // calls them postgres; the sweep's verdict decides which of them is ever
    // sent taskkill /t /f (Windows) or SIGQUIT (elsewhere).
    const [orphanPostmaster, ownedPostmaster, misclaimedPostmaster] = [liveDummy(), liveDummy(), liveDummy()];
    dummies.push(orphanPostmaster, ownedPostmaster, misclaimedPostmaster);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const orphanPid = orphanPostmaster.pid as number;
    const ownedPid = ownedPostmaster.pid as number;
    const misclaimedPid = misclaimedPostmaster.pid as number;

    const deadPostmaster = cluster('ppbf-dead-pg-test-1', { 'postmaster.pid': postmasterPid(gone, `${root}/ppbf-dead-pg-test-1`) });
    const reusedPid = cluster('ppbf-reused-pg-test-2', { 'postmaster.pid': postmasterPid(process.pid, `${root}/ppbf-reused-pg-test-2`) });
    const neverStartedOld = cluster('ppbf-old-pg-test-3', {}, 11 * 60 * 1000);
    const neverStartedYoung = cluster('ppbf-young-pg-test-4', {});
    const ownedLive = cluster('ppbf-owned-pg-test-5', {
      'postmaster.pid': postmasterPid(ownedPid, `${root}/ppbf-owned-pg-test-5`),
      'ppbf-helper.pid': `${process.pid}\n`,
    });
    const orphanLive = cluster('ppbf-orphan-pg-test-6', {
      'postmaster.pid': postmasterPid(orphanPid, `${root}/ppbf-orphan-pg-test-6`),
      'ppbf-helper.pid': `${gone}\n`,
    });
    const liveUnclaimed = cluster('ppbf-unclaimed-pg-test-7', {
      'postmaster.pid': postmasterPid(ownedPid, `${root}/ppbf-unclaimed-pg-test-7`),
    });
    // An orphan whose postmaster.pid names a live postgres that is running on
    // a DIFFERENT directory: the directory goes, the process must not.
    const misclaimed = cluster('ppbf-misclaimed-pg-test-8', {
      'postmaster.pid': postmasterPid(misclaimedPid, `${root}/somewhere-else`),
      'ppbf-helper.pid': `${gone}\n`,
    });
    const notOurs = cluster('ppbf-cls-notours', { 'postmaster.pid': postmasterPid(gone, `${root}/ppbf-cls-notours`) });
    const self = cluster('ppbf-self-pg-test-9', { 'postmaster.pid': postmasterPid(gone, `${root}/ppbf-self-pg-test-9`) });

    const result = evaluateScript(`
      const processes = new Map([
        [${process.pid}, 'node.exe'],
        [${orphanPid}, 'postgres.exe'],
        [${ownedPid}, 'postgres.exe'],
        [${misclaimedPid}, 'postgres.exe'],
        [${gone}, 'postgres.exe'],
      ]);
      const summary = await m.sweepStaleDataDirs(${JSON.stringify(root)}, {
        ownDataDir: ${JSON.stringify(self)},
        processes,
      });
      process.stdout.write(JSON.stringify({
        removed: summary.removed.map((d) => d.split(/[\\\\/]/).pop()).sort(),
        skipped: summary.skipped.map((d) => d.split(/[\\\\/]/).pop()).sort(),
        failed: summary.failed,
      }));
    `);

    expect(result.failed).toEqual([]);
    expect(result.removed).toEqual([
      'ppbf-dead-pg-test-1',
      'ppbf-misclaimed-pg-test-8',
      'ppbf-old-pg-test-3',
      'ppbf-orphan-pg-test-6',
      'ppbf-reused-pg-test-2',
    ]);
    expect(result.skipped).toEqual(['ppbf-owned-pg-test-5', 'ppbf-unclaimed-pg-test-7', 'ppbf-young-pg-test-4']);

    for (const dir of [deadPostmaster, reusedPid, neverStartedOld, orphanLive, misclaimed]) {
      expect({ dir: baseName(dir), exists: fs.existsSync(dir) }).toEqual({ dir: baseName(dir), exists: false });
    }
    for (const dir of [neverStartedYoung, ownedLive, liveUnclaimed, notOurs, self]) {
      expect({ dir: baseName(dir), exists: fs.existsSync(dir) }).toEqual({ dir: baseName(dir), exists: true });
    }

    // The orphan's postmaster was stopped; the owned one, the one whose
    // postmaster.pid claims another directory, and this test runner (a
    // recycled PID) were not.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect({ orphan: isAlive(orphanPid), owned: isAlive(ownedPid), misclaimed: isAlive(misclaimedPid) }).toEqual({
      orphan: false,
      owned: true,
      misclaimed: true,
    });
  }, 60_000);

  it('keeps a live cluster when the process list is unavailable', () => {
    const dir = cluster('ppbf-live-pg-test-1', { 'postmaster.pid': postmasterPid(process.pid, `${root}/ppbf-live-pg-test-1`) });
    const result = evaluateScript(`
      const summary = await m.sweepStaleDataDirs(${JSON.stringify(root)}, { processes: null });
      process.stdout.write(JSON.stringify({
        verdict: await m.judgeStaleDir(${JSON.stringify(dir)}, { processes: null }),
        removed: summary.removed,
        skipped: summary.skipped.length,
      }));
    `);
    expect(result).toEqual({ verdict: 'keep', removed: [], skipped: 1 });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('cleanupDataDir never kills a PID that is not a postgres image, and still removes the directory', () => {
    const dir = cluster('ppbf-recycled-pg-test-1', { 'postmaster.pid': postmasterPid(process.pid, `${root}/ppbf-recycled-pg-test-1`) });
    const result = evaluateScript(`
      const result = await m.cleanupDataDir(${JSON.stringify(dir)}, { processes: new Map([[${process.pid}, 'node.exe']]) });
      process.stdout.write(JSON.stringify(result));
    `);
    expect(result).toEqual({ dataDir: dir, killed: false, orphansKilled: [], removed: true });
    expect(fs.existsSync(dir)).toBe(false);
  }, 30_000);

  it('cleanupDataDir uses a remembered postmaster.pid when the directory has already lost it', () => {
    const dir = cluster('ppbf-remembered-pg-test-1', {});
    const result = evaluateScript(`
      const result = await m.cleanupDataDir(${JSON.stringify(dir)}, {
        processes: new Map([[${process.pid}, 'node.exe']]),
        postmaster: { pid: ${process.pid}, dataDir: ${JSON.stringify(dir.replace(/\\/g, '/'))} },
      });
      process.stdout.write(JSON.stringify(result));
    `);
    // A recycled PID (this test runner, listed as node): nothing to kill, no
    // children of it are postgres, directory removed.
    expect(result).toEqual({ dataDir: dir, killed: false, orphansKilled: [], removed: true });
    expect(fs.existsSync(dir)).toBe(false);
  }, 30_000);
});
