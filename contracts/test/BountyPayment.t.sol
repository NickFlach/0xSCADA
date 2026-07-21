// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../BountyPayment.sol";

/// @notice Recipient that accepts payment and does nothing else.
contract PlainReceiver {
    receive() external payable {}
}

/// @notice Recipient that rejects all payments.
contract RejectingReceiver {
    receive() external payable {
        revert("no thanks");
    }
}

/// @notice Recipient that records the bounty state it observes mid-payment and
///         optionally attempts to re-enter payBountyMultiple from receive().
///         Models a compromised recipient — including one holding PAYOUT_ROLE.
contract ReentrantRecipient {
    BountyPayment public immutable target;

    BountyPayment.BountyStatus public observedStatus;
    uint256 public observedTotalPaidOut;
    uint256 public observedRecordedRecipients;
    uint256 public timesPaid;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    uint256 private observeIssue;
    uint256 private reentryIssue;
    address payable[] private reentryRecipients;
    uint256[] private reentryAmounts;

    constructor(BountyPayment _target) {
        target = _target;
    }

    function setObserveIssue(uint256 issue) external {
        observeIssue = issue;
    }

    function setReentryPayload(
        uint256 issue,
        address payable[] memory recipients,
        uint256[] memory amounts
    ) external {
        reentryIssue = issue;
        reentryRecipients = recipients;
        reentryAmounts = amounts;
    }

    receive() external payable {
        timesPaid++;
        observedStatus = target.getBounty(observeIssue).status;
        observedTotalPaidOut = target.totalPaidOut();
        observedRecordedRecipients = target.getPayment(observeIssue).recipients.length;

        if (reentryRecipients.length > 0 && !reentryAttempted) {
            reentryAttempted = true;
            try target.payBountyMultiple(reentryIssue, 999, reentryRecipients, reentryAmounts) {
                reentrySucceeded = true;
            } catch {
                reentrySucceeded = false;
            }
        }
    }
}

