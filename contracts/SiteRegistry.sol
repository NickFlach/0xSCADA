// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SiteRegistry
 * @author 0xSCADA Team
 * @notice PRD Section 7.1: Site Registry Contract — manages industrial site identity,
 *         ownership, and authorization of gateways and signers.
 * @dev Security audit remediation applied (QE Phase 2, 2026-02-01):
 *      - H-03: Added reactivateSite() for recovery
 *      - M-01: Added pagination for siteIds array
 *      - M-02: Added gateway/signer counters and events
 *      - M-03: Documented timestamp usage
 *      - M-05: Added ReentrancyGuard
 *      - Locked Solidity version to 0.8.20
 */
contract SiteRegistry is ReentrancyGuard {

    struct Site {
        address owner;
        bool active;
        uint256 registeredAt;  // M-03: block.timestamp used for record-keeping only, not for ordering
    }

    /// @notice siteId => Site data
    mapping(bytes32 => Site) public sites;

    /// @notice siteId => gateway address => authorized
    mapping(bytes32 => mapping(address => bool)) public authorizedGateways;

    /// @notice siteId => signer address => authorized
    mapping(bytes32 => mapping(address => bool)) public authorizedSigners;

    /// @notice siteId => gateway count (M-02)
    mapping(bytes32 => uint256) public gatewayCount;

    /// @notice siteId => signer count (M-02)
    mapping(bytes32 => uint256) public signerCount;

    /// @notice All registered site IDs
    bytes32[] public siteIds;

    // ── Events ──────────────────────────────────────────────────────────

    event SiteRegistered(bytes32 indexed siteId, address indexed owner, uint256 timestamp);
    event SiteOwnershipTransferred(bytes32 indexed siteId, address indexed previousOwner, address indexed newOwner);
    event SiteDeactivated(bytes32 indexed siteId, uint256 timestamp);
    /// @notice H-03: Emitted when a site is reactivated
    event SiteReactivated(bytes32 indexed siteId, uint256 timestamp);
    event GatewayAuthorized(bytes32 indexed siteId, address indexed gateway, uint256 timestamp);
    event GatewayRevoked(bytes32 indexed siteId, address indexed gateway, uint256 timestamp);
    event SignerAuthorized(bytes32 indexed siteId, address indexed signer, uint256 timestamp);
    event SignerRevoked(bytes32 indexed siteId, address indexed signer, uint256 timestamp);

    // ── Modifiers ───────────────────────────────────────────────────────

    modifier onlySiteOwner(bytes32 siteId) {
        require(sites[siteId].owner == msg.sender, "Not site owner");
        _;
    }

    modifier siteExists(bytes32 siteId) {
        require(sites[siteId].active, "Site does not exist or inactive");
        _;
    }

    /// @notice Modifier that only requires the site was registered (active or not)
    modifier siteRegistered(bytes32 siteId) {
        require(sites[siteId].registeredAt > 0, "Site never registered");
        _;
    }

    // ── Write Functions ─────────────────────────────────────────────────

    /**
     * @notice Register a new site. The caller becomes the owner and an authorized signer.
     * @param siteId Unique identifier for the site (hash of off-chain ID)
     */
    function registerSite(bytes32 siteId) external nonReentrant {
        require(sites[siteId].registeredAt == 0, "Site already registered");
        require(siteId != bytes32(0), "Invalid site ID");

        sites[siteId] = Site({
            owner: msg.sender,
            active: true,
            registeredAt: block.timestamp
        });

        siteIds.push(siteId);

        // Owner is automatically an authorized signer
        authorizedSigners[siteId][msg.sender] = true;
        signerCount[siteId] = 1;

        emit SiteRegistered(siteId, msg.sender, block.timestamp);
        emit SignerAuthorized(siteId, msg.sender, block.timestamp);
    }

    /**
     * @notice Transfer site ownership to a new address.
     * @param siteId The site to transfer
     * @param newOwner The new owner address
     */
    function transferOwnership(bytes32 siteId, address newOwner)
        external
        onlySiteOwner(siteId)
        siteExists(siteId)
        nonReentrant
    {
        require(newOwner != address(0), "Invalid new owner");

        address previousOwner = sites[siteId].owner;
        sites[siteId].owner = newOwner;

        // New owner becomes authorized signer
        if (!authorizedSigners[siteId][newOwner]) {
            authorizedSigners[siteId][newOwner] = true;
            signerCount[siteId]++;
            emit SignerAuthorized(siteId, newOwner, block.timestamp);
        }

        emit SiteOwnershipTransferred(siteId, previousOwner, newOwner);
    }

    /**
     * @notice Deactivate a site (reversible via reactivateSite).
     * @param siteId The site to deactivate
     */
    function deactivateSite(bytes32 siteId)
        external
        onlySiteOwner(siteId)
        siteExists(siteId)
        nonReentrant
    {
        sites[siteId].active = false;
        emit SiteDeactivated(siteId, block.timestamp);
    }

    /**
     * @notice H-03 fix: Reactivate a previously deactivated site.
     * @param siteId The site to reactivate
     */
    function reactivateSite(bytes32 siteId)
        external
        onlySiteOwner(siteId)
        siteRegistered(siteId)
        nonReentrant
    {
        require(!sites[siteId].active, "Site already active");
        sites[siteId].active = true;
        emit SiteReactivated(siteId, block.timestamp);
    }

    /**
     * @notice Authorize a gateway for a site.
     * @param siteId The site
     * @param gateway The gateway address to authorize
     */
    function authorizeGateway(bytes32 siteId, address gateway)
        external
        onlySiteOwner(siteId)
        siteExists(siteId)
        nonReentrant
    {
        require(gateway != address(0), "Invalid gateway address");
        require(!authorizedGateways[siteId][gateway], "Gateway already authorized");

        authorizedGateways[siteId][gateway] = true;
        gatewayCount[siteId]++;
        emit GatewayAuthorized(siteId, gateway, block.timestamp);
    }

    /**
     * @notice Revoke a gateway's authorization.
     * @param siteId The site
     * @param gateway The gateway address to revoke
     */
    function revokeGateway(bytes32 siteId, address gateway)
        external
        onlySiteOwner(siteId)
        siteExists(siteId)
        nonReentrant
    {
        require(authorizedGateways[siteId][gateway], "Gateway not authorized");

        authorizedGateways[siteId][gateway] = false;
        gatewayCount[siteId]--;
        emit GatewayRevoked(siteId, gateway, block.timestamp);
    }

    /**
     * @notice Authorize a signer for a site.
     * @param siteId The site
     * @param signer The signer address to authorize
     */
    function authorizeSigner(bytes32 siteId, address signer)
        external
        onlySiteOwner(siteId)
        siteExists(siteId)
        nonReentrant
    {
        require(signer != address(0), "Invalid signer address");
        require(!authorizedSigners[siteId][signer], "Signer already authorized");

        authorizedSigners[siteId][signer] = true;
        signerCount[siteId]++;
        emit SignerAuthorized(siteId, signer, block.timestamp);
    }

    /**
     * @notice Revoke a signer's authorization.
     * @param siteId The site
     * @param signer The signer address to revoke
     */
    function revokeSigner(bytes32 siteId, address signer)
        external
        onlySiteOwner(siteId)
        siteExists(siteId)
        nonReentrant
    {
        require(signer != sites[siteId].owner, "Cannot revoke owner");
        require(authorizedSigners[siteId][signer], "Signer not authorized");

        authorizedSigners[siteId][signer] = false;
        signerCount[siteId]--;
        emit SignerRevoked(siteId, signer, block.timestamp);
    }

    // ── View Functions ──────────────────────────────────────────────────

    /**
     * @notice Check if a gateway is authorized for a site.
     * @param siteId The site
     * @param gateway The gateway address
     * @return True if authorized
     */
    function isGatewayAuthorized(bytes32 siteId, address gateway) external view returns (bool) {
        return authorizedGateways[siteId][gateway];
    }

    /**
     * @notice Check if a signer is authorized for a site.
     * @param siteId The site
     * @param signer The signer address
     * @return True if authorized
     */
    function isSignerAuthorized(bytes32 siteId, address signer) external view returns (bool) {
        return authorizedSigners[siteId][signer];
    }

    /**
     * @notice Get total number of registered sites.
     * @return count Total site count
     */
    function getSiteCount() external view returns (uint256 count) {
        return siteIds.length;
    }

    /**
     * @notice M-01 fix: Get a paginated slice of site IDs.
     * @param offset Starting index
     * @param limit Maximum number of items to return
     * @return result Array of site IDs in the requested range
     */
    function getSiteIdsPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory result)
    {
        uint256 total = siteIds.length;
        if (offset >= total) {
            return new bytes32[](0);
        }
        uint256 end = offset + limit;
        if (end > total) end = total;
        result = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = siteIds[i];
        }
    }

    /**
     * @notice Get site details.
     * @param siteId The site ID
     * @return owner Site owner address
     * @return active Whether the site is active
     * @return registeredAt Registration timestamp
     */
    function getSite(bytes32 siteId) external view returns (
        address owner,
        bool active,
        uint256 registeredAt
    ) {
        Site memory site = sites[siteId];
        return (site.owner, site.active, site.registeredAt);
    }
}
