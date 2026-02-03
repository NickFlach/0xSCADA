"use strict";
/**
 * 0xSCADA ZK Artifact Service
 *
 * VERITY Architecture - Phase α.2.2: Ethereum Fork ZK Proof Storage
 *
 * This service provides:
 * - Storage of ZK-related artifacts (witnesses, proofs, oracle snapshots, traces)
 * - Proof verification against stored witnesses
 * - On-chain hash anchoring interface
 * - Batch anchoring via Merkle trees
 *
 * "What was proven (cryptographic truth)"
 */
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
exports.zkArtifactService = exports.ZKArtifactService = void 0;
exports.initZKArtifactService = initZKArtifactService;
var crypto_1 = require("crypto");
var events_1 = require("events");
var ethers_1 = require("ethers");
var zk_artifact_1 = require("@shared/zk-artifact");
var artifact_storage_1 = require("./artifact-storage");
var blockchain_1 = require("../blockchain");
// =============================================================================
// MERKLE TREE FOR BATCHING
// =============================================================================
var ZKMerkleTree = /** @class */ (function () {
    function ZKMerkleTree(hashes) {
        var _this = this;
        this.leaves = hashes.map(function (h) { return _this.normalizeHash(h); });
        this.layers = [this.leaves];
        this.root = this.buildTree();
    }
    ZKMerkleTree.prototype.normalizeHash = function (hash) {
        // Ensure consistent format (with 0x prefix)
        return hash.startsWith("0x") ? hash : "0x".concat(hash);
    };
    ZKMerkleTree.prototype.hashPair = function (a, b) {
        var aBytes = (0, ethers_1.getBytes)(a);
        var bBytes = (0, ethers_1.getBytes)(b);
        // Sort for determinism
        if (a.toLowerCase() < b.toLowerCase()) {
            return (0, ethers_1.keccak256)((0, ethers_1.concat)([aBytes, bBytes]));
        }
        return (0, ethers_1.keccak256)((0, ethers_1.concat)([bBytes, aBytes]));
    };
    ZKMerkleTree.prototype.buildTree = function () {
        if (this.leaves.length === 0) {
            return (0, ethers_1.keccak256)((0, ethers_1.toUtf8Bytes)(""));
        }
        var currentLayer = __spreadArray([], this.leaves, true);
        while (currentLayer.length > 1) {
            var nextLayer = [];
            for (var i = 0; i < currentLayer.length; i += 2) {
                var left = currentLayer[i];
                var right = currentLayer[i + 1] || left;
                nextLayer.push(this.hashPair(left, right));
            }
            this.layers.push(nextLayer);
            currentLayer = nextLayer;
        }
        return currentLayer[0];
    };
    ZKMerkleTree.prototype.getRoot = function () {
        return this.root;
    };
    ZKMerkleTree.prototype.getProof = function (index) {
        if (index < 0 || index >= this.leaves.length) {
            return [];
        }
        var proof = [];
        var currentIndex = index;
        for (var i = 0; i < this.layers.length - 1; i++) {
            var layer = this.layers[i];
            var isRight = currentIndex % 2 === 1;
            var siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
            if (siblingIndex < layer.length) {
                proof.push(layer[siblingIndex]);
            }
            currentIndex = Math.floor(currentIndex / 2);
        }
        return proof;
    };
    ZKMerkleTree.verify = function (leafHash, proof, root) {
        var computedHash = leafHash.startsWith("0x") ? leafHash : "0x".concat(leafHash);
        for (var _i = 0, proof_1 = proof; _i < proof_1.length; _i++) {
            var sibling = proof_1[_i];
            var siblingNorm = sibling.startsWith("0x") ? sibling : "0x".concat(sibling);
            var aBytes = (0, ethers_1.getBytes)(computedHash);
            var bBytes = (0, ethers_1.getBytes)(siblingNorm);
            if (computedHash.toLowerCase() < siblingNorm.toLowerCase()) {
                computedHash = (0, ethers_1.keccak256)((0, ethers_1.concat)([aBytes, bBytes]));
            }
            else {
                computedHash = (0, ethers_1.keccak256)((0, ethers_1.concat)([bBytes, aBytes]));
            }
        }
        return computedHash.toLowerCase() === root.toLowerCase();
    };
    return ZKMerkleTree;
}());
// =============================================================================
// DEFAULT ON-CHAIN ANCHOR IMPLEMENTATION
// =============================================================================
var DefaultAnchorInterface = /** @class */ (function () {
    function DefaultAnchorInterface() {
    }
    DefaultAnchorInterface.prototype.anchorArtifact = function (request) {
        return __awaiter(this, void 0, void 0, function () {
            var txHash, error_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!blockchain_1.blockchainService.isEnabled()) {
                            return [2 /*return*/, {
                                    success: false,
                                    error: "Blockchain service not enabled",
                                }];
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, blockchain_1.blockchainService.anchorBatchRoot("ZK-".concat(request.artifactType, "-").concat(Date.now()), "0x".concat(request.contentHash), 1)];
                    case 2:
                        txHash = _a.sent();
                        if (txHash) {
                            return [2 /*return*/, {
                                    success: true,
                                    txHash: txHash,
                                    anchoredAt: new Date(),
                                }];
                        }
                        return [2 /*return*/, {
                                success: false,
                                error: "Transaction failed",
                            }];
                    case 3:
                        error_1 = _a.sent();
                        return [2 /*return*/, {
                                success: false,
                                error: error_1 instanceof Error ? error_1.message : "Unknown error",
                            }];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    DefaultAnchorInterface.prototype.anchorBatch = function (merkleRoot, artifactHashes, artifactType) {
        return __awaiter(this, void 0, void 0, function () {
            var batchId, txHash, error_2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!blockchain_1.blockchainService.isEnabled()) {
                            return [2 /*return*/, {
                                    success: false,
                                    error: "Blockchain service not enabled",
                                }];
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        batchId = "ZK-BATCH-".concat(artifactType, "-").concat(Date.now());
                        return [4 /*yield*/, blockchain_1.blockchainService.anchorBatchRoot(batchId, merkleRoot, artifactHashes.length)];
                    case 2:
                        txHash = _a.sent();
                        if (txHash) {
                            return [2 /*return*/, {
                                    success: true,
                                    txHash: txHash,
                                    anchoredAt: new Date(),
                                }];
                        }
                        return [2 /*return*/, {
                                success: false,
                                error: "Batch anchor transaction failed",
                            }];
                    case 3:
                        error_2 = _a.sent();
                        return [2 /*return*/, {
                                success: false,
                                error: error_2 instanceof Error ? error_2.message : "Unknown error",
                            }];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    DefaultAnchorInterface.prototype.verifyAnchor = function (contentHash, merkleProof) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                // In a full implementation, this would query the on-chain contract
                // For now, return not anchored (contract verification coming separately)
                return [2 /*return*/, { anchored: false }];
            });
        });
    };
    DefaultAnchorInterface.prototype.isEnabled = function () {
        return blockchain_1.blockchainService.isEnabled();
    };
    return DefaultAnchorInterface;
}());
// =============================================================================
// ZK ARTIFACT SERVICE
// =============================================================================
var ZKArtifactService = /** @class */ (function (_super) {
    __extends(ZKArtifactService, _super);
    function ZKArtifactService(config, storage) {
        if (config === void 0) { config = {}; }
        var _a, _b, _c, _d, _e;
        var _this = _super.call(this) || this;
        /** Batch anchor timer */
        _this.anchorTimer = null;
        _this.config = {
            enableLocalVerification: (_a = config.enableLocalVerification) !== null && _a !== void 0 ? _a : true,
            enableAnchoring: (_b = config.enableAnchoring) !== null && _b !== void 0 ? _b : true,
            anchorBatchSize: (_c = config.anchorBatchSize) !== null && _c !== void 0 ? _c : 50,
            anchorBatchMaxAgeMs: (_d = config.anchorBatchMaxAgeMs) !== null && _d !== void 0 ? _d : 5 * 60 * 1000, // 5 minutes
            anchorInterface: config.anchorInterface,
        };
        _this.storage = storage !== null && storage !== void 0 ? storage : artifact_storage_1.artifactStorage;
        _this.anchorInterface = (_e = config.anchorInterface) !== null && _e !== void 0 ? _e : new DefaultAnchorInterface();
        _this.zkIndex = new Map();
        _this.pendingAnchor = new Map();
        _this.witnessProofMap = new Map();
        // Initialize pending anchor queues
        for (var _i = 0, _f = Object.values(zk_artifact_1.ZKArtifactType); _i < _f.length; _i++) {
            var type = _f[_i];
            _this.pendingAnchor.set(type, []);
        }
        // Start batch anchor timer if enabled
        if (_this.config.enableAnchoring) {
            _this.startAnchorTimer();
        }
        return _this;
    }
    // ===========================================================================
    // LIFECYCLE
    // ===========================================================================
    ZKArtifactService.prototype.startAnchorTimer = function () {
        var _this = this;
        if (this.anchorTimer) {
            clearInterval(this.anchorTimer);
        }
        this.anchorTimer = setInterval(function () {
            _this.flushPendingAnchors();
        }, this.config.anchorBatchMaxAgeMs);
    };
    ZKArtifactService.prototype.shutdown = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (this.anchorTimer) {
                            clearInterval(this.anchorTimer);
                            this.anchorTimer = null;
                        }
                        // Flush any remaining pending anchors
                        return [4 /*yield*/, this.flushPendingAnchors()];
                    case 1:
                        // Flush any remaining pending anchors
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    // ===========================================================================
    // HASH COMPUTATION
    // ===========================================================================
    ZKArtifactService.prototype.computeHash = function (content) {
        var buffer = typeof content === "string"
            ? Buffer.from(content, "utf-8")
            : Buffer.from(content);
        return (0, crypto_1.createHash)("sha256").update(buffer).digest("hex");
    };
    ZKArtifactService.prototype.generateId = function (prefix) {
        var timestamp = Date.now().toString(36);
        var random = Math.random().toString(36).substring(2, 8);
        return "".concat(prefix, "-").concat(timestamp, "-").concat(random);
    };
    // ===========================================================================
    // WITNESS STORAGE
    // ===========================================================================
    /**
     * Store a ZK witness
     */
    ZKArtifactService.prototype.storeWitness = function (input) {
        return __awaiter(this, void 0, void 0, function () {
            var validated, privateInputsBuffer, privateInputsHash, witness, artifactInput, artifact, zkMetadata, stored;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        validated = zk_artifact_1.createZKWitnessInputSchema.parse(input);
                        privateInputsBuffer = typeof validated.privateInputs === "string"
                            ? Buffer.from(validated.privateInputs, "utf-8")
                            : Buffer.from(validated.privateInputs);
                        privateInputsHash = this.computeHash(privateInputsBuffer);
                        witness = {
                            witnessId: this.generateId("WIT"),
                            circuitId: validated.circuitId,
                            publicInputs: validated.publicInputs,
                            privateInputsHash: privateInputsHash,
                            capturedAt: new Date().toISOString(),
                            blockNumber: validated.blockNumber,
                            blockHash: validated.blockHash,
                            metadata: validated.metadata,
                        };
                        artifactInput = {
                            origin: {
                                system: "ethereum",
                            },
                            scope: {
                                type: "proof", // Using base artifact type
                                metadata: {
                                    zkType: zk_artifact_1.ZKArtifactType.WITNESS,
                                    witness: witness,
                                },
                            },
                            content: privateInputsBuffer,
                            summary: "ZK Witness for circuit ".concat(validated.circuitId),
                        };
                        return [4 /*yield*/, this.storage.store(artifactInput)];
                    case 1:
                        artifact = _a.sent();
                        zkMetadata = {
                            type: "zk-witness",
                            witness: witness,
                        };
                        stored = {
                            artifact: artifact,
                            zkMetadata: zkMetadata,
                            anchored: false,
                        };
                        // Index
                        this.zkIndex.set(artifact.id, stored);
                        this.witnessProofMap.set(artifact.id, []);
                        // Queue for anchoring
                        this.queueForAnchor(zk_artifact_1.ZKArtifactType.WITNESS, artifact.id);
                        this.emit("witness:stored", stored);
                        console.log("[ZKArtifact] Stored witness ".concat(witness.witnessId, " (").concat(artifact.id.slice(0, 12), "...)"));
                        return [2 /*return*/, stored];
                }
            });
        });
    };
    // ===========================================================================
    // ORACLE SNAPSHOT STORAGE
    // ===========================================================================
    /**
     * Store an oracle snapshot
     */
    ZKArtifactService.prototype.storeOracleSnapshot = function (input) {
        return __awaiter(this, void 0, void 0, function () {
            var validated, rawResponseHash, rawResponseBuffer, snapshot, content, artifactInput, artifact, zkMetadata, stored;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        validated = zk_artifact_1.createOracleSnapshotInputSchema.parse(input);
                        if (validated.rawResponse) {
                            rawResponseBuffer = typeof validated.rawResponse === "string"
                                ? Buffer.from(validated.rawResponse, "utf-8")
                                : Buffer.from(validated.rawResponse);
                            rawResponseHash = this.computeHash(rawResponseBuffer);
                        }
                        snapshot = {
                            snapshotId: this.generateId("ORACLE"),
                            source: validated.source,
                            value: validated.value,
                            oracleTimestamp: validated.oracleTimestamp,
                            capturedAt: new Date().toISOString(),
                            blockNumber: validated.blockNumber,
                            roundId: validated.roundId,
                            rawResponseHash: rawResponseHash,
                            oracleSignature: validated.oracleSignature,
                        };
                        content = JSON.stringify({
                            snapshot: snapshot,
                            rawResponse: rawResponseBuffer ? rawResponseBuffer.toString("base64") : null,
                        });
                        artifactInput = {
                            origin: {
                                system: "ethereum",
                            },
                            scope: {
                                type: "snapshot",
                                metadata: {
                                    zkType: zk_artifact_1.ZKArtifactType.ORACLE_SNAPSHOT,
                                    snapshot: snapshot,
                                },
                            },
                            content: content,
                            summary: "Oracle snapshot from ".concat(validated.source.provider, "/").concat(validated.source.feedId),
                        };
                        return [4 /*yield*/, this.storage.store(artifactInput)];
                    case 1:
                        artifact = _a.sent();
                        zkMetadata = {
                            type: "oracle-snapshot",
                            snapshot: snapshot,
                        };
                        stored = {
                            artifact: artifact,
                            zkMetadata: zkMetadata,
                            anchored: false,
                        };
                        this.zkIndex.set(artifact.id, stored);
                        this.queueForAnchor(zk_artifact_1.ZKArtifactType.ORACLE_SNAPSHOT, artifact.id);
                        this.emit("oracle:stored", stored);
                        console.log("[ZKArtifact] Stored oracle snapshot ".concat(snapshot.snapshotId, " (").concat(artifact.id.slice(0, 12), "...)"));
                        return [2 /*return*/, stored];
                }
            });
        });
    };
    // ===========================================================================
    // MERKLE STATE DIFF STORAGE
    // ===========================================================================
    /**
     * Store a Merkle state diff
     */
    ZKArtifactService.prototype.storeStateDiff = function (input) {
        return __awaiter(this, void 0, void 0, function () {
            var validated, changesJson, changesHash, diff, artifactInput, artifact, zkMetadata, stored;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        validated = zk_artifact_1.createMerkleStateDiffInputSchema.parse(input);
                        changesJson = JSON.stringify(validated.changes);
                        changesHash = this.computeHash(changesJson);
                        diff = {
                            diffId: this.generateId("DIFF"),
                            previousRoot: validated.previousRoot,
                            newRoot: validated.newRoot,
                            fromBlock: validated.fromBlock,
                            toBlock: validated.toBlock,
                            contractAddress: validated.contractAddress,
                            changeCount: validated.changes.length,
                            changesHash: changesHash,
                            changeSummary: validated.changes.slice(0, 100), // First 100 for summary
                            transitionProof: validated.transitionProof,
                        };
                        artifactInput = {
                            origin: {
                                system: "ethereum",
                            },
                            scope: {
                                type: "merkle",
                                metadata: {
                                    zkType: zk_artifact_1.ZKArtifactType.MERKLE_STATE_DIFF,
                                    diff: diff,
                                },
                            },
                            content: changesJson,
                            summary: "State diff blocks ".concat(validated.fromBlock, "-").concat(validated.toBlock),
                        };
                        return [4 /*yield*/, this.storage.store(artifactInput)];
                    case 1:
                        artifact = _a.sent();
                        zkMetadata = {
                            type: "merkle-state-diff",
                            diff: diff,
                        };
                        stored = {
                            artifact: artifact,
                            zkMetadata: zkMetadata,
                            anchored: false,
                        };
                        this.zkIndex.set(artifact.id, stored);
                        this.queueForAnchor(zk_artifact_1.ZKArtifactType.MERKLE_STATE_DIFF, artifact.id);
                        this.emit("stateDiff:stored", stored);
                        console.log("[ZKArtifact] Stored state diff ".concat(diff.diffId, " (").concat(artifact.id.slice(0, 12), "...)"));
                        return [2 /*return*/, stored];
                }
            });
        });
    };
    // ===========================================================================
    // CONTRACT TRACE STORAGE
    // ===========================================================================
    /**
     * Store a contract execution trace
     */
    ZKArtifactService.prototype.storeContractTrace = function (input) {
        return __awaiter(this, void 0, void 0, function () {
            var validated, inputBuffer, inputHash, outputHash, outputBuffer, traceBuffer, fullTraceHash, stepCount, eventsEmitted, trace, content, artifactInput, artifact, zkMetadata, stored;
            var _this = this;
            var _a, _b, _c;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        validated = zk_artifact_1.createContractTraceInputSchema.parse(input);
                        inputBuffer = typeof validated.input === "string"
                            ? Buffer.from(validated.input, "utf-8")
                            : Buffer.from(validated.input);
                        inputHash = this.computeHash(inputBuffer);
                        if (validated.output) {
                            outputBuffer = typeof validated.output === "string"
                                ? Buffer.from(validated.output, "utf-8")
                                : Buffer.from(validated.output);
                            outputHash = this.computeHash(outputBuffer);
                        }
                        traceBuffer = typeof validated.fullTrace === "string"
                            ? Buffer.from(validated.fullTrace, "utf-8")
                            : Buffer.from(validated.fullTrace);
                        fullTraceHash = this.computeHash(traceBuffer);
                        stepCount = (_b = (_a = validated.stepSummary) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : Math.floor(traceBuffer.length / 100);
                        eventsEmitted = (_c = validated.eventsEmitted) === null || _c === void 0 ? void 0 : _c.map(function (e) { return ({
                            address: e.address,
                            topics: e.topics,
                            dataHash: _this.computeHash(e.data),
                        }); });
                        trace = {
                            traceId: this.generateId("TRACE"),
                            txHash: validated.txHash,
                            blockNumber: validated.blockNumber,
                            contractAddress: validated.contractAddress,
                            functionSelector: validated.functionSelector,
                            functionName: validated.functionName,
                            from: validated.from,
                            value: validated.value,
                            inputHash: inputHash,
                            outputHash: outputHash,
                            gasUsed: validated.gasUsed,
                            status: validated.status,
                            revertReason: validated.revertReason,
                            stepCount: stepCount,
                            fullTraceHash: fullTraceHash,
                            stepSummary: validated.stepSummary,
                            internalCalls: validated.internalCalls,
                            eventsEmitted: eventsEmitted,
                        };
                        content = JSON.stringify({
                            trace: trace,
                            input: inputBuffer.toString("base64"),
                            output: validated.output
                                ? (typeof validated.output === "string"
                                    ? Buffer.from(validated.output).toString("base64")
                                    : Buffer.from(validated.output).toString("base64"))
                                : null,
                            fullTrace: traceBuffer.toString("base64"),
                        });
                        artifactInput = {
                            origin: {
                                system: "ethereum",
                            },
                            scope: {
                                type: "trace",
                                metadata: {
                                    zkType: zk_artifact_1.ZKArtifactType.CONTRACT_TRACE,
                                    trace: trace,
                                },
                            },
                            content: content,
                            summary: "Contract trace for tx ".concat(validated.txHash.slice(0, 18), "..."),
                        };
                        return [4 /*yield*/, this.storage.store(artifactInput)];
                    case 1:
                        artifact = _d.sent();
                        zkMetadata = {
                            type: "contract-trace",
                            trace: trace,
                        };
                        stored = {
                            artifact: artifact,
                            zkMetadata: zkMetadata,
                            anchored: false,
                        };
                        this.zkIndex.set(artifact.id, stored);
                        this.queueForAnchor(zk_artifact_1.ZKArtifactType.CONTRACT_TRACE, artifact.id);
                        this.emit("trace:stored", stored);
                        console.log("[ZKArtifact] Stored contract trace ".concat(trace.traceId, " (").concat(artifact.id.slice(0, 12), "...)"));
                        return [2 /*return*/, stored];
                }
            });
        });
    };
    // ===========================================================================
    // ZK PROOF STORAGE
    // ===========================================================================
    /**
     * Store a ZK proof
     */
    ZKArtifactService.prototype.storeProof = function (input) {
        return __awaiter(this, void 0, void 0, function () {
            var validated, proofBuffer, proofHash, vkBuffer, verificationKeyHash, proof, content, artifactInput, artifact, zkMetadata, stored, existingProofs;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        validated = zk_artifact_1.createZKProofInputSchema.parse(input);
                        proofBuffer = typeof validated.proof === "string"
                            ? Buffer.from(validated.proof, "utf-8")
                            : Buffer.from(validated.proof);
                        proofHash = this.computeHash(proofBuffer);
                        vkBuffer = typeof validated.verificationKey === "string"
                            ? Buffer.from(validated.verificationKey, "utf-8")
                            : Buffer.from(validated.verificationKey);
                        verificationKeyHash = this.computeHash(vkBuffer);
                        proof = {
                            proofId: this.generateId("PROOF"),
                            circuitId: validated.circuitId,
                            proofSystem: validated.proofSystem,
                            witnessId: validated.witnessId,
                            witnessHash: validated.witnessHash,
                            publicInputs: validated.publicInputs,
                            proofHash: proofHash,
                            verificationKeyHash: verificationKeyHash,
                            generatedAt: new Date().toISOString(),
                            generationTimeMs: validated.generationTimeMs,
                            proofSize: proofBuffer.length,
                            locallyVerified: false,
                        };
                        content = JSON.stringify({
                            proof: proof,
                            proofData: proofBuffer.toString("base64"),
                            verificationKey: vkBuffer.toString("base64"),
                        });
                        artifactInput = {
                            origin: {
                                system: "ethereum",
                            },
                            scope: {
                                type: "proof",
                                metadata: {
                                    zkType: zk_artifact_1.ZKArtifactType.PROOF,
                                    proof: proof,
                                },
                            },
                            content: content,
                            dependencies: [validated.witnessHash], // Depends on witness
                            summary: "ZK Proof (".concat(validated.proofSystem, ") for circuit ").concat(validated.circuitId),
                        };
                        return [4 /*yield*/, this.storage.store(artifactInput)];
                    case 1:
                        artifact = _b.sent();
                        zkMetadata = {
                            type: "zk-proof",
                            proof: proof,
                        };
                        stored = {
                            artifact: artifact,
                            zkMetadata: zkMetadata,
                            anchored: false,
                        };
                        this.zkIndex.set(artifact.id, stored);
                        existingProofs = (_a = this.witnessProofMap.get(validated.witnessHash)) !== null && _a !== void 0 ? _a : [];
                        existingProofs.push(artifact.id);
                        this.witnessProofMap.set(validated.witnessHash, existingProofs);
                        this.queueForAnchor(zk_artifact_1.ZKArtifactType.PROOF, artifact.id);
                        this.emit("proof:stored", stored);
                        console.log("[ZKArtifact] Stored proof ".concat(proof.proofId, " (").concat(artifact.id.slice(0, 12), "...)"));
                        return [2 /*return*/, stored];
                }
            });
        });
    };
    // ===========================================================================
    // RETRIEVAL
    // ===========================================================================
    /**
     * Get a ZK artifact by hash
     */
    ZKArtifactService.prototype.get = function (hash) {
        return __awaiter(this, void 0, void 0, function () {
            var indexed, artifact, zkType, zkMetadata, stored;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        indexed = this.zkIndex.get(hash);
                        if (indexed) {
                            return [2 /*return*/, indexed];
                        }
                        return [4 /*yield*/, this.storage.get(hash)];
                    case 1:
                        artifact = _b.sent();
                        if (!artifact) {
                            return [2 /*return*/, null];
                        }
                        zkType = (_a = artifact.scope.metadata) === null || _a === void 0 ? void 0 : _a.zkType;
                        if (!zkType) {
                            return [2 /*return*/, null];
                        }
                        zkMetadata = artifact.scope.metadata;
                        stored = {
                            artifact: artifact,
                            zkMetadata: zkMetadata,
                            anchored: false, // Would need to check chain
                        };
                        this.zkIndex.set(hash, stored);
                        return [2 /*return*/, stored];
                }
            });
        });
    };
    /**
     * Get all proofs for a witness
     */
    ZKArtifactService.prototype.getProofsForWitness = function (witnessHash) {
        return __awaiter(this, void 0, void 0, function () {
            var proofHashes, proofs, _i, proofHashes_1, hash, proof;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        proofHashes = (_a = this.witnessProofMap.get(witnessHash)) !== null && _a !== void 0 ? _a : [];
                        proofs = [];
                        _i = 0, proofHashes_1 = proofHashes;
                        _b.label = 1;
                    case 1:
                        if (!(_i < proofHashes_1.length)) return [3 /*break*/, 4];
                        hash = proofHashes_1[_i];
                        return [4 /*yield*/, this.get(hash)];
                    case 2:
                        proof = _b.sent();
                        if (proof) {
                            proofs.push(proof);
                        }
                        _b.label = 3;
                    case 3:
                        _i++;
                        return [3 /*break*/, 1];
                    case 4: return [2 /*return*/, proofs];
                }
            });
        });
    };
    /**
     * Query ZK artifacts
     */
    ZKArtifactService.prototype.query = function (options) {
        return __awaiter(this, void 0, void 0, function () {
            var results, _i, _a, _b, _, stored;
            return __generator(this, function (_c) {
                results = [];
                for (_i = 0, _a = this.zkIndex; _i < _a.length; _i++) {
                    _b = _a[_i], _ = _b[0], stored = _b[1];
                    // Type filter
                    if (options.type && stored.zkMetadata.type !== options.type) {
                        continue;
                    }
                    // Circuit filter (for witnesses and proofs)
                    if (options.circuitId) {
                        if (stored.zkMetadata.type === "zk-witness" &&
                            stored.zkMetadata.witness.circuitId !== options.circuitId) {
                            continue;
                        }
                        if (stored.zkMetadata.type === "zk-proof" &&
                            stored.zkMetadata.proof.circuitId !== options.circuitId) {
                            continue;
                        }
                    }
                    // Time filters
                    if (options.fromTimestamp && stored.artifact.timestamp < options.fromTimestamp) {
                        continue;
                    }
                    if (options.toTimestamp && stored.artifact.timestamp > options.toTimestamp) {
                        continue;
                    }
                    // Anchor filter
                    if (options.anchored !== undefined && stored.anchored !== options.anchored) {
                        continue;
                    }
                    results.push(stored);
                }
                // Sort by timestamp descending
                results.sort(function (a, b) { return b.artifact.timestamp.localeCompare(a.artifact.timestamp); });
                // Apply limit
                if (options.limit) {
                    return [2 /*return*/, results.slice(0, options.limit)];
                }
                return [2 /*return*/, results];
            });
        });
    };
    // ===========================================================================
    // PROOF VERIFICATION
    // ===========================================================================
    /**
     * Verify a proof against its stored witness
     */
    ZKArtifactService.prototype.verifyProofAgainstWitness = function (proofHash) {
        return __awaiter(this, void 0, void 0, function () {
            var proofArtifact, proof, witnessArtifact, witness, errors, circuitMatch, publicInputsMatch, witnessHashMatch, valid, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.get(proofHash)];
                    case 1:
                        proofArtifact = _a.sent();
                        if (!proofArtifact || proofArtifact.zkMetadata.type !== "zk-proof") {
                            return [2 /*return*/, {
                                    valid: false,
                                    proofId: "unknown",
                                    proofHash: proofHash,
                                    witnessHash: "",
                                    publicInputsMatch: false,
                                    circuitMatch: false,
                                    verifiedAt: new Date(),
                                    errors: ["Proof not found or invalid type"],
                                }];
                        }
                        proof = proofArtifact.zkMetadata.proof;
                        return [4 /*yield*/, this.get(proof.witnessHash)];
                    case 2:
                        witnessArtifact = _a.sent();
                        if (!witnessArtifact || witnessArtifact.zkMetadata.type !== "zk-witness") {
                            return [2 /*return*/, {
                                    valid: false,
                                    proofId: proof.proofId,
                                    proofHash: proofHash,
                                    witnessHash: proof.witnessHash,
                                    publicInputsMatch: false,
                                    circuitMatch: false,
                                    verifiedAt: new Date(),
                                    errors: ["Witness not found"],
                                }];
                        }
                        witness = witnessArtifact.zkMetadata.witness;
                        errors = [];
                        circuitMatch = proof.circuitId === witness.circuitId;
                        if (!circuitMatch) {
                            errors.push("Circuit mismatch: proof=".concat(proof.circuitId, ", witness=").concat(witness.circuitId));
                        }
                        publicInputsMatch = proof.publicInputs.length === witness.publicInputs.length &&
                            proof.publicInputs.every(function (input, i) { return input === witness.publicInputs[i]; });
                        if (!publicInputsMatch) {
                            errors.push("Public inputs mismatch");
                        }
                        witnessHashMatch = proof.witnessHash === witnessArtifact.artifact.id;
                        if (!witnessHashMatch) {
                            errors.push("Witness hash mismatch");
                        }
                        valid = circuitMatch && publicInputsMatch && witnessHashMatch && errors.length === 0;
                        result = {
                            valid: valid,
                            proofId: proof.proofId,
                            proofHash: proofHash,
                            witnessHash: proof.witnessHash,
                            publicInputsMatch: publicInputsMatch,
                            circuitMatch: circuitMatch,
                            verifiedAt: new Date(),
                            errors: errors.length > 0 ? errors : undefined,
                        };
                        this.emit("proof:verified", result);
                        return [2 /*return*/, result];
                }
            });
        });
    };
    /**
     * Verify witness integrity
     */
    ZKArtifactService.prototype.verifyWitnessIntegrity = function (witnessHash) {
        return __awaiter(this, void 0, void 0, function () {
            var witnessArtifact, witness, contentValid, proofs, proofHash, errors;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.get(witnessHash)];
                    case 1:
                        witnessArtifact = _a.sent();
                        if (!witnessArtifact || witnessArtifact.zkMetadata.type !== "zk-witness") {
                            return [2 /*return*/, {
                                    valid: false,
                                    witnessId: "unknown",
                                    witnessHash: witnessHash,
                                    circuitId: "unknown",
                                    verifiedAt: new Date(),
                                    errors: ["Witness not found"],
                                }];
                        }
                        witness = witnessArtifact.zkMetadata.witness;
                        return [4 /*yield*/, this.storage.verifyIntegrity(witnessHash)];
                    case 2:
                        contentValid = _a.sent();
                        return [4 /*yield*/, this.getProofsForWitness(witnessHash)];
                    case 3:
                        proofs = _a.sent();
                        proofHash = proofs.length > 0 ? proofs[0].artifact.id : undefined;
                        errors = [];
                        if (!contentValid) {
                            errors.push("Content integrity check failed");
                        }
                        return [2 /*return*/, {
                                valid: contentValid,
                                witnessId: witness.witnessId,
                                witnessHash: witnessHash,
                                proofHash: proofHash,
                                circuitId: witness.circuitId,
                                verifiedAt: new Date(),
                                errors: errors.length > 0 ? errors : undefined,
                            }];
                }
            });
        });
    };
    // ===========================================================================
    // ON-CHAIN ANCHORING
    // ===========================================================================
    ZKArtifactService.prototype.queueForAnchor = function (type, hash) {
        var _a;
        if (!this.config.enableAnchoring) {
            return;
        }
        var queue = (_a = this.pendingAnchor.get(type)) !== null && _a !== void 0 ? _a : [];
        queue.push(hash);
        this.pendingAnchor.set(type, queue);
        // Check if we should flush
        if (queue.length >= this.config.anchorBatchSize) {
            this.flushAnchorQueue(type);
        }
    };
    ZKArtifactService.prototype.flushAnchorQueue = function (type) {
        return __awaiter(this, void 0, void 0, function () {
            var queue, hashes, tree, merkleRoot, result, i, stored, existingQueue;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        queue = this.pendingAnchor.get(type);
                        if (!queue || queue.length === 0) {
                            return [2 /*return*/, null];
                        }
                        hashes = __spreadArray([], queue, true);
                        this.pendingAnchor.set(type, []);
                        console.log("[ZKArtifact] Anchoring batch of ".concat(hashes.length, " ").concat(type, " artifacts..."));
                        tree = new ZKMerkleTree(hashes);
                        merkleRoot = tree.getRoot();
                        return [4 /*yield*/, this.anchorInterface.anchorBatch(merkleRoot, hashes, type)];
                    case 1:
                        result = _b.sent();
                        if (result.success) {
                            // Update index with anchor info
                            for (i = 0; i < hashes.length; i++) {
                                stored = this.zkIndex.get(hashes[i]);
                                if (stored) {
                                    stored.anchored = true;
                                    stored.anchorTxHash = result.txHash;
                                    stored.anchorBlockNumber = result.blockNumber;
                                    this.zkIndex.set(hashes[i], stored);
                                }
                            }
                            this.emit("batch:anchored", {
                                type: type,
                                merkleRoot: merkleRoot,
                                hashes: hashes,
                                txHash: result.txHash,
                                blockNumber: result.blockNumber,
                            });
                            console.log("[ZKArtifact] Batch anchored: ".concat(result.txHash));
                        }
                        else {
                            existingQueue = (_a = this.pendingAnchor.get(type)) !== null && _a !== void 0 ? _a : [];
                            this.pendingAnchor.set(type, __spreadArray(__spreadArray([], hashes, true), existingQueue, true));
                            console.error("[ZKArtifact] Batch anchor failed: ".concat(result.error));
                        }
                        return [2 /*return*/, result];
                }
            });
        });
    };
    ZKArtifactService.prototype.flushPendingAnchors = function () {
        return __awaiter(this, void 0, void 0, function () {
            var _i, _a, type, queue;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _i = 0, _a = Object.values(zk_artifact_1.ZKArtifactType);
                        _b.label = 1;
                    case 1:
                        if (!(_i < _a.length)) return [3 /*break*/, 4];
                        type = _a[_i];
                        queue = this.pendingAnchor.get(type);
                        if (!(queue && queue.length > 0)) return [3 /*break*/, 3];
                        return [4 /*yield*/, this.flushAnchorQueue(type)];
                    case 2:
                        _b.sent();
                        _b.label = 3;
                    case 3:
                        _i++;
                        return [3 /*break*/, 1];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Manually anchor an artifact
     */
    ZKArtifactService.prototype.anchorArtifact = function (hash) {
        return __awaiter(this, void 0, void 0, function () {
            var stored, request, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.get(hash)];
                    case 1:
                        stored = _a.sent();
                        if (!stored) {
                            return [2 /*return*/, {
                                    success: false,
                                    error: "Artifact not found",
                                }];
                        }
                        if (stored.anchored) {
                            return [2 /*return*/, {
                                    success: true,
                                    txHash: stored.anchorTxHash,
                                    blockNumber: stored.anchorBlockNumber,
                                }];
                        }
                        request = {
                            artifactType: stored.zkMetadata.type,
                            contentHash: hash,
                            metadata: {
                                timestamp: stored.artifact.timestamp,
                            },
                        };
                        return [4 /*yield*/, this.anchorInterface.anchorArtifact(request)];
                    case 2:
                        result = _a.sent();
                        if (result.success) {
                            stored.anchored = true;
                            stored.anchorTxHash = result.txHash;
                            stored.anchorBlockNumber = result.blockNumber;
                            this.zkIndex.set(hash, stored);
                        }
                        return [2 /*return*/, result];
                }
            });
        });
    };
    /**
     * Get Merkle proof for an anchored artifact
     */
    ZKArtifactService.prototype.getMerkleProof = function (batchHashes, targetHash) {
        var index = batchHashes.indexOf(targetHash);
        if (index === -1) {
            return null;
        }
        var tree = new ZKMerkleTree(batchHashes);
        return tree.getProof(index);
    };
    /**
     * Verify a Merkle proof
     */
    ZKArtifactService.prototype.verifyMerkleProof = function (leafHash, proof, root) {
        return ZKMerkleTree.verify("0x".concat(leafHash), proof, root);
    };
    // ===========================================================================
    // STATISTICS
    // ===========================================================================
    ZKArtifactService.prototype.getStats = function () {
        var _a;
        var byType = {};
        var anchoredCount = 0;
        var totalSize = 0;
        for (var _i = 0, _b = this.zkIndex; _i < _b.length; _i++) {
            var _c = _b[_i], _ = _c[0], stored = _c[1];
            var type = stored.zkMetadata.type;
            byType[type] = ((_a = byType[type]) !== null && _a !== void 0 ? _a : 0) + 1;
            if (stored.anchored) {
                anchoredCount++;
            }
            totalSize += stored.artifact.content.size;
        }
        var pendingAnchorCount = 0;
        for (var _d = 0, _e = this.pendingAnchor; _d < _e.length; _d++) {
            var _f = _e[_d], _ = _f[0], queue = _f[1];
            pendingAnchorCount += queue.length;
        }
        return {
            totalArtifacts: this.zkIndex.size,
            byType: byType,
            anchoredCount: anchoredCount,
            pendingAnchorCount: pendingAnchorCount,
            totalSize: totalSize,
        };
    };
    /**
     * Check if anchoring is enabled
     */
    ZKArtifactService.prototype.isAnchoringEnabled = function () {
        return this.config.enableAnchoring && this.anchorInterface.isEnabled();
    };
    return ZKArtifactService;
}(events_1.EventEmitter));
exports.ZKArtifactService = ZKArtifactService;
// =============================================================================
// SINGLETON INSTANCE
// =============================================================================
exports.zkArtifactService = new ZKArtifactService({
    enableLocalVerification: process.env.ZK_LOCAL_VERIFICATION !== "false",
    enableAnchoring: process.env.ZK_ANCHORING !== "false",
    anchorBatchSize: parseInt((_a = process.env.ZK_ANCHOR_BATCH_SIZE) !== null && _a !== void 0 ? _a : "50"),
    anchorBatchMaxAgeMs: parseInt((_b = process.env.ZK_ANCHOR_BATCH_AGE_MS) !== null && _b !== void 0 ? _b : "300000"),
});
// =============================================================================
// INITIALIZATION HELPER
// =============================================================================
function initZKArtifactService(config) {
    return __awaiter(this, void 0, void 0, function () {
        var service;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    service = config
                        ? new ZKArtifactService(config)
                        : exports.zkArtifactService;
                    // Ensure underlying storage is initialized
                    return [4 /*yield*/, artifact_storage_1.artifactStorage.initialize()];
                case 1:
                    // Ensure underlying storage is initialized
                    _a.sent();
                    return [2 /*return*/, service];
            }
        });
    });
}
