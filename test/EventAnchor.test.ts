import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { SiteRegistry, EventAnchor } from "../typechain-types";

describe("EventAnchor", function () {
  // Fixture to deploy contracts
  async function deployContractsFixture() {
    const [owner, gateway, signer, unauthorized] = await ethers.getSigners();

    // Deploy SiteRegistry first
    const SiteRegistryFactory = await ethers.getContractFactory("SiteRegistry");
    const siteRegistry = await SiteRegistryFactory.deploy();
    await siteRegistry.waitForDeployment();

    // Deploy EventAnchor with SiteRegistry address
    const EventAnchorFactory = await ethers.getContractFactory("EventAnchor");
    const eventAnchor = await EventAnchorFactory.deploy(await siteRegistry.getAddress());
    await eventAnchor.waitForDeployment();

    // Register a test site
    const siteId = ethers.keccak256(ethers.toUtf8Bytes("test-site-001"));
    await siteRegistry.registerSite(siteId);

    // Authorize a gateway for the site
    await siteRegistry.authorizeGateway(siteId, gateway.address);

    return {
      siteRegistry,
      eventAnchor,
      siteId,
      owner,
      gateway,
      signer,
      unauthorized,
    };
  }

  // Helper function to create sample batch data
  function createSampleBatch(siteId: string) {
    return {
      siteId,
      merkleRoot: ethers.keccak256(ethers.toUtf8Bytes("merkle-root-test")),
      metadataHash: ethers.keccak256(ethers.toUtf8Bytes("metadata-hash")),
      metadataUri: "ipfs://QmTest123456789",
      eventCount: 10n,
      firstEventTimestamp: BigInt(Date.now() - 3600000), // 1 hour ago
      lastEventTimestamp: BigInt(Date.now()),
    };
  }

  describe("Deployment", function () {
    it("should set the correct SiteRegistry address", async function () {
      const { eventAnchor, siteRegistry } = await loadFixture(deployContractsFixture);
      expect(await eventAnchor.siteRegistry()).to.equal(await siteRegistry.getAddress());
    });

    it("should start with zero anchors", async function () {
      const { eventAnchor } = await loadFixture(deployContractsFixture);
      expect(await eventAnchor.getAnchorCount()).to.equal(0);
    });
  });

  describe("anchorBatch", function () {
    describe("Access Control", function () {
      it("should allow authorized gateway to anchor batch", async function () {
        const { eventAnchor, siteId, gateway } = await loadFixture(deployContractsFixture);
        const batch = createSampleBatch(siteId);

        await expect(
          eventAnchor.connect(gateway).anchorBatch(
            batch.siteId,
            batch.merkleRoot,
            batch.metadataHash,
            batch.metadataUri,
            batch.eventCount,
            batch.firstEventTimestamp,
            batch.lastEventTimestamp
          )
        ).to.not.be.reverted;
      });

      it("should allow authorized signer (owner) to anchor batch", async function () {
        const { eventAnchor, siteId, owner } = await loadFixture(deployContractsFixture);
        const batch = createSampleBatch(siteId);

        // Owner is automatically an authorized signer when they register the site
        await expect(
          eventAnchor.connect(owner).anchorBatch(
            batch.siteId,
            batch.merkleRoot,
            batch.metadataHash,
            batch.metadataUri,
            batch.eventCount,
            batch.firstEventTimestamp,
            batch.lastEventTimestamp
          )
        ).to.not.be.reverted;
      });

      it("should revert when unauthorized address tries to anchor", async function () {
        const { eventAnchor, siteId, unauthorized } = await loadFixture(deployContractsFixture);
        const batch = createSampleBatch(siteId);

        await expect(
          eventAnchor.connect(unauthorized).anchorBatch(
            batch.siteId,
            batch.merkleRoot,
            batch.metadataHash,
            batch.metadataUri,
            batch.eventCount,
            batch.firstEventTimestamp,
            batch.lastEventTimestamp
          )
        ).to.be.revertedWith("Not authorized to anchor for this site");
      });
    });

    describe("Input Validation", function () {
      it("should revert with zero merkle root", async function () {
        const { eventAnchor, siteId, gateway } = await loadFixture(deployContractsFixture);
        const batch = createSampleBatch(siteId);

        await expect(
          eventAnchor.connect(gateway).anchorBatch(
            batch.siteId,
            ethers.ZeroHash, // Invalid zero merkle root
            batch.metadataHash,
            batch.metadataUri,
            batch.eventCount,
            batch.firstEventTimestamp,
            batch.lastEventTimestamp
          )
        ).to.be.revertedWith("Invalid Merkle root");
      });

      it("should revert with zero event count", async function () {
        const { eventAnchor, siteId, gateway } = await loadFixture(deployContractsFixture);
        const batch = createSampleBatch(siteId);

        await expect(
          eventAnchor.connect(gateway).anchorBatch(
            batch.siteId,
            batch.merkleRoot,
            batch.metadataHash,
            batch.metadataUri,
            0, // Invalid zero event count
            batch.firstEventTimestamp,
            batch.lastEventTimestamp
          )
        ).to.be.revertedWith("Event count must be positive");
      });
    });

    describe("Event Emission", function () {
      it("should emit BatchAnchored event on successful anchor", async function () {
        const { eventAnchor, siteId, gateway } = await loadFixture(deployContractsFixture);
        const batch = createSampleBatch(siteId);

        await expect(
          eventAnchor.connect(gateway).anchorBatch(
            batch.siteId,
            batch.merkleRoot,
            batch.metadataHash,
            batch.metadataUri,
            batch.eventCount,
            batch.firstEventTimestamp,
            batch.lastEventTimestamp
          )
        )
          .to.emit(eventAnchor, "BatchAnchored")
          .withArgs(
            expect.anything(), // anchorId
            batch.siteId,
            batch.merkleRoot,
            batch.eventCount,
            expect.anything(), // timestamp
            gateway.address
          );
      });
    });

    describe("Anchor Storage", function () {
      it("should store anchor data correctly", async function () {
        const { eventAnchor, siteId, gateway } = await loadFixture(deployContractsFixture);
        const batch = createSampleBatch(siteId);

        const tx = await eventAnchor.connect(gateway).anchorBatch(
          batch.siteId,
          batch.merkleRoot,
          batch.metadataHash,
          batch.metadataUri,
          batch.eventCount,
          batch.firstEventTimestamp,
          batch.lastEventTimestamp
        );
        const receipt = await tx.wait();

        // Get anchor ID from event
        const event = receipt?.logs[0];
        const anchorId = (event as any).args[0];

        // Retrieve and verify anchor data
        const anchor = await eventAnchor.getAnchor(anchorId);
        expect(anchor.siteId).to.equal(batch.siteId);
        expect(anchor.merkleRoot).to.equal(batch.merkleRoot);
        expect(anchor.metadataHash).to.equal(batch.metadataHash);
        expect(anchor.metadataUri).to.equal(batch.metadataUri);
        expect(anchor.eventCount).to.equal(batch.eventCount);
        expect(anchor.anchoredBy).to.equal(gateway.address);
      });

      it("should increment anchor count", async function () {
        const { eventAnchor, siteId, gateway } = await loadFixture(deployContractsFixture);
        const batch = createSampleBatch(siteId);

        expect(await eventAnchor.getAnchorCount()).to.equal(0);

        await eventAnchor.connect(gateway).anchorBatch(
          batch.siteId,
          batch.merkleRoot,
          batch.metadataHash,
          batch.metadataUri,
          batch.eventCount,
          batch.firstEventTimestamp,
          batch.lastEventTimestamp
        );

        expect(await eventAnchor.getAnchorCount()).to.equal(1);
      });

      it("should increment site anchor count", async function () {
        const { eventAnchor, siteId, gateway } = await loadFixture(deployContractsFixture);
        const batch = createSampleBatch(siteId);

        expect(await eventAnchor.getSiteAnchorCount(siteId)).to.equal(0);

        await eventAnchor.connect(gateway).anchorBatch(
          batch.siteId,
          batch.merkleRoot,
          batch.metadataHash,
          batch.metadataUri,
          batch.eventCount,
          batch.firstEventTimestamp,
          batch.lastEventTimestamp
        );

        expect(await eventAnchor.getSiteAnchorCount(siteId)).to.equal(1);
      });

      it("should return unique anchor ID for each batch", async function () {
        const { eventAnchor, siteId, gateway } = await loadFixture(deployContractsFixture);
        
        const batch1 = createSampleBatch(siteId);
        const batch2 = {
          ...createSampleBatch(siteId),
          merkleRoot: ethers.keccak256(ethers.toUtf8Bytes("different-root")),
        };

        const tx1 = await eventAnchor.connect(gateway).anchorBatch(
          batch1.siteId,
          batch1.merkleRoot,
          batch1.metadataHash,
          batch1.metadataUri,
          batch1.eventCount,
          batch1.firstEventTimestamp,
          batch1.lastEventTimestamp
        );
        const receipt1 = await tx1.wait();
        const anchorId1 = (receipt1?.logs[0] as any).args[0];

        const tx2 = await eventAnchor.connect(gateway).anchorBatch(
          batch2.siteId,
          batch2.merkleRoot,
          batch2.metadataHash,
          batch2.metadataUri,
          batch2.eventCount,
          batch2.firstEventTimestamp,
          batch2.lastEventTimestamp
        );
        const receipt2 = await tx2.wait();
        const anchorId2 = (receipt2?.logs[0] as any).args[0];

        expect(anchorId1).to.not.equal(anchorId2);
      });
    });
  });

  describe("getAnchor", function () {
    it("should return correct anchor data", async function () {
      const { eventAnchor, siteId, gateway } = await loadFixture(deployContractsFixture);
      const batch = createSampleBatch(siteId);

      const tx = await eventAnchor.connect(gateway).anchorBatch(
        batch.siteId,
        batch.merkleRoot,
        batch.metadataHash,
        batch.metadataUri,
        batch.eventCount,
        batch.firstEventTimestamp,
        batch.lastEventTimestamp
      );
      const receipt = await tx.wait();
      const anchorId = (receipt?.logs[0] as any).args[0];

      const anchor = await eventAnchor.getAnchor(anchorId);

      expect(anchor.siteId).to.equal(batch.siteId);
      expect(anchor.merkleRoot).to.equal(batch.merkleRoot);
      expect(anchor.metadataHash).to.equal(batch.metadataHash);
      expect(anchor.metadataUri).to.equal(batch.metadataUri);
      expect(anchor.eventCount).to.equal(batch.eventCount);
      expect(anchor.firstEventTimestamp).to.equal(batch.firstEventTimestamp);
      expect(anchor.lastEventTimestamp).to.equal(batch.lastEventTimestamp);
      expect(anchor.anchoredBy).to.equal(gateway.address);
    });

    it("should return empty anchor for non-existent ID", async function () {
      const { eventAnchor } = await loadFixture(deployContractsFixture);
      const nonExistentId = ethers.keccak256(ethers.toUtf8Bytes("non-existent"));

      const anchor = await eventAnchor.getAnchor(nonExistentId);

      expect(anchor.anchoredAt).to.equal(0);
      expect(anchor.eventCount).to.equal(0);
    });
  });

  describe("getSiteAnchorAt", function () {
    it("should return anchor ID at index", async function () {
      const { eventAnchor, siteId, gateway } = await loadFixture(deployContractsFixture);
      const batch = createSampleBatch(siteId);

      const tx = await eventAnchor.connect(gateway).anchorBatch(
        batch.siteId,
        batch.merkleRoot,
        batch.metadataHash,
        batch.metadataUri,
        batch.eventCount,
        batch.firstEventTimestamp,
        batch.lastEventTimestamp
      );
      const receipt = await tx.wait();
      const anchorId = (receipt?.logs[0] as any).args[0];

      const retrievedAnchorId = await eventAnchor.getSiteAnchorAt(siteId, 0);
      expect(retrievedAnchorId).to.equal(anchorId);
    });
  });

  describe("verifyEvent (Merkle Proof)", function () {
    it("should verify valid merkle proof", async function () {
      const { eventAnchor, siteId, gateway } = await loadFixture(deployContractsFixture);

      // Create a simple merkle tree with 2 leaves
      const leaf1 = ethers.keccak256(ethers.toUtf8Bytes("event-1"));
      const leaf2 = ethers.keccak256(ethers.toUtf8Bytes("event-2"));
      const merkleRoot = ethers.keccak256(ethers.concat([leaf1, leaf2]));

      const batch = {
        ...createSampleBatch(siteId),
        merkleRoot,
        eventCount: 2n,
      };

      const tx = await eventAnchor.connect(gateway).anchorBatch(
        batch.siteId,
        batch.merkleRoot,
        batch.metadataHash,
        batch.metadataUri,
        batch.eventCount,
        batch.firstEventTimestamp,
        batch.lastEventTimestamp
      );
      const receipt = await tx.wait();
      const anchorId = (receipt?.logs[0] as any).args[0];

      // Verify leaf1 with proof [leaf2]
      const isValid = await eventAnchor.verifyEvent(anchorId, leaf1, [leaf2], 0);
      expect(isValid).to.be.true;
    });

    it("should reject invalid merkle proof", async function () {
      const { eventAnchor, siteId, gateway } = await loadFixture(deployContractsFixture);

      const leaf1 = ethers.keccak256(ethers.toUtf8Bytes("event-1"));
      const leaf2 = ethers.keccak256(ethers.toUtf8Bytes("event-2"));
      const merkleRoot = ethers.keccak256(ethers.concat([leaf1, leaf2]));

      const batch = {
        ...createSampleBatch(siteId),
        merkleRoot,
        eventCount: 2n,
      };

      const tx = await eventAnchor.connect(gateway).anchorBatch(
        batch.siteId,
        batch.merkleRoot,
        batch.metadataHash,
        batch.metadataUri,
        batch.eventCount,
        batch.firstEventTimestamp,
        batch.lastEventTimestamp
      );
      const receipt = await tx.wait();
      const anchorId = (receipt?.logs[0] as any).args[0];

      // Try to verify with wrong proof
      const wrongProof = ethers.keccak256(ethers.toUtf8Bytes("wrong"));
      const isValid = await eventAnchor.verifyEvent(anchorId, leaf1, [wrongProof], 0);
      expect(isValid).to.be.false;
    });

    it("should revert for non-existent anchor", async function () {
      const { eventAnchor } = await loadFixture(deployContractsFixture);
      const nonExistentId = ethers.keccak256(ethers.toUtf8Bytes("non-existent"));
      const eventHash = ethers.keccak256(ethers.toUtf8Bytes("event"));

      await expect(
        eventAnchor.verifyEvent(nonExistentId, eventHash, [], 0)
      ).to.be.revertedWith("Anchor does not exist");
    });
  });

  describe("Multiple Anchors", function () {
    it("should handle multiple anchors for same site", async function () {
      const { eventAnchor, siteId, gateway } = await loadFixture(deployContractsFixture);

      for (let i = 0; i < 5; i++) {
        const batch = {
          ...createSampleBatch(siteId),
          merkleRoot: ethers.keccak256(ethers.toUtf8Bytes(`merkle-${i}`)),
        };

        await eventAnchor.connect(gateway).anchorBatch(
          batch.siteId,
          batch.merkleRoot,
          batch.metadataHash,
          batch.metadataUri,
          batch.eventCount,
          batch.firstEventTimestamp,
          batch.lastEventTimestamp
        );
      }

      expect(await eventAnchor.getAnchorCount()).to.equal(5);
      expect(await eventAnchor.getSiteAnchorCount(siteId)).to.equal(5);
    });
  });
});
