// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SiteRegistry.sol";

/**
 * @title ChangeIntent
 * @notice PRD Section 7.3: Change Intent Contract
 * 
 * Anchors:
 * - Blueprint hashes
 * - Codegen output hashes
 * - Approval signatures
 * 
 * Finality before deployment - changes must be anchored before they can be deployed.
 */
contract ChangeIntent {
    
    SiteRegistry public immutable siteRegistry;
    
    enum IntentStatus {
        PENDING,
        APPROVED,
        REJECTED,
        DEPLOYED,
        ROLLED_BACK
    }
    
    struct Intent {
        bytes32 siteId;
        bytes32 blueprintHash;
        bytes32 codeHash;
        bytes32 changePackageHash;
        uint256 requiredApprovals;
        uint256 approvalCount;
        IntentStatus status;
        uint256 createdAt;
        uint256 approvedAt;
        uint256 deployedAt;
        address createdBy;
        address deployedBy;
    }
    
    struct Approval {
        address approver;
        bytes32 signatureHash;  // Hash of off-chain signature
        string comment;
        uint256 approvedAt;
    }
    
    // Intent ID => Intent
    mapping(bytes32 => Intent) public intents;
    
    // Intent ID => approver => Approval
    mapping(bytes32 => mapping(address => Approval)) public approvals;
    
    // Intent ID => list of approvers
    mapping(bytes32 => address[]) public intentApprovers;
    
    // Site ID => list of intent IDs
    mapping(bytes32 => bytes32[]) public siteIntents;
    
    // Track all intent IDs
    bytes32[] public intentIds;
    
    // Events
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
    
    constructor(address _siteRegistry) {
        siteRegistry = SiteRegistry(_siteRegistry);
    }
    
    /**
     * @notice Create a new change intent
     * @param siteId The site this change is for
     * @param blueprintHash Hash of the blueprint being changed
     * @param codeHash Hash of the generated code
     * @param changePackageHash Hash of the change package (diff, test plan, rollback)
     * @param requiredApprovals Number of approvals needed
     */
    function createIntent(
        bytes32 siteId,
        bytes32 blueprintHash,
        bytes32 codeHash,
        bytes32 changePackageHash,
        uint256 requiredApprovals
    ) external returns (bytes32 intentId) {
        // Verify caller is authorized
        require(
            siteRegistry.isSignerAuthorized(siteId, msg.sender),
            "Not authorized to create intents for this site"
        );
        
        require(blueprintHash != bytes32(0), "Invalid blueprint hash");
        require(requiredApprovals > 0, "Must require at least one approval");
        
        // Generate unique intent ID
        intentId = keccak256(abi.encodePacked(
            siteId,
            blueprintHash,
            codeHash,
            block.timestamp,
            msg.sender
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
     * @notice Approve a change intent
     * @param intentId The intent to approve
     * @param signatureHash Hash of the approver's off-chain signature
     * @param comment Optional comment
     */
    function approveIntent(
        bytes32 intentId,
        bytes32 signatureHash,
        string calldata comment
    ) external {
        Intent storage intent = intents[intentId];
        require(intent.createdAt > 0, "Intent does not exist");
        require(intent.status == IntentStatus.PENDING, "Intent not pending");
        
        // Verify caller is authorized
        require(
            siteRegistry.isSignerAuthorized(intent.siteId, msg.sender),
            "Not authorized to approve for this site"
        );
        
        // Check not already approved by this address
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
        
        // Check if fully approved
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
     * @notice Reject a change intent
     * @param intentId The intent to reject
     * @param reason Reason for rejection
     */
    function rejectIntent(bytes32 intentId, string calldata reason) external {
        Intent storage intent = intents[intentId];
        require(intent.createdAt > 0, "Intent does not exist");
        require(intent.status == IntentStatus.PENDING, "Intent not pending");
        
        // Verify caller is authorized
        require(
            siteRegistry.isSignerAuthorized(intent.siteId, msg.sender),
            "Not authorized to reject for this site"
        );
        
        intent.status = IntentStatus.REJECTED;
        
        emit IntentRejected(intentId, msg.sender, reason, block.timestamp);
    }
    
    /**
     * @notice Mark an intent as deployed
     * @param intentId The intent that was deployed
     */
    function markDeployed(bytes32 intentId) external {
        Intent storage intent = intents[intentId];
        require(intent.createdAt > 0, "Intent does not exist");
        require(intent.status == IntentStatus.APPROVED, "Intent not approved");
        
        // Verify caller is authorized
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
     * @notice Mark an intent as rolled back
     * @param intentId The intent that was rolled back
     * @param reason Reason for rollback
     */
    function markRolledBack(bytes32 intentId, string calldata reason) external {
        Intent storage intent = intents[intentId];
        require(intent.createdAt > 0, "Intent does not exist");
        require(intent.status == IntentStatus.DEPLOYED, "Intent not deployed");
        
        // Verify caller is authorized
        require(
            siteRegistry.isSignerAuthorized(intent.siteId, msg.sender),
            "Not authorized to rollback for this site"
        );
        
        intent.status = IntentStatus.ROLLED_BACK;
        
        emit IntentRolledBack(intentId, msg.sender, reason, block.timestamp);
    }
    
    // View functions
    
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
    
    function getIntentCount() external view returns (uint256) {
        return intentIds.length;
    }
    
    function getSiteIntentCount(bytes32 siteId) external view returns (uint256) {
        return siteIntents[siteId].length;
    }
    
    function getIntentApproverCount(bytes32 intentId) external view returns (uint256) {
        return intentApprovers[intentId].length;
    }
    
    function getApproval(bytes32 intentId, address approver) external view returns (
        bytes32 signatureHash,
        string memory comment,
        uint256 approvedAt
    ) {
        Approval memory approval = approvals[intentId][approver];
        return (approval.signatureHash, approval.comment, approval.approvedAt);
    }
    
    function isFullyApproved(bytes32 intentId) external view returns (bool) {
        Intent memory intent = intents[intentId];
        return intent.approvalCount >= intent.requiredApprovals;
    }
}
