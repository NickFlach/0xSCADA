// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./SiteRegistry.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ChangeIntent
 * @author 0xSCADA Team
 * @notice PRD Section 7.3: Change Intent Contract — anchors blueprint hashes,
 *         codegen output hashes, and approval signatures for finality before deployment.
 * @dev Security audit remediation applied (QE Phase 2, 2026-02-01):
 *      - C-02: Nonce-based intent ID (prevents front-running)
 *      - M-01: Pagination for intent arrays
 *      - M-03: Documented timestamp/block.number usage
 *      - M-04: Intent expiration (7-day default)
 *      - M-05: ReentrancyGuard on all state-changing functions
 *      - Locked Solidity version to 0.8.20
 */
contract ChangeIntent is ReentrancyGuard {

    SiteRegistry public immutable siteRegistry;

    /// @notice M-04 fix: Intents expire after this duration (7 days)
    uint256 public constant INTENT_EXPIRY = 7 days;

    enum IntentStatus {
        PENDING,
        APPROVED,
        REJECTED,
        DEPLOYED,
        ROLLED_BACK,
        EXPIRED      // M-04: New status for expired intents
    }

    struct Intent {
        bytes32 siteId;
        bytes32 blueprintHash;
        bytes32 codeHash;
        bytes32 changePackageHash;
        uint256 requiredApprovals;
        uint256 approvalCount;
        IntentStatus status;
        uint256 createdAt;       // M-03: block.timestamp — record-keeping, expiry baseline
        uint256 approvedAt;
        uint256 deployedAt;
        address createdBy;
        address deployedBy;
    }

    struct Approval {
        address approver;
        bytes32 signatureHash;   /// @dev Hash of off-chain signature
        string comment;
        uint256 approvedAt;
    }

    /// @notice Intent ID => Intent data
    mapping(bytes32 => Intent) public intents;

    /// @notice Intent ID => approver => Approval
    mapping(bytes32 => mapping(address => Approval)) public approvals;

    /// @notice Intent ID => ordered list of approvers
    mapping(bytes32 => address[]) public intentApprovers;

    /// @notice Site ID => list of intent IDs
    mapping(bytes32 => bytes32[]) public siteIntents;

    /// @notice All intent IDs
    bytes32[] public intentIds;

    /// @notice C-02 fix: Incrementing nonce prevents front-running of intent IDs
    uint256 private _intentNonce;

    // ── Events ──────────────────────────────────────────────────────────

    event IntentCreated(
        bytes32 indexed intentId,
        bytes32 indexed siteId,
        bytes32 blueprintHash,
        bytes32 codeHash,
        uint256 requiredApprovals,
        address indexed createdBy,
        uint256 timestamp
    );

    event IntentApproved(
        bytes32 indexed intentId,
        address indexed approver,
        uint256 approvalCount,
        uint256 timestamp
    );

    event IntentRejected(
        bytes32 indexed intentId,
        address indexed rejectedBy,
        string reason,
        uint256 timestamp
    );

    event IntentDeployed(
        bytes32 indexed intentId,
        address indexed deployedBy,
        uint256 timestamp
    );

    event IntentRolledBack(
        bytes32 indexed intentId,
        address indexed rolledBackBy,
        string reason,
        uint256 timestamp
    );

    /// @notice M-04: Emitted when an intent is marked expired
    event IntentExpired(
        bytes32 indexed intentId,
        uint256 timestamp
    );

    // ── Constructor ─────────────────────────────────────────────────────

    /**
     * @notice Deploy with a reference to the SiteRegistry.
     * @param _siteRegistry Address of the deployed SiteRegistry contract
     */
    constructor(address _siteRegistry) {
        siteRegistry = SiteRegistry(_siteRegistry);
    }

    // ── Write Functions ─────────────────────────────────────────────────

    /**
     * @notice Create a new change intent.
     * @param siteId The site this change is for
     * @param blueprintHash Hash of the blueprint being changed
     * @param codeHash Hash of the generated code
     * @param changePackageHash Hash of the change package (diff, test plan, rollback)
     * @param requiredApprovals Number of approvals needed
     * @return intentId The unique identifier for this intent
     */
    function createIntent(
        bytes32 siteId,
        bytes32 blueprintHash,
        bytes32 codeHash,
        bytes32 changePackageHash,
        uint256 requiredApprovals
    ) external nonReentrant returns (bytes32 intentId) {
        require(
            siteRegistry.isSignerAuthorized(siteId, msg.sender),
            "Not authorized to create intents for this site"
        );

        require(blueprintHash != bytes32(0), "Invalid blueprint hash");
        require(requiredApprovals > 0, "Must require at least one approval");

        // C-02 fix: nonce makes ID unpredictable
        unchecked { _intentNonce++; }
        intentId = keccak256(abi.encodePacked(
            siteId,
            blueprintHash,
            codeHash,
            block.number,   // M-03: block.number for ordering
            msg.sender,
            _intentNonce
        ));

        require(intents[intentId].createdAt == 0, "Intent already exists");

        intents[intentId] = Intent({
            siteId: siteId,
            blueprintHash: blueprintHash,
            codeHash: codeHash,
            changePackageHash: changePackageHash,
            requiredApprovals: requiredApprovals,
            approvalCount: 0,
            status: IntentStatus.PENDING,
            createdAt: block.timestamp,
            approvedAt: 0,
            deployedAt: 0,
            createdBy: msg.sender,
            deployedBy: address(0)
        });

        intentIds.push(intentId);
        siteIntents[siteId].push(intentId);

        emit IntentCreated(
            intentId,
            siteId,
            blueprintHash,
            codeHash,
            requiredApprovals,
            msg.sender,
            block.timestamp
        );

        return intentId;
    }

    /**
     * @notice Approve a change intent. Reverts if the intent has expired.
     * @param intentId The intent to approve
     * @param signatureHash Hash of the approver's off-chain signature
     * @param comment Optional comment
     */
    function approveIntent(
        bytes32 intentId,
        bytes32 signatureHash,
        string calldata comment
    ) external nonReentrant {
        Intent storage intent = intents[intentId];
        require(intent.createdAt > 0, "Intent does not exist");
        require(intent.status == IntentStatus.PENDING, "Intent not pending");
        require(!isExpired(intentId), "Intent has expired");

        require(
            siteRegistry.isSignerAuthorized(intent.siteId, msg.sender),
            "Not authorized to approve for this site"
        );

        require(
            approvals[intentId][msg.sender].approvedAt == 0,
            "Already approved"
        );

        approvals[intentId][msg.sender] = Approval({
            approver: msg.sender,
            signatureHash: signatureHash,
            comment: comment,
            approvedAt: block.timestamp
        });

        intentApprovers[intentId].push(msg.sender);
        intent.approvalCount++;

        if (intent.approvalCount >= intent.requiredApprovals) {
            intent.status = IntentStatus.APPROVED;
            intent.approvedAt = block.timestamp;
        }

        emit IntentApproved(
            intentId,
            msg.sender,
            intent.approvalCount,
            block.timestamp
        );
    }

    /**
     * @notice Reject a change intent.
     * @param intentId The intent to reject
     * @param reason Reason for rejection
     */
    function rejectIntent(bytes32 intentId, string calldata reason) external nonReentrant {
        Intent storage intent = intents[intentId];
        require(intent.createdAt > 0, "Intent does not exist");
        require(intent.status == IntentStatus.PENDING, "Intent not pending");

        require(
            siteRegistry.isSignerAuthorized(intent.siteId, msg.sender),
            "Not authorized to reject for this site"
        );

        intent.status = IntentStatus.REJECTED;

        emit IntentRejected(intentId, msg.sender, reason, block.timestamp);
    }

    /**
     * @notice Mark an approved intent as deployed.
     * @param intentId The intent that was deployed
     */
    function markDeployed(bytes32 intentId) external nonReentrant {
        Intent storage intent = intents[intentId];
        require(intent.createdAt > 0, "Intent does not exist");
        require(intent.status == IntentStatus.APPROVED, "Intent not approved");

        require(
            siteRegistry.isSignerAuthorized(intent.siteId, msg.sender),
            "Not authorized to mark deployed for this site"
        );

        intent.status = IntentStatus.DEPLOYED;
        intent.deployedAt = block.timestamp;
        intent.deployedBy = msg.sender;

        emit IntentDeployed(intentId, msg.sender, block.timestamp);
    }

    /**
     * @notice Mark a deployed intent as rolled back.
     * @param intentId The intent that was rolled back
     * @param reason Reason for rollback
     */
    function markRolledBack(bytes32 intentId, string calldata reason) external nonReentrant {
        Intent storage intent = intents[intentId];
        require(intent.createdAt > 0, "Intent does not exist");
        require(intent.status == IntentStatus.DEPLOYED, "Intent not deployed");

        require(
            siteRegistry.isSignerAuthorized(intent.siteId, msg.sender),
            "Not authorized to rollback for this site"
        );

        intent.status = IntentStatus.ROLLED_BACK;

        emit IntentRolledBack(intentId, msg.sender, reason, block.timestamp);
    }

    /**
     * @notice M-04 fix: Explicitly mark an expired intent. Anyone can call this
     *         for housekeeping; the intent must actually be past INTENT_EXPIRY.
     * @param intentId The intent to expire
     */
    function markExpired(bytes32 intentId) external nonReentrant {
        Intent storage intent = intents[intentId];
        require(intent.createdAt > 0, "Intent does not exist");
        require(intent.status == IntentStatus.PENDING, "Intent not pending");
        require(isExpired(intentId), "Intent not yet expired");

        intent.status = IntentStatus.EXPIRED;
        emit IntentExpired(intentId, block.timestamp);
    }

    // ── View Functions ──────────────────────────────────────────────────

    /**
     * @notice M-04 fix: Check if an intent has expired.
     * @param intentId The intent to check
     * @return True if the intent is past its expiry window
     */
    function isExpired(bytes32 intentId) public view returns (bool) {
        Intent memory intent = intents[intentId];
        if (intent.createdAt == 0) return false;
        return block.timestamp > intent.createdAt + INTENT_EXPIRY;
    }

    /**
     * @notice Get full intent details.
     * @param intentId The intent ID
     */
    function getIntent(bytes32 intentId) external view returns (
        bytes32 siteId,
        bytes32 blueprintHash,
        bytes32 codeHash,
        bytes32 changePackageHash,
        uint256 requiredApprovals,
        uint256 approvalCount,
        IntentStatus status,
        uint256 createdAt,
        uint256 approvedAt,
        uint256 deployedAt,
        address createdBy,
        address deployedBy
    ) {
        Intent memory intent = intents[intentId];
        return (
            intent.siteId,
            intent.blueprintHash,
            intent.codeHash,
            intent.changePackageHash,
            intent.requiredApprovals,
            intent.approvalCount,
            intent.status,
            intent.createdAt,
            intent.approvedAt,
            intent.deployedAt,
            intent.createdBy,
            intent.deployedBy
        );
    }

    /**
     * @notice Get total intent count.
     * @return Total number of intents
     */
    function getIntentCount() external view returns (uint256) {
        return intentIds.length;
    }

    /**
     * @notice Get intent count for a specific site.
     * @param siteId The site ID
     * @return Number of intents for the site
     */
    function getSiteIntentCount(bytes32 siteId) external view returns (uint256) {
        return siteIntents[siteId].length;
    }

    /**
     * @notice Get approver count for an intent.
     * @param intentId The intent ID
     * @return Number of approvers
     */
    function getIntentApproverCount(bytes32 intentId) external view returns (uint256) {
        return intentApprovers[intentId].length;
    }

    /**
     * @notice Get approval details for a specific approver.
     * @param intentId The intent ID
     * @param approver The approver address
     */
    function getApproval(bytes32 intentId, address approver) external view returns (
        bytes32 signatureHash,
        string memory comment,
        uint256 approvedAt
    ) {
        Approval memory approval = approvals[intentId][approver];
        return (approval.signatureHash, approval.comment, approval.approvedAt);
    }

    /**
     * @notice Check if an intent has received all required approvals.
     * @param intentId The intent ID
     * @return True if fully approved
     */
    function isFullyApproved(bytes32 intentId) external view returns (bool) {
        Intent memory intent = intents[intentId];
        return intent.approvalCount >= intent.requiredApprovals;
    }

    /**
     * @notice M-01 fix: Paginated access to all intent IDs.
     * @param offset Starting index
     * @param limit Maximum items to return
     * @return result Slice of intent IDs
     */
    function getIntentIdsPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory result)
    {
        uint256 total = intentIds.length;
        if (offset >= total) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        result = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = intentIds[i];
        }
    }

    /**
     * @notice M-01 fix: Paginated access to site-specific intent IDs.
     * @param siteId The site ID
     * @param offset Starting index
     * @param limit Maximum items to return
     * @return result Slice of intent IDs for the site
     */
    function getSiteIntentsPaginated(bytes32 siteId, uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory result)
    {
        uint256 total = siteIntents[siteId].length;
        if (offset >= total) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        result = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = siteIntents[siteId][i];
        }
    }
}
