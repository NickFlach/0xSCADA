import { createGatewayProxy } from "./proxy";

function parsePort(value: string | undefined): number {
  const raw = value ?? "8080";
  if (!/^\d+$/.test(raw)) throw new Error("PORT must be an integer");
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be between 1 and 65535");
  }
  return port;
}

function requiredServerUrl(value: string | undefined): string {
  if (!value?.trim()) throw new Error("SERVER_URL is required");
  return value.trim();
}

try {
  const port = parsePort(process.env.PORT);
  const host = process.env.HOST?.trim() || "0.0.0.0";
  const gateway = createGatewayProxy({
    serverUrl: requiredServerUrl(process.env.SERVER_URL),
  });
  let shuttingDown = false;

  gateway.server.listen(port, host, () => {
    console.log(`0xSCADA gateway listening on ${host}:${port}`);
  });
  gateway.server.once("error", () => {
    console.error("0xSCADA gateway listener failed");
    process.exitCode = 1;
  });

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`0xSCADA gateway received ${signal}; shutting down`);
    void gateway.close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  const message = error instanceof Error ? error.message : "invalid configuration";
  console.error(`0xSCADA gateway failed to start: ${message}`);
  process.exitCode = 1;
}
