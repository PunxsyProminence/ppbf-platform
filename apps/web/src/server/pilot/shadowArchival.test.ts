import {
  ARCHIVAL_MIN_INTERVAL_MS,
  ARCHIVE_COLD_DAYS,
  createShadowArchivalSweep,
  resolveArchiveConfig,
  type ArchiveConfig,
  type ArchiveResult,
} from './shadowArchival';

const ok: ArchiveResult = { success: true, archivedCount: 4, aggregatedMonths: 2 };

describe('archive configuration', () => {
  test('is absent without a storage destination, so nothing is deleted unarchived', () => {
    // The sweep deletes audit rows once they are written to blob storage. An
    // environment with no storage connection string must archive nothing
    // rather than delete a minor's conversation history into no destination.
    expect(resolveArchiveConfig({})).toBeNull();
    expect(resolveArchiveConfig({ AZURE_STORAGE_CONNECTION_STRING: '   ' })).toBeNull();
  });

  test('reads the destination from the environment and defaults the container', () => {
    const config = resolveArchiveConfig({ AZURE_STORAGE_CONNECTION_STRING: 'conn' });
    expect(config).toEqual({
      hotDays: expect.any(Number),
      coldDays: ARCHIVE_COLD_DAYS,
      blobConnectionString: 'conn',
      containerName: 'ppbf-pilot-shadow-archive',
    });

    expect(
      resolveArchiveConfig({
        AZURE_STORAGE_CONNECTION_STRING: 'conn',
        PPBF_PILOT_SHADOW_ARCHIVE_CONTAINER: 'other-container',
      })?.containerName,
    ).toBe('other-container');
  });
});

describe('archival sweep', () => {
  const env = { AZURE_STORAGE_CONNECTION_STRING: 'conn' };

  test('runs at most once a day however often the caller ticks', async () => {
    // Housekeeping ticks hourly by default and the interval is
    // deploy-configurable, so the daily floor has to live in the sweep.
    let clock = 1_000_000;
    const archive = jest.fn(async () => ok);
    const sweep = createShadowArchivalSweep({ env, archive, now: () => clock });

    expect(await sweep()).toEqual({ ran: true, result: ok });

    clock += ARCHIVAL_MIN_INTERVAL_MS - 1;
    expect(await sweep()).toEqual({ ran: false, skipped: 'not_due' });
    expect(archive).toHaveBeenCalledTimes(1);

    clock += 1;
    expect(await sweep()).toEqual({ ran: true, result: ok });
    expect(archive).toHaveBeenCalledTimes(2);
  });

  test('does nothing, and stays due, while no destination is configured', async () => {
    let clock = 1_000_000;
    const archive = jest.fn(async () => ok);
    const configurable: Record<string, string | undefined> = {};
    const sweep = createShadowArchivalSweep({ env: configurable, archive, now: () => clock });

    expect(await sweep()).toEqual({ ran: false, skipped: 'not_configured' });
    expect(archive).not.toHaveBeenCalled();

    // An unconfigured tick must not consume the daily slot: the first tick
    // after storage is configured archives rather than waiting a day.
    configurable.AZURE_STORAGE_CONNECTION_STRING = 'conn';
    clock += 1_000;
    expect(await sweep()).toEqual({ ran: true, result: ok });
  });

  test('reports a failing archival instead of throwing at the worker', async () => {
    // The sweep shares a tick with job processing; a storage outage must
    // degrade to a logged failure, never an error that reaches the loop.
    const archive = jest.fn(async () => {
      throw new Error('storage unreachable');
    });
    const sweep = createShadowArchivalSweep({ env, archive, now: () => 1_000_000 });

    const outcome = await sweep();
    expect(outcome.ran).toBe(true);
    expect(outcome.result?.success).toBe(false);
    expect(outcome.result?.error).toContain('storage unreachable');
    expect(outcome.result?.archivedCount).toBe(0);
  });

  test('a failed run still consumes the daily slot', async () => {
    // Retrying a broken destination every hour would be an hourly connection
    // storm against Azure Storage for as long as it stays broken.
    let clock = 1_000_000;
    const archive = jest.fn(async (): Promise<ArchiveResult> => ({
      success: false,
      archivedCount: 0,
      aggregatedMonths: 0,
      error: 'Archive failed: container missing',
    }));
    const sweep = createShadowArchivalSweep({ env, archive, now: () => clock });

    await sweep();
    clock += 60 * 60 * 1000;
    expect(await sweep()).toEqual({ ran: false, skipped: 'not_due' });
    expect(archive).toHaveBeenCalledTimes(1);
  });

  test('passes the resolved configuration through to the archival run', async () => {
    const seen: ArchiveConfig[] = [];
    const sweep = createShadowArchivalSweep({
      env: { AZURE_STORAGE_CONNECTION_STRING: 'conn', PPBF_PILOT_SHADOW_ARCHIVE_CONTAINER: 'cold' },
      archive: async (config) => {
        seen.push(config);
        return ok;
      },
      now: () => 1_000_000,
    });

    await sweep();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ containerName: 'cold', coldDays: ARCHIVE_COLD_DAYS });
  });
});
