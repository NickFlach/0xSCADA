// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "hardhat/console.sol";
import "../../SiteRegistry.sol";

/**
 * @title SiteRegistryFuzzTest
 * @notice Fuzz tests for SiteRegistry contract - authorization and access control
 * @dev Issue #55: Security Fuzz Testing for Protocol Handlers
 */
contract SiteRegistryFuzzTest {
    SiteRegistry public siteRegistry;
    
    event TestPassed(string testName);
    event TestFailed(string testName, string reason);
    
    constructor() {
        siteRegistry = new SiteRegistry();
    }
    
    // =========================================================================
    // SITE REGISTRATION FUZZ TESTS
    // =========================================================================
    
    /**
     * @notice Fuzz test: Site registration with random site IDs
     * @param siteIdSeed Seed for generating site ID
     */
    function fuzz_siteRegistration(uint256 siteIdSeed) external {
        bytes32 siteId = keccak256(abi.encodePacked(siteIdSeed, block.timestamp, msg.sender));
        
        // Skip zero siteId
        if (siteId == bytes32(0)) return;
        
        // Should not be registered yet
        (, bool activeBefore,) = siteRegistry.getSite(siteId);
        require(!activeBefore, "Site should not exist before registration");
        
        // Register site
        siteRegistry.registerSite(siteId);
        
        // Verify registration
        (address owner, bool active, uint256 registeredAt) = siteRegistry.getSite(siteId);
        require(owner == address(this), "Owner should be msg.sender");
        require(active, "Site should be active after registration");
        require(registeredAt > 0, "Registration timestamp should be set");
        
        // Owner should be auto-authorized as signer
        require(siteRegistry.isSignerAuthorized(siteId, address(this)), "Owner should be authorized signer");
        
        emit TestPassed("fuzz_siteRegistration");
    }
    
    /**
     * @notice Fuzz test: Cannot register same site twice
     * @param siteIdSeed Seed for generating site ID
     */
    function fuzz_cannotRegisterTwice(uint256 siteIdSeed) external {
        bytes32 siteId = keccak256(abi.encodePacked(siteIdSeed, "unique", msg.sender));
        
        if (siteId == bytes32(0)) return;
        
        // First registration should succeed
        siteRegistry.registerSite(siteId);
        
        // Second registration should fail
        bool secondFailed = false;
        try siteRegistry.registerSite(siteId) {
            // Should not reach here
        } catch {
            secondFailed = true;
        }
        
        require(secondFailed, "Second registration should fail");
        
        emit TestPassed("fuzz_cannotRegisterTwice");
    }
    
    // =========================================================================
    // GATEWAY AUTHORIZATION FUZZ TESTS
    // =========================================================================
    
    /**
     * @notice Fuzz test: Gateway authorization with random addresses
     * @param siteIdSeed Seed for site ID
     * @param gatewayAddr Random gateway address
     */
    function fuzz_gatewayAuthorization(uint256 siteIdSeed, address gatewayAddr) external {
        if (gatewayAddr == address(0)) return;
        
        bytes32 siteId = keccak256(abi.encodePacked(siteIdSeed, "gateway-test"));
        if (siteId == bytes32(0)) return;
        
        // Register site first
        siteRegistry.registerSite(siteId);
        
        // Should not be authorized initially
        require(!siteRegistry.isGatewayAuthorized(siteId, gatewayAddr), "Gateway should not be authorized initially");
        
        // Authorize gateway
        siteRegistry.authorizeGateway(siteId, gatewayAddr);
        
        // Should be authorized now
        require(siteRegistry.isGatewayAuthorized(siteId, gatewayAddr), "Gateway should be authorized after authorization");
        
        emit TestPassed("fuzz_gatewayAuthorization");
    }
    
    /**
     * @notice Fuzz test: Gateway revocation
     * @param siteIdSeed Seed for site ID
     * @param gatewayAddr Random gateway address
     */
    function fuzz_gatewayRevocation(uint256 siteIdSeed, address gatewayAddr) external {
        if (gatewayAddr == address(0)) return;
        
        bytes32 siteId = keccak256(abi.encodePacked(siteIdSeed, "revoke-test"));
        if (siteId == bytes32(0)) return;
        
        // Setup
        siteRegistry.registerSite(siteId);
        siteRegistry.authorizeGateway(siteId, gatewayAddr);
        
        require(siteRegistry.isGatewayAuthorized(siteId, gatewayAddr), "Gateway should be authorized");
        
        // Revoke
        siteRegistry.revokeGateway(siteId, gatewayAddr);
        
        // Should no longer be authorized
        require(!siteRegistry.isGatewayAuthorized(siteId, gatewayAddr), "Gateway should not be authorized after revocation");
        
        emit TestPassed("fuzz_gatewayRevocation");
    }
    
    /**
     * @notice Fuzz test: Cannot authorize gateway twice
     * @param siteIdSeed Seed for site ID
     * @param gatewayAddr Gateway address
     */
    function fuzz_cannotAuthorizeTwice(uint256 siteIdSeed, address gatewayAddr) external {
        if (gatewayAddr == address(0)) return;
        
        bytes32 siteId = keccak256(abi.encodePacked(siteIdSeed, "double-auth"));
        if (siteId == bytes32(0)) return;
        
        siteRegistry.registerSite(siteId);
        siteRegistry.authorizeGateway(siteId, gatewayAddr);
        
        // Second authorization should fail
        bool secondFailed = false;
        try siteRegistry.authorizeGateway(siteId, gatewayAddr) {
            // Should not reach here
        } catch {
            secondFailed = true;
        }
        
        require(secondFailed, "Second authorization should fail");
        
        emit TestPassed("fuzz_cannotAuthorizeTwice");
    }
    
    // =========================================================================
    // SIGNER AUTHORIZATION FUZZ TESTS
    // =========================================================================
    
    /**
     * @notice Fuzz test: Signer authorization with random addresses
     * @param siteIdSeed Seed for site ID
     * @param signerAddr Random signer address
     */
    function fuzz_signerAuthorization(uint256 siteIdSeed, address signerAddr) external {
        if (signerAddr == address(0)) return;
        if (signerAddr == address(this)) return; // Owner is auto-authorized
        
        bytes32 siteId = keccak256(abi.encodePacked(siteIdSeed, "signer-test"));
        if (siteId == bytes32(0)) return;
        
        siteRegistry.registerSite(siteId);
        
        // Should not be authorized initially (unless it's the owner)
        if (signerAddr != address(this)) {
            require(!siteRegistry.isSignerAuthorized(siteId, signerAddr), "Non-owner signer should not be authorized initially");
        }
        
        // Authorize signer
        siteRegistry.authorizeSigner(siteId, signerAddr);
        
        // Should be authorized now
        require(siteRegistry.isSignerAuthorized(siteId, signerAddr), "Signer should be authorized");
        
        emit TestPassed("fuzz_signerAuthorization");
    }
    
    /**
     * @notice Fuzz test: Cannot revoke owner as signer
     * @param siteIdSeed Seed for site ID
     */
    function fuzz_cannotRevokeOwner(uint256 siteIdSeed) external {
        bytes32 siteId = keccak256(abi.encodePacked(siteIdSeed, "owner-revoke"));
        if (siteId == bytes32(0)) return;
        
        siteRegistry.registerSite(siteId);
        
        // Try to revoke owner (should fail)
        bool revokeFailed = false;
        try siteRegistry.revokeSigner(siteId, address(this)) {
            // Should not reach here
        } catch {
            revokeFailed = true;
        }
        
        require(revokeFailed, "Should not be able to revoke owner");
        require(siteRegistry.isSignerAuthorized(siteId, address(this)), "Owner should still be authorized");
        
        emit TestPassed("fuzz_cannotRevokeOwner");
    }
    
    // =========================================================================
    // OWNERSHIP TRANSFER FUZZ TESTS
    // =========================================================================
    
    /**
     * @notice Fuzz test: Ownership transfer
     * @param siteIdSeed Seed for site ID
     * @param newOwner New owner address
     */
    function fuzz_ownershipTransfer(uint256 siteIdSeed, address newOwner) external {
        if (newOwner == address(0)) return;
        
        bytes32 siteId = keccak256(abi.encodePacked(siteIdSeed, "transfer-test"));
        if (siteId == bytes32(0)) return;
        
        siteRegistry.registerSite(siteId);
        
        // Transfer ownership
        siteRegistry.transferOwnership(siteId, newOwner);
        
        // Verify transfer
        (address owner,,) = siteRegistry.getSite(siteId);
        require(owner == newOwner, "Ownership should be transferred");
        
        // New owner should be authorized as signer
        require(siteRegistry.isSignerAuthorized(siteId, newOwner), "New owner should be authorized signer");
        
        emit TestPassed("fuzz_ownershipTransfer");
    }
    
    /**
     * @notice Fuzz test: Cannot transfer to zero address
     * @param siteIdSeed Seed for site ID
     */
    function fuzz_cannotTransferToZero(uint256 siteIdSeed) external {
        bytes32 siteId = keccak256(abi.encodePacked(siteIdSeed, "zero-transfer"));
        if (siteId == bytes32(0)) return;
        
        siteRegistry.registerSite(siteId);
        
        // Try to transfer to zero address
        bool transferFailed = false;
        try siteRegistry.transferOwnership(siteId, address(0)) {
            // Should not reach here
        } catch {
            transferFailed = true;
        }
        
        require(transferFailed, "Transfer to zero should fail");
        
        emit TestPassed("fuzz_cannotTransferToZero");
    }
    
    // =========================================================================
    // SITE DEACTIVATION FUZZ TESTS
    // =========================================================================
    
    /**
     * @notice Fuzz test: Site deactivation
     * @param siteIdSeed Seed for site ID
     */
    function fuzz_siteDeactivation(uint256 siteIdSeed) external {
        bytes32 siteId = keccak256(abi.encodePacked(siteIdSeed, "deactivate-test"));
        if (siteId == bytes32(0)) return;
        
        siteRegistry.registerSite(siteId);
        
        (, bool activeBefore,) = siteRegistry.getSite(siteId);
        require(activeBefore, "Site should be active");
        
        // Deactivate
        siteRegistry.deactivateSite(siteId);
        
        (, bool activeAfter,) = siteRegistry.getSite(siteId);
        require(!activeAfter, "Site should be inactive after deactivation");
        
        emit TestPassed("fuzz_siteDeactivation");
    }
    
    /**
     * @notice Fuzz test: Cannot operate on deactivated site
     * @param siteIdSeed Seed for site ID
     * @param gatewayAddr Gateway address to try authorizing
     */
    function fuzz_cannotOperateOnDeactivatedSite(uint256 siteIdSeed, address gatewayAddr) external {
        if (gatewayAddr == address(0)) return;
        
        bytes32 siteId = keccak256(abi.encodePacked(siteIdSeed, "deactivated-ops"));
        if (siteId == bytes32(0)) return;
        
        siteRegistry.registerSite(siteId);
        siteRegistry.deactivateSite(siteId);
        
        // Try to authorize gateway on deactivated site
        bool opFailed = false;
        try siteRegistry.authorizeGateway(siteId, gatewayAddr) {
            // Should not reach here
        } catch {
            opFailed = true;
        }
        
        require(opFailed, "Operations on deactivated site should fail");
        
        emit TestPassed("fuzz_cannotOperateOnDeactivatedSite");
    }
    
    // =========================================================================
    // BOUNDARY CONDITION TESTS
    // =========================================================================
    
    /**
     * @notice Fuzz test: Site count consistency
     * @param numSites Number of sites to register (capped)
     */
    function fuzz_siteCountConsistency(uint8 numSites) external {
        uint256 initialCount = siteRegistry.getSiteCount();
        uint256 toRegister = uint256(numSites) % 10 + 1; // Cap at 10
        
        for (uint256 i = 0; i < toRegister; i++) {
            bytes32 siteId = keccak256(abi.encodePacked("count-test", i, block.timestamp));
            siteRegistry.registerSite(siteId);
        }
        
        uint256 finalCount = siteRegistry.getSiteCount();
        require(finalCount == initialCount + toRegister, "Site count should increase correctly");
        
        emit TestPassed("fuzz_siteCountConsistency");
    }
    
    /**
     * @notice Fuzz test: Zero site ID should be rejected
     */
    function fuzz_zeroSiteIdRejected() external {
        bytes32 zeroId = bytes32(0);
        
        bool registerFailed = false;
        try siteRegistry.registerSite(zeroId) {
            // Should not reach here
        } catch {
            registerFailed = true;
        }
        
        require(registerFailed, "Zero site ID registration should fail");
        
        emit TestPassed("fuzz_zeroSiteIdRejected");
    }
    
    // =========================================================================
    // HELPER FUNCTIONS
    // =========================================================================
    
    /**
     * @notice Run all fuzz tests with default parameters for basic validation
     */
    function runBasicValidation() external {
        console.log("Running SiteRegistry fuzz test validation...");
        
        fuzz_siteRegistration(12345);
        fuzz_cannotRegisterTwice(67890);
        fuzz_gatewayAuthorization(11111, address(0x1111));
        fuzz_gatewayRevocation(22222, address(0x2222));
        fuzz_cannotAuthorizeTwice(33333, address(0x3333));
        fuzz_signerAuthorization(44444, address(0x4444));
        fuzz_cannotRevokeOwner(55555);
        fuzz_ownershipTransfer(66666, address(0x6666));
        fuzz_cannotTransferToZero(77777);
        fuzz_siteDeactivation(88888);
        fuzz_cannotOperateOnDeactivatedSite(99999, address(0x9999));
        fuzz_siteCountConsistency(5);
        fuzz_zeroSiteIdRejected();
        
        console.log("All SiteRegistry validation tests passed!");
    }
}
