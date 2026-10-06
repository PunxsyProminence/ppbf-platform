import type { BridgeCredential } from './azureClients.js';
import type { BridgeConfig } from './config.js';
import { parseResearchExport, type ResearchExport } from './schemas.js';
import { trackSafeEvent } from './telemetry.js';

export class PpbfResearchClient {
  constructor(
    private readonly config: BridgeConfig,
    private readonly credential: BridgeCredential,
    private readonly request: typeof fetch = fetch,
  ) {}

  async fetchExport(): Promise<ResearchExport> {
    const scope = `${this.config.mcpAudience}/.default`;
    const accessToken = await this.credential.getToken(scope);
    if (!accessToken?.token) {
      throw new Error('ManagedIdentityTokenUnavailable');
    }

    const response = await this.request(
      `${this.config.stagingAppOrigin}/api/pilot/shadow/research-bridge/export`,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken.token}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(60_000),
      },
    );

    if (!response.ok) {
      throw new Error(`StagingExportHttp${response.status}`);
    }

    const { snapshot, dropped } = parseResearchExport(await response.json());
    if (dropped.research_needs > 0 || dropped.approved_evidence > 0) {
      trackSafeEvent('research.export.items-dropped', dropped);
    }
    return snapshot;
  }
}
