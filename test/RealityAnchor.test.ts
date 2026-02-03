import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { SiteRegistry, RealityAnchor } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { keccak256, toUtf8Bytes, solidityPackedKeccak256 } from "ethers";

/**
 * RealityAnchor Contract Tests
 * 
 * Tests artifact attestation functionality for the VERITY architecture.
 * Covers single attestations, batch attestations, and Merkle proof verification.
 */
describe("RealityAnchor", function () {
  // Artifact type constants (must match contract)
  const ARTIFACT_TYPE_TRACE = 1;
  const ARTIFACT_TYPE_PROOF = 2;
  const ARTIFACT_TYPE_TWIN = 3;
  const ARTIFACT_TYPE_DECISION = 4;

  // Test fixtures
  async function deployRealityAnchorFixture() {
    const [owner, gateway, signer, unauthorized] = await ethers.getSigners();

    // Deploy SiteRegistry
    const SiteRegistry = await ethers.getContractFactory("SiteRegistry");
    const siteRegistry = await SiteRegistry.deploy();
    await siteRegistry.waitForDeployment();

    // Deploy RealityAnchor
    const RealityAnchor = await ethers.getContractFactory("RealityAnchor");
    const realityAnchor = await RealityAnchor.deploy(
      await siteRegistry.getAddress()
    );
    await realityAnchor.waitForDeployment();

    // Register a test site
    const siteId = keccak256(toUtf8Bytes("test-site-001"));
    await siteRegistry.connect(owner).registerSite(siteId);

    // Authorize gateway
    await siteRegistry.connect(owner).authorizeGateway(siteId, gateway.address);

    return {
      siteRegistry,
      realityAnchor,
      siteId,
      owner,
      gateway,
      signer,
      unauthorized,
    };
  }

  // Helper to generate test content hashes
  function generateContentHash(content: string): string {
    return keccak256(toUtf8Bytes(content));
  }

  // Helper to build a simple Merkle tree and proofs
  function buildMerkleTree(leaves: string[]): {
    root: string;
    proofs: Map<string, { proof: string[]; index: number }>;
  } {
    if (leaves.length === 0) throw new Error("Empty leaves");

    // Pad to power of 2
    let paddedLeaves = [...leaves];
    while (paddedLeaves.length & (paddedLeaves.length - 1)) {
      paddedLeaves.push(paddedLeaves[paddedLeaves.length - 1]);
    }

    const proofs = new Map<string, { proof: string[]; index: number }>();

    // Initialize proof tracking
    leaves.forEach((leaf, i) => {
      proofs.set(leaf, { proof: [], index: i });
    });

    // Build tree level by level
    let currentLevel = paddedLeaves;
    while (currentLevel.length > 1) {
      const nextLevel: string[] = [];

      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = currentLevel[i + 1];

        // Update proofs
        leaves.forEach((leaf) => {
          const proofData = proofs.get(leaf)!;
          const leafIndex = proofData.index;

          if (Math.floor(leafIndex / 2) === Math.floor(i / 2)) {
            // This pair contains our leaf
            if (leafIndex % 2 === 0) {
              proofData.proof.push(right);
            } else {
              proofData.proof.push(left);
            }
            proofData.index = Math.floor(proofData.index / 2);
          }
        });

        // Compute parent hash
        const parent = solidityPackedKeccak256(
          ["bytes32", "bytes32"],
          [left, right]
        );
        nextLevel.push(parent);
      }

      currentLevel = nextLevel;
    }

    // Reset indices to original
    leaves.forEach((leaf, i) => {
      const proofData = proofs.get(leaf)!;
      proofData.index = i;
    });

    return { root: currentLevel[0], proofs };
  }

  describe("Deployment", function () {
    it("Should deploy with correct SiteRegistry reference", async function () {
      const { realityAnchor, siteRegistry } = await loadFixture(
        deployRealityAnchorFixture
      );

      expect(await realityAnchor.siteRegistry()).to.equal(
        await siteRegistry.getAddress()
      );
    });

    it("Should expose artifact type constants", async function () {
      const { realityAnchor } = await loadFixture(deployRealityAnchorFixture);

      expect(await realityAnchor.ARTIFACT_TYPE_TRACE()).to.equal(1);
      expect(await realityAnchor.ARTIFACT_TYPE_PROOF()).to.equal(2);
      expect(await realityAnchor.ARTIFACT_TYPE_TWIN()).to.equal(3);
      expect(await realityAnchor.ARTIFACT_TYPE_DECISION()).to.equal(4);
    });
  });

  describe("Single Artifact Attestation", function () {
    it("Should attest a trace artifact from authorized gateway", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      const contentHash = generateContentHash("kernel-trace-001");
      const metadataUri = "ipfs://QmTest123";

      const tx = await realityAnchor
        .connect(gateway)
        .attestArtifact(siteId, contentHash, ARTIFACT_TYPE_TRACE, metadataUri);

      const receipt = await tx.wait();

      // Check event
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = realityAnchor.interface.parseLog(log as any);
          return parsed?.name === "ArtifactAttested";
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;
    });

    it("Should attest a decision artifact from site owner (signer)", async function () {
      const { realityAnchor, siteId, owner } = await loadFixture(
        deployRealityAnchorFixture
      );

      const contentHash = generateContentHash("agent-decision-001");

      await expect(
        realityAnchor
          .connect(owner)
          .attestArtifact(siteId, contentHash, ARTIFACT_TYPE_DECISION, "")
      ).to.not.be.reverted;
    });

    it("Should reject attestation from unauthorized address", async function () {
      const { realityAnchor, siteId, unauthorized } = await loadFixture(
        deployRealityAnchorFixture
      );

      const contentHash = generateContentHash("unauthorized-artifact");

      await expect(
        realityAnchor
          .connect(unauthorized)
          .attestArtifact(siteId, contentHash, ARTIFACT_TYPE_TRACE, "")
      ).to.be.revertedWith("RealityAnchor: not authorized");
    });

    it("Should reject duplicate attestation of same content", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      const contentHash = generateContentHash("duplicate-artifact");

      // First attestation succeeds
      await realityAnchor
        .connect(gateway)
        .attestArtifact(siteId, contentHash, ARTIFACT_TYPE_TWIN, "");

      // Second attestation fails
      await expect(
        realityAnchor
          .connect(gateway)
          .attestArtifact(siteId, contentHash, ARTIFACT_TYPE_TWIN, "")
      ).to.be.revertedWith("RealityAnchor: artifact already attested");
    });

    it("Should reject invalid artifact type", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      const contentHash = generateContentHash("invalid-type-artifact");

      await expect(
        realityAnchor
          .connect(gateway)
          .attestArtifact(siteId, contentHash, 0, "") // Invalid type
      ).to.be.revertedWith("RealityAnchor: invalid artifact type");

      await expect(
        realityAnchor
          .connect(gateway)
          .attestArtifact(siteId, contentHash, 5, "") // Invalid type
      ).to.be.revertedWith("RealityAnchor: invalid artifact type");
    });

    it("Should reject zero content hash", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      await expect(
        realityAnchor
          .connect(gateway)
          .attestArtifact(
            siteId,
            ethers.ZeroHash,
            ARTIFACT_TYPE_TRACE,
            ""
          )
      ).to.be.revertedWith("RealityAnchor: invalid content hash");
    });
  });

  describe("Artifact Verification", function () {
    it("Should verify attested artifact", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      const contentHash = generateContentHash("verified-artifact");

      await realityAnchor
        .connect(gateway)
        .attestArtifact(siteId, contentHash, ARTIFACT_TYPE_PROOF, "");

      const [valid, attestedAt, attester] =
        await realityAnchor.verifyArtifact(contentHash);

      expect(valid).to.be.true;
      expect(attestedAt).to.be.gt(0);
      expect(attester).to.equal(gateway.address);
    });

    it("Should return false for non-attested artifact", async function () {
      const { realityAnchor } = await loadFixture(deployRealityAnchorFixture);

      const contentHash = generateContentHash("never-attested");

      const [valid, attestedAt, attester] =
        await realityAnchor.verifyArtifact(contentHash);

      expect(valid).to.be.false;
      expect(attestedAt).to.equal(0);
      expect(attester).to.equal(ethers.ZeroAddress);
    });

    it("Should check if content is attested via isAttested", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      const contentHash = generateContentHash("check-attested");

      // Before attestation
      let [exists, attestationId] = await realityAnchor.isAttested(contentHash);
      expect(exists).to.be.false;
      expect(attestationId).to.equal(ethers.ZeroHash);

      // Attest
      await realityAnchor
        .connect(gateway)
        .attestArtifact(siteId, contentHash, ARTIFACT_TYPE_TRACE, "");

      // After attestation
      [exists, attestationId] = await realityAnchor.isAttested(contentHash);
      expect(exists).to.be.true;
      expect(attestationId).to.not.equal(ethers.ZeroHash);
    });
  });

  describe("Batch Attestation", function () {
    it("Should attest a batch of artifacts", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      const leaves = [
        generateContentHash("batch-artifact-1"),
        generateContentHash("batch-artifact-2"),
        generateContentHash("batch-artifact-3"),
        generateContentHash("batch-artifact-4"),
      ];

      const { root } = buildMerkleTree(leaves);
      const artifactCount = leaves.length;

      const tx = await realityAnchor
        .connect(gateway)
        .attestArtifactBatch(siteId, root, ARTIFACT_TYPE_TRACE, artifactCount);

      const receipt = await tx.wait();

      // Check event
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = realityAnchor.interface.parseLog(log as any);
          return parsed?.name === "ArtifactBatchAttested";
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;
    });

    it("Should reject empty batch", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      const fakeRoot = generateContentHash("fake-root");

      await expect(
        realityAnchor
          .connect(gateway)
          .attestArtifactBatch(siteId, fakeRoot, ARTIFACT_TYPE_TRACE, 0)
      ).to.be.revertedWith("RealityAnchor: empty batch");
    });

    it("Should reject zero merkle root", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      await expect(
        realityAnchor
          .connect(gateway)
          .attestArtifactBatch(siteId, ethers.ZeroHash, ARTIFACT_TYPE_TRACE, 10)
      ).to.be.revertedWith("RealityAnchor: invalid merkle root");
    });
  });

  describe("Batch Merkle Proof Verification", function () {
    it("Should verify artifact in batch with valid proof", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      const leaves = [
        generateContentHash("merkle-artifact-1"),
        generateContentHash("merkle-artifact-2"),
        generateContentHash("merkle-artifact-3"),
        generateContentHash("merkle-artifact-4"),
      ];

      const { root, proofs } = buildMerkleTree(leaves);

      // Attest the batch
      const tx = await realityAnchor
        .connect(gateway)
        .attestArtifactBatch(siteId, root, ARTIFACT_TYPE_DECISION, leaves.length);

      const receipt = await tx.wait();

      // Extract batch ID from event
      let batchId: string = "";
      for (const log of receipt?.logs || []) {
        try {
          const parsed = realityAnchor.interface.parseLog(log as any);
          if (parsed?.name === "ArtifactBatchAttested") {
            batchId = parsed.args[0];
            break;
          }
        } catch {}
      }
      expect(batchId).to.not.equal("");

      // Verify each leaf
      for (const leaf of leaves) {
        const proofData = proofs.get(leaf)!;
        const [valid, attestedAt] = await realityAnchor.verifyArtifactInBatch(
          batchId,
          leaf,
          proofData.proof,
          proofData.index
        );

        expect(valid).to.be.true;
        expect(attestedAt).to.be.gt(0);
      }
    });

    it("Should reject invalid merkle proof", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      const leaves = [
        generateContentHash("valid-1"),
        generateContentHash("valid-2"),
      ];

      const { root, proofs } = buildMerkleTree(leaves);

      // Attest batch
      const tx = await realityAnchor
        .connect(gateway)
        .attestArtifactBatch(siteId, root, ARTIFACT_TYPE_PROOF, leaves.length);

      const receipt = await tx.wait();
      let batchId: string = "";
      for (const log of receipt?.logs || []) {
        try {
          const parsed = realityAnchor.interface.parseLog(log as any);
          if (parsed?.name === "ArtifactBatchAttested") {
            batchId = parsed.args[0];
            break;
          }
        } catch {}
      }

      // Try to verify with wrong content hash
      const fakeContent = generateContentHash("not-in-batch");
      const proofData = proofs.get(leaves[0])!;

      const [valid] = await realityAnchor.verifyArtifactInBatch(
        batchId,
        fakeContent,
        proofData.proof,
        proofData.index
      );

      expect(valid).to.be.false;
    });

    it("Should return false for non-existent batch", async function () {
      const { realityAnchor } = await loadFixture(deployRealityAnchorFixture);

      const fakeBatchId = generateContentHash("fake-batch-id");
      const fakeContent = generateContentHash("fake-content");

      const [valid, attestedAt] = await realityAnchor.verifyArtifactInBatch(
        fakeBatchId,
        fakeContent,
        [],
        0
      );

      expect(valid).to.be.false;
      expect(attestedAt).to.equal(0);
    });
  });

  describe("View Functions", function () {
    it("Should retrieve attestation details", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      const contentHash = generateContentHash("detailed-artifact");
      const metadataUri = "ipfs://QmDetailedTest";

      const tx = await realityAnchor
        .connect(gateway)
        .attestArtifact(siteId, contentHash, ARTIFACT_TYPE_TWIN, metadataUri);

      const receipt = await tx.wait();

      // Get attestation ID from event
      let attestationId: string = "";
      for (const log of receipt?.logs || []) {
        try {
          const parsed = realityAnchor.interface.parseLog(log as any);
          if (parsed?.name === "ArtifactAttested") {
            attestationId = parsed.args[0];
            break;
          }
        } catch {}
      }

      const [
        retrievedContentHash,
        merkleRoot,
        artifactType,
        timestamp,
        attester,
        retrievedSiteId,
        retrievedUri,
      ] = await realityAnchor.getAttestation(attestationId);

      expect(retrievedContentHash).to.equal(contentHash);
      expect(merkleRoot).to.equal(ethers.ZeroHash); // Standalone
      expect(artifactType).to.equal(ARTIFACT_TYPE_TWIN);
      expect(timestamp).to.be.gt(0);
      expect(attester).to.equal(gateway.address);
      expect(retrievedSiteId).to.equal(siteId);
      expect(retrievedUri).to.equal(metadataUri);
    });

    it("Should return correct artifact type names", async function () {
      const { realityAnchor } = await loadFixture(deployRealityAnchorFixture);

      expect(await realityAnchor.getArtifactTypeName(1)).to.equal("trace");
      expect(await realityAnchor.getArtifactTypeName(2)).to.equal("proof");
      expect(await realityAnchor.getArtifactTypeName(3)).to.equal("twin");
      expect(await realityAnchor.getArtifactTypeName(4)).to.equal("decision");
      expect(await realityAnchor.getArtifactTypeName(99)).to.equal("unknown");
    });

    it("Should track attestation counts", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      expect(await realityAnchor.getAttestationCount()).to.equal(0);
      expect(await realityAnchor.getSiteAttestationCount(siteId)).to.equal(0);

      // Add attestations
      await realityAnchor
        .connect(gateway)
        .attestArtifact(
          siteId,
          generateContentHash("count-test-1"),
          ARTIFACT_TYPE_TRACE,
          ""
        );

      await realityAnchor
        .connect(gateway)
        .attestArtifact(
          siteId,
          generateContentHash("count-test-2"),
          ARTIFACT_TYPE_PROOF,
          ""
        );

      expect(await realityAnchor.getAttestationCount()).to.equal(2);
      expect(await realityAnchor.getSiteAttestationCount(siteId)).to.equal(2);
    });

    it("Should track batch counts", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      expect(await realityAnchor.getBatchCount()).to.equal(0);
      expect(await realityAnchor.getSiteBatchCount(siteId)).to.equal(0);

      // Add batches
      await realityAnchor
        .connect(gateway)
        .attestArtifactBatch(
          siteId,
          generateContentHash("batch-root-1"),
          ARTIFACT_TYPE_TRACE,
          10
        );

      await realityAnchor
        .connect(gateway)
        .attestArtifactBatch(
          siteId,
          generateContentHash("batch-root-2"),
          ARTIFACT_TYPE_DECISION,
          5
        );

      expect(await realityAnchor.getBatchCount()).to.equal(2);
      expect(await realityAnchor.getSiteBatchCount(siteId)).to.equal(2);
    });
  });

  describe("Gas Cost Analysis", function () {
    it("Should measure gas for single attestation", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      const contentHash = generateContentHash("gas-test-single");

      const tx = await realityAnchor
        .connect(gateway)
        .attestArtifact(siteId, contentHash, ARTIFACT_TYPE_TRACE, "");

      const receipt = await tx.wait();
      const gasUsed = receipt?.gasUsed || 0n;

      console.log(`    Gas for single attestation (no URI): ${gasUsed}`);
      expect(gasUsed).to.be.lt(100000n); // Should be under 100k
    });

    it("Should measure gas for attestation with metadata URI", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      const contentHash = generateContentHash("gas-test-with-uri");
      const metadataUri = "ipfs://QmTestMetadataHashThatIsReasonablyLong";

      const tx = await realityAnchor
        .connect(gateway)
        .attestArtifact(siteId, contentHash, ARTIFACT_TYPE_PROOF, metadataUri);

      const receipt = await tx.wait();
      const gasUsed = receipt?.gasUsed || 0n;

      console.log(`    Gas for attestation with URI: ${gasUsed}`);
      expect(gasUsed).to.be.lt(120000n);
    });

    it("Should measure gas for batch attestation", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      const root = generateContentHash("batch-gas-test-root");

      const tx = await realityAnchor
        .connect(gateway)
        .attestArtifactBatch(siteId, root, ARTIFACT_TYPE_DECISION, 100);

      const receipt = await tx.wait();
      const gasUsed = receipt?.gasUsed || 0n;

      console.log(`    Gas for batch attestation (100 artifacts): ${gasUsed}`);
      expect(gasUsed).to.be.lt(80000n); // Batches should be efficient
    });

    it("Should measure gas for merkle proof verification", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      const leaves = [
        generateContentHash("verify-gas-1"),
        generateContentHash("verify-gas-2"),
        generateContentHash("verify-gas-3"),
        generateContentHash("verify-gas-4"),
      ];

      const { root, proofs } = buildMerkleTree(leaves);

      const tx = await realityAnchor
        .connect(gateway)
        .attestArtifactBatch(siteId, root, ARTIFACT_TYPE_TRACE, leaves.length);

      const receipt = await tx.wait();
      let batchId: string = "";
      for (const log of receipt?.logs || []) {
        try {
          const parsed = realityAnchor.interface.parseLog(log as any);
          if (parsed?.name === "ArtifactBatchAttested") {
            batchId = parsed.args[0];
            break;
          }
        } catch {}
      }

      // Verification is a view function, estimate gas
      const proofData = proofs.get(leaves[0])!;
      const gasEstimate = await realityAnchor.verifyArtifactInBatch.estimateGas(
        batchId,
        leaves[0],
        proofData.proof,
        proofData.index
      );

      console.log(`    Gas for merkle verification (depth=${proofData.proof.length}): ${gasEstimate}`);
      expect(gasEstimate).to.be.lt(30000n);
    });
  });

  describe("Inherited EventAnchor Functionality", function () {
    it("Should still support anchorBatch from EventAnchor", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      const merkleRoot = generateContentHash("event-anchor-test");
      const metadataHash = generateContentHash("metadata");

      await expect(
        realityAnchor.connect(gateway).anchorBatch(
          siteId,
          merkleRoot,
          metadataHash,
          "ipfs://events",
          100, // eventCount
          Math.floor(Date.now() / 1000) - 3600, // firstEventTimestamp
          Math.floor(Date.now() / 1000) // lastEventTimestamp
        )
      ).to.not.be.reverted;
    });

    it("Should still support verifyEvent from EventAnchor", async function () {
      const { realityAnchor, siteId, gateway } = await loadFixture(
        deployRealityAnchorFixture
      );

      const leaves = [
        generateContentHash("event-1"),
        generateContentHash("event-2"),
      ];
      const { root, proofs } = buildMerkleTree(leaves);

      const tx = await realityAnchor.connect(gateway).anchorBatch(
        siteId,
        root,
        generateContentHash("meta"),
        "ipfs://events",
        leaves.length,
        Math.floor(Date.now() / 1000) - 3600,
        Math.floor(Date.now() / 1000)
      );

      const receipt = await tx.wait();
      let anchorId: string = "";
      for (const log of receipt?.logs || []) {
        try {
          const parsed = realityAnchor.interface.parseLog(log as any);
          if (parsed?.name === "BatchAnchored") {
            anchorId = parsed.args[0];
            break;
          }
        } catch {}
      }

      const proofData = proofs.get(leaves[0])!;
      const valid = await realityAnchor.verifyEvent(
        anchorId,
        leaves[0],
        proofData.proof,
        proofData.index
      );

      expect(valid).to.be.true;
    });
  });
});
