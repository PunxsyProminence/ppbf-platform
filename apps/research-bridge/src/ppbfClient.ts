import type { BridgeCredential } from './azureClients.js';
import type { BridgeConfig } from './config.js';
import { researchExportSchema, type ResearchExport } from './schemas.js';

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
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      throw new Error(`StagingExportHttp${response.status}`);
    }

    return researchExportSchema.parse(await response.json());
  }
}
