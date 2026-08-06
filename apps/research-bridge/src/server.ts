import type { NextFunction, Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import type { BridgeConfig } from './config.js';
import type { EvidenceSearchResult } from './evidenceSearch.js';
import type { ResearchExport } from './schemas.js';
import { trackSafeEvent, trackSafeException } from './telemetry.js';

export interface ResearchDataSource {
  fetchExport(): Promise<ResearchExport>;
}

export interface EvidenceDataSource {
  search(query: string, limit: number): Promise<EvidenceSearchResult[]>;
}

type ServerDependencies = {
  research: ResearchDataSource;
  evidence: EvidenceDataSource;
};

function createProtocolServer(dependencies: ServerDependencies): McpServer {
  const server = new McpServer(
    { name: 'ppbf-research-bridge', version: '0.1.0' },
    {
      instructions: 'Read-only access to sanitized PPBF staging research needs and human-approved evidence. Never infer athlete identity and never request credentials or production data.',
    },
  );

  server.registerTool(
    'list_research_needs',
    {
      title: 'List PPBF research needs',
      description: 'Lists sanitized, non-athlete PPBF staging research needs that are safe for scientific review.',
      inputSchema: {
        status: z.enum(['open', 'resolved', 'all']).default('open'),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ status, limit }) => {
      const snapshot = await dependencies.research.fetchExport();
      const items = snapshot.research_needs
        .filter((item) => status === 'all' || item.status === status)
        .slice(0, limit);
      trackSafeEvent('mcp.tool.completed', { tool: 'list_research_needs', result_count: items.length });
      return {
        content: [{ type: 'text', text: JSON.stringify(items) }],
        structuredContent: { items },
      };
    },
  );

  server.registerTool(
    'get_research_need',
    {
      title: 'Get a PPBF research need',
      description: 'Returns one sanitized research need by the opaque ID returned by list_research_needs.',
      inputSchema: { research_need_id: z.string().min(12).max(64) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ research_need_id }) => {
      const snapshot = await dependencies.research.fetchExport();
      const item = snapshot.research_needs.find((candidate) => candidate.id === research_need_id) ?? null;
      trackSafeEvent('mcp.tool.completed', { tool: 'get_research_need', found: item !== null });
      return {
        content: [{ type: 'text', text: item ? JSON.stringify(item) : 'Research need not found.' }],
        structuredContent: { item },
        ...(item ? {} : { isError: true }),
      };
    },
  );

  server.registerTool(
    'search_approved_evidence',
    {
      title: 'Search approved PPBF evidence',
      description: 'Searches only organization-wide evidence that PPBF reviewers have approved and verified.',
      inputSchema: {
        query: z.string().trim().min(3).max(500),
        limit: z.number().int().min(1).max(10).default(5),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const items = await dependencies.evidence.search(query, limit);
      trackSafeEvent('mcp.tool.completed', { tool: 'search_approved_evidence', result_count: items.length });
      return {
        content: [{ type: 'text', text: JSON.stringify(items) }],
        structuredContent: { items },
      };
    },
  );

  return server;
}

function requirePlatformPrincipal(config: BridgeConfig) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!config.requirePlatformAuth || request.header('x-ms-client-principal')) {
      next();
      return;
    }
    response.status(401).json({ error: 'authentication_required' });
  };
}

export function createBridgeApp(config: BridgeConfig, dependencies: ServerDependencies) {
  const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: config.allowedHosts });
  app.disable('x-powered-by');

  app.get('/health', (_request: Request, response: Response) => {
    response.status(200).json({ status: 'ok', service: 'ppbf-research-bridge', data_access: false });
  });

  const requireAuth = requirePlatformPrincipal(config);
  app.post('/mcp', requireAuth, async (request: Request, response: Response) => {
    const server = createProtocolServer(dependencies);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
      response.on('close', () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      trackSafeException(error, 'mcp.request');
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_request: Request, response: Response): void => {
    response.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed' },
      id: null,
    });
  };
  app.get('/mcp', requireAuth, methodNotAllowed);
  app.delete('/mcp', requireAuth, methodNotAllowed);

  return app;
}
