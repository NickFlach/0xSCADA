const hre = require("hardhat");
import { createHash } from "crypto";

interface BenchmarkResult {
  operation: string;
  gasUsed: bigint;
  gasPrice: bigint;
  costWei: bigint;
  costGwei: string;
  costUsd: string;
}

interface BatchBenchmarkResult {
  batchSize: number;
  totalGasUsed: bigint;
  gasPerEvent: number;
  costPerEvent: string;
  savingsVsIndividual: string;
}

const ETH_PRICE_USD = 3100;
const GWEI_PER_ETH = BigInt(1_000_000_000);

function weiToUsd(wei: bigint): string {
  const ethValue = Number(wei) / 1e18;
  return (ethValue * ETH_PRICE_USD).toFixed(6);
}

function formatGwei(wei: bigint): string {
  return (Number(wei) / 1e9).toFixed(4) + " gwei";
}

function generateEventHash(): string {
  const payload = {
    assetId: `asset-${Math.random().toString(36).substring(7)}`,
    eventType: "SETPOINT_CHANGE",
    value: Math.random() * 100,
    timestamp: new Date().toISOString(),
  };
  return "0x" + createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function buildMerkleRoot(hashes: string[]): string {
  if (hashes.length === 0) {
    return "0x" + createHash("sha256").update("").digest("hex");
  }

  let layer = hashes.map(h => h.replace("0x", ""));

  while (layer.length > 1) {
    const nextLayer: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = layer[i + 1] || left;
      const combined = left < right ? left + right : right + left;
      nextLayer.push(createHash("sha256").update(combined).digest("hex"));
    }
    layer = nextLayer;
  }

  return "0x" + layer[0];
}

