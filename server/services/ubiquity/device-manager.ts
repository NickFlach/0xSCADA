/**
 * Ubiquity Device Manager
 * Manages device discovery, tracking, and linking to 0xSCADA entities
 */

import { db } from "../../db";
import {
  ubiquityDevices,
  ubiquityDomains,
  controllers,
  assets,
  assetAdministrationShells,
} from "../../../shared/schema";
import { eq, and } from "drizzle-orm";
import { getUbiquityClient } from "./ubiquity-client";
import type {
  UbiquityDevice,
  DeviceDiscoveryResult,
  DeviceStatus,
} from "./ubiquity-types";

export class DeviceManager {
  /**
   * Discover devices from a Ubiquity domain and sync to database
   */
  async discoverAndSync(domainId: string): Promise<DeviceDiscoveryResult> {
    // Get domain from database
    const [domain] = await db
      .select()
      .from(ubiquityDomains)
      .where(eq(ubiquityDomains.id, domainId))
      .limit(1);

    if (!domain) {
      throw new Error(`Domain ${domainId} not found`);
    }

    // Call bridge to discover devices
    const client = getUbiquityClient();
    const discoveryResult = await client.discoverDevices(domainId);

    // Sync each device to database
    for (const device of discoveryResult.devices) {
      await this.syncDevice(domainId, device);
    }

    return discoveryResult;
  }

  /**
   * Sync a single device to database
   */
  private async syncDevice(domainId: string, device: UbiquityDevice): Promise<void> {
    // Check if device already exists
    const [existing] = await db
      .select()
      .from(ubiquityDevices)
      .where(
        and(
          eq(ubiquityDevices.domainId, domainId),
          eq(ubiquityDevices.ubiquityDeviceId, device.ubiquityDeviceId)
        )
      )
      .limit(1);

    if (existing) {
      // Update existing device
      await db
        .update(ubiquityDevices)
        .set({
          name: device.name,
          displayName: device.displayName,
          description: device.description,
          deviceType: device.deviceType,
          model: device.model,
          serialNumber: device.serialNumber,
          firmwareVersion: device.firmwareVersion,
          osVersion: device.osVersion,
          macAddress: device.macAddress,
          ipAddress: device.ipAddress,
          connectionStatus: device.connectionStatus,
          lastSeen: device.lastSeen ? new Date(device.lastSeen) : null,
          signalStrength: device.signalStrength,
          supportsRemoteDesktop: device.supportsRemoteDesktop,
          supportsFileTransfer: device.supportsFileTransfer,
          supportsProcessMonitor: device.supportsProcessMonitor,
          metadata: device.metadata ?? {},
          updatedAt: new Date(),
        })
        .where(eq(ubiquityDevices.id, existing.id));
    } else {
      // Insert new device
      await db.insert(ubiquityDevices).values({
        domainId,
        ubiquityDeviceId: device.ubiquityDeviceId,
        name: device.name,
        displayName: device.displayName,
        description: device.description,
        deviceType: device.deviceType,
        model: device.model,
        serialNumber: device.serialNumber,
        firmwareVersion: device.firmwareVersion,
        osVersion: device.osVersion,
        macAddress: device.macAddress,
        ipAddress: device.ipAddress,
        connectionStatus: device.connectionStatus,
        lastSeen: device.lastSeen ? new Date(device.lastSeen) : null,
        signalStrength: device.signalStrength,
        supportsRemoteDesktop: device.supportsRemoteDesktop,
        supportsFileTransfer: device.supportsFileTransfer,
        supportsProcessMonitor: device.supportsProcessMonitor,
        metadata: device.metadata ?? {},
      });
    }
  }

  /**
   * Get all devices, optionally filtered by domain
   */
  async getDevices(domainId?: string): Promise<UbiquityDevice[]> {
    let query = db.select().from(ubiquityDevices);

    if (domainId) {
      query = query.where(eq(ubiquityDevices.domainId, domainId)) as typeof query;
    }

    const devices = await query;

    return devices.map((d) => ({
      id: d.id,
      domainId: d.domainId,
      ubiquityDeviceId: d.ubiquityDeviceId,
      name: d.name,
      displayName: d.displayName ?? undefined,
      description: d.description ?? undefined,
      deviceType: d.deviceType ?? undefined,
      model: d.model ?? undefined,
      serialNumber: d.serialNumber ?? undefined,
      firmwareVersion: d.firmwareVersion ?? undefined,
      osVersion: d.osVersion ?? undefined,
      macAddress: d.macAddress ?? undefined,
      ipAddress: d.ipAddress ?? undefined,
      connectionStatus: d.connectionStatus as UbiquityDevice["connectionStatus"],
      lastSeen: d.lastSeen ?? undefined,
      signalStrength: d.signalStrength ?? undefined,
      supportsRemoteDesktop: d.supportsRemoteDesktop ?? false,
      supportsFileTransfer: d.supportsFileTransfer ?? false,
      supportsProcessMonitor: d.supportsProcessMonitor ?? false,
      metadata: d.metadata as Record<string, unknown>,
    }));
  }

