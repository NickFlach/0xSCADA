"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.blockchainService = exports.BlockchainService = void 0;
var ethers_1 = require("ethers");
var crypto_1 = require("crypto");
var fs_1 = require("fs");
var path_1 = require("path");
var REGISTRY_ABI = [
    "function registerSite(string siteId, string name, string location, address owner)",
    "function registerAsset(string assetId, string siteId, string assetType, string nameOrTag, bool critical)",
    "function anchorEvent(string assetId, string eventType, bytes32 payloadHash)",
    "function anchorMaintenance(string assetId, string workOrderId, string maintenanceType, uint256 performedAt)",
    "function anchorBatchRoot(string batchId, bytes32 merkleRoot, uint256 eventCount)",
    "event SiteRegistered(string indexed siteId, string name, address owner, uint256 timestamp)",
    "event AssetRegistered(string indexed assetId, string siteId, string assetType, uint256 timestamp)",
    "event EventAnchored(string indexed assetId, string eventType, bytes32 payloadHash, uint256 timestamp, address recordedBy)",
    "event MaintenanceAnchored(string indexed assetId, string workOrderId, string maintenanceType, uint256 timestamp, address performedBy)",
    "event BatchRootAnchored(string indexed batchId, bytes32 merkleRoot, uint256 eventCount, uint256 timestamp, address anchoredBy)",
];
var BlockchainService = /** @class */ (function () {
    function BlockchainService() {
        this.config = {
            enabled: false,
            provider: null,
            wallet: null,
            registry: null,
        };
        this.initialize();
    }
    BlockchainService.prototype.initialize = function () {
        try {
            var rpcUrl = process.env.BLOCKCHAIN_RPC_URL || "http://127.0.0.1:8545";
            var privateKey = process.env.BLOCKCHAIN_PRIVATE_KEY;
            var contractAddress = this.getContractAddress();
            if (!privateKey) {
                console.warn("⚠️  BLOCKCHAIN_PRIVATE_KEY not set. Blockchain features disabled.");
                return;
            }
            if (!contractAddress) {
                console.warn("⚠️  Contract not deployed. Run 'npx hardhat run scripts/deploy.ts --network localhost' first.");
                return;
            }
            this.config.provider = new ethers_1.ethers.JsonRpcProvider(rpcUrl);
            this.config.wallet = new ethers_1.ethers.Wallet(privateKey, this.config.provider);
            this.config.registry = new ethers_1.ethers.Contract(contractAddress, REGISTRY_ABI, this.config.wallet);
            this.config.enabled = true;
            console.log("✅ Blockchain service initialized");
            console.log("   Provider: ".concat(rpcUrl));
            console.log("   Contract: ".concat(contractAddress));
            console.log("   Signer: ".concat(this.config.wallet.address));
        }
        catch (error) {
            console.error("❌ Failed to initialize blockchain service:", error);
        }
    };
    BlockchainService.prototype.getContractAddress = function () {
        try {
            var deploymentPath = path_1.default.join(process.cwd(), "deployment.json");
            if (fs_1.default.existsSync(deploymentPath)) {
                var deployment = JSON.parse(fs_1.default.readFileSync(deploymentPath, "utf-8"));
                return deployment.address;
            }
        }
        catch (error) {
            console.error("Failed to read deployment.json:", error);
        }
        return null;
    };
    BlockchainService.prototype.isEnabled = function () {
        return this.config.enabled;
    };
    BlockchainService.prototype.hashPayload = function (payload) {
        var hash = (0, crypto_1.createHash)("sha256");
        hash.update(JSON.stringify(payload));
        return "0x" + hash.digest("hex");
    };
    BlockchainService.prototype.registerSite = function (siteId, name, location, owner) {
        return __awaiter(this, void 0, void 0, function () {
            var tx, receipt, error_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.config.enabled || !this.config.registry) {
                            return [2 /*return*/, null];
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 4, , 5]);
                        return [4 /*yield*/, this.config.registry.registerSite(siteId, name, location, owner)];
                    case 2:
                        tx = _a.sent();
                        return [4 /*yield*/, tx.wait()];
                    case 3:
                        receipt = _a.sent();
                        console.log("\u2705 Site ".concat(siteId, " registered on-chain: ").concat(receipt.hash));
                        return [2 /*return*/, receipt.hash];
                    case 4:
                        error_1 = _a.sent();
                        console.error("Failed to register site on-chain:", error_1);
                        return [2 /*return*/, null];
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    BlockchainService.prototype.registerAsset = function (assetId, siteId, assetType, nameOrTag, critical) {
        return __awaiter(this, void 0, void 0, function () {
            var tx, receipt, error_2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.config.enabled || !this.config.registry) {
                            return [2 /*return*/, null];
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 4, , 5]);
                        return [4 /*yield*/, this.config.registry.registerAsset(assetId, siteId, assetType, nameOrTag, critical)];
                    case 2:
                        tx = _a.sent();
                        return [4 /*yield*/, tx.wait()];
                    case 3:
                        receipt = _a.sent();
                        console.log("\u2705 Asset ".concat(assetId, " registered on-chain: ").concat(receipt.hash));
                        return [2 /*return*/, receipt.hash];
                    case 4:
                        error_2 = _a.sent();
                        console.error("Failed to register asset on-chain:", error_2);
                        return [2 /*return*/, null];
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    BlockchainService.prototype.anchorEvent = function (assetId, eventType, payloadHash) {
        return __awaiter(this, void 0, void 0, function () {
            var tx, receipt, error_3;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.config.enabled || !this.config.registry) {
                            return [2 /*return*/, null];
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 4, , 5]);
                        return [4 /*yield*/, this.config.registry.anchorEvent(assetId, eventType, payloadHash)];
                    case 2:
                        tx = _a.sent();
                        return [4 /*yield*/, tx.wait()];
                    case 3:
                        receipt = _a.sent();
                        console.log("\u2705 Event anchored on-chain: ".concat(receipt.hash));
                        return [2 /*return*/, receipt.hash];
                    case 4:
                        error_3 = _a.sent();
                        console.error("Failed to anchor event on-chain:", error_3);
                        return [2 /*return*/, null];
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    BlockchainService.prototype.anchorMaintenance = function (assetId, workOrderId, maintenanceType, performedAt) {
        return __awaiter(this, void 0, void 0, function () {
            var tx, receipt, error_4;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.config.enabled || !this.config.registry) {
                            return [2 /*return*/, null];
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 4, , 5]);
                        return [4 /*yield*/, this.config.registry.anchorMaintenance(assetId, workOrderId, maintenanceType, performedAt)];
                    case 2:
                        tx = _a.sent();
                        return [4 /*yield*/, tx.wait()];
                    case 3:
                        receipt = _a.sent();
                        console.log("\u2705 Maintenance anchored on-chain: ".concat(receipt.hash));
                        return [2 /*return*/, receipt.hash];
                    case 4:
                        error_4 = _a.sent();
                        console.error("Failed to anchor maintenance on-chain:", error_4);
                        return [2 /*return*/, null];
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    BlockchainService.prototype.anchorBatchRoot = function (batchId, merkleRoot, eventCount) {
        return __awaiter(this, void 0, void 0, function () {
            var tx, receipt, error_5;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.config.enabled || !this.config.registry) {
                            return [2 /*return*/, null];
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 4, , 5]);
                        return [4 /*yield*/, this.config.registry.anchorBatchRoot(batchId, merkleRoot, eventCount)];
                    case 2:
                        tx = _a.sent();
                        return [4 /*yield*/, tx.wait()];
                    case 3:
                        receipt = _a.sent();
                        console.log("\u2705 Batch root anchored on-chain: ".concat(receipt.hash));
                        console.log("   Batch ID: ".concat(batchId));
                        console.log("   Merkle Root: ".concat(merkleRoot));
                        console.log("   Event Count: ".concat(eventCount));
                        return [2 /*return*/, receipt.hash];
                    case 4:
                        error_5 = _a.sent();
                        console.error("Failed to anchor batch root on-chain:", error_5);
                        return [2 /*return*/, null];
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    BlockchainService.prototype.getGasPrice = function () {
        return __awaiter(this, void 0, void 0, function () {
            var feeData, gasPrice, formatted, error_6;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.config.enabled || !this.config.provider) {
                            return [2 /*return*/, null];
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, this.config.provider.getFeeData()];
                    case 2:
                        feeData = _a.sent();
                        gasPrice = feeData.gasPrice || BigInt(0);
                        formatted = ethers_1.ethers.formatUnits(gasPrice, "gwei") + " gwei";
                        return [2 /*return*/, { gasPrice: gasPrice, formatted: formatted }];
                    case 3:
                        error_6 = _a.sent();
                        console.error("Failed to get gas price:", error_6);
                        return [2 /*return*/, null];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    BlockchainService.prototype.estimateGas = function (functionName) {
        var args = [];
        for (var _i = 1; _i < arguments.length; _i++) {
            args[_i - 1] = arguments[_i];
        }
        return __awaiter(this, void 0, void 0, function () {
            var gasEstimate, error_7;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!this.config.enabled || !this.config.registry) {
                            return [2 /*return*/, null];
                        }
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, (_a = this.config.registry[functionName]).estimateGas.apply(_a, args)];
                    case 2:
                        gasEstimate = _b.sent();
                        return [2 /*return*/, gasEstimate];
                    case 3:
                        error_7 = _b.sent();
                        console.error("Failed to estimate gas for ".concat(functionName, ":"), error_7);
                        return [2 /*return*/, null];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    return BlockchainService;
}());
exports.BlockchainService = BlockchainService;
exports.blockchainService = new BlockchainService();
