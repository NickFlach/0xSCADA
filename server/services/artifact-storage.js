"use strict";
/**
 * 0xSCADA Artifact Storage Service
 *
 * VERITY Architecture - Phase α.1: LFS Content-Addressed Artifact Storage
 *
 * This service provides:
 * - Content-addressed storage using SHA-256 hashes
 * - LFS-compatible artifact storage
 * - Schema validation for all artifacts
 * - Dependency tracking between artifacts
 * - Query and retrieval by hash or metadata
 *
 * "Artifacts are truth. Never overwrite evidence to satisfy intent."
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
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
exports.artifactStorage = exports.ArtifactStorageService = void 0;
exports.initArtifactStorage = initArtifactStorage;
var crypto_1 = require("crypto");
var fs_1 = require("fs");
var path_1 = require("path");
var events_1 = require("events");
var artifact_1 = require("@shared/artifact");
// =============================================================================
// ARTIFACT STORAGE SERVICE
// =============================================================================
var ArtifactStorageService = /** @class */ (function (_super) {
    __extends(ArtifactStorageService, _super);
    function ArtifactStorageService(config) {
        if (config === void 0) { config = {}; }
        var _a, _b, _c, _d;
        var _this = _super.call(this) || this;
        /** Initialization state */
        _this.initialized = false;
        _this.config = {
            lfsDir: (_a = config.lfsDir) !== null && _a !== void 0 ? _a : "./artifacts/lfs",
            enableIndex: (_b = config.enableIndex) !== null && _b !== void 0 ? _b : true,
            maxContentSize: (_c = config.maxContentSize) !== null && _c !== void 0 ? _c : 0,
            enableDeduplication: (_d = config.enableDeduplication) !== null && _d !== void 0 ? _d : true,
        };
        _this.artifactIndex = new Map();
        _this.dependentIndex = new Map();
        return _this;
    }
    // ===========================================================================
    // LIFECYCLE
    // ===========================================================================
    /**
     * Initialize the storage service
     */
    ArtifactStorageService.prototype.initialize = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (this.initialized) {
                            return [2 /*return*/];
                        }
                        // Create LFS directory structure
                        return [4 /*yield*/, this.ensureDirectoryStructure()];
                    case 1:
                        // Create LFS directory structure
                        _a.sent();
                        if (!this.config.enableIndex) return [3 /*break*/, 3];
                        return [4 /*yield*/, this.loadIndex()];
                    case 2:
                        _a.sent();
                        _a.label = 3;
                    case 3:
                        this.initialized = true;
                        console.log("[ArtifactStorage] Initialized at ".concat(this.config.lfsDir));
                        console.log("   Artifacts indexed: ".concat(this.artifactIndex.size));
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Ensure the LFS directory structure exists
     */
    ArtifactStorageService.prototype.ensureDirectoryStructure = function () {
        return __awaiter(this, void 0, void 0, function () {
            var objectsDir, metadataDir, i, shardDir;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        objectsDir = path_1.default.join(this.config.lfsDir, "objects");
                        return [4 /*yield*/, fs_1.promises.mkdir(objectsDir, { recursive: true })];
                    case 1:
                        _a.sent();
                        metadataDir = path_1.default.join(this.config.lfsDir, "metadata");
                        return [4 /*yield*/, fs_1.promises.mkdir(metadataDir, { recursive: true })];
                    case 2:
                        _a.sent();
                        i = 0;
                        _a.label = 3;
                    case 3:
                        if (!(i < 256)) return [3 /*break*/, 6];
                        shardDir = path_1.default.join(objectsDir, i.toString(16).padStart(2, "0"));
                        return [4 /*yield*/, fs_1.promises.mkdir(shardDir, { recursive: true })];
                    case 4:
                        _a.sent();
                        _a.label = 5;
                    case 5:
                        i++;
                        return [3 /*break*/, 3];
                    case 6: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Load artifact index from disk
     */
    ArtifactStorageService.prototype.loadIndex = function () {
        return __awaiter(this, void 0, void 0, function () {
            var indexFile, data, parsed, _i, parsed_1, _a, hash, metadata, _b, _c, dep, error_1;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        indexFile = path_1.default.join(this.config.lfsDir, "metadata", "index.json");
                        _d.label = 1;
                    case 1:
                        _d.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, fs_1.promises.readFile(indexFile, "utf-8")];
                    case 2:
                        data = _d.sent();
                        parsed = JSON.parse(data);
                        for (_i = 0, parsed_1 = parsed; _i < parsed_1.length; _i++) {
                            _a = parsed_1[_i], hash = _a.hash, metadata = _a.metadata;
                            // Rehydrate dates
                            metadata.storedAt = new Date(metadata.storedAt);
                            metadata.lastAccessedAt = new Date(metadata.lastAccessedAt);
                            this.artifactIndex.set(hash, metadata);
                            // Rebuild dependent index
                            for (_b = 0, _c = metadata.artifact.dependencies; _b < _c.length; _b++) {
                                dep = _c[_b];
                                if (!this.dependentIndex.has(dep)) {
                                    this.dependentIndex.set(dep, new Set());
                                }
                                this.dependentIndex.get(dep).add(hash);
                            }
                        }
                        return [3 /*break*/, 4];
                    case 3:
                        error_1 = _d.sent();
                        if (error_1.code !== "ENOENT") {
                            console.warn("[ArtifactStorage] Failed to load index: ".concat(error_1.message));
                        }
                        return [3 /*break*/, 4];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Save artifact index to disk
     */
    ArtifactStorageService.prototype.saveIndex = function () {
        return __awaiter(this, void 0, void 0, function () {
            var indexFile, data;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.config.enableIndex)
                            return [2 /*return*/];
                        indexFile = path_1.default.join(this.config.lfsDir, "metadata", "index.json");
                        data = Array.from(this.artifactIndex.entries()).map(function (_a) {
                            var hash = _a[0], metadata = _a[1];
                            return ({
                                hash: hash,
                                metadata: metadata,
                            });
                        });
                        return [4 /*yield*/, fs_1.promises.writeFile(indexFile, JSON.stringify(data, null, 2))];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    // ===========================================================================
    // CONTENT HASHING
    // ===========================================================================
    /**
     * Compute SHA-256 hash of content
     */
    ArtifactStorageService.prototype.computeHash = function (content) {
        var buffer = typeof content === "string"
            ? Buffer.from(content, "utf-8")
            : Buffer.from(content);
        return (0, crypto_1.createHash)("sha256").update(buffer).digest("hex");
    };
    /**
     * Get the storage path for a content hash
     */
    ArtifactStorageService.prototype.getObjectPath = function (hash) {
        var shard = hash.slice(0, 2);
        return path_1.default.join(this.config.lfsDir, "objects", shard, hash);
    };
    /**
     * Get the metadata path for a content hash
     */
    ArtifactStorageService.prototype.getMetadataPath = function (hash) {
        var shard = hash.slice(0, 2);
        return path_1.default.join(this.config.lfsDir, "metadata", shard, "".concat(hash, ".json"));
    };
    // ===========================================================================
    // ARTIFACT OPERATIONS
    // ===========================================================================
    /**
     * Store an artifact
     *
     * @returns The stored RealityArtifact with computed ID
     */
    ArtifactStorageService.prototype.store = function (input) {
        return __awaiter(this, void 0, void 0, function () {
            var validatedInput, contentBuffer, contentHash, _i, _a, depHash, lfsPointer, artifact, objectPath, metadataPath, metadata, _b, _c, depHash;
            var _d, _e;
            return __generator(this, function (_f) {
                switch (_f.label) {
                    case 0:
                        validatedInput = artifact_1.createArtifactInputSchema.parse(input);
                        contentBuffer = typeof validatedInput.content === "string"
                            ? Buffer.from(validatedInput.content, "utf-8")
                            : Buffer.from(validatedInput.content);
                        // Check size limit
                        if (this.config.maxContentSize > 0 && contentBuffer.length > this.config.maxContentSize) {
                            throw new Error("Content size ".concat(contentBuffer.length, " exceeds maximum ").concat(this.config.maxContentSize));
                        }
                        contentHash = this.computeHash(contentBuffer);
                        // Check for deduplication
                        if (this.config.enableDeduplication && this.artifactIndex.has(contentHash)) {
                            console.log("[ArtifactStorage] Deduplication: artifact ".concat(contentHash.slice(0, 12), "... already exists"));
                            return [2 /*return*/, this.artifactIndex.get(contentHash).artifact];
                        }
                        // Validate dependencies exist
                        for (_i = 0, _a = (_d = validatedInput.dependencies) !== null && _d !== void 0 ? _d : []; _i < _a.length; _i++) {
                            depHash = _a[_i];
                            if (!this.artifactIndex.has(depHash)) {
                                throw new Error("Dependency artifact not found: ".concat(depHash));
                            }
                        }
                        lfsPointer = {
                            version: "v1",
                            oid: contentHash,
                            size: contentBuffer.length,
                            mimeType: validatedInput.mimeType,
                            filename: validatedInput.filename,
                        };
                        artifact = {
                            id: contentHash,
                            timestamp: new Date().toISOString(),
                            origin: validatedInput.origin,
                            scope: validatedInput.scope,
                            dependencies: (_e = validatedInput.dependencies) !== null && _e !== void 0 ? _e : [],
                            signature: validatedInput.signature,
                            summary: validatedInput.summary,
                            content: lfsPointer,
                        };
                        // Validate the complete artifact
                        artifact_1.realityArtifactSchema.parse(artifact);
                        objectPath = this.getObjectPath(contentHash);
                        return [4 /*yield*/, fs_1.promises.mkdir(path_1.default.dirname(objectPath), { recursive: true })];
                    case 1:
                        _f.sent();
                        return [4 /*yield*/, fs_1.promises.writeFile(objectPath, contentBuffer)];
                    case 2:
                        _f.sent();
                        metadataPath = this.getMetadataPath(contentHash);
                        return [4 /*yield*/, fs_1.promises.mkdir(path_1.default.dirname(metadataPath), { recursive: true })];
                    case 3:
                        _f.sent();
                        return [4 /*yield*/, fs_1.promises.writeFile(metadataPath, JSON.stringify(artifact, null, 2))];
                    case 4:
                        _f.sent();
                        metadata = {
                            artifact: artifact,
                            storedAt: new Date(),
                            accessCount: 0,
                            lastAccessedAt: new Date(),
                        };
                        this.artifactIndex.set(contentHash, metadata);
                        // Update dependent index
                        for (_b = 0, _c = artifact.dependencies; _b < _c.length; _b++) {
                            depHash = _c[_b];
                            if (!this.dependentIndex.has(depHash)) {
                                this.dependentIndex.set(depHash, new Set());
                            }
                            this.dependentIndex.get(depHash).add(contentHash);
                        }
                        // Save index
                        return [4 /*yield*/, this.saveIndex()];
                    case 5:
                        // Save index
                        _f.sent();
                        // Emit event
                        this.emit("artifact:stored", artifact);
                        console.log("[ArtifactStorage] Stored artifact ".concat(contentHash.slice(0, 12), "... ") +
                            "(".concat(artifact.scope.type, ", ").concat(contentBuffer.length, " bytes)"));
                        return [2 /*return*/, artifact];
                }
            });
        });
    };
    /**
     * Retrieve an artifact by hash
     */
    ArtifactStorageService.prototype.get = function (hash) {
        return __awaiter(this, void 0, void 0, function () {
            var metadata, metadataPath, data, artifact, error_2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        // Validate hash format
                        artifact_1.contentHashSchema.parse(hash);
                        metadata = this.artifactIndex.get(hash);
                        if (metadata) {
                            // Update access stats
                            metadata.accessCount++;
                            metadata.lastAccessedAt = new Date();
                            return [2 /*return*/, metadata.artifact];
                        }
                        metadataPath = this.getMetadataPath(hash);
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, fs_1.promises.readFile(metadataPath, "utf-8")];
                    case 2:
                        data = _a.sent();
                        artifact = artifact_1.realityArtifactSchema.parse(JSON.parse(data));
                        // Add to index
                        this.artifactIndex.set(hash, {
                            artifact: artifact,
                            storedAt: new Date(),
                            accessCount: 1,
                            lastAccessedAt: new Date(),
                        });
                        return [2 /*return*/, artifact];
                    case 3:
                        error_2 = _a.sent();
                        if (error_2.code === "ENOENT") {
                            return [2 /*return*/, null];
                        }
                        throw error_2;
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Retrieve artifact content by hash
     */
    ArtifactStorageService.prototype.getContent = function (hash) {
        return __awaiter(this, void 0, void 0, function () {
            var objectPath, error_3;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        objectPath = this.getObjectPath(hash);
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, fs_1.promises.readFile(objectPath)];
                    case 2: return [2 /*return*/, _a.sent()];
                    case 3:
                        error_3 = _a.sent();
                        if (error_3.code === "ENOENT") {
                            return [2 /*return*/, null];
                        }
                        throw error_3;
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Check if an artifact exists
     */
    ArtifactStorageService.prototype.exists = function (hash) {
        return __awaiter(this, void 0, void 0, function () {
            var objectPath, _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (this.artifactIndex.has(hash)) {
                            return [2 /*return*/, true];
                        }
                        objectPath = this.getObjectPath(hash);
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, fs_1.promises.access(objectPath)];
                    case 2:
                        _b.sent();
                        return [2 /*return*/, true];
                    case 3:
                        _a = _b.sent();
                        return [2 /*return*/, false];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Validate an artifact schema
     */
    ArtifactStorageService.prototype.validate = function (artifact) {
        try {
            var validated = artifact_1.realityArtifactSchema.parse(artifact);
            return { valid: true, errors: [], artifact: validated };
        }
        catch (error) {
            if (error.errors) {
                return {
                    valid: false,
                    errors: error.errors.map(function (e) { return ({
                        path: e.path.join("."),
                        message: e.message,
                    }); }),
                };
            }
            return {
                valid: false,
                errors: [{ path: "", message: error.message }],
            };
        }
    };
    /**
     * Validate artifact content integrity
     */
    ArtifactStorageService.prototype.verifyIntegrity = function (hash) {
        return __awaiter(this, void 0, void 0, function () {
            var content, computedHash;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.getContent(hash)];
                    case 1:
                        content = _a.sent();
                        if (!content) {
                            return [2 /*return*/, false];
                        }
                        computedHash = this.computeHash(content);
                        return [2 /*return*/, computedHash === hash];
                }
            });
        });
    };
    // ===========================================================================
    // QUERY OPERATIONS
    // ===========================================================================
    /**
     * Query artifacts by various criteria
     */
    ArtifactStorageService.prototype.query = function (query) {
        return __awaiter(this, void 0, void 0, function () {
            var results, _loop_1, this_1, _i, _a, _b, _, metadata, offset, limit;
            var _c, _d, _e;
            return __generator(this, function (_f) {
                results = [];
                _loop_1 = function (_, metadata) {
                    var artifact = metadata.artifact;
                    // Apply filters
                    if (query.system && artifact.origin.system !== query.system)
                        return "continue";
                    if (query.type && artifact.scope.type !== query.type)
                        return "continue";
                    if (query.agentId && artifact.origin.agent !== query.agentId)
                        return "continue";
                    if (query.siteId && artifact.scope.siteId !== query.siteId)
                        return "continue";
                    if (query.assetId && artifact.scope.assetId !== query.assetId)
                        return "continue";
                    // Tag filter (all must match)
                    if (query.tags && query.tags.length > 0) {
                        var artifactTags_1 = (_c = artifact.scope.tags) !== null && _c !== void 0 ? _c : [];
                        if (!query.tags.every(function (t) { return artifactTags_1.includes(t); }))
                            return "continue";
                    }
                    // Dependency filters
                    if (query.dependsOn && !artifact.dependencies.includes(query.dependsOn))
                        return "continue";
                    if (query.dependentOf) {
                        var dependents = this_1.dependentIndex.get(query.dependentOf);
                        if (!dependents || !dependents.has(artifact.id))
                            return "continue";
                    }
                    // Time range filters
                    if (query.fromTimestamp && artifact.timestamp < query.fromTimestamp)
                        return "continue";
                    if (query.toTimestamp && artifact.timestamp > query.toTimestamp)
                        return "continue";
                    results.push(artifact);
                };
                this_1 = this;
                for (_i = 0, _a = this.artifactIndex; _i < _a.length; _i++) {
                    _b = _a[_i], _ = _b[0], metadata = _b[1];
                    _loop_1(_, metadata);
                }
                // Sort by timestamp descending
                results.sort(function (a, b) { return b.timestamp.localeCompare(a.timestamp); });
                offset = (_d = query.offset) !== null && _d !== void 0 ? _d : 0;
                limit = (_e = query.limit) !== null && _e !== void 0 ? _e : 100;
                return [2 /*return*/, results.slice(offset, offset + limit)];
            });
        });
    };
    /**
     * Get all dependents of an artifact
     */
    ArtifactStorageService.prototype.getDependents = function (hash) {
        var dependents = this.dependentIndex.get(hash);
        return dependents ? Array.from(dependents) : [];
    };
    /**
     * Get the full dependency graph for an artifact
     */
    ArtifactStorageService.prototype.getDependencyGraph = function (hash) {
        return __awaiter(this, void 0, void 0, function () {
            var nodes, visited, queue, currentHash, artifact, node, _i, _a, dep, _b, _c, dependent, _d, topologicalOrder, cycles;
            return __generator(this, function (_e) {
                switch (_e.label) {
                    case 0:
                        nodes = new Map();
                        visited = new Set();
                        queue = [hash];
                        _e.label = 1;
                    case 1:
                        if (!(queue.length > 0)) return [3 /*break*/, 3];
                        currentHash = queue.shift();
                        if (visited.has(currentHash))
                            return [3 /*break*/, 1];
                        visited.add(currentHash);
                        return [4 /*yield*/, this.get(currentHash)];
                    case 2:
                        artifact = _e.sent();
                        if (!artifact)
                            return [3 /*break*/, 1];
                        node = {
                            id: currentHash,
                            dependencies: artifact.dependencies,
                            dependents: this.getDependents(currentHash),
                        };
                        nodes.set(currentHash, node);
                        // Add dependencies to queue
                        for (_i = 0, _a = artifact.dependencies; _i < _a.length; _i++) {
                            dep = _a[_i];
                            if (!visited.has(dep)) {
                                queue.push(dep);
                            }
                        }
                        // Add dependents to queue
                        for (_b = 0, _c = node.dependents; _b < _c.length; _b++) {
                            dependent = _c[_b];
                            if (!visited.has(dependent)) {
                                queue.push(dependent);
                            }
                        }
                        return [3 /*break*/, 1];
                    case 3:
                        _d = this.computeTopologicalOrder(nodes), topologicalOrder = _d.topologicalOrder, cycles = _d.cycles;
                        return [2 /*return*/, { nodes: nodes, topologicalOrder: topologicalOrder, cycles: cycles }];
                }
            });
        });
    };
    /**
     * Compute topological order and detect cycles
     */
    ArtifactStorageService.prototype.computeTopologicalOrder = function (nodes) {
        var _a, _b, _c;
        var inDegree = new Map();
        var adjList = new Map();
        // Initialize
        for (var _i = 0, nodes_1 = nodes; _i < nodes_1.length; _i++) {
            var _d = nodes_1[_i], hash = _d[0], node = _d[1];
            inDegree.set(hash, 0);
            adjList.set(hash, []);
        }
        // Build adjacency list and in-degree count
        for (var _e = 0, nodes_2 = nodes; _e < nodes_2.length; _e++) {
            var _f = nodes_2[_e], hash = _f[0], node = _f[1];
            for (var _g = 0, _h = node.dependencies; _g < _h.length; _g++) {
                var dep = _h[_g];
                if (nodes.has(dep)) {
                    adjList.get(dep).push(hash);
                    inDegree.set(hash, ((_a = inDegree.get(hash)) !== null && _a !== void 0 ? _a : 0) + 1);
                }
            }
        }
        // Kahn's algorithm
        var queue = [];
        var result = [];
        for (var _j = 0, inDegree_1 = inDegree; _j < inDegree_1.length; _j++) {
            var _k = inDegree_1[_j], hash = _k[0], degree = _k[1];
            if (degree === 0) {
                queue.push(hash);
            }
        }
        while (queue.length > 0) {
            var node = queue.shift();
            result.push(node);
            for (var _l = 0, _m = (_b = adjList.get(node)) !== null && _b !== void 0 ? _b : []; _l < _m.length; _l++) {
                var neighbor = _m[_l];
                var newDegree = ((_c = inDegree.get(neighbor)) !== null && _c !== void 0 ? _c : 1) - 1;
                inDegree.set(neighbor, newDegree);
                if (newDegree === 0) {
                    queue.push(neighbor);
                }
            }
        }
        if (result.length === nodes.size) {
            return { topologicalOrder: result };
        }
        // Cycle detected - find cycles
        var cycles = [];
        var remaining = new Set(nodes.keys());
        for (var _o = 0, result_1 = result; _o < result_1.length; _o++) {
            var hash = result_1[_o];
            remaining.delete(hash);
        }
        // Simple cycle detection (not comprehensive)
        if (remaining.size > 0) {
            cycles.push(Array.from(remaining));
        }
        return { cycles: cycles };
    };
    // ===========================================================================
    // STATISTICS
    // ===========================================================================
    /**
     * Get storage statistics
     */
    ArtifactStorageService.prototype.getStats = function () {
        return __awaiter(this, void 0, void 0, function () {
            var byType, bySystem, totalSize, totalDependencies, oldestTimestamp, newestTimestamp, _i, _a, _b, _, metadata, artifact, totalArtifacts;
            var _c, _d;
            return __generator(this, function (_e) {
                byType = {};
                bySystem = {};
                totalSize = 0;
                totalDependencies = 0;
                for (_i = 0, _a = this.artifactIndex; _i < _a.length; _i++) {
                    _b = _a[_i], _ = _b[0], metadata = _b[1];
                    artifact = metadata.artifact;
                    // Count by type
                    byType[artifact.scope.type] = ((_c = byType[artifact.scope.type]) !== null && _c !== void 0 ? _c : 0) + 1;
                    // Count by system
                    bySystem[artifact.origin.system] = ((_d = bySystem[artifact.origin.system]) !== null && _d !== void 0 ? _d : 0) + 1;
                    // Sum size
                    totalSize += artifact.content.size;
                    // Sum dependencies
                    totalDependencies += artifact.dependencies.length;
                    // Track timestamps
                    if (!oldestTimestamp || artifact.timestamp < oldestTimestamp) {
                        oldestTimestamp = artifact.timestamp;
                    }
                    if (!newestTimestamp || artifact.timestamp > newestTimestamp) {
                        newestTimestamp = artifact.timestamp;
                    }
                }
                totalArtifacts = this.artifactIndex.size;
                return [2 /*return*/, {
                        totalArtifacts: totalArtifacts,
                        totalSize: totalSize,
                        byType: byType,
                        bySystem: bySystem,
                        avgDependencies: totalArtifacts > 0 ? totalDependencies / totalArtifacts : 0,
                        oldestTimestamp: oldestTimestamp,
                        newestTimestamp: newestTimestamp,
                    }];
            });
        });
    };
    /**
     * Get all artifact IDs
     */
    ArtifactStorageService.prototype.getAllIds = function () {
        return Array.from(this.artifactIndex.keys());
    };
    /**
     * Get count of stored artifacts
     */
    ArtifactStorageService.prototype.getCount = function () {
        return this.artifactIndex.size;
    };
    return ArtifactStorageService;
}(events_1.EventEmitter));
exports.ArtifactStorageService = ArtifactStorageService;
// =============================================================================
// SINGLETON INSTANCE
// =============================================================================
exports.artifactStorage = new ArtifactStorageService({
    lfsDir: (_a = process.env.ARTIFACT_LFS_DIR) !== null && _a !== void 0 ? _a : "./artifacts/lfs",
    enableIndex: true,
    maxContentSize: parseInt((_b = process.env.ARTIFACT_MAX_SIZE) !== null && _b !== void 0 ? _b : "0"),
    enableDeduplication: process.env.ARTIFACT_DEDUP !== "false",
});
// =============================================================================
// INITIALIZATION HELPER
// =============================================================================
function initArtifactStorage(config) {
    return __awaiter(this, void 0, void 0, function () {
        var service;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    service = config
                        ? new ArtifactStorageService(config)
                        : exports.artifactStorage;
                    return [4 /*yield*/, service.initialize()];
                case 1:
                    _a.sent();
                    return [2 /*return*/, service];
            }
        });
    });
}
