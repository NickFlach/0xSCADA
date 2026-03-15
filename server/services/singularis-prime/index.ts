/**
 * SingularisPrime Integration
 *
 * Provides SCADA domain event schemas and Flux Universe publishing
 * for the SpaceChildCollective / SingularisPrime event mesh.
 *
 * Issues: #348, #349
 * ADR: ADR-0022
 */

export * from "./schemas";
export { FluxUniversePublisher, loadFluxUniverseConfig } from "./flux-universe-publisher";
export type { FluxUniversePublisherConfig } from "./flux-universe-publisher";

import { FluxUniversePublisher, loadFluxUniverseConfig } from "./flux-universe-publisher";

let _instance: FluxUniversePublisher | null = null;

/** Get or create the FluxUniversePublisher singleton */
export function getFluxUniversePublisher(): FluxUniversePublisher {
  if (!_instance) {
    _instance = new FluxUniversePublisher(loadFluxUniverseConfig());
  }
  return _instance;
}

/** Start the SingularisPrime Flux Universe integration */
export function startSingularisPrimeIntegration(): FluxUniversePublisher {
  const pub = getFluxUniversePublisher();
  pub.start();
  return pub;
}

/** Stop the SingularisPrime integration */
export function stopSingularisPrimeIntegration(): void {
  _instance?.stop();
}
