import { ethers } from "ethers";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { log, logError, logWarn } from "./logger";

const REGISTRY_ABI = [
  "function registerSite(string siteId, string name, string location, address owner)",
  "function registerAsset(string assetId, string siteId, string assetType, string nameOrTag, bool critical)",
  "function anchorEvent(string assetId, string eventType, bytes32 payloadHash)",
  "function anchorMaintenance(string assetId, string workOrderId, string maintenanceType, uint256 performedAt)",
  "function anchorBatchRoot(string batchId, bytes32 merkleRoot, uint256 eventCount)",
  "event SiteRegistered(string indexed siteId, string name, address owner, uint256 timestamp)",
  "event AssetRegistered(string indexed assetId, string siteId, string assetType, uint256 timestamp)",
  "event EventAnchored(string indexed assetId, string eventType, bytes32 payloadHash, uint256 timestamp, address recordedBy)",
  "event MaintenanceAnchored(string indexed assetId, string workOrderId, string maintenanceType, uint256 timestamp, address performedBy)",
  "event BatchRootAnchored(string indexed batchId, bytes32 merkleRoot, uint256 eventCount, uint256 timestamp, address anchoredBy)",
];

export interface BlockchainConfig {
  enabled: boolean;
  provider: ethers.JsonRpcProvider | null;
  wallet: ethers.Wallet | null;
  registry: ethers.Contract | null;
}

export class BlockchainService {
  private config: BlockchainConfig;

  constructor() {
    this.config = {
      enabled: false,
      provider: null,
      wallet: null,
      registry: null,
    };

    this.initialize();
  }

  private initialize() {
    try {
      const rpcUrl = process.env.BLOCKCHAIN_RPC_URL || "http://127.0.0.1:8545";
      const privateKey = process.env.BLOCKCHAIN_PRIVATE_KEY;
      const contractAddress = this.getContractAddress();

      if (!privateKey) {
        logWarn("⚠️  BLOCKCHAIN_PRIVATE_KEY not set. Blockchain features disabled.", "blockchain");
        return;
      }

      if (!contractAddress) {
        logWarn("⚠️  Contract not deployed. Run 'npx hardhat run scripts/deploy.ts --network localhost' first.", "blockchain");
        return;
      }

      this.config.provider = new ethers.JsonRpcProvider(rpcUrl);
      this.config.wallet = new ethers.Wallet(privateKey, this.config.provider);
      this.config.registry = new ethers.Contract(contractAddress, REGISTRY_ABI, this.config.wallet);
      this.config.enabled = true;

      log("✅ Blockchain service initialized", "blockchain");
      log(`   Provider: ${rpcUrl}`, "blockchain");
      log(`   Contract: ${contractAddress}`, "blockchain");
      log(`   Signer: ${this.config.wallet.address}`, "blockchain");
    } catch (error) {
      logError("❌ Failed to initialize blockchain service:", error, "blockchain");
    }
  }

  private getContractAddress(): string | null {
    try {
      const deploymentPath = path.join(process.cwd(), "deployment.json");
      if (fs.existsSync(deploymentPath)) {
        const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
        return deployment.address;
      }
    } catch (error) {
      logError("Failed to read deployment.json:", error, "blockchain");
    }
    return null;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  hashPayload(payload: any): string {
    const hash = createHash("sha256");
    hash.update(JSON.stringify(payload));
    return "0x" + hash.digest("hex");
  }

  async registerSite(siteId: string, name: string, location: string, owner: string): Promise<string | null> {
    if (!this.config.enabled || !this.config.registry) {
      return null;
    }

    try {
      const tx = await this.config.registry.registerSite(siteId, name, location, owner);
      const receipt = await tx.wait();
      log(`✅ Site ${siteId} registered on-chain: ${receipt.hash}`, "blockchain");
      return receipt.hash;
    } catch (error) {
      logError("Failed to register site on-chain:", error, "blockchain");
      return null;
    }
  }

  async registerAsset(
    assetId: string,
    siteId: string,
    assetType: string,
    nameOrTag: string,
    critical: boolean
  ): Promise<string | null> {
    if (!this.config.enabled || !this.config.registry) {
      return null;
    }

    try {
      const tx = await this.config.registry.registerAsset(assetId, siteId, assetType, nameOrTag, critical);
      const receipt = await tx.wait();
      log(`✅ Asset ${assetId} registered on-chain: ${receipt.hash}`, "blockchain");
      return receipt.hash;
    } catch (error) {
      logError("Failed to register asset on-chain:", error, "blockchain");
      return null;
    }
  }

  async anchorEvent(assetId: string, eventType: string, payloadHash: string): Promise<string | null> {
    if (!this.config.enabled || !this.config.registry) {
      return null;
    }

    try {
      const tx = await this.config.registry.anchorEvent(assetId, eventType, payloadHash);
      const receipt = await tx.wait();
      log(`✅ Event anchored on-chain: ${receipt.hash}`, "blockchain");
      return receipt.hash;
    } catch (error) {
      logError("Failed to anchor event on-chain:", error, "blockchain");
      return null;
    }
  }

  async anchorMaintenance(
    assetId: string,
    workOrderId: string,
    maintenanceType: string,
    performedAt: number
  ): Promise<string | null> {
    if (!this.config.enabled || !this.config.registry) {
      return null;
    }

    try {
      const tx = await this.config.registry.anchorMaintenance(assetId, workOrderId, maintenanceType, performedAt);
      const receipt = await tx.wait();
      log(`✅ Maintenance anchored on-chain: ${receipt.hash}`, "blockchain");
      return receipt.hash;
    } catch (error) {
      logError("Failed to anchor maintenance on-chain:", error, "blockchain");
      return null;
    }
  }

  async anchorBatchRoot(
    batchId: string,
    merkleRoot: string,
    eventCount: number
  ): Promise<string | null> {
    if (!this.config.enabled || !this.config.registry) {
      return null;
    }

    try {
      const tx = await this.config.registry.anchorBatchRoot(batchId, merkleRoot, eventCount);
      const receipt = await tx.wait();
      log(`✅ Batch root anchored on-chain: ${receipt.hash}`, "blockchain");
      log(`   Batch ID: ${batchId}`, "blockchain");
      log(`   Merkle Root: ${merkleRoot}`, "blockchain");
      log(`   Event Count: ${eventCount}`, "blockchain");
      return receipt.hash;
    } catch (error) {
      logError("Failed to anchor batch root on-chain:", error, "blockchain");
      return null;
    }
  }

  async getGasPrice(): Promise<{ gasPrice: bigint; formatted: string } | null> {
    if (!this.config.enabled || !this.config.provider) {
      return null;
    }

    try {
      const feeData = await this.config.provider.getFeeData();
      const gasPrice = feeData.gasPrice || BigInt(0);
      const formatted = ethers.formatUnits(gasPrice, "gwei") + " gwei";
      return { gasPrice, formatted };
    } catch (error) {
      logError("Failed to get gas price:", error, "blockchain");
      return null;
    }
  }

  async estimateGas(functionName: string, ...args: any[]): Promise<bigint | null> {
    if (!this.config.enabled || !this.config.registry) {
      return null;
    }

    try {
      const gasEstimate = await this.config.registry[functionName].estimateGas(...args);
      return gasEstimate;
    } catch (error) {
      logError(`Failed to estimate gas for ${functionName}:`, error, "blockchain");
      return null;
    }
  }
}

export const blockchainService = new BlockchainService();
