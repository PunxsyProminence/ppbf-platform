import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(
  path.resolve(__dirname, 'lib/offline-runtime-lifecycle.mjs'),
).href;

function evaluate(expression: string) {
  const script = `
    import * as m from ${JSON.stringify(moduleUrl)};
    const value = await (${expression});
    process.stdout.write(JSON.stringify(value ?? null));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }));
}

function evaluateScript(body: string) {
  const script = `
    import * as m from ${JSON.stringify(moduleUrl)};
    ${body}
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }));
}

function stopWithLookup(pid: number, processInfo: object | null, repoDir = worktree) {
  return evaluateScript(`
    const signaled = [];
    await m.stopRecordedProcesses({
      version: 1,
      repoDir: ${JSON.stringify(repoDir)},
      appPort: 3111,
      databasePort: 1,
      launcherPid: ${pid},
      nextPid: null,
      postgresPid: null,
    }, null, {
      platform: 'win32',
      lookupProcess: async (candidate) => candidate === ${pid} ? ${JSON.stringify(processInfo)} : null,
      signalProcess: (candidate, signal) => signaled.push({ pid: candidate, signal: signal ?? null }),
      waitUntilDead: async () => [],
    });
    process.stdout.write(JSON.stringify(signaled));
  `);
}

const mainRepo = 'C:\\Dev\\ppbf-platform';
const worktree = 'C:\\Dev_WORKTREES\\sl01-runtime-lifecycle';

describe('offline runtime argument parsing', () => {
  test('defaults to start on port 3100', () => {
    expect(evaluate('m.parseRuntimeArgs([])')).toEqual({
      command: 'start',
      reset: false,
      port: 3100,
    });
  });

  test('accepts stop, status, restart, --reset and --port', () => {
    expect(evaluate("m.parseRuntimeArgs(['stop'])")).toEqual({
      command: 'stop', reset: false, port: 3100,
    });
    expect(evaluate("m.parseRuntimeArgs(['status'])")).toEqual({
      command: 'status', reset: false, port: 3100,
    });
    expect(evaluate("m.parseRuntimeArgs(['restart', '--port', '3111', '--reset'])")).toEqual({
      command: 'restart', reset: true, port: 3111,
    });
  });

  test('rejects --reset and --port on stop/status', () => {
    expect(() => evaluate("m.parseRuntimeArgs(['stop', '--reset'])")).toThrow(/--reset cannot be combined with stop/);
    expect(() => evaluate("m.parseRuntimeArgs(['status', '--port', '3111'])")).toThrow(/--port cannot be combined with status/);
  });
});

describe('worktree-scoped process matching', () => {
  test('the worktree launcher belongs to the worktree and not the main checkout', () => {
    const commandLine = `${worktree}\\apps\\web\\scripts\\offline-runtime.mjs --port 3111`;
    expect(evaluate(`m.belongsToOfflineRuntime(${JSON.stringify({ commandLine, repoDir: worktree })})`)).toBe(true);
    expect(evaluate(`m.belongsToOfflineRuntime(${JSON.stringify({ commandLine, repoDir: mainRepo })})`)).toBe(false);
  });

  test('the main checkout launcher belongs to the main checkout and not the worktree', () => {
    const commandLine = `${mainRepo}\\apps\\web\\scripts\\offline-runtime.mjs`;
    expect(evaluate(`m.belongsToOfflineRuntime(${JSON.stringify({ commandLine, repoDir: mainRepo })})`)).toBe(true);
    expect(evaluate(`m.belongsToOfflineRuntime(${JSON.stringify({ commandLine, repoDir: worktree })})`)).toBe(false);
  });

  test('postgres with this worktree data directory matches; a generic postgres under the same drive does not', () => {
    const postgres = `postgres.exe -D ${worktree}\\.ppbf-offline\\postgres`;
    expect(evaluate(`m.belongsToOfflineRuntime(${JSON.stringify({ commandLine: postgres, repoDir: worktree })})`)).toBe(true);
    expect(evaluate(`m.belongsToOfflineRuntime(${JSON.stringify({
      commandLine: 'postgres.exe -D C:\\\\Dev\\\\unrelated\\\\data',
      executablePath: `${worktree}\\\\node_modules\\\\pg\\\\postgres.exe`,
      repoDir: worktree,
    })})`)).toBe(false);
  });

  test('the production launcher has no broad Windows orphan force-stop path', () => {
    const launcher = fs.readFileSync(path.resolve(__dirname, 'offline-runtime.mjs'), 'utf8');
    const lifecycle = fs.readFileSync(path.resolve(__dirname, 'lib/offline-runtime-lifecycle.mjs'), 'utf8');

    expect(launcher).not.toContain('stopWindowsOrphans');
    expect(launcher).not.toContain('windowsStopCommand');
    expect(lifecycle).not.toMatch(/Stop-Process\s+-Id.*-Force/);
  });});

