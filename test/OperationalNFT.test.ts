import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { OperationalNFT } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("OperationalNFT", function () {
  // Certification types enum values
  const CertType = {
    MACHINE_STATE: 0,
    SAFETY_CONDITION: 1,
    AGENT_CAPABILITY: 2,
    COMPLIANCE_SNAPSHOT: 3,
    CALIBRATION_RECORD: 4,
  };

  async function deployFixture() {
    const [owner, certifier, revoker, recipient, other] = await ethers.getSigners();

    const OperationalNFT = await ethers.getContractFactory("OperationalNFT");
    const nft = await OperationalNFT.deploy();

    // Grant roles
    const CERTIFIER_ROLE = await nft.CERTIFIER_ROLE();
    const REVOKER_ROLE = await nft.REVOKER_ROLE();
    await nft.grantRole(CERTIFIER_ROLE, certifier.address);
    await nft.grantRole(REVOKER_ROLE, revoker.address);

    // Sample data
    const siteId = ethers.keccak256(ethers.toUtf8Bytes("SITE-001"));
    const artifactHash = ethers.keccak256(ethers.toUtf8Bytes("artifact-data-v1"));
    const metadataUri = "ipfs://QmExample123";
    const oneYear = 365 * 24 * 60 * 60;

    return {
      nft,
      owner,
      certifier,
      revoker,
      recipient,
      other,
      siteId,
      artifactHash,
      metadataUri,
      oneYear,
      CERTIFIER_ROLE,
      REVOKER_ROLE,
    };
  }

  describe("Deployment", function () {
    it("Should set correct name and symbol", async function () {
      const { nft } = await loadFixture(deployFixture);
      expect(await nft.name()).to.equal("0xSCADA Operational Certification");
      expect(await nft.symbol()).to.equal("SCADA-CERT");
    });

    it("Should grant admin role to deployer", async function () {
      const { nft, owner } = await loadFixture(deployFixture);
      const adminRole = await nft.DEFAULT_ADMIN_ROLE();
      expect(await nft.hasRole(adminRole, owner.address)).to.be.true;
    });
  });

  describe("Minting", function () {
    it("Should mint certification with correct data", async function () {
      const { nft, certifier, recipient, siteId, artifactHash, metadataUri, oneYear } =
        await loadFixture(deployFixture);

      const validUntil = (await time.latest()) + oneYear;

      await expect(
        nft.connect(certifier).mint(
          recipient.address,
          CertType.MACHINE_STATE,
          artifactHash,
          validUntil,
          siteId,
          metadataUri
        )
      ).to.emit(nft, "CertificationMinted");

      // Verify token ownership
      expect(await nft.ownerOf(1)).to.equal(recipient.address);

      // Verify certification data
      const cert = await nft.getCertification(1);
      expect(cert.certType).to.equal(CertType.MACHINE_STATE);
      expect(cert.artifactHash).to.equal(artifactHash);
      expect(cert.certifier).to.equal(certifier.address);
      expect(cert.supersededBy).to.equal(0);
      expect(cert.siteId).to.equal(siteId);
    });

    it("Should mint certification with no expiry", async function () {
      const { nft, certifier, recipient, siteId, artifactHash, metadataUri } =
        await loadFixture(deployFixture);

      await nft.connect(certifier).mint(
        recipient.address,
        CertType.SAFETY_CONDITION,
        artifactHash,
        0, // No expiry
        siteId,
        metadataUri
      );

      const cert = await nft.getCertification(1);
      expect(cert.validUntil).to.equal(0);
    });

    it("Should reject mint from non-certifier", async function () {
      const { nft, other, recipient, siteId, artifactHash, metadataUri, oneYear } =
        await loadFixture(deployFixture);

      const validUntil = (await time.latest()) + oneYear;

      await expect(
        nft.connect(other).mint(
          recipient.address,
          CertType.MACHINE_STATE,
          artifactHash,
          validUntil,
          siteId,
          metadataUri
        )
      ).to.be.reverted;
    });

    it("Should reject duplicate artifact hash", async function () {
      const { nft, certifier, recipient, siteId, artifactHash, metadataUri, oneYear } =
        await loadFixture(deployFixture);

      const validUntil = (await time.latest()) + oneYear;

      await nft.connect(certifier).mint(
        recipient.address,
        CertType.MACHINE_STATE,
        artifactHash,
        validUntil,
        siteId,
        metadataUri
      );

      await expect(
        nft.connect(certifier).mint(
          recipient.address,
          CertType.MACHINE_STATE,
          artifactHash, // Same hash
          validUntil,
          siteId,
          metadataUri
        )
      ).to.be.revertedWith("Artifact already certified");
    });

    it("Should reject expired validUntil", async function () {
      const { nft, certifier, recipient, siteId, artifactHash, metadataUri } =
        await loadFixture(deployFixture);

      const pastTime = (await time.latest()) - 1000;

      await expect(
        nft.connect(certifier).mint(
          recipient.address,
          CertType.MACHINE_STATE,
          artifactHash,
          pastTime,
          siteId,
          metadataUri
        )
      ).to.be.revertedWith("Expiry must be in future");
    });
  });

  describe("Verification", function () {
    it("Should verify valid certification", async function () {
      const { nft, certifier, recipient, siteId, artifactHash, metadataUri, oneYear } =
        await loadFixture(deployFixture);

      const validUntil = (await time.latest()) + oneYear;

      await nft.connect(certifier).mint(
        recipient.address,
        CertType.COMPLIANCE_SNAPSHOT,
        artifactHash,
        validUntil,
        siteId,
        metadataUri
      );

      const [isValid, reason] = await nft.verifyCertification(1);
      expect(isValid).to.be.true;
      expect(reason).to.equal("Certification valid");
    });

    it("Should detect expired certification", async function () {
      const { nft, certifier, recipient, siteId, artifactHash, metadataUri } =
        await loadFixture(deployFixture);

      const oneHour = 60 * 60;
      const validUntil = (await time.latest()) + oneHour;

      await nft.connect(certifier).mint(
        recipient.address,
        CertType.CALIBRATION_RECORD,
        artifactHash,
        validUntil,
        siteId,
        metadataUri
      );

      // Fast forward past expiry
      await time.increase(oneHour + 1);

      const [isValid, reason] = await nft.verifyCertification(1);
      expect(isValid).to.be.false;
      expect(reason).to.equal("Certification expired");
    });

    it("Should detect revoked certification", async function () {
      const { nft, certifier, revoker, recipient, siteId, artifactHash, metadataUri, oneYear } =
        await loadFixture(deployFixture);

      const validUntil = (await time.latest()) + oneYear;

      await nft.connect(certifier).mint(
        recipient.address,
        CertType.AGENT_CAPABILITY,
        artifactHash,
        validUntil,
        siteId,
        metadataUri
      );

      await nft.connect(revoker).revoke(1, 0);

      const [isValid, reason] = await nft.verifyCertification(1);
      expect(isValid).to.be.false;
      expect(reason).to.equal("Certification revoked");
    });

    it("Should verify by artifact hash", async function () {
      const { nft, certifier, recipient, siteId, artifactHash, metadataUri, oneYear } =
        await loadFixture(deployFixture);

      const validUntil = (await time.latest()) + oneYear;

      await nft.connect(certifier).mint(
        recipient.address,
        CertType.MACHINE_STATE,
        artifactHash,
        validUntil,
        siteId,
        metadataUri
      );

      const [isValid, tokenId, reason] = await nft.verifyCertificationByArtifact(artifactHash);
      expect(isValid).to.be.true;
      expect(tokenId).to.equal(1);
      expect(reason).to.equal("Certification valid");
    });

    it("Should return invalid for unknown artifact", async function () {
      const { nft } = await loadFixture(deployFixture);

      const unknownHash = ethers.keccak256(ethers.toUtf8Bytes("unknown"));
      const [isValid, tokenId, reason] = await nft.verifyCertificationByArtifact(unknownHash);
      
      expect(isValid).to.be.false;
      expect(tokenId).to.equal(0);
      expect(reason).to.equal("Artifact not certified");
    });
  });

  describe("Revocation", function () {
    it("Should revoke certification without replacement", async function () {
      const { nft, certifier, revoker, recipient, siteId, artifactHash, metadataUri, oneYear } =
        await loadFixture(deployFixture);

      const validUntil = (await time.latest()) + oneYear;

      await nft.connect(certifier).mint(
        recipient.address,
        CertType.SAFETY_CONDITION,
        artifactHash,
        validUntil,
        siteId,
        metadataUri
      );

      await expect(nft.connect(revoker).revoke(1, 0))
        .to.emit(nft, "CertificationRevoked")
        .withArgs(1, 0, revoker.address, await time.latest() + 1);
    });

    it("Should revoke with superseding token", async function () {
      const { nft, certifier, revoker, recipient, siteId, metadataUri, oneYear } =
        await loadFixture(deployFixture);

      const validUntil = (await time.latest()) + oneYear;
      const artifact1 = ethers.keccak256(ethers.toUtf8Bytes("v1"));
      const artifact2 = ethers.keccak256(ethers.toUtf8Bytes("v2"));

      // Mint original
      await nft.connect(certifier).mint(
        recipient.address,
        CertType.MACHINE_STATE,
        artifact1,
        validUntil,
        siteId,
        metadataUri
      );

      // Mint replacement
      await nft.connect(certifier).mint(
        recipient.address,
        CertType.MACHINE_STATE,
        artifact2,
        validUntil,
        siteId,
        metadataUri
      );

      // Revoke original pointing to replacement
      await nft.connect(revoker).revoke(1, 2);

      const cert = await nft.getCertification(1);
      expect(cert.supersededBy).to.equal(2);

      const [isValid, reason] = await nft.verifyCertification(1);
      expect(isValid).to.be.false;
      expect(reason).to.equal("Certification superseded");
    });

    it("Should reject revoke from non-revoker", async function () {
      const { nft, certifier, other, recipient, siteId, artifactHash, metadataUri, oneYear } =
        await loadFixture(deployFixture);

      const validUntil = (await time.latest()) + oneYear;

      await nft.connect(certifier).mint(
        recipient.address,
        CertType.MACHINE_STATE,
        artifactHash,
        validUntil,
        siteId,
        metadataUri
      );

      await expect(nft.connect(other).revoke(1, 0)).to.be.reverted;
    });

    it("Should reject revoking already-revoked token", async function () {
      const { nft, certifier, revoker, recipient, siteId, artifactHash, metadataUri, oneYear } =
        await loadFixture(deployFixture);

      const validUntil = (await time.latest()) + oneYear;

      await nft.connect(certifier).mint(
        recipient.address,
        CertType.MACHINE_STATE,
        artifactHash,
        validUntil,
        siteId,
        metadataUri
      );

      await nft.connect(revoker).revoke(1, 0);

      await expect(nft.connect(revoker).revoke(1, 0)).to.be.revertedWith(
        "Already revoked/superseded"
      );
    });
  });

  describe("Superseding Mint", function () {
    it("Should mint and automatically revoke superseded token", async function () {
      const { nft, certifier, recipient, siteId, metadataUri, oneYear } =
        await loadFixture(deployFixture);

      const validUntil = (await time.latest()) + oneYear;
      const artifact1 = ethers.keccak256(ethers.toUtf8Bytes("v1"));
      const artifact2 = ethers.keccak256(ethers.toUtf8Bytes("v2"));

      // Mint original
      await nft.connect(certifier).mint(
        recipient.address,
        CertType.CALIBRATION_RECORD,
        artifact1,
        validUntil,
        siteId,
        metadataUri
      );

      // Mint superseding
      await expect(
        nft.connect(certifier).mintSuperseding(
          recipient.address,
          CertType.CALIBRATION_RECORD,
          artifact2,
          validUntil,
          siteId,
          metadataUri,
          1
        )
      )
        .to.emit(nft, "CertificationRenewed")
        .withArgs(1, 2, validUntil);

      // Old is now superseded
      const [isValid, reason] = await nft.verifyCertification(1);
      expect(isValid).to.be.false;
      expect(reason).to.equal("Certification superseded");

      // New is valid
      const [newValid] = await nft.verifyCertification(2);
      expect(newValid).to.be.true;
    });
  });

  describe("Site Queries", function () {
    it("Should track certifications by site", async function () {
      const { nft, certifier, recipient, siteId, metadataUri, oneYear } =
        await loadFixture(deployFixture);

      const validUntil = (await time.latest()) + oneYear;

      // Mint 3 certs for same site
      for (let i = 0; i < 3; i++) {
        const hash = ethers.keccak256(ethers.toUtf8Bytes(`artifact-${i}`));
        await nft.connect(certifier).mint(
          recipient.address,
          CertType.MACHINE_STATE,
          hash,
          validUntil,
          siteId,
          metadataUri
        );
      }

      const siteCerts = await nft.getSiteCertifications(siteId);
      expect(siteCerts.length).to.equal(3);
    });

    it("Should filter active certifications", async function () {
      const { nft, certifier, revoker, recipient, siteId, metadataUri, oneYear } =
        await loadFixture(deployFixture);

      const validUntil = (await time.latest()) + oneYear;

      // Mint 3 certs
      for (let i = 0; i < 3; i++) {
        const hash = ethers.keccak256(ethers.toUtf8Bytes(`artifact-${i}`));
        await nft.connect(certifier).mint(
          recipient.address,
          CertType.MACHINE_STATE,
          hash,
          validUntil,
          siteId,
          metadataUri
        );
      }

      // Revoke one
      await nft.connect(revoker).revoke(2, 0);

      const activeCerts = await nft.getActiveSiteCertifications(siteId);
      expect(activeCerts.length).to.equal(2);
      expect(activeCerts[0]).to.equal(1);
      expect(activeCerts[1]).to.equal(3);
    });
  });

  describe("Type Queries", function () {
    it("Should track certifications by type", async function () {
      const { nft, certifier, recipient, siteId, metadataUri, oneYear } =
        await loadFixture(deployFixture);

      const validUntil = (await time.latest()) + oneYear;

      // Mint different types
      const types = [
        CertType.MACHINE_STATE,
        CertType.SAFETY_CONDITION,
        CertType.MACHINE_STATE,
        CertType.AGENT_CAPABILITY,
      ];

      for (let i = 0; i < types.length; i++) {
        const hash = ethers.keccak256(ethers.toUtf8Bytes(`artifact-${i}`));
        await nft.connect(certifier).mint(
          recipient.address,
          types[i],
          hash,
          validUntil,
          siteId,
          metadataUri
        );
      }

      const machineCerts = await nft.getCertificationsByType(CertType.MACHINE_STATE);
      expect(machineCerts.length).to.equal(2);

      const safetyCerts = await nft.getCertificationsByType(CertType.SAFETY_CONDITION);
      expect(safetyCerts.length).to.equal(1);
    });
  });

  describe("Remaining Validity", function () {
    it("Should return correct remaining time", async function () {
      const { nft, certifier, recipient, siteId, artifactHash, metadataUri, oneYear } =
        await loadFixture(deployFixture);

      const validUntil = (await time.latest()) + oneYear;

      await nft.connect(certifier).mint(
        recipient.address,
        CertType.MACHINE_STATE,
        artifactHash,
        validUntil,
        siteId,
        metadataUri
      );

      const remaining = await nft.getRemainingValidity(1);
      expect(remaining).to.be.closeTo(BigInt(oneYear), BigInt(10)); // Within 10 seconds
    });

    it("Should return max for no-expiry certs", async function () {
      const { nft, certifier, recipient, siteId, artifactHash, metadataUri } =
        await loadFixture(deployFixture);

      await nft.connect(certifier).mint(
        recipient.address,
        CertType.MACHINE_STATE,
        artifactHash,
        0, // No expiry
        siteId,
        metadataUri
      );

      const remaining = await nft.getRemainingValidity(1);
      expect(remaining).to.equal(ethers.MaxUint256);
    });
  });

  describe("Token URI", function () {
    it("Should return metadata URI", async function () {
      const { nft, certifier, recipient, siteId, artifactHash, metadataUri, oneYear } =
        await loadFixture(deployFixture);

      const validUntil = (await time.latest()) + oneYear;

      await nft.connect(certifier).mint(
        recipient.address,
        CertType.MACHINE_STATE,
        artifactHash,
        validUntil,
        siteId,
        metadataUri
      );

      expect(await nft.tokenURI(1)).to.equal(metadataUri);
    });
  });

  describe("ERC721 Enumerable", function () {
    it("Should enumerate tokens", async function () {
      const { nft, certifier, recipient, siteId, metadataUri, oneYear } =
        await loadFixture(deployFixture);

      const validUntil = (await time.latest()) + oneYear;

      for (let i = 0; i < 3; i++) {
        const hash = ethers.keccak256(ethers.toUtf8Bytes(`artifact-${i}`));
        await nft.connect(certifier).mint(
          recipient.address,
          CertType.MACHINE_STATE,
          hash,
          validUntil,
          siteId,
          metadataUri
        );
      }

      expect(await nft.totalSupply()).to.equal(3);
      expect(await nft.tokenOfOwnerByIndex(recipient.address, 0)).to.equal(1);
      expect(await nft.tokenByIndex(2)).to.equal(3);
    });
  });
});
