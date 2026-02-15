/**
 * Adapter Registry
 *
 * Central registry for all vendor adapters. Provides registration,
 * lookup, and capability querying.
 */

import { EventEmitter } from "events";
import type {
  BaseAdapter,
  AdapterType,
  AdapterManifest,
  AdapterEvent,
  ProtocolAdapter,
  DeviceAdapter,
  FeatureAdapter,
} from "../../shared/types/vendor-adapter";

// =============================================================================
// REGISTRY
// =============================================================================

export class AdapterRegistry extends EventEmitter {
  private adapters = new Map<string, BaseAdapter>();

  /**
   * Register an adapter. Throws if ID is already taken.
   */
  register(adapter: BaseAdapter): void {
    const { id } = adapter.manifest;
    if (this.adapters.has(id)) {
      throw new Error(`Adapter "${id}" is already registered`);
    }

    // Validate manifest
    this.validateManifest(adapter.manifest);

    this.adapters.set(id, adapter);
    this.emitEvent({ type: "adapter:registered", adapterId: id });
    console.log(`[AdapterRegistry] Registered: ${id} (${adapter.manifest.type})`);
  }

  /**
   * Unregister an adapter by ID.
   */
  unregister(id: string): boolean {
    const removed = this.adapters.delete(id);
    if (removed) {
      this.emitEvent({ type: "adapter:disposed", adapterId: id });
      console.log(`[AdapterRegistry] Unregistered: ${id}`);
    }
    return removed;
  }

  /**
   * Get an adapter by ID.
   */
  get(id: string): BaseAdapter | undefined {
    return this.adapters.get(id);
  }

  /**
   * Get a protocol adapter by ID (type-safe).
   */
  getProtocol(id: string): ProtocolAdapter | undefined {
    const adapter = this.adapters.get(id);
    return adapter?.manifest.type === "protocol"
      ? (adapter as ProtocolAdapter)
      : undefined;
  }

  /**
   * Get a device adapter by ID (type-safe).
   */
  getDevice(id: string): DeviceAdapter | undefined {
    const adapter = this.adapters.get(id);
    return adapter?.manifest.type === "device"
      ? (adapter as DeviceAdapter)
      : undefined;
  }

  /**
   * Get a feature adapter by ID (type-safe).
   */
  getFeature(id: string): FeatureAdapter | undefined {
    const adapter = this.adapters.get(id);
    return adapter?.manifest.type === "feature"
      ? (adapter as FeatureAdapter)
      : undefined;
  }

  /**
   * Get all adapters, optionally filtered by type.
   */
  getAll(type?: AdapterType): BaseAdapter[] {
    const all = Array.from(this.adapters.values());
    return type ? all.filter((a) => a.manifest.type === type) : all;
  }

  /**
   * Find adapters that declare a specific capability.
   */
  findByCapability(capabilityId: string): BaseAdapter[] {
    return this.getAll().filter((a) => a.hasCapability(capabilityId));
  }

  /**
   * Check if an adapter is registered.
   */
  has(id: string): boolean {
    return this.adapters.has(id);
  }

  /**
   * Get count of registered adapters.
   */
  get size(): number {
    return this.adapters.size;
  }

  /**
   * List all adapter manifests.
   */
  listManifests(): AdapterManifest[] {
    return this.getAll().map((a) => a.manifest);
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  private validateManifest(manifest: AdapterManifest): void {
    if (!manifest.id || typeof manifest.id !== "string") {
      throw new Error("Adapter manifest must have a non-empty string 'id'");
    }
    if (!manifest.name) {
      throw new Error(`Adapter "${manifest.id}": manifest must have a 'name'`);
    }
    if (!manifest.vendor) {
      throw new Error(`Adapter "${manifest.id}": manifest must have a 'vendor'`);
    }
    if (!manifest.version) {
      throw new Error(`Adapter "${manifest.id}": manifest must have a 'version'`);
    }
    if (!["protocol", "device", "feature"].includes(manifest.type)) {
      throw new Error(`Adapter "${manifest.id}": invalid type "${manifest.type}"`);
    }
  }

  private emitEvent(event: AdapterEvent): void {
    this.emit(event.type, event);
    this.emit("adapter:event", event);
  }
}

// Singleton instance
let registryInstance: AdapterRegistry | null = null;

export function getAdapterRegistry(): AdapterRegistry {
  if (!registryInstance) {
    registryInstance = new AdapterRegistry();
  }
  return registryInstance;
}

export function resetAdapterRegistry(): void {
  registryInstance = null;
}