describe('recorded PID ownership on Windows', () => {
  const worktreeLauncher = {
    commandLine: `${worktree}\\apps\\web\\scripts\\offline-runtime.mjs --port 3111`,
    executablePath: 'node.exe',
  };
  const otherCheckoutLauncher = {
    commandLine: `${mainRepo}\\apps\\web\\scripts\\offline-runtime.mjs --port 3111`,
    executablePath: 'node.exe',
  };
  const unrelated = {
    commandLine: 'C:\\Windows\\System32\\notepad.exe',
    executablePath: 'C:\\Windows\\System32\\notepad.exe',
  };
  const reused = {
    commandLine: 'C:\\Windows\\System32\\svchost.exe -k netsvcs',
    executablePath: 'C:\\Windows\\System32\\svchost.exe',
  };

  test('a verified offline-runtime process for this worktree is eligible for termination', () => {
    expect(evaluate(`m.isOwnedOfflineProcess(${JSON.stringify(worktreeLauncher)}, ${JSON.stringify(worktree)})`)).toBe(true);
    expect(stopWithLookup(4242, worktreeLauncher)).toEqual([{ pid: 4242, signal: null }]);
  });

  test('a process from another checkout is rejected', () => {
    expect(evaluate(`m.isOwnedOfflineProcess(${JSON.stringify(otherCheckoutLauncher)}, ${JSON.stringify(worktree)})`)).toBe(false);
    expect(stopWithLookup(4242, otherCheckoutLauncher)).toEqual([]);
  });

  test('an unrelated process is rejected', () => {
    expect(evaluate(`m.isOwnedOfflineProcess(${JSON.stringify(unrelated)}, ${JSON.stringify(worktree)})`)).toBe(false);
    expect(stopWithLookup(4242, unrelated)).toEqual([]);
  });

  test('a reused or stale recorded PID is rejected when current metadata does not prove ownership', () => {
    expect(evaluate(`m.isOwnedOfflineProcess(${JSON.stringify(reused)}, ${JSON.stringify(worktree)})`)).toBe(false);
    expect(stopWithLookup(4242, reused)).toEqual([]);
  });

  test('a dead or missing PID is skipped without failure', () => {
    expect(evaluate('m.isOwnedOfflineProcess(null, "C:\\\\Dev_WORKTREES\\\\sl01-runtime-lifecycle")')).toBe(false);
    expect(stopWithLookup(4242, null)).toEqual([]);
  });

  test('Windows process query names one PID and does not hardcode a checkout path', () => {
    const command = evaluate('m.windowsProcessQueryCommand(4242)');
    expect(command).toContain('ProcessId=4242');
    expect(command).not.toContain('C:\\Dev\\ppbf-platform');
    expect(evaluate('m.parseWindowsProcessQuery("")')).toBe(null);
    expect(evaluate(`m.parseWindowsProcessQuery(${JSON.stringify(JSON.stringify({
      ProcessId: 4242,
      CommandLine: `${worktree}\\apps\\web\\scripts\\offline-runtime.mjs`,
      ExecutablePath: 'node.exe',
    }))})`)).toEqual({
      pid: 4242,
      commandLine: `${worktree}\\apps\\web\\scripts\\offline-runtime.mjs`,
      executablePath: 'node.exe',
    });
  });

  test('force termination is only offered to a still-owned process', () => {
    const signaled = evaluateScript(`
      const signaled = [];
      await m.stopRecordedProcesses({
        version: 1,
        repoDir: ${JSON.stringify(worktree)},
        appPort: 3111,
        databasePort: 1,
        launcherPid: 4242,
        nextPid: 99,
        postgresPid: null,
      }, null, {
        platform: 'win32',
        lookupProcess: async (pid) => {
          if (pid === 4242) {
            return ${JSON.stringify(worktreeLauncher)};
          }
          if (pid === 99) {
            return ${JSON.stringify(unrelated)};
          }
          return null;
        },
        signalProcess: (pid, signal) => signaled.push({ pid, signal: signal ?? null }),
        waitUntilDead: async (pids) => pids.filter((pid) => pid === 4242),
      });
      process.stdout.write(JSON.stringify(signaled));
    `);
    expect(signaled).toEqual([
      { pid: 4242, signal: null },
      { pid: 4242, signal: 'SIGKILL' },
    ]);
  });

  function stopAcrossGrace(pid: number, firstInfo: object | null, secondInfo: object | null | 'throw', remaining = [pid]) {
    const secondLookup = secondInfo === 'throw'
      ? 'throw new Error("cim query failed");'
      : `return ${JSON.stringify(secondInfo)};`;
    return evaluateScript(`
      const signaled = [];
      let lookups = 0;
      await m.stopRecordedProcesses({
        version: 1,
        repoDir: ${JSON.stringify(worktree)},
        appPort: 3111,
        databasePort: 1,
        launcherPid: ${pid},
        nextPid: null,
        postgresPid: null,
      }, null, {
        platform: 'win32',
        lookupProcess: async (candidate) => {
          if (candidate !== ${pid}) return null;
          lookups += 1;
          if (lookups === 1) return ${JSON.stringify(firstInfo)};
          ${secondLookup}
        },
        signalProcess: (candidate, signal) => signaled.push({ pid: candidate, signal: signal ?? null }),
        waitUntilDead: async (pids, timeoutMs) => timeoutMs === 2000 ? [] : ${JSON.stringify(remaining)},
      });
      process.stdout.write(JSON.stringify({ signaled, lookups }));
    `);
  }

  test('SIGKILL is permitted only after a second live ownership proof', () => {
    expect(stopAcrossGrace(4242, worktreeLauncher, worktreeLauncher)).toEqual({
      signaled: [
        { pid: 4242, signal: null },
        { pid: 4242, signal: 'SIGKILL' },
      ],
      lookups: 2,
    });
  });

  test('a PID reused by an unrelated process during the grace window is not SIGKILLed', () => {
    expect(stopAcrossGrace(4242, worktreeLauncher, unrelated)).toEqual({
      signaled: [{ pid: 4242, signal: null }],
      lookups: 2,
    });
  });

  test('a process that disappears during the grace window is not SIGKILLed', () => {
    expect(stopAcrossGrace(4242, worktreeLauncher, null)).toEqual({
      signaled: [{ pid: 4242, signal: null }],
      lookups: 2,
    });
  });

  test('a second lookup failure fails safe and does not SIGKILL', () => {
    expect(stopAcrossGrace(4242, worktreeLauncher, 'throw')).toEqual({
      signaled: [{ pid: 4242, signal: null }],
      lookups: 2,
    });
  });
  test('revalidates ownership immediately before force termination', () => {
    const result = evaluateScript(`
      const signaled = [];
      let lookups = 0;
      await m.stopRecordedProcesses({
        version: 1,
        repoDir: ${JSON.stringify(worktree)},
        appPort: 3111,
        databasePort: 1,
        launcherPid: 4242,
        nextPid: null,
        postgresPid: null,
      }, null, {
        platform: 'win32',
        lookupProcess: async (pid) => {
          if (pid !== 4242) return null;
          lookups += 1;
          return ${JSON.stringify(worktreeLauncher)};
        },
        signalProcess: (pid, signal) => signaled.push({ pid, signal: signal ?? null }),
        waitUntilDead: async (pids, timeoutMs) => timeoutMs === 2000 ? [] : [...pids],
      });
      process.stdout.write(JSON.stringify({ signaled, lookups }));
    `);
    expect(result).toEqual({
      signaled: [
        { pid: 4242, signal: null },
        { pid: 4242, signal: 'SIGKILL' },
      ],
      lookups: 2,
    });
  });

  test('does not force-kill a PID reused during the graceful wait', () => {
    const result = evaluateScript(`
      const signaled = [];
      let lookups = 0;
      await m.stopRecordedProcesses({
        version: 1,
        repoDir: ${JSON.stringify(worktree)},
        appPort: 3111,
        databasePort: 1,
        launcherPid: 4242,
        nextPid: null,
        postgresPid: null,
      }, null, {
        platform: 'win32',
        lookupProcess: async (pid) => {
          if (pid !== 4242) return null;
          lookups += 1;
          return lookups === 1
            ? ${JSON.stringify(worktreeLauncher)}
            : ${JSON.stringify(unrelated)};
        },
        signalProcess: (pid, signal) => signaled.push({ pid, signal: signal ?? null }),
        waitUntilDead: async (pids, timeoutMs) => timeoutMs === 2000 ? [] : [...pids],
      });
      process.stdout.write(JSON.stringify({ signaled, lookups }));
    `);
    expect(result).toEqual({
      signaled: [{ pid: 4242, signal: null }],
      lookups: 2,
    });
  });

  test('does not force-kill when the owned process disappears during the graceful wait', () => {
    const result = evaluateScript(`
      const signaled = [];
      let lookups = 0;
      await m.stopRecordedProcesses({
        version: 1,
        repoDir: ${JSON.stringify(worktree)},
        appPort: 3111,
        databasePort: 1,
        launcherPid: 4242,
        nextPid: null,
        postgresPid: null,
      }, null, {
        platform: 'win32',
        lookupProcess: async (pid) => {
          if (pid !== 4242) return null;
          lookups += 1;
          return lookups === 1 ? ${JSON.stringify(worktreeLauncher)} : null;
        },
        signalProcess: (pid, signal) => signaled.push({ pid, signal: signal ?? null }),
        waitUntilDead: async (pids, timeoutMs) => timeoutMs === 2000 ? [] : [...pids],
      });
      process.stdout.write(JSON.stringify({ signaled, lookups }));
    `);
    expect(result).toEqual({
      signaled: [{ pid: 4242, signal: null }],
      lookups: 2,
    });
  });

  test('fails safe when the ownership lookup throws before force termination', () => {
    const result = evaluateScript(`
      const signaled = [];
      let lookups = 0;
      await m.stopRecordedProcesses({
        version: 1,
        repoDir: ${JSON.stringify(worktree)},
        appPort: 3111,
        databasePort: 1,
        launcherPid: 4242,
        nextPid: null,
        postgresPid: null,
      }, null, {
        platform: 'win32',
        lookupProcess: async (pid) => {
          if (pid !== 4242) return null;
          lookups += 1;
          if (lookups === 1) return ${JSON.stringify(worktreeLauncher)};
          throw new Error('simulated lookup failure');
        },
        signalProcess: (pid, signal) => signaled.push({ pid, signal: signal ?? null }),
        waitUntilDead: async (pids, timeoutMs) => timeoutMs === 2000 ? [] : [...pids],
      });
      process.stdout.write(JSON.stringify({ signaled, lookups }));
    `);
    expect(result).toEqual({
      signaled: [{ pid: 4242, signal: null }],
      lookups: 2,
    });
  });

  test('does not force-kill when the PID now belongs to another checkout', () => {
    const result = evaluateScript(`
      const signaled = [];
      let lookups = 0;
      await m.stopRecordedProcesses({
        version: 1,
        repoDir: ${JSON.stringify(worktree)},
        appPort: 3111,
        databasePort: 1,
        launcherPid: 4242,
        nextPid: null,
        postgresPid: null,
      }, null, {
        platform: 'win32',
        lookupProcess: async (pid) => {
          if (pid !== 4242) return null;
          lookups += 1;
          return lookups === 1
            ? ${JSON.stringify(worktreeLauncher)}
            : ${JSON.stringify(otherCheckoutLauncher)};
        },
        signalProcess: (pid, signal) => signaled.push({ pid, signal: signal ?? null }),
        waitUntilDead: async (pids, timeoutMs) => timeoutMs === 2000 ? [] : [...pids],
      });
      process.stdout.write(JSON.stringify({ signaled, lookups }));
    `);
    expect(result).toEqual({
      signaled: [{ pid: 4242, signal: null }],
      lookups: 2,
    });
  });
});

