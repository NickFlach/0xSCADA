/**
 * OpenAPI 3.0 Specification for 0xSCADA API
 * 
 * This module defines the complete OpenAPI specification for all
 * 0xSCADA REST API endpoints.
 */

import type { OpenAPIV3 } from 'openapi-types';

export const openApiSpec: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: {
    title: '0xSCADA API',
    description: `
# 0xSCADA REST API

Industrial SCADA system with blockchain-backed audit trails.

## Authentication

Most endpoints require authentication via API key or JWT token:

- **API Key**: Include \`X-API-Key\` header
- **JWT Bearer**: Include \`Authorization: Bearer <token>\` header

## Rate Limiting

API endpoints are rate-limited:
- Standard endpoints: 100 requests/minute
- Data ingestion: 1000 requests/minute
- Health checks: No limit

## Versioning

Current API version: v1 (default), v2 (events only)
    `,
    version: '1.0.0',
    contact: {
      name: '0xSCADA Team',
      url: 'https://github.com/NickFlach/0xSCADA',
    },
    license: {
      name: 'MIT',
      url: 'https://opensource.org/licenses/MIT',
    },
  },
  servers: [
    {
      url: '/api',
      description: 'Current server',
    },
    {
      url: 'http://localhost:5000/api',
      description: 'Development server',
    },
  ],
  tags: [
    { name: 'Health', description: 'System health and status endpoints' },
    { name: 'Sites', description: 'Site management operations' },
    { name: 'Assets', description: 'Asset management within sites' },
    { name: 'Events', description: 'Event logging and retrieval' },
    { name: 'Blueprints', description: 'Control module blueprints and code generation' },
    { name: 'Agents', description: 'AI agent operations and outputs' },
    { name: 'Blockchain', description: 'Blockchain anchoring and verification' },
    { name: 'AAS', description: 'Asset Administration Shell integration' },
  ],
  paths: {
    // Health endpoints
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'System health check',
        description: 'Returns health status of all system components including database and blockchain connectivity.',
        operationId: 'getHealth',
        responses: {
          '200': {
            description: 'System is healthy',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
                example: {
                  status: 'healthy',
                  timestamp: '2024-01-15T12:00:00Z',
                  version: '1.0.0',
                  uptime: 3600.5,
                  components: {
                    database: { status: 'up', latencyMs: 5 },
                    blockchain: { status: 'up' },
                  },
                },
              },
            },
          },
          '503': {
            description: 'System is unhealthy',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
              },
            },
          },
        },
      },
    },

    // Sites endpoints
    '/sites': {
      get: {
        tags: ['Sites'],
        summary: 'List all sites',
        description: 'Retrieves all registered SCADA sites.',
        operationId: 'getSites',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        responses: {
          '200': {
            description: 'List of sites',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Site' },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['Sites'],
        summary: 'Create a new site',
        description: 'Registers a new SCADA site.',
        operationId: 'createSite',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateSiteRequest' },
              example: {
                name: 'Water Treatment Plant A',
                location: 'Austin, TX',
                description: 'Primary water treatment facility',
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Site created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Site' },
              },
            },
          },
          '400': {
            description: 'Invalid request',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    '/sites/{siteId}': {
      get: {
        tags: ['Sites'],
        summary: 'Get site by ID',
        operationId: 'getSiteById',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        parameters: [
          {
            name: 'siteId',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
            description: 'Site ID',
          },
        ],
        responses: {
          '200': {
            description: 'Site details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Site' },
              },
            },
          },
          '404': {
            description: 'Site not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },

    // Events endpoints
    '/v2/events': {
      get: {
        tags: ['Events'],
        summary: 'List events with pagination',
        description: 'Retrieves events with cursor-based pagination for efficient large dataset handling.',
        operationId: 'getEvents',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        parameters: [
          {
            name: 'cursor',
            in: 'query',
            schema: { type: 'string' },
            description: 'Pagination cursor for next page',
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            description: 'Number of events to return',
          },
          {
            name: 'siteId',
            in: 'query',
            schema: { type: 'integer' },
            description: 'Filter by site ID',
          },
          {
            name: 'type',
            in: 'query',
            schema: { type: 'string' },
            description: 'Filter by event type',
          },
        ],
        responses: {
          '200': {
            description: 'Paginated event list',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EventListResponse' },
              },
            },
          },
        },
      },
      post: {
        tags: ['Events'],
        summary: 'Create a new event',
        operationId: 'createEvent',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateEventRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Event created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Event' },
              },
            },
          },
        },
      },
    },

    // Blueprints endpoints
    '/blueprints/seed': {
      post: {
        tags: ['Blueprints'],
        summary: 'Seed blueprint database',
        description: 'Seeds the database with standard control module blueprints.',
        operationId: 'seedBlueprints',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Database seeded successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/blueprints/import': {
      post: {
        tags: ['Blueprints'],
        summary: 'Import blueprints from files',
        operationId: 'importBlueprints',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/BlueprintImportRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Import results',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/BlueprintImportResponse' },
              },
            },
          },
        },
      },
    },
    '/codegen/structured-text': {
      post: {
        tags: ['Blueprints'],
        summary: 'Generate IEC 61131-3 Structured Text',
        operationId: 'generateStructuredText',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CodegenRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Generated code',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CodegenResponse' },
              },
            },
          },
        },
      },
    },

    // Agents endpoints
    '/agents/outputs': {
      get: {
        tags: ['Agents'],
        summary: 'Get agent outputs',
        description: 'Retrieves outputs from AI agents.',
        operationId: 'getAgentOutputs',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        responses: {
          '200': {
            description: 'List of agent outputs',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/AgentOutput' },
                },
              },
            },
          },
        },
      },
    },
    '/agents/proposals': {
      get: {
        tags: ['Agents'],
        summary: 'Get agent proposals',
        description: 'Retrieves proposals awaiting approval.',
        operationId: 'getAgentProposals',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        responses: {
          '200': {
            description: 'List of proposals',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/AgentProposal' },
                },
              },
            },
          },
        },
      },
    },

    // Batch anchoring endpoints
    '/batch/status': {
      get: {
        tags: ['Blockchain'],
        summary: 'Get batch anchoring status',
        operationId: 'getBatchStatus',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Batch anchoring status',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/BatchStatus' },
              },
            },
          },
        },
      },
    },
    '/batch/anchor': {
      post: {
        tags: ['Blockchain'],
        summary: 'Trigger batch anchor',
        description: 'Manually triggers anchoring of pending events to blockchain.',
        operationId: 'triggerBatchAnchor',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Anchor result',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AnchorResult' },
              },
            },
          },
        },
      },
    },

    // AAS endpoints
    '/aas/shells': {
      get: {
        tags: ['AAS'],
        summary: 'List Asset Administration Shells',
        operationId: 'getAASShells',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        responses: {
          '200': {
            description: 'List of AAS shells',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/AASShell' },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'API key for authentication',
      },
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT token for authentication',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string' },
          code: { type: 'string' },
          details: { type: 'object' },
        },
      },
      HealthResponse: {
        type: 'object',
        required: ['status', 'timestamp', 'version', 'uptime', 'components'],
        properties: {
          status: {
            type: 'string',
            enum: ['healthy', 'unhealthy'],
          },
          timestamp: { type: 'string', format: 'date-time' },
          version: { type: 'string' },
          uptime: { type: 'number', description: 'Uptime in seconds' },
          components: {
            type: 'object',
            properties: {
              database: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['up', 'down'] },
                  latencyMs: { type: 'number' },
                },
              },
              blockchain: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['up', 'down'] },
                },
              },
            },
          },
        },
      },
      Site: {
        type: 'object',
        required: ['id', 'name', 'createdAt'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          location: { type: 'string', nullable: true },
          description: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      CreateSiteRequest: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
          location: { type: 'string', maxLength: 255 },
          description: { type: 'string', maxLength: 1000 },
        },
      },
      Event: {
        type: 'object',
        required: ['id', 'siteId', 'type', 'severity', 'message', 'timestamp'],
        properties: {
          id: { type: 'integer' },
          siteId: { type: 'integer' },
          assetId: { type: 'integer', nullable: true },
          type: { type: 'string' },
          severity: {
            type: 'string',
            enum: ['info', 'warning', 'error', 'critical'],
          },
          message: { type: 'string' },
          data: { type: 'object', nullable: true },
          timestamp: { type: 'string', format: 'date-time' },
          acknowledged: { type: 'boolean', default: false },
          acknowledgedAt: { type: 'string', format: 'date-time', nullable: true },
          acknowledgedBy: { type: 'string', nullable: true },
          merkleRoot: { type: 'string', nullable: true },
          txHash: { type: 'string', nullable: true },
        },
      },
      CreateEventRequest: {
        type: 'object',
        required: ['siteId', 'type', 'severity', 'message'],
        properties: {
          siteId: { type: 'integer' },
          assetId: { type: 'integer' },
          type: { type: 'string' },
          severity: {
            type: 'string',
            enum: ['info', 'warning', 'error', 'critical'],
          },
          message: { type: 'string' },
          data: { type: 'object' },
        },
      },
      EventListResponse: {
        type: 'object',
        required: ['events', 'pagination'],
        properties: {
          events: {
            type: 'array',
            items: { $ref: '#/components/schemas/Event' },
          },
          pagination: {
            type: 'object',
            properties: {
              nextCursor: { type: 'string', nullable: true },
              hasMore: { type: 'boolean' },
              total: { type: 'integer' },
            },
          },
        },
      },
      BlueprintImportRequest: {
        type: 'object',
        properties: {
          cmTypes: { type: 'string' },
          units: { type: 'string' },
          phases: { type: 'string' },
        },
      },
      BlueprintImportResponse: {
        type: 'object',
        properties: {
          cmTypesImported: { type: 'integer' },
          unitsImported: { type: 'integer' },
          phasesImported: { type: 'integer' },
          errors: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      CodegenRequest: {
        type: 'object',
        required: ['cmTypeId'],
        properties: {
          cmTypeId: { type: 'integer' },
          instanceName: { type: 'string' },
          parameters: { type: 'object' },
        },
      },
      CodegenResponse: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          language: { type: 'string' },
          warnings: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      AgentOutput: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          agentId: { type: 'string' },
          type: { type: 'string' },
          content: { type: 'string' },
          metadata: { type: 'object' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      AgentProposal: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          agentId: { type: 'string' },
          proposalType: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'approved', 'rejected'],
          },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      BatchStatus: {
        type: 'object',
        properties: {
          pendingEvents: { type: 'integer' },
          lastAnchorTime: { type: 'string', format: 'date-time', nullable: true },
          lastMerkleRoot: { type: 'string', nullable: true },
          lastTxHash: { type: 'string', nullable: true },
        },
      },
      AnchorResult: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          eventsAnchored: { type: 'integer' },
          merkleRoot: { type: 'string' },
          txHash: { type: 'string' },
        },
      },
      AASShell: {
        type: 'object',
        properties: {
          idShort: { type: 'string' },
          id: { type: 'string' },
          assetInformation: {
            type: 'object',
            properties: {
              assetKind: { type: 'string' },
              globalAssetId: { type: 'string' },
            },
          },
          submodels: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                keys: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string' },
                      value: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

export default openApiSpec;
