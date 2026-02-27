/**
 * Flux State Engine Integration
 * 
 * Publishes SCADA equipment state to the Flux shared world state engine,
 * enabling cross-agent observability and bidirectional control.
 * 
 * See ADR-0015 and Issue #260.
 */

export { FluxPublisher } from "./flux-publisher";
export { FluxCommander } from "./flux-commander";
export type { CommandHandler } from "./flux-commander";
export { loadFluxConfig } from "./types";
export type { FluxConfig, FluxEvent, FluxEntity, FluxCommand, FluxCommandAck } from "./types";

import { FluxPublisher } from "./flux-publisher";
import { FluxCommander } from "./flux-commander";
import { loadFluxConfig } from "./types";

// Singleton instances
let _publisher: FluxPublisher | null = null;
let _commander: FluxCommander | null = null;

/** Get or create the FluxPublisher singleton */
export function getFluxPublisher(): FluxPublisher {
  if (!_publisher) {
    _publisher = new FluxPublisher(loadFluxConfig());
  }
  return _publisher;
}

/** Get or create the FluxCommander singleton */
export function getFluxCommander(): FluxCommander {
  if (!_commander) {
    _commander = new FluxCommander(loadFluxConfig());
  }
  return _commander;
}

/** Initialize and start the full Flux integration */
export function startFluxIntegration(): { publisher: FluxPublisher; commander: FluxCommander } {
  const publisher = getFluxPublisher();
  const commander = getFluxCommander();
  publisher.start();
  commander.start();
  return { publisher, commander };
}

/** Stop the Flux integration cleanly */
export function stopFluxIntegration(): void {
  _publisher?.stop();
  _commander?.stop();
}