describe('recorded PID ownership on POSIX', () => {
  const posixWorktree = '/home/dev/ppbf-platform';
  const otherPosixCheckout = '/home/dev/ppbf-other';

  const ownedNext = {
    pid: 4242,
    commandLine: `node ${posixWorktree}/node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3111`,
    executablePath: '',
  };
  const otherCheckoutNext = {
    pid: 4242,
    commandLine: `node ${otherPosixCheckout}/node_modules/next/dist/bin/next dev`,
    executablePath: '',
  };
  const ownedPostgres = {
    pid: 4242,
    commandLine: `/opt/pg/bin/postgres -D ${posixWorktree}/.ppbf-offline/postgres -p 5432`,
    executablePath: '',
  };
  const foreignPostgres = {
    pid: 4242,
    commandLine: '/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main -p 5432',
    executablePath: '',
  };
  const unrelated = { pid: 4242, commandLine: '/usr/sbin/cron -f', executablePath: '' };
  // The real launcher argv: npm runs `node scripts/offline-runtime.mjs` from
  // apps/web, so it carries the runtime marker but never the checkout path.
  const launcherAsActuallyLaunched = {
    pid: 4242,
    commandLine: 'node scripts/offline-runtime.mjs',
    executablePath: '',
  };

  function posixStop(options: {
    launcherPid?: number | null;
    nextPid?: number | null;
    postgresPid?: number | null;
    lookups?: Record<string, unknown>;
    secondLookups?: Record<string, unknown>;
    throwOnLookup?: number[];
    survivors?: number[];
    alivePids?: number[];
  }) {
    const {
      launcherPid = null, nextPid = null, postgresPid = null,
      lookups = {}, secondLookups = {}, throwOnLookup = [], survivors = [], alivePids = [],
    } = options;

    return evaluateScript(`
      const signaled = [];
      const lookupCounts = {};
      const first = ${JSON.stringify(lookups)};
      const second = ${JSON.stringify(secondLookups)};
      const throwOn = ${JSON.stringify(throwOnLookup)};
      const survivors = ${JSON.stringify(survivors)};
      const alivePids = ${JSON.stringify(alivePids)};

      const result = await m.stopRecordedProcesses({
        version: 1,
        repoDir: ${JSON.stringify(posixWorktree)},
        appPort: 3111,
        databasePort: 5432,
        launcherPid: ${JSON.stringify(launcherPid)},
        nextPid: ${JSON.stringify(nextPid)},
        postgresPid: ${JSON.stringify(postgresPid)},
      }, null, {
        platform: 'linux',
        lookupProcess: async (pid) => {
          if (throwOn.includes(pid)) throw new Error('ps exited non-zero');
          lookupCounts[pid] = (lookupCounts[pid] ?? 0) + 1;
          const key = String(pid);
          if (lookupCounts[pid] > 1 && Object.prototype.hasOwnProperty.call(second, key)) return second[key];
          return Object.prototype.hasOwnProperty.call(first, key) ? first[key] : null;
        },
        signalProcess: (pid, signal) => signaled.push({ pid, signal: signal ?? null }),
        waitUntilDead: async (pids) => pids.filter((pid) => survivors.includes(pid)),
        isProcessAlive: (pid) => alivePids.includes(pid),
      });

      process.stdout.write(JSON.stringify({ signaled, result, lookupCounts }));
    `);
  }

  test('a Next process for this checkout is proven and signalled', () => {
    const out = posixStop({ nextPid: 4242, lookups: { 4242: ownedNext } });
    expect(out.signaled).toEqual([{ pid: 4242, signal: null }]);
    expect(out.result).toEqual({ unstopped: [], ambiguous: [] });
  });

  test('a postgres for this data directory is proven; a foreign postgres is not', () => {
    expect(posixStop({ postgresPid: 4242, lookups: { 4242: ownedPostgres } }).signaled)
      .toEqual([{ pid: 4242, signal: null }]);
    expect(posixStop({ postgresPid: 4242, lookups: { 4242: foreignPostgres } }).signaled)
      .toEqual([]);
  });

  test('a process from another checkout is rejected', () => {
    expect(posixStop({ nextPid: 4242, lookups: { 4242: otherCheckoutNext } }).signaled).toEqual([]);
  });

  test('a failed, empty, or uninformative lookup never authorizes a signal', () => {
    expect(posixStop({ nextPid: 4242, throwOnLookup: [4242] }).signaled).toEqual([]);
    expect(posixStop({ nextPid: 4242, lookups: { 4242: null } }).signaled).toEqual([]);
    expect(posixStop({
      nextPid: 4242,
      lookups: { 4242: { pid: 4242, commandLine: '', executablePath: '' } },
    }).signaled).toEqual([]);
  });

  test('a live but unproven recorded PID is never signalled and blocks the lifecycle', () => {
    const out = posixStop({
      launcherPid: 4242,
      lookups: { 4242: unrelated },
      alivePids: [4242],
      survivors: [4242],
    });

    expect(out.signaled).toEqual([]);
    expect(out.result.ambiguous).toEqual([4242]);
    expect(out.result.unstopped).toEqual([]);
  });

  test('the launcher as it is really launched is unproven, so it is never signalled', () => {
    const out = posixStop({
      launcherPid: 4242,
      lookups: { 4242: launcherAsActuallyLaunched },
      alivePids: [4242],
      survivors: [4242],
    });

    expect(out.signaled).toEqual([]);
    expect(out.result.ambiguous).toEqual([4242]);
  });

  test('an unproven recorded PID that exits during the bounded wait stops blocking', () => {
    const out = posixStop({
      launcherPid: 4242,
      lookups: { 4242: launcherAsActuallyLaunched },
      alivePids: [4242],
      survivors: [],
    });

    expect(out.signaled).toEqual([]);
    expect(out.result).toEqual({ unstopped: [], ambiguous: [] });
  });

  test('force termination requires a second fresh proof, and a survivor still blocks', () => {
    const out = posixStop({ nextPid: 4242, lookups: { 4242: ownedNext }, survivors: [4242] });

    expect(out.signaled).toEqual([
      { pid: 4242, signal: null },
      { pid: 4242, signal: 'SIGKILL' },
    ]);
    expect(out.lookupCounts['4242']).toBe(2);
    expect(out.result.unstopped).toEqual([4242]);
  });

  test('a PID reused between the two proofs is not force-killed', () => {
    const out = posixStop({
      nextPid: 4242,
      lookups: { 4242: ownedNext },
      secondLookups: { 4242: unrelated },
      survivors: [4242],
    });

    expect(out.signaled).toEqual([{ pid: 4242, signal: null }]);
    expect(out.lookupCounts['4242']).toBe(2);
    expect(out.result.unstopped).toEqual([]);
  });

  test('an unproven discovered postmaster PID is never signalled and never blocks', () => {
    const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-f6-postmaster-'));
    try {
      fs.writeFileSync(path.join(databaseDir, 'postmaster.pid'), '4242\n');
      const out = evaluateScript(`
        const signaled = [];
        const result = await m.stopRecordedProcesses({
          version: 1,
          repoDir: ${JSON.stringify(posixWorktree)},
          appPort: 3111,
          databasePort: 5432,
          launcherPid: null,
          nextPid: null,
          postgresPid: null,
        }, ${JSON.stringify(databaseDir)}, {
          platform: 'linux',
          lookupProcess: async () => (${JSON.stringify(unrelated)}),
          signalProcess: (pid, signal) => signaled.push({ pid, signal: signal ?? null }),
          waitUntilDead: async (pids) => [...pids],
          isProcessAlive: () => true,
        });
        process.stdout.write(JSON.stringify({ signaled, result }));
      `);

      expect(out.signaled).toEqual([]);
      expect(out.result).toEqual({ unstopped: [], ambiguous: [] });
    } finally {
      fs.rmSync(databaseDir, { recursive: true, force: true });
    }
  });

  test('a proven-owned discovered PID that survives termination still blocks', () => {
    const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-f6-owned-pg-'));
    try {
      fs.writeFileSync(path.join(databaseDir, 'postmaster.pid'), '4242\n');
      const out = evaluateScript(`
        const signaled = [];
        const result = await m.stopRecordedProcesses({
          version: 1,
          repoDir: ${JSON.stringify(posixWorktree)},
          appPort: 3111,
          databasePort: 5432,
          launcherPid: null,
          nextPid: null,
          postgresPid: null,
        }, ${JSON.stringify(databaseDir)}, {
          platform: 'linux',
          lookupProcess: async () => (${JSON.stringify(ownedPostgres)}),
          signalProcess: (pid, signal) => signaled.push({ pid, signal: signal ?? null }),
          waitUntilDead: async (pids) => [...pids],
          isProcessAlive: () => true,
        });
        process.stdout.write(JSON.stringify({ signaled, result }));
      `);

      expect(out.signaled).toEqual([
        { pid: 4242, signal: null },
        { pid: 4242, signal: 'SIGKILL' },
      ]);
      expect(out.result.unstopped).toEqual([4242]);
    } finally {
      fs.rmSync(databaseDir, { recursive: true, force: true });
    }
  });

  test('POSIX process metadata parsing is fail-closed, and truncation cannot prove ownership', () => {
    const args = `node ${posixWorktree}/node_modules/next/dist/bin/next dev`;
    expect(evaluate(`m.parsePosixProcessQuery(4242, ${JSON.stringify(`${args}\n`)})`)).toEqual({
      pid: 4242,
      commandLine: args,
      executablePath: '',
    });

    expect(evaluate('m.parsePosixProcessQuery(4242, "")')).toBe(null);
    expect(evaluate('m.parsePosixProcessQuery(4242, "   ")')).toBe(null);
    expect(evaluate(`m.parsePosixProcessQuery(4242, ${JSON.stringify('one\ntwo')})`)).toBe(null);
    expect(evaluate('m.parsePosixProcessQuery(0, "node x")')).toBe(null);

    // A command line clipped before the checkout path loses evidence; it can
    // never gain any, so truncation is a false negative and never a false
    // positive.
    expect(evaluate(`m.belongsToOfflineRuntime(${JSON.stringify({
      commandLine: 'node /home/dev/ppbf-pla',
      repoDir: posixWorktree,
    })})`)).toBe(false);
  });
});

