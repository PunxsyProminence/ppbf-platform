import type { ResearchExport } from './schemas.js';
import type { ResearchDataSource } from './server.js';

/**
 * CL-C22. Each MCP tool call used to fetch the whole staging export again, so
 * one `list_research_needs` cost one full export query. The MCP server reads
 * through this instead: one fetch serves every call for `ttlMs`, concurrent
 * calls share the fetch in flight, and a failed fetch is not remembered.
 *
 * MCP reads only. The sync job keeps its own fresh fetch, so a retraction
 * still leaves the search index on the next sync, not a TTL later.
 */
export class CachedResearchSource implements ResearchDataSource {
  private cached: { snapshot: ResearchExport; fetchedAt: number } | null = null;
  private inFlight: Promise<ResearchExport> | null = null;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly upstream: ResearchDataSource,
    options: { ttlMs: number; now?: () => number },
  ) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  fetchExport(): Promise<ResearchExport> {
    if (this.cached && this.now() - this.cached.fetchedAt < this.ttlMs) {
      return Promise.resolve(this.cached.snapshot);
    }
    if (!this.inFlight) {
      this.inFlight = this.upstream
        .fetchExport()
        .then((snapshot) => {
          this.cached = { snapshot, fetchedAt: this.now() };
          return snapshot;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }
}
