/**
 * Swagger/OpenAPI Documentation Setup
 * 
 * Serves the OpenAPI spec and Swagger UI at /api/docs
 * 
 * Note: This implementation serves YAML directly to Swagger UI, which handles
 * the parsing client-side. This avoids needing a YAML parser dependency.
 */

import { Router } from "express";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { rateLimit as expressRateLimit } from "express-rate-limit";
import { rateLimitMiddleware } from "./middleware/api-gateway";

export const swaggerRouter = Router();

// Rate limit for documentation endpoints (generous limit for static content).
//
// Paired for the reason documented on the `/api/` limiters in
// `middleware/api-gateway.ts`: `rateLimitMiddleware` is the real, optionally
// Redis-backed one but is invisible to static analysis; `express-rate-limit` is
// modelled by CodeQL and, being per-process, can only be stricter.
const docsRateLimit = rateLimitMiddleware({ windowMs: 60_000, maxRequests: 100 });
swaggerRouter.use(docsRateLimit);
swaggerRouter.use(
  expressRateLimit({
    windowMs: 60_000,
    limit: 100,
    standardHeaders: false,
    legacyHeaders: false,
  }),
);

// Get the path to the OpenAPI spec
function getSpecPath(): string {
  // Try multiple possible locations
  const possiblePaths = [
    join(__dirname, "..", "docs", "openapi.yaml"),
    join(process.cwd(), "docs", "openapi.yaml"),
  ];
  
  for (const path of possiblePaths) {
    if (existsSync(path)) {
      return path;
    }
  }
  
  return possiblePaths[0]; // Return first path as default
}

// Serve the OpenAPI spec as YAML
swaggerRouter.get("/openapi.yaml", (req, res) => {
  try {
    const specPath = getSpecPath();
    const specContent = readFileSync(specPath, "utf8");
    res.type("text/yaml").send(specContent);
  } catch (error) {
    console.error("Failed to read OpenAPI spec:", error);
    res.status(404).json({ error: "OpenAPI spec not found" });
  }
});

// Swagger UI HTML - loads YAML directly (Swagger UI handles parsing)
const swaggerUIHtml = (specUrl: string) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>0xSCADA API Documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css" />
  <style>
    body {
      margin: 0;
      padding: 0;
    }
    .swagger-ui .topbar {
      background-color: #0D0D0D;
    }
    .swagger-ui .topbar .download-url-wrapper .download-url-button {
      background-color: #00FF9C;
      color: #0D0D0D;
    }
    .swagger-ui .info .title {
      color: #00FF9C;
    }
    .swagger-ui .scheme-container {
      background-color: #1a1a1a;
    }
    /* Custom header */
    .custom-header {
      background: linear-gradient(135deg, #0D0D0D 0%, #1a1a2e 100%);
      padding: 20px 40px;
      color: #00FF9C;
      font-family: 'Share Tech Mono', monospace;
    }
    .custom-header h1 {
      margin: 0;
      font-size: 2em;
      letter-spacing: 2px;
    }
    .custom-header p {
      margin: 10px 0 0;
      color: #888;
      font-size: 0.9em;
    }
    .custom-header .links {
      margin-top: 10px;
    }
    .custom-header .links a {
      color: #0ABDC9;
      margin-right: 20px;
      text-decoration: none;
    }
    .custom-header .links a:hover {
      text-decoration: underline;
    }
  </style>
  <link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap" rel="stylesheet">
</head>
<body>
  <div class="custom-header">
    <h1>▓▓ 0xSCADA API</h1>
    <p>Decentralized Industrial Control Fabric • OpenAPI 3.0 Documentation</p>
    <div class="links">
      <a href="/api/docs/openapi.yaml" download>📥 Download OpenAPI Spec (YAML)</a>
      <a href="/api/docs/redoc">📖 View in ReDoc</a>
    </div>
  </div>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '${specUrl}',
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
        persistAuthorization: true,
        tryItOutEnabled: true,
        displayRequestDuration: true,
        filter: true,
        syntaxHighlight: {
          activate: true,
          theme: "monokai"
        }
      });
    };
  </script>
</body>
</html>
`;

// Serve Swagger UI
swaggerRouter.get("/", (req, res) => {
  const protocol = req.protocol;
  const host = req.get("host");
  const specUrl = `${protocol}://${host}/api/docs/openapi.yaml`;
  res.type("html").send(swaggerUIHtml(specUrl));
});

// Serve Redoc as alternative documentation viewer
const redocHtml = (specUrl: string) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>0xSCADA API Documentation - ReDoc</title>
  <link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap" rel="stylesheet">
  <style>
    body { margin: 0; padding: 0; }
  </style>
</head>
<body>
  <redoc spec-url='${specUrl}' 
         hide-download-button="false"
         theme='{
           "colors": {
             "primary": { "main": "#00FF9C" }
           },
           "typography": {
             "fontFamily": "system-ui, -apple-system, sans-serif",
             "headings": { "fontFamily": "Share Tech Mono, monospace" }
           },
           "sidebar": {
             "backgroundColor": "#0D0D0D",
             "textColor": "#ffffff"
           }
         }'>
  </redoc>
  <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
</body>
</html>
`;

swaggerRouter.get("/redoc", (req, res) => {
  const protocol = req.protocol;
  const host = req.get("host");
  const specUrl = `${protocol}://${host}/api/docs/openapi.yaml`;
  res.type("html").send(redocHtml(specUrl));
});

export default swaggerRouter;