async function main() {
  const { ethers } = hre;
  
  console.log("\n🔬 0xSCADA Gas Cost Benchmarking Tool");
  console.log("=====================================\n");
  console.log(`ETH Price: $${ETH_PRICE_USD}`);

  const [signer] = await ethers.getSigners();
  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice || BigInt(0);
  console.log(`Current Gas Price: ${ethers.formatUnits(gasPrice, "gwei")} gwei\n`);

  const IndustrialRegistry = await ethers.getContractFactory("IndustrialRegistry");
  const registry = await IndustrialRegistry.deploy();
  await registry.waitForDeployment();
  console.log(`📋 Contract deployed to: ${await registry.getAddress()}\n`);

  const siteId = "benchmark-site-" + Date.now();
  let tx = await registry.registerSite(siteId, "Benchmark Site", "Test Location", signer.address);
  let receipt = await tx.wait();
  console.log(`✅ Site registered (gas: ${receipt?.gasUsed})\n`);

  const assetId = "benchmark-asset-" + Date.now();
  tx = await registry.registerAsset(assetId, siteId, "BREAKER", "CB-BENCH-001", true);
  receipt = await tx.wait();
  console.log(`✅ Asset registered (gas: ${receipt?.gasUsed})\n`);

  console.log("📊 INDIVIDUAL EVENT ANCHORING");
  console.log("─".repeat(50));

  const individualResults: BenchmarkResult[] = [];
  for (let i = 0; i < 5; i++) {
    const eventHash = generateEventHash();
    const eventType = ["BREAKER_TRIP", "SETPOINT_CHANGE", "ALARM_ACTIVE", "STATUS_CHANGE", "VALUE_UPDATE"][i];
    
    tx = await registry.anchorEvent(assetId, eventType, eventHash);
    receipt = await tx.wait();
    
    const gasUsed: bigint = receipt?.gasUsed || BigInt(0);
    const costWei: bigint = gasUsed * gasPrice;
    
    individualResults.push({
      operation: `anchorEvent (${eventType})`,
      gasUsed,
      gasPrice,
      costWei,
      costGwei: formatGwei(costWei),
      costUsd: weiToUsd(costWei),
    });
    
    console.log(`  Event ${i + 1}: ${gasUsed} gas = $${weiToUsd(costWei)}`);
  }

  const avgIndividualGas = individualResults.reduce((sum, r) => sum + r.gasUsed, BigInt(0)) / BigInt(individualResults.length);
  const avgIndividualCost = Number(avgIndividualGas) * Number(gasPrice) / 1e18 * ETH_PRICE_USD;
  console.log(`\n  Average per event: ${avgIndividualGas} gas = $${avgIndividualCost.toFixed(6)}`);

  console.log("\n📦 BATCH ANCHORING (Merkle Root)");
  console.log("─".repeat(50));

  const batchSizes = [10, 25, 50, 100, 250, 500];
  const batchResults: BatchBenchmarkResult[] = [];

  for (const size of batchSizes) {
    const eventHashes = Array.from({ length: size }, () => generateEventHash());
    const merkleRoot = buildMerkleRoot(eventHashes);
    const batchId = `batch-${size}-${Date.now()}`;

    tx = await registry.anchorBatchRoot(batchId, merkleRoot, size);
    receipt = await tx.wait();

    const gasUsed = receipt?.gasUsed || BigInt(0);
    const gasPerEvent = Number(gasUsed) / size;
    const costWei = gasUsed * gasPrice;
    const costPerEvent = Number(costWei) / size / 1e18 * ETH_PRICE_USD;
    const individualCostForBatch = Number(avgIndividualGas) * size * Number(gasPrice) / 1e18 * ETH_PRICE_USD;
    const batchCost = Number(costWei) / 1e18 * ETH_PRICE_USD;
    const savings = ((individualCostForBatch - batchCost) / individualCostForBatch * 100).toFixed(1);

    batchResults.push({
      batchSize: size,
      totalGasUsed: gasUsed,
      gasPerEvent,
      costPerEvent: costPerEvent.toFixed(8),
      savingsVsIndividual: `${savings}%`,
    });

    console.log(`  Batch of ${size.toString().padStart(3)} events: ${gasUsed} gas total, ${gasPerEvent.toFixed(0)} gas/event, saves ${savings}%`);
  }

  console.log("\n📈 COST PROJECTION (Daily Operations)");
  console.log("─".repeat(50));

  const scenarios = [
    { name: "Small Plant", eventsPerDay: 100 },
    { name: "Medium Plant", eventsPerDay: 500 },
    { name: "Large Plant", eventsPerDay: 2000 },
    { name: "Multi-Site Fleet", eventsPerDay: 10000 },
  ];

  console.log("\n  Scenario              | Individual/day | Batched/day | Monthly Savings");
  console.log("  " + "─".repeat(70));

  for (const scenario of scenarios) {
    const individualDailyCost = Number(avgIndividualGas) * scenario.eventsPerDay * Number(gasPrice) / 1e18 * ETH_PRICE_USD;
    
    const batchesPerDay = Math.ceil(scenario.eventsPerDay / 100);
    const batch100 = batchResults.find(b => b.batchSize === 100);
    const batchedDailyCost = batchesPerDay * Number(batch100?.totalGasUsed || BigInt(0)) * Number(gasPrice) / 1e18 * ETH_PRICE_USD;
    
    const monthlySavings = (individualDailyCost - batchedDailyCost) * 30;

    console.log(`  ${scenario.name.padEnd(20)} | $${individualDailyCost.toFixed(2).padStart(12)} | $${batchedDailyCost.toFixed(4).padStart(10)} | $${monthlySavings.toFixed(2)}/mo`);
  }

  console.log("\n📋 SUMMARY");
  console.log("─".repeat(50));
  console.log(`  Individual event anchor: ~${avgIndividualGas} gas ($${avgIndividualCost.toFixed(6)} at current prices)`);
  console.log(`  Batch anchor (100 events): ~${batchResults.find(b => b.batchSize === 100)?.totalGasUsed} gas`);
  console.log(`  Gas savings with batching: 95-99% depending on batch size`);
  console.log(`\n  ✅ Recommendation: Batch events every 5-15 minutes for optimal cost efficiency`);
  console.log(`  ✅ For high-volume sites: Consider EIP-4844 blobs for even lower costs\n`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