describe('owned app listener cleanup', () => {
  test('Windows listener PID parsing is fail-closed on ambiguity', () => {
    expect(evaluate('m.parseWindowsListenerPid("5001")')).toBe(5001);
    expect(evaluate('m.parseWindowsListenerPid("[5001,5001]")')).toBe(5001);
    expect(evaluate('m.parseWindowsListenerPid("[5001,5002]")')).toBe(null);
    expect(evaluate('m.parseWindowsListenerPid("")')).toBe(null);
  });

  test('stops the actual owned app listener even when it is not the recorded Next parent', () => {
    const result = evaluateScript(`
      const listener = {
        pid: 5001,
        commandLine: ${JSON.stringify(`${worktree}\\node_modules\\next\\dist\\server\\lib\\start-server.js`)},
        executablePath: 'node.exe',
      };
      const signaled = [];
      await m.stopRecordedProcesses({
        version: 1,
        repoDir: ${JSON.stringify(worktree)},
        appPort: 3111,
        databasePort: 5432,
        launcherPid: null,
        nextPid: null,
        postgresPid: null,
      }, null, {
        platform: 'win32',
        lookupListenerPid: async () => 5001,
        lookupProcess: async (pid) => pid === 5001 ? listener : null,
        signalProcess: (pid, signal) => signaled.push({ pid, signal: signal ?? null }),
        waitUntilDead: async () => [],
      });
      process.stdout.write(JSON.stringify(signaled));
    `);

    expect(result).toEqual([{ pid: 5001, signal: null }]);
  });

  test('never stops an unowned process listening on the app port', () => {
    const result = evaluateScript(`
      const unrelated = {
        pid: 5002,
        commandLine: 'C:\\\\Windows\\\\System32\\\\notepad.exe',
        executablePath: 'C:\\\\Windows\\\\System32\\\\notepad.exe',
      };
      const signaled = [];
      await m.stopRecordedProcesses({
        version: 1,
        repoDir: ${JSON.stringify(worktree)},
        appPort: 3111,
        databasePort: 5432,
        launcherPid: null,
        nextPid: null,
        postgresPid: null,
      }, null, {
        platform: 'win32',
        lookupListenerPid: async () => 5002,
        lookupProcess: async () => unrelated,
        signalProcess: (pid, signal) => signaled.push({ pid, signal: signal ?? null }),
        waitUntilDead: async () => [],
      });
      process.stdout.write(JSON.stringify(signaled));
    `);

    expect(result).toEqual([]);
  });

  test('launcher preserves runtime state when an owned process remains after stop', () => {
    const launcher = fs.readFileSync(path.resolve(__dirname, 'offline-runtime.mjs'), 'utf8');
    expect(launcher).toContain('const { unstopped, ambiguous } = await stopRecordedProcesses(state, databaseDir, { repoDir });');
    expect(launcher).toContain('Runtime state was preserved.');
  });

  test('the launcher only clears runtime state when nothing is left blocking', () => {
    const launcher = fs.readFileSync(path.resolve(__dirname, 'offline-runtime.mjs'), 'utf8');

    // removeRuntimeState must sit after the throw, so a non-empty blocking set
    // preserves the file rather than deleting it.
    const throwIndex = launcher.indexOf('if (problems.length) {');
    const clearIndex = launcher.indexOf('await removeRuntimeState(stateFile);');
    expect(throwIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeGreaterThan(throwIndex);

    // start and restart both route through the same gate, so the throw blocks them.
    expect(launcher).toContain('await stopThisCheckoutRuntime();');
    expect(launcher).toContain('start and restart are blocked');
  });

  test('the blocking message never tells the operator to delete state when ownership is merely unproven', () => {
    const launcher = fs.readFileSync(path.resolve(__dirname, 'offline-runtime.mjs'), 'utf8');

    expect(launcher).toContain('could not prove they belong to this checkout');
    expect(launcher).toContain('not a finding that they are unrelated');
    expect(launcher).toContain('only after independently verifying');
    expect(launcher).not.toMatch(/--force|--clear-state|--forget-runtime/);
  });
});

describe('runtime status', () => {
  test('no state is stopped', () => {
    expect(evaluate("m.formatStatus(null, m.inspectRuntime(null))")).toBe('PPBF offline runtime: stopped');
  });

  test('state whose pids are gone is reported stale rather than running', () => {
    const state = {
      version: 1,
      repoDir: worktree,
      appPort: 3111,
      databasePort: 54321,
      launcherPid: 2147483646,
      nextPid: 2147483645,
      postgresPid: 2147483644,
      startedAt: '2026-08-31T00:00:00.000Z',
    };
    const text = evaluate(`m.formatStatus(${JSON.stringify(state)}, m.inspectRuntime(${JSON.stringify(state)}))`);
    expect(text).toMatch(/^PPBF offline runtime: stopped \(stale state/);
    expect(text).toContain(worktree);
  });
});

describe('launcher source', () => {
  test('does not hardcode the main checkout path', () => {
    const launcher = fs.readFileSync(path.resolve(__dirname, 'offline-runtime.mjs'), 'utf8');
    const lifecycle = fs.readFileSync(path.resolve(__dirname, 'lib/offline-runtime-lifecycle.mjs'), 'utf8');
    expect(launcher).not.toMatch(/C:\\\\Dev\\\\ppbf-platform/);
    expect(lifecycle).not.toMatch(/C:\\\\Dev\\\\ppbf-platform/);
    expect(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).scripts.offline)
      .toBe('node scripts/offline-runtime.mjs');
  });
});

describe('runtime paths', () => {
  test('state and database live under this checkout, not a shared machine path', () => {
    expect(evaluate(`m.runtimePaths(${JSON.stringify(worktree)})`)).toEqual({
      runtimeDir: path.join(worktree, '.ppbf-offline'),
      databaseDir: path.join(worktree, '.ppbf-offline', 'postgres'),
      stateFile: path.join(worktree, '.ppbf-offline', 'runtime-state.json'),
    });
  });

  test('readRuntimeState ignores a state file from another checkout', () => {
    const expression = `
      (async () => {
        const fs = await import('node:fs/promises');
        const os = await import('node:os');
        const path = await import('node:path');
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ppbf-offline-state-'));
        const file = path.join(dir, 'runtime-state.json');
        await m.writeRuntimeState(file, m.createRuntimeState({
          repoDir: ${JSON.stringify(mainRepo)},
          appPort: 3100,
          databasePort: 5432,
          launcherPid: 9,
          nextPid: 8,
          postgresPid: 7,
          startedAt: '2026-08-31T00:00:00.000Z',
        }));
        const ignored = await m.readRuntimeState(file, ${JSON.stringify(worktree)});
        const accepted = await m.readRuntimeState(file, ${JSON.stringify(mainRepo)});
        await fs.rm(dir, { recursive: true, force: true });
        return { ignored, acceptedRepo: accepted && accepted.repoDir };
      })()
    `;
    expect(evaluate(expression)).toEqual({ ignored: null, acceptedRepo: mainRepo });
  });
});
