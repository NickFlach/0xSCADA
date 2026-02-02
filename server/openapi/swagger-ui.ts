/**
 * Swagger UI Integration
 * 
 * Provides interactive API documentation at /api/docs
 */

import type { Express, Request, Response } from 'express';
import { openApiSpec } from './openapi-spec.js';

// Swagger UI HTML template (embedded to avoid additional dependencies)
const swaggerUiHtml = (specUrl: string) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>0xSCADA API Documentation</title>
  <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; padding: 0; }
    .topbar { display: none; }
    .swagger-ui .info { margin: 30px 0; }
    .swagger-ui .info .title { font-size: 2em; }
    .swagger-ui .info .description { font-size: 1em; }
    .swagger-ui .info .description p { margin: 10px 0; }
    .swagger-ui .info .description code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
    .swagger-ui .info .description h1 { font-size: 1.5em; margin-top: 20px; }
    .swagger-ui .info .description h2 { font-size: 1.2em; margin-top: 15px; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function() {
      window.ui = SwaggerUIBundle({
        url: "${specUrl}",
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout",
        defaultModelsExpandDepth: 1,
        defaultModelExpandDepth: 1,
        displayRequestDuration: true,
        filter: true,
        showExtensions: true,
        showCommonExtensions: true,
        tryItOutEnabled: true,
        requestSnippetsEnabled: true,
        persistAuthorization: true
      });
    };
  </script>
</body>
</html>
`;

/**
 * Register Swagger UI routes
 */
export function registerSwaggerRoutes(app: Express): void {
  // Serve OpenAPI spec as JSON
  app.get('/api/docs/openapi.json', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(openApiSpec);
  });

  // Serve OpenAPI spec as YAML (optional)
  app.get('/api/docs/openapi.yaml', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/yaml');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(jsonToYaml(openApiSpec));
  });

  // Serve Swagger UI
  app.get('/api/docs', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(swaggerUiHtml('/api/docs/openapi.json'));
  });

  // Redirect /api/docs/ to /api/docs
  app.get('/api/docs/', (_req: Request, res: Response) => {
    res.redirect('/api/docs');
  });

  console.log('[OpenAPI] Swagger UI available at /api/docs');
}

/**
 * Simple JSON to YAML converter for OpenAPI spec
 */
function jsonToYaml(obj: object, indent = 0): string {
  const spaces = '  '.repeat(indent);
  let yaml = '';

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      yaml += `${spaces}${key}: null\n`;
    } else if (typeof value === 'string') {
      // Handle multiline strings
      if (value.includes('\n')) {
        yaml += `${spaces}${key}: |\n`;
        value.split('\n').forEach(line => {
          yaml += `${spaces}  ${line}\n`;
        });
      } else if (value.includes(':') || value.includes('#') || value.startsWith('*')) {
        yaml += `${spaces}${key}: "${value.replace(/"/g, '\\"')}"\n`;
      } else {
        yaml += `${spaces}${key}: ${value}\n`;
      }
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      yaml += `${spaces}${key}: ${value}\n`;
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        yaml += `${spaces}${key}: []\n`;
      } else {
        yaml += `${spaces}${key}:\n`;
        value.forEach(item => {
          if (typeof item === 'object' && item !== null) {
            yaml += `${spaces}- `;
            const itemYaml = jsonToYaml(item, indent + 2);
            const lines = itemYaml.split('\n').filter(l => l.trim());
            yaml += lines[0].trim() + '\n';
            lines.slice(1).forEach(line => {
              yaml += `${spaces}  ${line.trim()}\n`;
            });
          } else {
            yaml += `${spaces}- ${item}\n`;
          }
        });
      }
    } else if (typeof value === 'object') {
      yaml += `${spaces}${key}:\n`;
      yaml += jsonToYaml(value, indent + 1);
    }
  }

  return yaml;
}

export default registerSwaggerRoutes;