  /**
   * Get a single device by ID
   */
  async getDevice(deviceId: string): Promise<UbiquityDevice | null> {
    const [device] = await db
      .select()
      .from(ubiquityDevices)
      .where(eq(ubiquityDevices.id, deviceId))
      .limit(1);

    if (!device) return null;

    return {
      id: device.id,
      domainId: device.domainId,
      ubiquityDeviceId: device.ubiquityDeviceId,
      name: device.name,
      displayName: device.displayName ?? undefined,
      description: device.description ?? undefined,
      deviceType: device.deviceType ?? undefined,
      model: device.model ?? undefined,
      serialNumber: device.serialNumber ?? undefined,
      firmwareVersion: device.firmwareVersion ?? undefined,
      osVersion: device.osVersion ?? undefined,
      macAddress: device.macAddress ?? undefined,
      ipAddress: device.ipAddress ?? undefined,
      connectionStatus: device.connectionStatus as UbiquityDevice["connectionStatus"],
      lastSeen: device.lastSeen ?? undefined,
      signalStrength: device.signalStrength ?? undefined,
      supportsRemoteDesktop: device.supportsRemoteDesktop ?? false,
      supportsFileTransfer: device.supportsFileTransfer ?? false,
      supportsProcessMonitor: device.supportsProcessMonitor ?? false,
      metadata: device.metadata as Record<string, unknown>,
    };
  }

  /**
   * Get device status from bridge (real-time)
   */
  async getDeviceStatus(deviceId: string): Promise<DeviceStatus | null> {
    const client = getUbiquityClient();
    return client.getDeviceStatus(deviceId);
  }

  /**
   * Link device to a 0xSCADA controller
   */
  async linkToController(deviceId: string, controllerId: string): Promise<void> {
    // Verify controller exists
    const [controller] = await db
      .select()
      .from(controllers)
      .where(eq(controllers.id, controllerId))
      .limit(1);

    if (!controller) {
      throw new Error(`Controller ${controllerId} not found`);
    }

    await db
      .update(ubiquityDevices)
      .set({ controllerId, updatedAt: new Date() })
      .where(eq(ubiquityDevices.id, deviceId));
  }

  /**
   * Link device to a 0xSCADA asset
   */
  async linkToAsset(deviceId: string, assetId: string): Promise<void> {
    // Verify asset exists
    const [asset] = await db
      .select()
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);

    if (!asset) {
      throw new Error(`Asset ${assetId} not found`);
    }

    await db
      .update(ubiquityDevices)
      .set({ assetId, updatedAt: new Date() })
      .where(eq(ubiquityDevices.id, deviceId));
  }

  /**
   * Link device to a Digital Twin (AAS)
   */
  async linkToAAS(deviceId: string, aasId: string): Promise<void> {
    // Verify AAS exists
    const [aas] = await db
      .select()
      .from(assetAdministrationShells)
      .where(eq(assetAdministrationShells.id, aasId))
      .limit(1);

    if (!aas) {
      throw new Error(`AAS ${aasId} not found`);
    }

    await db
      .update(ubiquityDevices)
      .set({ aasId, updatedAt: new Date() })
      .where(eq(ubiquityDevices.id, deviceId));
  }

  /**
   * Remove device from tracking
   */
  async removeDevice(deviceId: string): Promise<boolean> {
    const result = await db
      .delete(ubiquityDevices)
      .where(eq(ubiquityDevices.id, deviceId))
      .returning({ id: ubiquityDevices.id });

    return result.length > 0;
  }

  /**
   * Update device metadata
   */
  async updateDevice(
    deviceId: string,
    updates: Partial<Pick<UbiquityDevice, "displayName" | "description" | "metadata">>
  ): Promise<UbiquityDevice | null> {
    await db
      .update(ubiquityDevices)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(ubiquityDevices.id, deviceId));

    return this.getDevice(deviceId);
  }
}

// Singleton instance
let deviceManagerInstance: DeviceManager | null = null;

export function getDeviceManager(): DeviceManager {
  if (!deviceManagerInstance) {
    deviceManagerInstance = new DeviceManager();
  }
  return deviceManagerInstance;
}
