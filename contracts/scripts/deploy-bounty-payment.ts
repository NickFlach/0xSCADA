import { ethers } from "hardhat";

/**
 * Deploy BountyPayment contract
 *
 * Usage:
 *   npx hardhat run scripts/deploy-bounty-payment.ts --network polygon
 *   npx hardhat run scripts/deploy-bounty-payment.ts --network arbitrum
 *   npx hardhat run scripts/deploy-bounty-payment.ts --network optimism
 */
async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("Deploying BountyPayment Contract");
  console.log("═══════════════════════════════════════════════════════════\n");

  const [deployer] = await ethers.getSigners();

  console.log("Deployer address:", deployer.address);
  console.log(
    "Deployer balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH\n"
  );

  // Deploy BountyPayment contract
  console.log("Deploying BountyPayment...");
  const BountyPayment = await ethers.getContractFactory("BountyPayment");
  const bountyPayment = await BountyPayment.deploy();

  await bountyPayment.waitForDeployment();

  const contractAddress = await bountyPayment.getAddress();

  console.log("✅ BountyPayment deployed to:", contractAddress);
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("Post-Deployment Configuration");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Grant roles to GitHub Actions bot (replace with actual bot address)
  const GITHUB_ACTIONS_BOT = process.env.GITHUB_ACTIONS_BOT_ADDRESS;

  if (GITHUB_ACTIONS_BOT) {
    console.log("Granting PAYOUT_ROLE to GitHub Actions bot:", GITHUB_ACTIONS_BOT);
    const PAYOUT_ROLE = await bountyPayment.PAYOUT_ROLE();
    await bountyPayment.grantRole(PAYOUT_ROLE, GITHUB_ACTIONS_BOT);
    console.log("✅ PAYOUT_ROLE granted\n");
  } else {
    console.log("⚠️  GITHUB_ACTIONS_BOT_ADDRESS not set. You'll need to grant PAYOUT_ROLE manually.\n");
  }

  // Add additional maintainers if provided
  const ADDITIONAL_MAINTAINERS = process.env.ADDITIONAL_MAINTAINERS?.split(",") || [];

  if (ADDITIONAL_MAINTAINERS.length > 0) {
    console.log("Adding additional maintainers...");
    const MAINTAINER_ROLE = await bountyPayment.MAINTAINER_ROLE();

    for (const maintainer of ADDITIONAL_MAINTAINERS) {
      if (ethers.isAddress(maintainer.trim())) {
        await bountyPayment.grantRole(MAINTAINER_ROLE, maintainer.trim());
        console.log("  ✅", maintainer.trim());
      }
    }
    console.log();
  }

  // Fund the contract with initial bounty budget
  const INITIAL_FUNDING = process.env.INITIAL_FUNDING_ETH;

  if (INITIAL_FUNDING && parseFloat(INITIAL_FUNDING) > 0) {
    console.log(`Funding contract with ${INITIAL_FUNDING} ETH...`);
    const tx = await deployer.sendTransaction({
      to: contractAddress,
      value: ethers.parseEther(INITIAL_FUNDING),
    });
    await tx.wait();
    console.log("✅ Contract funded\n");
  } else {
    console.log("⚠️  INITIAL_FUNDING_ETH not set. Remember to fund the contract!\n");
  }

  // Get contract stats
  const stats = await bountyPayment.getStats();
  console.log("Contract Statistics:");
  console.log("  Total Bounties:", stats[0].toString());
  console.log("  Total Paid:", ethers.formatEther(stats[1]), "ETH");
  console.log("  Contract Balance:", ethers.formatEther(stats[2]), "ETH");
  console.log("  Paused:", stats[3]);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("Verification Instructions");
  console.log("═══════════════════════════════════════════════════════════\n");

  const network = await ethers.provider.getNetwork();
  const chainId = network.chainId;

  let explorerUrl = "";
  let verifyCommand = "";

  switch (chainId) {
    case 137n: // Polygon Mainnet
      explorerUrl = `https://polygonscan.com/address/${contractAddress}`;
      verifyCommand = `npx hardhat verify --network polygon ${contractAddress}`;
      break;
    case 42161n: // Arbitrum One
      explorerUrl = `https://arbiscan.io/address/${contractAddress}`;
      verifyCommand = `npx hardhat verify --network arbitrum ${contractAddress}`;
      break;
    case 10n: // Optimism
      explorerUrl = `https://optimistic.etherscan.io/address/${contractAddress}`;
      verifyCommand = `npx hardhat verify --network optimism ${contractAddress}`;
      break;
    case 8453n: // Base
      explorerUrl = `https://basescan.org/address/${contractAddress}`;
      verifyCommand = `npx hardhat verify --network base ${contractAddress}`;
      break;
    default:
      explorerUrl = `https://etherscan.io/address/${contractAddress}`;
      verifyCommand = `npx hardhat verify --network mainnet ${contractAddress}`;
  }

  console.log("Contract URL:", explorerUrl);
  console.log("\nTo verify the contract on the block explorer:");
  console.log("  ", verifyCommand);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("Environment Variables to Set");
  console.log("═══════════════════════════════════════════════════════════\n");

  console.log("Add these to your .env and GitHub Secrets:\n");
  console.log(`BOUNTY_CONTRACT_ADDRESS=${contractAddress}`);
  console.log(`BOUNTY_CONTRACT_NETWORK=${network.name}`);
  console.log(`BOUNTY_CONTRACT_CHAIN_ID=${chainId}`);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("Deployment Complete! 🎉");
  console.log("═══════════════════════════════════════════════════════════\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