/// @title BountyPayment re-entrancy and checks-effects-interactions tests (issue #449)
/// @dev Dependency-free forge tests: the test contract deploys BountyPayment,
///      so it holds DEFAULT_ADMIN_ROLE, MAINTAINER_ROLE and PAYOUT_ROLE itself.
contract BountyPaymentTest {
    BountyPayment internal bounty;

    uint256 internal constant ISSUE_A = 42;
    uint256 internal constant ISSUE_B = 43;
    uint256 internal constant PR = 100;

    function setUp() public {
        bounty = new BountyPayment();
        (bool funded, ) = address(bounty).call{value: 100 ether}("");
        require(funded, "setup: funding escrow failed");
    }

    function _openAndClaim(uint256 issue, uint256 amount, address claimant) internal {
        bounty.registerBounty(issue, amount, address(0), "ipfs://meta", true);
        bounty.claimBounty(issue, claimant);
    }

    function _single(address payable who, uint256 amount)
        internal
        pure
        returns (address payable[] memory recipients, uint256[] memory amounts)
    {
        recipients = new address payable[](1);
        recipients[0] = who;
        amounts = new uint256[](1);
        amounts[0] = amount;
    }

    // ── invariant: every recipient paid exactly once, state fully recorded ──

    function test_payBountyMultiple_paysAllRecipientsExactlyOnce() public {
        PlainReceiver r1 = new PlainReceiver();
        PlainReceiver r2 = new PlainReceiver();
        PlainReceiver r3 = new PlainReceiver();
        _openAndClaim(ISSUE_A, 6 ether, address(r1));

        address payable[] memory recipients = new address payable[](3);
        recipients[0] = payable(address(r1));
        recipients[1] = payable(address(r2));
        recipients[2] = payable(address(r3));
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 1 ether;
        amounts[1] = 2 ether;
        amounts[2] = 3 ether;

        bounty.payBountyMultiple(ISSUE_A, PR, recipients, amounts);

        require(address(r1).balance == 1 ether, "r1 amount wrong");
        require(address(r2).balance == 2 ether, "r2 amount wrong");
        require(address(r3).balance == 3 ether, "r3 amount wrong");
        require(
            bounty.getBounty(ISSUE_A).status == BountyPayment.BountyStatus.Paid,
            "status not Paid"
        );
        require(bounty.totalPaidOut() == 6 ether, "totalPaidOut wrong");

        BountyPayment.Payment memory p = bounty.getPayment(ISSUE_A);
        require(p.recipients.length == recipients.length, "payment record incomplete");
        require(p.amounts.length == amounts.length, "amounts record incomplete");
    }

    // ── re-entrancy: blocked even for a recipient holding PAYOUT_ROLE ──

    function test_payBountyMultiple_reentryBlockedEvenWithPayoutRole() public {
        ReentrantRecipient attacker = new ReentrantRecipient(bounty);
        PlainReceiver bystander = new PlainReceiver();

        _openAndClaim(ISSUE_A, 2 ether, address(attacker));
        _openAndClaim(ISSUE_B, 5 ether, address(attacker));
        bounty.grantRole(bounty.PAYOUT_ROLE(), address(attacker));

        // Mid-payment of bounty A, the attacker tries to pay out bounty B
        // (still Claimed) to itself. Only nonReentrant stands in the way.
        attacker.setObserveIssue(ISSUE_A);
        (address payable[] memory rr, uint256[] memory ra) =
            _single(payable(address(attacker)), 5 ether);
        attacker.setReentryPayload(ISSUE_B, rr, ra);

        address payable[] memory recipients = new address payable[](2);
        recipients[0] = payable(address(attacker));
        recipients[1] = payable(address(bystander));
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1 ether;
        amounts[1] = 1 ether;

        bounty.payBountyMultiple(ISSUE_A, PR, recipients, amounts);

        require(attacker.reentryAttempted(), "attacker never attempted re-entry");
        require(!attacker.reentrySucceeded(), "re-entrant payout must revert");
        require(
            bounty.getBounty(ISSUE_B).status == BountyPayment.BountyStatus.Claimed,
            "bounty B must be untouched"
        );
        require(bounty.totalPaidOut() == 2 ether, "only bounty A may be paid");
        require(address(attacker).balance == 1 ether, "attacker paid exactly once");
        require(address(bystander).balance == 1 ether, "bystander still paid");
    }

    // ── checks-effects-interactions: state is final before any external call ──

    function test_payBountyMultiple_effectsCompleteBeforeInteractions() public {
        ReentrantRecipient observer = new ReentrantRecipient(bounty);
        _openAndClaim(ISSUE_A, 2 ether, address(observer));
        observer.setObserveIssue(ISSUE_A);

        (address payable[] memory recipients, uint256[] memory amounts) =
            _single(payable(address(observer)), 2 ether);
        bounty.payBountyMultiple(ISSUE_A, PR, recipients, amounts);

        require(
            observer.observedStatus() == BountyPayment.BountyStatus.Paid,
            "status must be Paid before external calls"
        );
        require(
            observer.observedTotalPaidOut() == 2 ether,
            "totalPaidOut must be updated before external calls"
        );
        require(
            observer.observedRecordedRecipients() == 1,
            "payment record must exist before external calls"
        );
    }

    function test_payBounty_effectsCompleteBeforeInteractions() public {
        ReentrantRecipient observer = new ReentrantRecipient(bounty);
        _openAndClaim(ISSUE_A, 2 ether, address(observer));
        observer.setObserveIssue(ISSUE_A);

        bounty.payBounty(ISSUE_A, PR, payable(address(observer)));

        require(
            observer.observedStatus() == BountyPayment.BountyStatus.Paid,
            "status must be Paid before the transfer"
        );
        require(
            observer.observedTotalPaidOut() == 2 ether,
            "totalPaidOut must be updated before the transfer"
        );
    }

    // ── failure atomicity: one rejecting recipient reverts the whole payout ──

    function test_payBountyMultiple_rejectingRecipientRevertsWholePayment() public {
        PlainReceiver r1 = new PlainReceiver();
        RejectingReceiver r2 = new RejectingReceiver();
        _openAndClaim(ISSUE_A, 2 ether, address(r1));

        address payable[] memory recipients = new address payable[](2);
        recipients[0] = payable(address(r1));
        recipients[1] = payable(address(r2));
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1 ether;
        amounts[1] = 1 ether;

        try bounty.payBountyMultiple(ISSUE_A, PR, recipients, amounts) {
            revert("payout should have reverted");
        } catch {}

        require(
            bounty.getBounty(ISSUE_A).status == BountyPayment.BountyStatus.Claimed,
            "status must roll back to Claimed"
        );
        require(bounty.totalPaidOut() == 0, "totalPaidOut must roll back");
        require(address(r1).balance == 0, "partial payment must roll back");
    }

    // ── input guards ──

    function test_payBountyMultiple_totalMismatchReverts() public {
        PlainReceiver r1 = new PlainReceiver();
        _openAndClaim(ISSUE_A, 2 ether, address(r1));

        (address payable[] memory recipients, uint256[] memory amounts) =
            _single(payable(address(r1)), 1 ether);

        try bounty.payBountyMultiple(ISSUE_A, PR, recipients, amounts) {
            revert("mismatched total should revert");
        } catch {}
        require(
            bounty.getBounty(ISSUE_A).status == BountyPayment.BountyStatus.Claimed,
            "status must stay Claimed"
        );
    }
}
