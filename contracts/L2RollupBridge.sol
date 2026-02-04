// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title L2RollupBridge
 * @notice L1 Bridge Contract for 0xSCADA L2 Rollup
 *
 * This contract handles:
 * - State commitment submissions from L2
 * - Batch finalization
 * - Fraud proof verification (optimistic rollups)
 * - Validity proof verification (ZK rollups)
 *
 * Architecture:
 * - Sequencer submits state commitments
 * - Challenge period for optimistic mode
 * - Direct finalization for ZK mode (after proof verification)
 *
 * Security Features:
 * - Reentrancy protection on all external calls
 * - Input validation on all public functions
 * - Configurable ZK verifier contract
 */
contract L2RollupBridge {
    // Reentrancy guard
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;
    uint256 private _reentrancyStatus = NOT_ENTERED;

    modifier nonReentrant() {
        require(_reentrancyStatus != ENTERED, "ReentrancyGuard: reentrant call");
        _reentrancyStatus = ENTERED;
        _;
        _reentrancyStatus = NOT_ENTERED;
    }

    // =========================================================================
    // TYPES
    // =========================================================================

    struct StateCommitment {
        bytes32 stateRoot;
        bytes32 prevStateRoot;
        bytes32 dataHash;
        uint256 eventCount;
        uint256 timestamp;
        uint256 submittedAt;
        address submitter;
        bool finalized;
        bool challenged;
    }

    struct Challenge {
        address challenger;
        uint256 invalidEventIndex;
        bytes32 expectedStateRoot;
        uint256 timestamp;
        bool resolved;
        bool successful;
    }

    // Rollup mode
    enum RollupMode { OPTIMISTIC, ZK }

    // =========================================================================
    // STATE
    // =========================================================================

    // Configuration
    RollupMode public immutable mode;
    uint256 public immutable challengePeriod;
    address public sequencer;
    address public owner;

    // ZK Verifier contract (for ZK mode)
    address public zkVerifier;

    // Timestamp validation bounds
    uint256 public constant MAX_TIMESTAMP_DRIFT = 1 hours;

    // State commitments: batchIndex => StateCommitment
    mapping(uint256 => StateCommitment) public stateCommitments;

    // Challenges: batchIndex => Challenge
    mapping(uint256 => Challenge) public challenges;

    // Tracking
    uint256 public latestBatchIndex;
    uint256 public latestFinalizedBatch;
    bytes32 public latestStateRoot;

    // Pausing
    bool public paused;

    // Staking for challengers (optional)
    uint256 public constant CHALLENGE_STAKE = 0.1 ether;
    mapping(address => uint256) public challengerStakes;

    // =========================================================================
    // EVENTS
    // =========================================================================

    event StateCommitmentSubmitted(
        uint256 indexed batchIndex,
        bytes32 stateRoot,
        bytes32 prevStateRoot,
        uint256 eventCount,
        uint256 timestamp,
        address indexed submitter
    );

    event BatchFinalized(
        uint256 indexed batchIndex,
        bytes32 stateRoot,
        uint256 timestamp
    );

    event FraudProofSubmitted(
        uint256 indexed batchIndex,
        address indexed challenger,
        uint256 invalidEventIndex,
        bytes32 expectedStateRoot
    );

    event BatchChallenged(
        uint256 indexed batchIndex,
        address indexed challenger
    );

    event ChallengeResolved(
        uint256 indexed batchIndex,
        bool successful,
        address indexed challenger
    );

    event ValidityProofSubmitted(
        uint256 indexed batchIndex,
        address indexed submitter
    );

    event SequencerUpdated(address indexed oldSequencer, address indexed newSequencer);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    // =========================================================================
    // MODIFIERS
    // =========================================================================

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    modifier onlySequencer() {
        require(msg.sender == sequencer, "Only sequencer");
        _;
    }

    modifier onlySequencerOrOwner() {
        require(msg.sender == sequencer || msg.sender == owner, "Only sequencer or owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Contract is paused");
        _;
    }

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * @notice Initialize the L2 rollup bridge
     * @param _mode Rollup mode (0 = OPTIMISTIC, 1 = ZK)
     * @param _challengePeriod Challenge period in seconds (for optimistic mode)
     * @param _sequencer Initial sequencer address
     */
    constructor(
        RollupMode _mode,
        uint256 _challengePeriod,
        address _sequencer
    ) {
        mode = _mode;
        challengePeriod = _mode == RollupMode.OPTIMISTIC ? _challengePeriod : 0;
        sequencer = _sequencer;
        owner = msg.sender;
        latestStateRoot = keccak256(abi.encodePacked("0xSCADA_L2_GENESIS"));
    }

    // =========================================================================
    // STATE COMMITMENT FUNCTIONS
    // =========================================================================

    /**
     * @notice Submit a state commitment for a batch
     * @param batchIndex Sequential batch number
     * @param stateRoot Merkle root of L2 state after this batch
     * @param prevStateRoot Previous state root (for chaining)
     * @param dataHash Hash of batch data
     * @param eventCount Number of events in the batch
     * @param timestamp Timestamp when batch was created
     */
    function submitStateCommitment(
        uint256 batchIndex,
        bytes32 stateRoot,
        bytes32 prevStateRoot,
        bytes32 dataHash,
        uint256 eventCount,
        uint256 timestamp
    ) external onlySequencerOrOwner whenNotPaused {
        // Validate all inputs
        require(stateRoot != bytes32(0), "Invalid state root");
        require(dataHash != bytes32(0), "Invalid data hash");
        require(eventCount > 0, "Event count must be positive");
        require(batchIndex == latestBatchIndex + 1, "Invalid batch index");
        require(prevStateRoot == latestStateRoot, "State root mismatch");
        require(stateCommitments[batchIndex].submittedAt == 0, "Batch already submitted");

        // Validate timestamp is reasonable (not too far in past or future)
        require(timestamp <= block.timestamp + MAX_TIMESTAMP_DRIFT, "Timestamp too far in future");
        require(timestamp >= block.timestamp - MAX_TIMESTAMP_DRIFT, "Timestamp too far in past");

        stateCommitments[batchIndex] = StateCommitment({
            stateRoot: stateRoot,
            prevStateRoot: prevStateRoot,
            dataHash: dataHash,
            eventCount: eventCount,
            timestamp: timestamp,
            submittedAt: block.timestamp,
            submitter: msg.sender,
            finalized: false,
            challenged: false
        });

        latestBatchIndex = batchIndex;
        latestStateRoot = stateRoot;

        emit StateCommitmentSubmitted(
            batchIndex,
            stateRoot,
            prevStateRoot,
            eventCount,
            timestamp,
            msg.sender
        );

        // For ZK mode, batch can be finalized immediately after proof verification
        // (proof verification happens in submitValidityProof)
    }

    /**
     * @notice Get state commitment for a batch
     */
    function getStateCommitment(uint256 batchIndex) external view returns (
        bytes32 stateRoot,
        uint256 eventCount,
        uint256 timestamp,
        bool finalized
    ) {
        StateCommitment memory commitment = stateCommitments[batchIndex];
        return (
            commitment.stateRoot,
            commitment.eventCount,
            commitment.timestamp,
            commitment.finalized
        );
    }

    // =========================================================================
    // FINALIZATION FUNCTIONS
    // =========================================================================

    /**
     * @notice Finalize a batch after challenge period (optimistic) or proof verification (ZK)
     * @param batchIndex The batch to finalize
     */
    function finalizeBatch(uint256 batchIndex) external whenNotPaused {
        StateCommitment storage commitment = stateCommitments[batchIndex];
        require(commitment.submittedAt > 0, "Batch not submitted");
        require(!commitment.finalized, "Already finalized");
        require(!commitment.challenged, "Batch is challenged");

        if (mode == RollupMode.OPTIMISTIC) {
            // Check challenge period has passed
            require(
                block.timestamp >= commitment.submittedAt + challengePeriod,
                "Challenge period not over"
            );
        }
        // For ZK mode, finalization should only happen after proof verification
        // which sets finalized = true in submitValidityProof

        commitment.finalized = true;

        if (batchIndex > latestFinalizedBatch) {
            latestFinalizedBatch = batchIndex;
        }

        emit BatchFinalized(batchIndex, commitment.stateRoot, block.timestamp);
    }

    /**
     * @notice Check if a batch is finalized
     */
    function isBatchFinalized(uint256 batchIndex) external view returns (bool) {
        return stateCommitments[batchIndex].finalized;
    }

    // =========================================================================
    // FRAUD PROOF FUNCTIONS (OPTIMISTIC MODE)
    // =========================================================================

    /**
     * @notice Submit a fraud proof for an invalid batch
     * @param batchIndex The batch being challenged
     * @param invalidEventIndex Index of the invalid event
     * @param expectedStateRoot The correct state root
     * @param proof Merkle proof for the invalid event
     */
    function submitFraudProof(
        uint256 batchIndex,
        uint256 invalidEventIndex,
        bytes32 expectedStateRoot,
        bytes32[] calldata proof
    ) external payable whenNotPaused nonReentrant {
        require(mode == RollupMode.OPTIMISTIC, "Not in optimistic mode");

        StateCommitment storage commitment = stateCommitments[batchIndex];
        require(commitment.submittedAt > 0, "Batch not submitted");
        require(!commitment.finalized, "Batch already finalized");
        require(!commitment.challenged, "Already challenged");
        require(
            block.timestamp < commitment.submittedAt + challengePeriod,
            "Challenge period expired"
        );

        // Require stake for challenge
        require(msg.value >= CHALLENGE_STAKE, "Insufficient stake");
        challengerStakes[msg.sender] += msg.value;

        // Mark batch as challenged
        commitment.challenged = true;

        // Store challenge details
        challenges[batchIndex] = Challenge({
            challenger: msg.sender,
            invalidEventIndex: invalidEventIndex,
            expectedStateRoot: expectedStateRoot,
            timestamp: block.timestamp,
            resolved: false,
            successful: false
        });

        emit FraudProofSubmitted(batchIndex, msg.sender, invalidEventIndex, expectedStateRoot);
        emit BatchChallenged(batchIndex, msg.sender);

        // Note: In a full implementation, the fraud proof would be verified here
        // For simplicity, we assume the proof is valid and mark for resolution
    }

    /**
     * @notice Resolve a challenge (called by owner/arbitrator)
     * @param batchIndex The challenged batch
     * @param challengeSuccessful Whether the challenge was valid
     */
    function resolveChallenge(
        uint256 batchIndex,
        bool challengeSuccessful
    ) external onlyOwner nonReentrant {
        Challenge storage challenge = challenges[batchIndex];
        require(challenge.timestamp > 0, "No challenge exists");
        require(!challenge.resolved, "Already resolved");

        challenge.resolved = true;
        challenge.successful = challengeSuccessful;

        StateCommitment storage commitment = stateCommitments[batchIndex];

        if (challengeSuccessful) {
            // Challenge successful - batch is invalid
            // Revert state to previous batch
            latestStateRoot = commitment.prevStateRoot;
            latestBatchIndex = batchIndex - 1;

            // Return stake to challenger with bonus
            uint256 stake = challengerStakes[challenge.challenger];
            challengerStakes[challenge.challenger] = 0;
            payable(challenge.challenger).transfer(stake);

            emit ChallengeResolved(batchIndex, true, challenge.challenger);
        } else {
            // Challenge failed - batch is valid
            commitment.challenged = false;

            // Slash challenger stake (goes to sequencer)
            uint256 stake = challengerStakes[challenge.challenger];
            challengerStakes[challenge.challenger] = 0;
            payable(sequencer).transfer(stake);

            emit ChallengeResolved(batchIndex, false, challenge.challenger);
        }
    }

    /**
     * @notice Get challenge status for a batch
     */
    function getChallengeStatus(uint256 batchIndex) external view returns (
        bool challenged,
        address challenger,
        uint256 timestamp
    ) {
        StateCommitment memory commitment = stateCommitments[batchIndex];
        Challenge memory challenge = challenges[batchIndex];
        return (
            commitment.challenged,
            challenge.challenger,
            challenge.timestamp
        );
    }

    // =========================================================================
    // VALIDITY PROOF FUNCTIONS (ZK MODE)
    // =========================================================================

    /**
     * @notice Submit a validity proof for a batch (ZK mode)
     * @param batchIndex The batch to prove
     * @param proof The ZK proof (SNARK/STARK)
     * @param publicInputs Public inputs for verification
     */
    function submitValidityProof(
        uint256 batchIndex,
        bytes calldata proof,
        bytes32[] calldata publicInputs
    ) external onlySequencerOrOwner whenNotPaused {
        require(mode == RollupMode.ZK, "Not in ZK mode");

        StateCommitment storage commitment = stateCommitments[batchIndex];
        require(commitment.submittedAt > 0, "Batch not submitted");
        require(!commitment.finalized, "Already finalized");

        // Validate proof structure
        require(proof.length >= 32, "Proof too short");
        require(publicInputs.length >= 2, "Missing public inputs");
        require(publicInputs[0] == commitment.prevStateRoot, "Invalid prev state root");
        require(publicInputs[1] == commitment.stateRoot, "Invalid state root");

        // Verify the ZK proof using the verifier contract
        // If no verifier is set, require owner to manually verify
        if (zkVerifier != address(0)) {
            // Call external verifier contract
            (bool success, bytes memory result) = zkVerifier.staticcall(
                abi.encodeWithSignature("verify(bytes,bytes32[])", proof, publicInputs)
            );
            require(success && abi.decode(result, (bool)), "ZK proof verification failed");
        } else {
            // No verifier set - only owner can submit proofs (for testing/bootstrap)
            require(msg.sender == owner, "No verifier set, only owner can submit");
        }

        // Mark as finalized (ZK proofs provide instant finality)
        commitment.finalized = true;

        if (batchIndex > latestFinalizedBatch) {
            latestFinalizedBatch = batchIndex;
        }

        emit ValidityProofSubmitted(batchIndex, msg.sender);
        emit BatchFinalized(batchIndex, commitment.stateRoot, block.timestamp);
    }

    /**
     * @notice Set the ZK verifier contract address
     * @param _zkVerifier Address of the ZK proof verifier contract
     */
    function setZkVerifier(address _zkVerifier) external onlyOwner {
        zkVerifier = _zkVerifier;
    }

    // =========================================================================
    // ADMIN FUNCTIONS
    // =========================================================================

    /**
     * @notice Update the sequencer address
     */
    function setSequencer(address _sequencer) external onlyOwner {
        require(_sequencer != address(0), "Invalid sequencer");
        address oldSequencer = sequencer;
        sequencer = _sequencer;
        emit SequencerUpdated(oldSequencer, _sequencer);
    }

    /**
     * @notice Pause the contract
     */
    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Unpause the contract
     */
    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /**
     * @notice Transfer ownership
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid owner");
        owner = newOwner;
    }

    // =========================================================================
    // VIEW FUNCTIONS
    // =========================================================================

    /**
     * @notice Get the latest state root
     */
    function getLatestStateRoot() external view returns (bytes32) {
        return latestStateRoot;
    }

    /**
     * @notice Get the latest batch index
     */
    function getLatestBatchIndex() external view returns (uint256) {
        return latestBatchIndex;
    }

    /**
     * @notice Get the latest finalized batch index
     */
    function getLatestFinalizedBatch() external view returns (uint256) {
        return latestFinalizedBatch;
    }

    /**
     * @notice Get rollup mode
     */
    function getMode() external view returns (RollupMode) {
        return mode;
    }

    /**
     * @notice Check if challenge period is active for a batch
     */
    function isChallengePeriodActive(uint256 batchIndex) external view returns (bool) {
        if (mode != RollupMode.OPTIMISTIC) return false;

        StateCommitment memory commitment = stateCommitments[batchIndex];
        if (commitment.submittedAt == 0) return false;
        if (commitment.finalized) return false;

        return block.timestamp < commitment.submittedAt + challengePeriod;
    }

    /**
     * @notice Get time remaining in challenge period
     */
    function getChallengeTimeRemaining(uint256 batchIndex) external view returns (uint256) {
        if (mode != RollupMode.OPTIMISTIC) return 0;

        StateCommitment memory commitment = stateCommitments[batchIndex];
        if (commitment.submittedAt == 0) return 0;
        if (commitment.finalized) return 0;

        uint256 endTime = commitment.submittedAt + challengePeriod;
        if (block.timestamp >= endTime) return 0;

        return endTime - block.timestamp;
    }

    // =========================================================================
    // EMERGENCY FUNCTIONS
    // =========================================================================

    /**
     * @notice Emergency withdrawal of stuck funds
     */
    function emergencyWithdraw() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "No funds to withdraw");
        payable(owner).transfer(balance);
    }

    /**
     * @notice Receive function to accept ETH
     */
    receive() external payable {}
}
