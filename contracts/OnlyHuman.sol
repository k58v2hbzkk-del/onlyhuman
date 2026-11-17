// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title OnlyHuman — giveaways that only pay real people
/// @notice Creators lock a prize budget (QUSDC, any ERC-20, or native QIE).
///         Each claim needs a short-lived signed pass from the OnlyHuman checker
///         proving the claimer cleared the drop's gate:
///           Open     -> wallet passed on-chain bot checks
///           QieId    -> wallet owns a QIE ID name (one claim per name)
///           Verified -> wallet is QIE Pass KYC-verified (one claim per person)
///         One claim per wallet AND per "human key" (name / person / wallet cluster),
///         so farmers can't drain a drop with many wallets.
contract OnlyHuman is EIP712, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    enum Gate { Open, QieId, Verified }

    struct Drop {
        address creator;
        address token;          // address(0) = native QIE
        uint128 amountPerClaim; // base payout
        uint128 balance;        // what's left to pay out
        uint32 maxClaims;
        uint32 claimed;
        uint16 verifiedBonusBps; // extra share for QIE Pass-verified claimers
        Gate gate;
        uint64 endsAt;
        bool closed;
    }

    bytes32 public constant CLAIM_TYPEHASH = keccak256(
        "Claim(uint256 dropId,address claimer,bytes32 humanKey,uint8 level,uint64 deadline)"
    );

    uint16 public constant MAX_FEE_BPS = 300;    // never more than 3%
    uint16 public constant MAX_BONUS_BPS = 10000; // verified bonus up to +100%

    address public checker;   // signs claim passes
    address public treasury;  // receives the platform fee
    uint16 public feeBps = 100; // 1%

    uint256 public dropCount;
    mapping(uint256 => Drop) public drops;
    mapping(uint256 => mapping(address => bool)) public walletClaimed;
    mapping(uint256 => mapping(bytes32 => bool)) public humanClaimed;

    event DropCreated(
        uint256 indexed dropId, address indexed creator, address token,
        uint256 budget, uint256 fee, uint256 amountPerClaim, uint32 maxClaims,
        Gate gate, uint16 verifiedBonusBps, uint64 endsAt
    );
    event Claimed(uint256 indexed dropId, address indexed claimer, bytes32 indexed humanKey, uint8 level, uint256 amount);
    event DropClosed(uint256 indexed dropId, uint256 refunded);
    event CheckerUpdated(address checker);
    event TreasuryUpdated(address treasury);
    event FeeUpdated(uint16 feeBps);

    error BadParams();
    error WrongValue();
    error DropNotActive();
    error AlreadyClaimed();
    error GateNotMet();
    error PassExpired();
    error BadPass();
    error SoldOut();
    error NotCreator();
    error TooEarly();
    error TransferFailed();

    constructor(address checker_, address treasury_)
        EIP712("OnlyHuman", "1")
        Ownable(msg.sender)
    {
        if (checker_ == address(0) || treasury_ == address(0)) revert BadParams();
        checker = checker_;
        treasury = treasury_;
    }

    // ------------------------------------------------------------------ create

    /// @param budget total prize money the creator puts in (fee is taken on top)
    function createDrop(
        address token,
        uint128 budget,
        uint128 amountPerClaim,
        uint32 maxClaims,
        Gate gate,
        uint16 verifiedBonusBps,
        uint64 endsAt
    ) external payable nonReentrant returns (uint256 dropId) {
        if (amountPerClaim == 0 || maxClaims == 0 || budget < amountPerClaim) revert BadParams();
        if (verifiedBonusBps > MAX_BONUS_BPS || endsAt <= block.timestamp) revert BadParams();

        uint256 fee = (uint256(budget) * feeBps) / 10_000;

        if (token == address(0)) {
            if (msg.value != uint256(budget) + fee) revert WrongValue();
            if (fee > 0) _sendNative(treasury, fee);
        } else {
            if (msg.value != 0) revert WrongValue();
            IERC20(token).safeTransferFrom(msg.sender, address(this), budget);
            if (fee > 0) IERC20(token).safeTransferFrom(msg.sender, treasury, fee);
        }

        dropId = ++dropCount;
        drops[dropId] = Drop({
            creator: msg.sender,
            token: token,
            amountPerClaim: amountPerClaim,
            balance: budget,
            maxClaims: maxClaims,
            claimed: 0,
            verifiedBonusBps: verifiedBonusBps,
            gate: gate,
            endsAt: endsAt,
            closed: false
        });

        emit DropCreated(dropId, msg.sender, token, budget, fee, amountPerClaim, maxClaims, gate, verifiedBonusBps, endsAt);
    }

    // ------------------------------------------------------------------- claim

    /// @param humanKey  hash identifying the human behind the wallet
    ///                  (QIE ID name / QIE Pass identity / wallet cluster)
    /// @param level     0 = passed bot checks, 1 = owns QIE ID, 2 = QIE Pass verified
    function claim(
        uint256 dropId,
        bytes32 humanKey,
        uint8 level,
        uint64 deadline,
        bytes calldata pass
    ) external nonReentrant returns (uint256 amount) {
        return _claim(dropId, msg.sender, humanKey, level, deadline, pass);
    }

    /// @notice Gasless claim: anyone (e.g. the OnlyHuman relayer) can submit a
    ///         claimer's pass and pay the gas. Money only ever goes to `claimer`,
    ///         the wallet the pass was signed for, so relaying can't redirect funds.
    function claimFor(
        uint256 dropId,
        address claimer,
        bytes32 humanKey,
        uint8 level,
        uint64 deadline,
        bytes calldata pass
    ) external nonReentrant returns (uint256 amount) {
        return _claim(dropId, claimer, humanKey, level, deadline, pass);
    }

    function _claim(
        uint256 dropId,
        address claimer,
        bytes32 humanKey,
        uint8 level,
        uint64 deadline,
        bytes calldata pass
    ) internal returns (uint256 amount) {
        Drop storage d = drops[dropId];
        if (d.creator == address(0) || d.closed || block.timestamp > d.endsAt) revert DropNotActive();
        if (d.claimed >= d.maxClaims) revert SoldOut();
        if (walletClaimed[dropId][claimer] || humanClaimed[dropId][humanKey]) revert AlreadyClaimed();
        if (level > uint8(Gate.Verified) || level < uint8(d.gate)) revert GateNotMet();
        if (block.timestamp > deadline) revert PassExpired();

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(CLAIM_TYPEHASH, dropId, claimer, humanKey, level, deadline))
        );
        if (ECDSA.recover(digest, pass) != checker) revert BadPass();

        amount = d.amountPerClaim;
        if (level == uint8(Gate.Verified) && d.verifiedBonusBps > 0) {
            amount += (amount * d.verifiedBonusBps) / 10_000;
        }
        if (amount > d.balance) amount = d.balance; // last claimer gets what's left
        if (amount == 0) revert SoldOut();

        walletClaimed[dropId][claimer] = true;
        humanClaimed[dropId][humanKey] = true;
        d.claimed += 1;
        d.balance -= uint128(amount);

        _payout(d.token, claimer, amount);
        emit Claimed(dropId, claimer, humanKey, level, amount);
    }

    // ------------------------------------------------------------------- close

    /// @notice Creator takes back unclaimed money once the drop ended or sold out.
    function closeDrop(uint256 dropId) external nonReentrant {
        Drop storage d = drops[dropId];
        if (msg.sender != d.creator) revert NotCreator();
        if (d.closed) revert DropNotActive();
        bool finished = block.timestamp > d.endsAt || d.claimed >= d.maxClaims || d.claimed == 0;
        if (!finished) revert TooEarly();

        d.closed = true;
        uint256 refund = d.balance;
        d.balance = 0;
        if (refund > 0) _payout(d.token, d.creator, refund);
        emit DropClosed(dropId, refund);
    }

    // ------------------------------------------------------------------- views

    function getDrop(uint256 dropId) external view returns (Drop memory) {
        return drops[dropId];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ------------------------------------------------------------------- admin

    function setChecker(address c) external onlyOwner {
        if (c == address(0)) revert BadParams();
        checker = c;
        emit CheckerUpdated(c);
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert BadParams();
        treasury = t;
        emit TreasuryUpdated(t);
    }

    function setFee(uint16 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert BadParams();
        feeBps = bps;
        emit FeeUpdated(bps);
    }

    // ---------------------------------------------------------------- internal

    function _payout(address token, address to, uint256 amount) internal {
        if (token == address(0)) _sendNative(to, amount);
        else IERC20(token).safeTransfer(to, amount);
    }

    function _sendNative(address to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
