// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * DEPENDENCY: npm install @openzeppelin/contracts
 * This contract requires OpenZeppelin Contracts v5.x
 */

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title OperationalNFT
 * @notice Industrial-grade NFTs representing certified operational states
 * 
 * From REALITY_ARTIFACT_ARCHITECTURE.md:
 * "NFT = Certified operational state, not art."
 * 
 * Each NFT represents:
 * - Certified machine state (twin snapshot hash)
 * - Validated safety condition (SIL-2 verified)
 * - Trained agent capability (model hash + eval results)
 * - Compliance snapshot (ISO 27001 audit bundle)
 * - Calibration records (instrument verification)
 * 
 * Transfer = Operational responsibility changes hands
 * Burn/Revoke = Decommissioned/superseded reality
 */
contract OperationalNFT is ERC721, ERC721Enumerable, AccessControl {
    
    // ============ Roles ============
    
    /// @notice Role for addresses authorized to mint certifications
    bytes32 public constant CERTIFIER_ROLE = keccak256("CERTIFIER_ROLE");
    
    /// @notice Role for addresses authorized to revoke certifications
    bytes32 public constant REVOKER_ROLE = keccak256("REVOKER_ROLE");
    
    // ============ Enums ============
    
    /**
     * @notice Types of industrial certifications
     * 
     * MACHINE_STATE: Certified snapshot of physical equipment state
     *   - Twin checkpoint hash, PLC states, sensor readings
     *   - Example: "Pump P-101 certified at 87 PSI, 1200 RPM"
     * 
     * SAFETY_CONDITION: Validated safety system state (SIL-2/3/4)
     *   - Safety interlock verification, trip system tests
     *   - Example: "ESD-001 trip logic verified per IEC 61511"
     * 
     * AGENT_CAPABILITY: Certified AI/agent operational capability
     *   - Model hash, evaluation results, decision boundaries
     *   - Example: "Agent-Alpha certified for pressure control ±5%"
     * 
     * COMPLIANCE_SNAPSHOT: Regulatory compliance evidence bundle
     *   - ISO 27001, ISA-95, IEC 62443 audit results
     *   - Example: "Site-A ISO 27001:2022 compliant as of 2024-01-15"
     * 
     * CALIBRATION_RECORD: Instrument calibration verification
     *   - Calibration certificates, measurement uncertainty
     *   - Example: "PT-101 calibrated ±0.1% per NIST traceability"
     */
    enum CertificationType {
        MACHINE_STATE,
        SAFETY_CONDITION,
        AGENT_CAPABILITY,
        COMPLIANCE_SNAPSHOT,
        CALIBRATION_RECORD
    }
    
    // ============ Structs ============
    
    /**
     * @notice Certification data stored for each NFT
     */
    struct Certification {
        CertificationType certType;     // Type of certification
        bytes32 artifactHash;           // LFS pointer to full evidence
        uint64 validFrom;               // Start of validity period (Unix timestamp)
        uint64 validUntil;              // End of validity (0 = no expiry)
        address certifier;              // Who issued the certification
        uint256 supersededBy;           // Token ID that supersedes this (0 = active)
        bytes32 siteId;                 // Associated site (links to SiteRegistry)
        string metadataUri;             // URI to extended metadata (IPFS/LFS)
    }
    
    // ============ State ============
    
    /// @notice Token ID counter
    uint256 private _tokenIdCounter;
    
    /// @notice Token ID => Certification data
    mapping(uint256 => Certification) public certifications;
    
    /// @notice Artifact hash => Token ID (for lookup)
    mapping(bytes32 => uint256) public artifactToToken;
    
    /// @notice Site ID => Token IDs
    mapping(bytes32 => uint256[]) public siteCertifications;
    
    /// @notice CertificationType => Token IDs (for filtering)
    mapping(CertificationType => uint256[]) public certificationsByType;
    
    // ============ Events ============
    
    event CertificationMinted(
        uint256 indexed tokenId,
        CertificationType indexed certType,
        bytes32 indexed siteId,
        bytes32 artifactHash,
        address certifier,
        uint64 validFrom,
        uint64 validUntil
    );
    
    event CertificationRevoked(
        uint256 indexed tokenId,
        uint256 indexed supersededBy,
        address indexed revoker,
        uint256 timestamp
    );
    
    event CertificationRenewed(
        uint256 indexed oldTokenId,
        uint256 indexed newTokenId,
        uint64 newValidUntil
    );
    
    // ============ Constructor ============
    
    constructor() ERC721("0xSCADA Operational Certification", "SCADA-CERT") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(CERTIFIER_ROLE, msg.sender);
        _grantRole(REVOKER_ROLE, msg.sender);
    }
    
    // ============ Minting ============
    
    /**
     * @notice Mint a new operational certification NFT
     * @param to Recipient address (usually the site owner)
     * @param certType Type of certification
     * @param artifactHash LFS content hash of the evidence bundle
     * @param validUntil Expiration timestamp (0 = no expiry)
     * @param siteId Associated site from SiteRegistry
     * @param metadataUri URI to extended metadata
     * @return tokenId The newly minted token ID
     */
    function mint(
        address to,
        CertificationType certType,
        bytes32 artifactHash,
        uint64 validUntil,
        bytes32 siteId,
        string calldata metadataUri
    ) external onlyRole(CERTIFIER_ROLE) returns (uint256 tokenId) {
        require(to != address(0), "Invalid recipient");
        require(artifactHash != bytes32(0), "Invalid artifact hash");
        require(artifactToToken[artifactHash] == 0, "Artifact already certified");
        
        // If validUntil is set, must be in the future
        if (validUntil != 0) {
            require(validUntil > block.timestamp, "Expiry must be in future");
        }
        
        _tokenIdCounter++;
        tokenId = _tokenIdCounter;
        
        certifications[tokenId] = Certification({
            certType: certType,
            artifactHash: artifactHash,
            validFrom: uint64(block.timestamp),
            validUntil: validUntil,
            certifier: msg.sender,
            supersededBy: 0,
            siteId: siteId,
            metadataUri: metadataUri
        });
        
        artifactToToken[artifactHash] = tokenId;
        siteCertifications[siteId].push(tokenId);
        certificationsByType[certType].push(tokenId);
        
        _safeMint(to, tokenId);
        
        emit CertificationMinted(
            tokenId,
            certType,
            siteId,
            artifactHash,
            msg.sender,
            uint64(block.timestamp),
            validUntil
        );
        
        return tokenId;
    }
    
    /**
     * @notice Mint a certification that supersedes an existing one (renewal/update)
     * @dev Automatically revokes the old certification
     */
    function mintSuperseding(
        address to,
        CertificationType certType,
        bytes32 artifactHash,
        uint64 validUntil,
        bytes32 siteId,
        string calldata metadataUri,
        uint256 supersedes
    ) external onlyRole(CERTIFIER_ROLE) returns (uint256 tokenId) {
        require(supersedes > 0 && supersedes <= _tokenIdCounter, "Invalid supersedes token");
        require(certifications[supersedes].supersededBy == 0, "Already superseded");
        
        // Mint the new certification
        tokenId = this.mint(to, certType, artifactHash, validUntil, siteId, metadataUri);
        
        // Mark old as superseded
        certifications[supersedes].supersededBy = tokenId;
        
        emit CertificationRevoked(supersedes, tokenId, msg.sender, block.timestamp);
        emit CertificationRenewed(supersedes, tokenId, validUntil);
        
        return tokenId;
    }
    
    // ============ Revocation ============
    
    /**
     * @notice Revoke a certification (mark as superseded without replacement)
     * @param tokenId The certification to revoke
     * @param supersededBy Token ID of replacement (0 = no replacement, just revoked)
     */
    function revoke(
        uint256 tokenId,
        uint256 supersededBy
    ) external onlyRole(REVOKER_ROLE) {
        require(_exists(tokenId), "Token does not exist");
        require(certifications[tokenId].supersededBy == 0, "Already revoked/superseded");
        
        // If supersededBy is specified, it must exist and be valid
        if (supersededBy != 0) {
            require(_exists(supersededBy), "Superseding token does not exist");
            require(
                certifications[supersededBy].supersededBy == 0,
                "Superseding token is also revoked"
            );
        }
        
        // Use max uint256 to indicate "revoked without replacement"
        certifications[tokenId].supersededBy = supersededBy == 0 
            ? type(uint256).max 
            : supersededBy;
        
        emit CertificationRevoked(tokenId, supersededBy, msg.sender, block.timestamp);
    }
    
    // ============ Verification ============
    
    /**
     * @notice Check if a certification is currently valid
     * @param tokenId The certification to verify
     * @return isValid True if certification is valid
     * @return reason Human-readable status
     */
    function verifyCertification(uint256 tokenId) 
        external 
        view 
        returns (bool isValid, string memory reason) 
    {
        if (!_exists(tokenId)) {
            return (false, "Token does not exist");
        }
        
        Certification memory cert = certifications[tokenId];
        
        // Check if superseded/revoked
        if (cert.supersededBy != 0) {
            if (cert.supersededBy == type(uint256).max) {
                return (false, "Certification revoked");
            }
            return (false, "Certification superseded");
        }
        
        // Check if not yet valid
        if (block.timestamp < cert.validFrom) {
            return (false, "Certification not yet valid");
        }
        
        // Check expiration
        if (cert.validUntil != 0 && block.timestamp > cert.validUntil) {
            return (false, "Certification expired");
        }
        
        return (true, "Certification valid");
    }
    
    /**
     * @notice Verify a certification by artifact hash
     * @param artifactHash The LFS hash to verify
     */
    function verifyCertificationByArtifact(bytes32 artifactHash)
        external
        view
        returns (bool isValid, uint256 tokenId, string memory reason)
    {
        tokenId = artifactToToken[artifactHash];
        if (tokenId == 0) {
            return (false, 0, "Artifact not certified");
        }
        
        (isValid, reason) = this.verifyCertification(tokenId);
        return (isValid, tokenId, reason);
    }
    
    /**
     * @notice Get remaining validity time
     * @param tokenId The certification to check
     * @return remainingSeconds Seconds until expiration (0 = no expiry or expired)
     */
    function getRemainingValidity(uint256 tokenId) external view returns (uint256 remainingSeconds) {
        if (!_exists(tokenId)) {
            return 0;
        }
        
        Certification memory cert = certifications[tokenId];
        
        if (cert.validUntil == 0) {
            return type(uint256).max; // No expiry
        }
        
        if (block.timestamp >= cert.validUntil) {
            return 0; // Expired
        }
        
        return cert.validUntil - block.timestamp;
    }
    
    // ============ View Functions ============
    
    /**
     * @notice Get full certification details
     */
    function getCertification(uint256 tokenId) external view returns (
        CertificationType certType,
        bytes32 artifactHash,
        uint64 validFrom,
        uint64 validUntil,
        address certifier,
        uint256 supersededBy,
        bytes32 siteId,
        string memory metadataUri,
        address owner
    ) {
        require(_exists(tokenId), "Token does not exist");
        Certification memory cert = certifications[tokenId];
        return (
            cert.certType,
            cert.artifactHash,
            cert.validFrom,
            cert.validUntil,
            cert.certifier,
            cert.supersededBy,
            cert.siteId,
            cert.metadataUri,
            ownerOf(tokenId)
        );
    }
    
    /**
     * @notice Get all certifications for a site
     */
    function getSiteCertifications(bytes32 siteId) external view returns (uint256[] memory) {
        return siteCertifications[siteId];
    }
    
    /**
     * @notice Get all active (valid) certifications for a site
     */
    function getActiveSiteCertifications(bytes32 siteId) external view returns (uint256[] memory) {
        uint256[] memory all = siteCertifications[siteId];
        uint256 activeCount = 0;
        
        // Count active
        for (uint256 i = 0; i < all.length; i++) {
            (bool isValid,) = this.verifyCertification(all[i]);
            if (isValid) activeCount++;
        }
        
        // Build result array
        uint256[] memory active = new uint256[](activeCount);
        uint256 idx = 0;
        for (uint256 i = 0; i < all.length; i++) {
            (bool isValid,) = this.verifyCertification(all[i]);
            if (isValid) {
                active[idx] = all[i];
                idx++;
            }
        }
        
        return active;
    }
    
    /**
     * @notice Get certifications by type
     */
    function getCertificationsByType(CertificationType certType) 
        external 
        view 
        returns (uint256[] memory) 
    {
        return certificationsByType[certType];
    }
    
    /**
     * @notice Get total number of certifications minted
     */
    function totalMinted() external view returns (uint256) {
        return _tokenIdCounter;
    }
    
    /**
     * @notice Check if a token exists
     */
    function _exists(uint256 tokenId) internal view returns (bool) {
        return tokenId > 0 && tokenId <= _tokenIdCounter;
    }
    
    // ============ Required Overrides ============
    
    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721, ERC721Enumerable)
        returns (address)
    {
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 value)
        internal
        override(ERC721, ERC721Enumerable)
    {
        super._increaseBalance(account, value);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721Enumerable, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
    
    /**
     * @notice Token URI returns the metadata URI from the certification
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_exists(tokenId), "Token does not exist");
        return certifications[tokenId].metadataUri;
    }
}
