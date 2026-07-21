// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title BountyPayment
 * @notice Automated bounty payment system for 0xSCADA GitHub contributions
 * @dev Supports both human contributors and AI agents with automated payment on PR merge
 *
 * Key Features:
 * - Register bounties with GitHub issue numbers
 * - Claim mechanism with 14-day timeout
 * - Automated payment on PR merge (triggered by GitHub Actions)
 * - Support for native token (ETH/MATIC) and ERC20 tokens (USDC, etc.)
 * - Multi-recipient payments for collaborative bounties
 * - Dispute resolution system
 * - Emergency pause functionality
 *
 * Security:
 * - Role-based access control for maintainers
 * - Reentrancy protection on payment functions
 * - Timelock for claim expiry
 * - Event logging for all state changes
 */
contract BountyPayment is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════════

    bytes32 public constant MAINTAINER_ROLE = keccak256("MAINTAINER_ROLE");
    bytes32 public constant PAYOUT_ROLE = keccak256("PAYOUT_ROLE"); // GitHub Actions bot

    // ═══════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════

    enum BountyStatus {
        Open,       // Available to claim
        Claimed,    // Claimed by someone, work in progress
        Completed,  // Reserved: no longer set (payments go Claimed -> Paid atomically); kept to preserve enum indices in the ABI
        Paid,       // Payment successful
        Expired,    // Claim expired, reverted to Open
        Disputed,   // Under dispute resolution
        Cancelled   // Bounty cancelled by maintainer
    }

    struct Bounty {
        uint256 issueNumber;        // GitHub issue number
        uint256 amount;             // Bounty amount in wei or token units
        address token;              // Token address (address(0) for native token)
        BountyStatus status;        // Current status
        address claimant;           // Who claimed the bounty
        uint256 claimedAt;          // Timestamp of claim
        uint256 claimTimeout;       // Duration in seconds before claim expires
        string metadata;            // IPFS hash or JSON metadata
        bool isAgentFriendly;       // Can AI agents claim this?
        uint256 createdAt;          // Timestamp of creation
        address createdBy;          // Who registered the bounty
    }

    struct Payment {
        uint256 issueNumber;
        uint256 prNumber;           // GitHub PR number
        address[] recipients;       // Support multi-recipient payments
        uint256[] amounts;          // Amount per recipient
        uint256 paidAt;             // Timestamp of payment
        bytes32 txHash;             // Transaction hash for reference
    }

    // ═══════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════

    // Mapping: issueNumber => Bounty
    mapping(uint256 => Bounty) public bounties;

    // Mapping: issueNumber => Payment
    mapping(uint256 => Payment) public payments;

    // Track all issue numbers
    uint256[] public issueNumbers;

    // Default claim timeout (14 days in seconds)
    uint256 public defaultClaimTimeout = 14 days;

    // Contract pause state
    bool public paused;

    // Total bounties registered
    uint256 public totalBountiesRegistered;

    // Total amount paid out
    uint256 public totalPaidOut;

    // ═══════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event BountyRegistered(
        uint256 indexed issueNumber,
        uint256 amount,
        address token,
        string metadata,
        bool isAgentFriendly
    );

    event BountyClaimed(
        uint256 indexed issueNumber,
        address indexed claimant,
        uint256 claimedAt,
        uint256 expiresAt
    );

    event BountyPaid(
        uint256 indexed issueNumber,
        uint256 indexed prNumber,
        address indexed recipient,
        uint256 amount,
        address token
    );

    event BountyExpired(
        uint256 indexed issueNumber,
        address previousClaimant
    );

    event BountyDisputed(
        uint256 indexed issueNumber,
        string reason
    );

    event BountyResolved(
        uint256 indexed issueNumber,
        bool inFavorOfClaimant
    );

    event BountyCancelled(
        uint256 indexed issueNumber,
        string reason
    );

    event ClaimTimeoutUpdated(uint256 newTimeout);
    event ContractPaused(address by);
    event ContractUnpaused(address by);

    // ═══════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════

    modifier whenNotPaused() {
        require(!paused, "Contract is paused");
        _;
    }

    modifier bountyExists(uint256 issueNumber) {
        require(bounties[issueNumber].createdAt > 0, "Bounty does not exist");
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor() {
        // Grant admin role to deployer
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MAINTAINER_ROLE, msg.sender);
        _grantRole(PAYOUT_ROLE, msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════════
    // BOUNTY REGISTRATION
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Register a new bounty for a GitHub issue
     * @param issueNumber GitHub issue number
     * @param amount Bounty amount in wei or token units
     * @param token Token address (address(0) for native ETH/MATIC)
     * @param metadata IPFS hash or JSON metadata
     * @param isAgentFriendly Can AI agents claim this bounty?
     */
    function registerBounty(
        uint256 issueNumber,
        uint256 amount,
        address token,
        string memory metadata,
        bool isAgentFriendly
    ) external onlyRole(MAINTAINER_ROLE) whenNotPaused {
        require(issueNumber > 0, "Invalid issue number");
        require(amount > 0, "Amount must be greater than 0");
        require(bounties[issueNumber].createdAt == 0, "Bounty already exists");

        bounties[issueNumber] = Bounty({
            issueNumber: issueNumber,
            amount: amount,
            token: token,
            status: BountyStatus.Open,
            claimant: address(0),
            claimedAt: 0,
            claimTimeout: defaultClaimTimeout,
            metadata: metadata,
            isAgentFriendly: isAgentFriendly,
            createdAt: block.timestamp,
            createdBy: msg.sender
        });

        issueNumbers.push(issueNumber);
        totalBountiesRegistered++;

        emit BountyRegistered(issueNumber, amount, token, metadata, isAgentFriendly);
    }

    // ═══════════════════════════════════════════════════════════════════
    // CLAIM MECHANISM
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Claim a bounty (called via GitHub Actions when user comments /claim)
     * @param issueNumber GitHub issue number
     * @param claimant Claimant's wallet address
     */
    function claimBounty(
        uint256 issueNumber,
        address claimant
    ) external onlyRole(PAYOUT_ROLE) whenNotPaused bountyExists(issueNumber) {
        Bounty storage bounty = bounties[issueNumber];

        require(bounty.status == BountyStatus.Open, "Bounty not available");
        require(claimant != address(0), "Invalid claimant address");

        bounty.status = BountyStatus.Claimed;
        bounty.claimant = claimant;
        bounty.claimedAt = block.timestamp;

        uint256 expiresAt = block.timestamp + bounty.claimTimeout;

        emit BountyClaimed(issueNumber, claimant, block.timestamp, expiresAt);
    }

    /**
     * @notice Check and expire stale claims (to be called by cron job or anyone)
     * @param issueNumber GitHub issue number
     */
    function expireClaim(uint256 issueNumber) external bountyExists(issueNumber) {
        Bounty storage bounty = bounties[issueNumber];

        require(bounty.status == BountyStatus.Claimed, "Bounty not claimed");
        require(
            block.timestamp >= bounty.claimedAt + bounty.claimTimeout,
            "Claim has not expired yet"
        );

        address previousClaimant = bounty.claimant;

        bounty.status = BountyStatus.Open;
        bounty.claimant = address(0);
        bounty.claimedAt = 0;

        emit BountyExpired(issueNumber, previousClaimant);
    }

    // ═══════════════════════════════════════════════════════════════════
    // PAYMENT
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Pay bounty to contributor (called by GitHub Actions on PR merge)
     * @param issueNumber GitHub issue number
     * @param prNumber GitHub PR number
     * @param recipient Recipient wallet address
     */
    function payBounty(
        uint256 issueNumber,
        uint256 prNumber,
        address payable recipient
    ) external onlyRole(PAYOUT_ROLE) whenNotPaused nonReentrant bountyExists(issueNumber) {
        Bounty storage bounty = bounties[issueNumber];

        require(bounty.status == BountyStatus.Claimed, "Bounty not claimed");
        require(bounty.claimant == recipient, "Recipient must be the claimant");
        require(recipient != address(0), "Invalid recipient");

        // Effects: finalize all state before the external transfer so a
        // re-entering recipient can never observe or exploit an intermediate
        // state (checks-effects-interactions). A failed transfer reverts the
        // whole transaction, rolling these back.
        bounty.status = BountyStatus.Paid;

        address[] memory recipients = new address[](1);
        recipients[0] = recipient;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = bounty.amount;

        payments[issueNumber] = Payment({
            issueNumber: issueNumber,
            prNumber: prNumber,
            recipients: recipients,
            amounts: amounts,
            paidAt: block.timestamp,
            txHash: blockhash(block.number - 1) // Approximate tx hash
        });

        totalPaidOut += bounty.amount;

        // Interactions: transfer funds
        if (bounty.token == address(0)) {
            // Native token (ETH/MATIC)
            require(address(this).balance >= bounty.amount, "Insufficient contract balance");
            (bool success, ) = recipient.call{value: bounty.amount}("");
            require(success, "Payment failed");
        } else {
            // ERC20 token
            IERC20 tokenContract = IERC20(bounty.token);
            require(
                tokenContract.balanceOf(address(this)) >= bounty.amount,
                "Insufficient token balance"
            );
            tokenContract.safeTransfer(recipient, bounty.amount);
        }

        emit BountyPaid(issueNumber, prNumber, recipient, bounty.amount, bounty.token);
    }

    /**
     * @notice Pay bounty to multiple contributors (for collaborative work)
     * @param issueNumber GitHub issue number
     * @param prNumber GitHub PR number
     * @param recipients Array of recipient addresses
     * @param amounts Array of amounts per recipient
     */
    function payBountyMultiple(
        uint256 issueNumber,
        uint256 prNumber,
        address payable[] memory recipients,
        uint256[] memory amounts
    ) external onlyRole(PAYOUT_ROLE) whenNotPaused nonReentrant bountyExists(issueNumber) {
        require(recipients.length == amounts.length, "Arrays length mismatch");
        require(recipients.length > 0, "No recipients specified");

        Bounty storage bounty = bounties[issueNumber];
        require(bounty.status == BountyStatus.Claimed, "Bounty not claimed");

        // Calculate total amount
        uint256 totalAmount = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            totalAmount += amounts[i];
        }
        require(totalAmount == bounty.amount, "Total amounts must equal bounty amount");
        if (bounty.token == address(0)) {
            require(address(this).balance >= totalAmount, "Insufficient contract balance");
        } else {
            require(
                IERC20(bounty.token).balanceOf(address(this)) >= totalAmount,
                "Insufficient token balance"
            );
        }

        // Effects: finalize all state before any external call so a
        // re-entering recipient mid-loop can never observe or exploit an
        // intermediate state (checks-effects-interactions). Any failed
        // transfer reverts the whole transaction, rolling these back.
        bounty.status = BountyStatus.Paid;

        // Payment.recipients is address[]; the payable array cannot be assigned directly
        address[] memory recipientAddrs = new address[](recipients.length);
        for (uint256 i = 0; i < recipients.length; i++) {
            recipientAddrs[i] = recipients[i];
        }

        // Record payment
        payments[issueNumber] = Payment({
            issueNumber: issueNumber,
            prNumber: prNumber,
            recipients: recipientAddrs,
            amounts: amounts,
            paidAt: block.timestamp,
            txHash: blockhash(block.number - 1)
        });

        totalPaidOut += totalAmount;

        // Interactions: transfer funds to each recipient
        for (uint256 i = 0; i < recipients.length; i++) {
            address payable recipient = recipients[i];
            uint256 amount = amounts[i];

            if (bounty.token == address(0)) {
                // Native token
                (bool success, ) = recipient.call{value: amount}("");
                require(success, "Payment failed");
            } else {
                // ERC20 token
                IERC20(bounty.token).safeTransfer(recipient, amount);
            }

            emit BountyPaid(issueNumber, prNumber, recipient, amount, bounty.token);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // DISPUTE RESOLUTION
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Mark bounty as disputed
     * @param issueNumber GitHub issue number
     * @param reason Reason for dispute
     */
    function disputeBounty(
        uint256 issueNumber,
        string memory reason
    ) external onlyRole(MAINTAINER_ROLE) bountyExists(issueNumber) {
        Bounty storage bounty = bounties[issueNumber];
        require(
            bounty.status == BountyStatus.Claimed || bounty.status == BountyStatus.Completed,
            "Can only dispute claimed or completed bounties"
        );

        bounty.status = BountyStatus.Disputed;
        emit BountyDisputed(issueNumber, reason);
    }

    /**
     * @notice Resolve dispute (maintainer decision)
     * @param issueNumber GitHub issue number
     * @param inFavorOfClaimant If true, proceed with payment; if false, revert to Open
     */
    function resolveDispute(
        uint256 issueNumber,
        bool inFavorOfClaimant
    ) external onlyRole(MAINTAINER_ROLE) bountyExists(issueNumber) {
        Bounty storage bounty = bounties[issueNumber];
        require(bounty.status == BountyStatus.Disputed, "Bounty not disputed");

        if (inFavorOfClaimant) {
            bounty.status = BountyStatus.Claimed; // Allow payment to proceed
        } else {
            bounty.status = BountyStatus.Open;
            bounty.claimant = address(0);
            bounty.claimedAt = 0;
        }

        emit BountyResolved(issueNumber, inFavorOfClaimant);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Cancel a bounty
     * @param issueNumber GitHub issue number
     * @param reason Reason for cancellation
     */
    function cancelBounty(
        uint256 issueNumber,
        string memory reason
    ) external onlyRole(MAINTAINER_ROLE) bountyExists(issueNumber) {
        Bounty storage bounty = bounties[issueNumber];
        require(bounty.status != BountyStatus.Paid, "Cannot cancel paid bounty");

        bounty.status = BountyStatus.Cancelled;
        emit BountyCancelled(issueNumber, reason);
    }

    /**
     * @notice Update default claim timeout
     * @param newTimeout New timeout in seconds
     */
    function setDefaultClaimTimeout(uint256 newTimeout) external onlyRole(MAINTAINER_ROLE) {
        require(newTimeout >= 1 days && newTimeout <= 30 days, "Invalid timeout range");
        defaultClaimTimeout = newTimeout;
        emit ClaimTimeoutUpdated(newTimeout);
    }

    /**
     * @notice Pause the contract (emergency)
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        paused = true;
        emit ContractPaused(msg.sender);
    }

    /**
     * @notice Unpause the contract
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        paused = false;
        emit ContractUnpaused(msg.sender);
    }

    /**
     * @notice Withdraw native tokens (emergency)
     * @param to Recipient address
     * @param amount Amount to withdraw
     */
    function withdrawNative(
        address payable to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(to != address(0), "Invalid recipient");
        require(address(this).balance >= amount, "Insufficient balance");
        (bool success, ) = to.call{value: amount}("");
        require(success, "Withdrawal failed");
    }

    /**
     * @notice Withdraw ERC20 tokens (emergency)
     * @param token Token address
     * @param to Recipient address
     * @param amount Amount to withdraw
     */
    function withdrawToken(
        address token,
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(to != address(0), "Invalid recipient");
        IERC20(token).safeTransfer(to, amount);
    }

    // ═══════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Get bounty details
     */
    function getBounty(uint256 issueNumber) external view returns (Bounty memory) {
        return bounties[issueNumber];
    }

    /**
     * @notice Get payment details
     */
    function getPayment(uint256 issueNumber) external view returns (Payment memory) {
        return payments[issueNumber];
    }

    /**
     * @notice Get all issue numbers
     */
    function getAllIssueNumbers() external view returns (uint256[] memory) {
        return issueNumbers;
    }

    /**
     * @notice Check if bounty has expired
     */
    function isClaimExpired(uint256 issueNumber) external view bountyExists(issueNumber) returns (bool) {
        Bounty memory bounty = bounties[issueNumber];
        if (bounty.status != BountyStatus.Claimed) {
            return false;
        }
        return block.timestamp >= bounty.claimedAt + bounty.claimTimeout;
    }

    /**
     * @notice Get contract statistics
     */
    function getStats() external view returns (
        uint256 _totalBounties,
        uint256 _totalPaid,
        uint256 _contractBalance,
        bool _isPaused
    ) {
        return (
            totalBountiesRegistered,
            totalPaidOut,
            address(this).balance,
            paused
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // RECEIVE FUNCTION
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Allow contract to receive native tokens
     */
    receive() external payable {}

    /**
     * @notice Fallback function
     */
    fallback() external payable {}
}
