/**
 * @file context-manager.js
 * @description
 * Manages contextual information for relevance scoring.
 * Tracks recently accessed entities and provides context-aware scoring support.
 */

import { ImportanceLevel } from './scoring-utils.js';

/**
 * @typedef {Object} CacheMetrics
 * @property {number} hits - Number of cache hits
 * @property {number} misses - Number of cache misses  
 * @property {number} totalRequests - Total number of requests
 */

/**
 * @typedef {Object} CacheSize
 * @property {number} adjacency - Size of adjacency cache
 * @property {number} distance - Size of distance cache
 */

/**
 * @typedef {Object} GraphCacheMetrics
 * @property {number} hits - Number of cache hits
 * @property {number} misses - Number of cache misses
 * @property {number} totalRequests - Total requests
 * @property {number} hitRate - Hit rate ratio (0-1)
 * @property {CacheSize} size - Cache sizes
 */

/**
 * @typedef {Object} PerformanceStats
 * @property {number} bfsCount - Number of BFS operations
 * @property {number} totalBFSTime - Total time spent in BFS (ms)
 * @property {number} cacheHits - Number of cache hits
 * @property {number} totalRequests - Total requests
 */

/**
 * @typedef {Object} BFSStats
 * @property {number} count - Number of BFS operations
 * @property {number} avgTimeMs - Average time per BFS operation
 */

/**
 * @typedef {Object} CacheStats
 * @property {number} contextHitRate - Context cache hit rate (0-1)
 * @property {number} graphHitRate - Graph cache hit rate (0-1)
 * @property {CacheSize} graphCacheSize - Graph cache sizes
 */

/**
 * @typedef {Object} TotalStats
 * @property {number} requests - Total requests
 * @property {number} cacheHits - Total cache hits
 * @property {number} graphRequests - Total graph requests
 * @property {number} graphHits - Total graph hits
 */

/**
 * @typedef {Object} FullPerformanceStats
 * @property {BFSStats} bfs - BFS statistics
 * @property {CacheStats} cache - Cache statistics
 * @property {TotalStats} totals - Total statistics
 */

/**
 * @typedef {Object} ContextCacheStats
 * @property {boolean} cacheValid - Whether cache is valid
 * @property {number} recentEntitiesCount - Number of recent entities cached
 * @property {Date|null} lastUpdate - Last cache update time
 * @property {number} ttlSeconds - Cache TTL in seconds
 * @property {number} maxRecentEntities - Maximum recent entities to cache
 */

/**
 * GraphCache for optimizing graph traversal operations.
 * Caches adjacency lists and computed distances between nodes.
 * @private
 */
class GraphCache {
    /**
     * Map of entity_id to Set of connected entity IDs
     * @type {Map<string, Set<string>>}
     */
    #adjacencyCache = new Map();
    
    /**
     * Map of "from_id:to_id" to distance
     * @type {Map<string, number>}
     */
    #distanceCache = new Map();
    
    /**
     * Cache expiry timestamp
     * @type {number}
     */
    #cacheExpiry = Date.now() + 5 * 60 * 1000; // 5 minutes
    
    /**
     * Performance metrics
     * @type {CacheMetrics}
     */
    #metrics = {
        hits: 0,
        misses: 0,
        totalRequests: 0
    };
    
    /**
     * Check if cache is still valid
     * @returns {boolean}
     */
    isValid() {
        return Date.now() < this.#cacheExpiry;
    }
    
    /**
     * Get cached distance between two entities
     * @param {string} from - Source entity ID
     * @param {string} to - Target entity ID
     * @returns {number|null} Distance or null if not cached
     */
    getDistance(from, to) {
        this.#metrics.totalRequests++;
        const key = `${from}:${to}`;
        const distance = this.#distanceCache.get(key);
        
        if (distance !== undefined) {
            this.#metrics.hits++;
            return distance;
        }
        
        this.#metrics.misses++;

        return null;
    }
    
    /**
     * Cache distance between two entities
     * @param {string} from - Source entity ID
     * @param {string} to - Target entity ID
     * @param {number|null} distance - Distance to cache
     */
    setDistance(from, to, distance) {
        const key = `${from}:${to}`;
        this.#distanceCache.set(key, distance);
    }
    
    /**
     * Get cached adjacency list for an entity
     * @param {string} entityId - Entity ID
     * @returns {Set<string>|null} Set of connected entity IDs or null
     */
    getAdjacent(entityId) {
        return this.#adjacencyCache.get(entityId) || null;
    }
    
    /**
     * Cache adjacency list for an entity
     * @param {string} entityId - Entity ID
     * @param {Set<string>} connections - Connected entity IDs
     */
    setAdjacent(entityId, connections) {
        this.#adjacencyCache.set(entityId, connections);
    }
    
    /**
     * Clear all cached data
     */
    clear() {
        this.#adjacencyCache.clear();
        this.#distanceCache.clear();
        this.#cacheExpiry = Date.now() + 5 * 60 * 1000;
        this.#metrics = { hits: 0, misses: 0, totalRequests: 0 };
    }
    
    /**
     * Get cache performance metrics
     * @returns {GraphCacheMetrics} Cache metrics
     */
    getMetrics() {
        return {
            ...this.#metrics,
            hitRate: this.#metrics.totalRequests > 0 
                ? this.#metrics.hits / this.#metrics.totalRequests 
                : 0,
            size: {
                adjacency: this.#adjacencyCache.size,
                distance: this.#distanceCache.size
            }
        };
    }
}

/**
 * In-memory cache for context data.
 * @private
 */
const contextCache = {
    recentEntities: [],
    lastUpdate: null,
    ttl: 5 * 60 * 1000, // 5 minutes in milliseconds
    maxRecentEntities: 10
};

/**
 * ContextManager class for managing search context and recently accessed entities.
 * @class
 */
export class ContextManager {
    /**
     * Repository abstraction for backend access.
     * @private
     * @type {import('./graph-repository.js').GraphRepository|null}
     */
    #repository = null;

    /**
     * Graph cache for optimizing traversal operations
     * @private
     * @type {GraphCache}
     */
    #graphCache = new GraphCache();

    /**
     * Performance tracking
     * @private
     * @type {PerformanceStats}
     */
    #performanceStats = {
        bfsCount: 0,
        totalBFSTime: 0,
        cacheHits: 0,
        totalRequests: 0
    };

    /**
     * Creates a new ContextManager.
     * @param {import('./graph-repository.js').GraphRepository} repository - Repository implementation
     */
    constructor(repository) {
        this.#repository = repository;
    }

    /**
     * Check if the context cache is still valid.
     * @private
     * @returns {boolean} True if cache is valid
     */
    #isCacheValid() {
        if (!contextCache.lastUpdate) {
            return false;
        }
        
        const now = Date.now();
        const age = now - contextCache.lastUpdate;

        return age < contextCache.ttl;
    }

    /**
     * Convert entity names to IDs (batch operation).
     * 
     * @param {Array<string>} names - Entity names
     * @returns {Promise<Map<string, string>>} Map of name to ID
     * 
     * @example
     * const idMap = await contextManager.getEntityIdsByNames(['Project_MEMENTO', 'User']);
     * // Returns: Map { 'Project_MEMENTO' => '123', 'User' => '456' }
     */
    async getEntityIdsByNames(names) {
        if (!names || names.length === 0) {
            return new Map();
        }
        
        return this.#repository.getEntityIdsByNames(names);
    }

    /**
     * Convert entity IDs to names (batch operation).
     * 
     * @param {Array<string|number>} ids - Entity IDs
     * @returns {Promise<Map<string, string>>} Map of ID to name
     * 
     * @example
     * const nameMap = await contextManager.getEntityNamesByIds(['123', '456']);
     * // Returns: Map { '123' => 'Project_MEMENTO', '456' => 'User' }
     */
    async getEntityNamesByIds(ids) {
        if (!ids || ids.length === 0) {
            return new Map();
        }
        
        return this.#repository.getEntityNamesByIds(ids);
    }

    /**
     * Preload adjacency lists for a subset of entities.
     * 
     * @param {Array<string>} entityIds - Entity IDs to preload
     * @param {number} [depth=2] - Depth to preload
     * @returns {Promise<void>}
     */
    async preloadGraphSubset(entityIds, depth = 2) {
        if (!entityIds || entityIds.length === 0) {
            return;
        }
        
        if (!this.#graphCache.isValid()) {
            this.#graphCache.clear();
        }
        
        const toProcess = new Set(entityIds);
        const processed = new Set();
        
        for (let d = 0; d < depth; d++) {
            const currentLevel = Array.from(toProcess);
            toProcess.clear();
            
            /** @type {{from_id: any, to_id: any}[]} */
            const relations = await this.#repository.getRelationsForEntityIds(currentLevel);
            const adjacencyMap = new Map();
            
            for (const entityId of currentLevel) {
                if (!adjacencyMap.has(entityId)) {
                    adjacencyMap.set(entityId, new Set());
                }
            }
            
            for (const rel of relations) {
                const sourceId = rel.from_id.toString();
                const targetId = rel.to_id.toString();
                
                if (!adjacencyMap.has(sourceId)) {
                    adjacencyMap.set(sourceId, new Set());
                }

                if (!adjacencyMap.has(targetId)) {
                    adjacencyMap.set(targetId, new Set());
                }
                
                adjacencyMap.get(sourceId).add(targetId);
                adjacencyMap.get(targetId).add(sourceId);
                
                if (!processed.has(targetId)) {
                    toProcess.add(targetId);
                }

                if (!processed.has(sourceId)) {
                    toProcess.add(sourceId);
                }
            }
            
            for (const [entityId, connections] of adjacencyMap) {
                this.#graphCache.setAdjacent(entityId, connections);
                processed.add(entityId);
            }
        }
    }

    /**
     * Get recently accessed entities from cache or database.
     * 
     * @param {number} [limit=5] - Maximum number of entities to return
     * @returns {Promise<Array<string>>} Array of entity IDs
     * 
     * @example
     * const recentIds = await contextManager.getRecentlyAccessedEntities(5);
     * // Returns: ['Entity1', 'Entity2', 'Entity3', ...]
     */
    async getRecentlyAccessedEntities(limit = 5) {
        if (this.#isCacheValid() && contextCache.recentEntities.length > 0) {
            return contextCache.recentEntities.slice(0, limit);
        }
        
        try {
            contextCache.recentEntities = await this.#repository.getRecentlyAccessedEntities(Math.min(limit, contextCache.maxRecentEntities));
            contextCache.lastUpdate = Date.now();

            return contextCache.recentEntities.slice(0, limit);

        } catch (error) {
            return [];
        }
    }

    /**
     * Update access statistics for entities after a search.
     * Increments access count and updates last_accessed timestamp.
     * 
     * @param {Array<number>} entityIds - Entity IDs to update
     * @returns {Promise<void>}
     * 
     * @example
     * await contextManager.updateAccessStats([1, 2, 3]);
     */
    async updateAccessStats(entityIds) {
        if (!entityIds || entityIds.length === 0) {
            return;
        }
        
        try {
            await this.#repository.updateAccessStats(entityIds);
            contextCache.lastUpdate = null;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Calculate graph distance between two entities using BFS with caching.
     * Limited to a maximum depth to prevent expensive searches.
     * 
     * @param {string} fromEntityId - Source entity ID
     * @param {string} toEntityId - Target entity ID
     * @param {number} [maxDepth=3] - Maximum search depth
     * @returns {Promise<number|null>} Distance or null if not connected
     * 
     * @example
     * const distance = await contextManager.calculateGraphDistance('123', '456');
     * // Returns: 2 (two hops away)
     */
    async calculateGraphDistance(fromEntityId, toEntityId, maxDepth = 3) {
        if (fromEntityId === toEntityId) {
            return 0;
        }
        
        const startTime = Date.now();
        
        // Check cache first
        const cachedDistance = this.#graphCache.getDistance(fromEntityId, toEntityId);
        if (cachedDistance !== null) {
            this.#performanceStats.cacheHits++;
            return cachedDistance;
        }
        
        try {
            const visited = new Set([fromEntityId]);
            const queue = [{ entityId: fromEntityId, depth: 0 }];
            
            while (queue.length > 0) {
                const { entityId, depth } = queue.shift();
                
                if (depth >= maxDepth) {
                    break;
                }
                
                let connections = this.#graphCache.getAdjacent(entityId);
                
                if (!connections) {
                    const rows = await this.#repository.getRelationsForEntityIds([entityId]);
                    connections = new Set();
                    for (const row of rows) {
                        if (row.from_id.toString() === entityId.toString()) {
                            connections.add(row.to_id.toString());
                        }
                        if (row.to_id.toString() === entityId.toString()) {
                            connections.add(row.from_id.toString());
                        }
                    }
                    this.#graphCache.setAdjacent(entityId, connections);
                }
                
                if (connections.has(toEntityId)) {
                    const distance = depth + 1;
                    this.#graphCache.setDistance(fromEntityId, toEntityId, distance);
                    this.#graphCache.setDistance(toEntityId, fromEntityId, distance); // Undirected
                    
                    this.#performanceStats.bfsCount++;
                    this.#performanceStats.totalBFSTime += Date.now() - startTime;
                    
                    return distance;
                }
                
                for (const connectedId of connections) {
                    if (!visited.has(connectedId)) {
                        visited.add(connectedId);
                        queue.push({ entityId: connectedId, depth: depth + 1 });
                    }
                }
            }
            
            this.#graphCache.setDistance(fromEntityId, toEntityId, null);
            this.#performanceStats.bfsCount++;
            this.#performanceStats.totalBFSTime += Date.now() - startTime;
            
            return null;
            
        } catch (error) {
            return null;
        }
    }

    /**
     * Calculate graph distances for multiple entity pairs (batch operation).
     * Optimized for performance with caching and preloading.
     * 
     * @param {Array<string>} fromIds - Source entity IDs
     * @param {Array<string>} toIds - Target entity IDs
     * @param {number} [maxDepth=3] - Maximum search depth
     * @returns {Promise<Map<string, number|null>>} Map of "from:to" to distance
     * 
     * @example
     * const distances = await contextManager.calculateGraphDistanceBatch(
     *     ['123', '456'],
     *     ['789', '101'],
     *     3
     * );
     * // Returns: Map { '123:789' => 2, '123:101' => 3, '456:789' => 1, '456:101' => null }
     */
    async calculateGraphDistanceBatch(fromIds, toIds, maxDepth = 3) {
        const results = new Map();
        
        const allIds = [...new Set([...fromIds, ...toIds])];
        await this.preloadGraphSubset(allIds, Math.min(maxDepth, 2));
        
        for (const fromId of fromIds) {
            for (const toId of toIds) {
                const key = `${fromId}:${toId}`;
                const distance = await this.calculateGraphDistance(fromId, toId, maxDepth);
                results.set(key, distance);
            }
        }
        
        return results;
    }

    /**
     * Get contextual scores for multiple entities based on their distance
     * from recently accessed entities (optimized batch version).
     * 
     * @param {Array<string>} entityIds - Entity IDs to score
     * @param {Array<string>} [contextEntityIds=null] - Context entities (or use recent)
     * @returns {Promise<Map<string, number>>} Map of entity ID to minimum distance
     * 
     * @example
     * const distances = await contextManager.getContextualDistances(['123', '456', '789']);
     * // Returns: Map { '123' => 1, '456' => 2, '789' => null }
     */
    async getContextualDistances(entityIds, contextEntityIds = null) {
        const distances = new Map();
        
        const contextEntities = contextEntityIds ||
            await this.getRecentlyAccessedEntities();
        
        if (contextEntities.length === 0) {
            entityIds.forEach(id => distances.set(id, null));
            return distances;
        }
        
        const batchDistances = await this.calculateGraphDistanceBatch(
            contextEntities,
            entityIds
        );
        
        for (const entityId of entityIds) {
            let minDistance = null;
            
            for (const contextId of contextEntities) {
                const key = `${contextId}:${entityId}`;
                const distance = batchDistances.get(key);
                
                if (distance !== null) {
                    minDistance = minDistance === null ? 
                        distance : 
                        Math.min(minDistance, distance);
                }
                
                if (minDistance === 1) break;
            }
            
            distances.set(entityId, minDistance);
        }
        
        return distances;
    }

    /**
     * Set importance level for an entity.
     * 
     * @param {string} entityId - Entity ID
     * @param {string} importance - Importance level from ImportanceLevel enum
     * @returns {Promise<boolean>} Success status
     */
    async setImportance(entityId, importance) {
        const validLevels = Object.values(ImportanceLevel);
        
        if (!validLevels.includes(importance)) {
            throw new Error(`Invalid importance level: ${importance}. Use ImportanceLevel enum values.`);
        }
        
        return this.#repository.setImportance(entityId, importance);
    }
    
    /**
     * Add tags to an entity's observations.
     * 
     * @param {string} entityId - Entity ID
     * @param {Array<string>|string} tags - Tags to add
     * @returns {Promise<boolean>} Success status
     * 
     * @example
     * await contextManager.addTags('Session_2025-08-16', ['completed', 'phase1']);
     */
    async addTags(entityId, tags) {
        if (!Array.isArray(tags)) {
            tags = [tags];
        }
        
        try {
            return await this.#repository.addTags(entityId, tags);
        } catch (error) {
            return false;
        }
    }

    /**
     * Clear the context cache.
     * Useful after significant data changes.
     */
    clearCache() {
        contextCache.recentEntities = [];
        contextCache.lastUpdate = null;
        this.#graphCache.clear();
    }
    
    /**
     * Get cache statistics for monitoring.
     * 
     * @returns {{
     *     cacheValid: boolean,
     *     recentEntitiesCount: number,
     *     lastUpdate: Date | null,
     *     ttlSeconds: number,
     *     maxRecentEntities: number
     * }} Cache statistics
     */
    getCacheStats() {
        return {
            cacheValid: this.#isCacheValid(),
            recentEntitiesCount: contextCache.recentEntities.length,
            lastUpdate: contextCache.lastUpdate ? new Date(contextCache.lastUpdate) : null,
            ttlSeconds: contextCache.ttl / 1000,
            maxRecentEntities: contextCache.maxRecentEntities
        };
    }
    
    /**
     * Get performance statistics for graph operations.
     * 
     * @returns {FullPerformanceStats} Performance metrics
     */
    getPerformanceStats() {
        const graphMetrics = this.#graphCache.getMetrics();
        
        return {
            bfs: {
                count: this.#performanceStats.bfsCount,
                avgTimeMs: this.#performanceStats.bfsCount > 0 
                    ? this.#performanceStats.totalBFSTime / this.#performanceStats.bfsCount
                    : 0
            },
            cache: {
                contextHitRate: this.#performanceStats.totalRequests > 0
                    ? this.#performanceStats.cacheHits / this.#performanceStats.totalRequests
                    : 0,
                graphHitRate: graphMetrics.hitRate,
                graphCacheSize: graphMetrics.size
            },
            totals: {
                requests: this.#performanceStats.totalRequests,
                cacheHits: this.#performanceStats.cacheHits,
                graphRequests: graphMetrics.totalRequests,
                graphHits: graphMetrics.hits
            }
        };
    }
    
    /**
     * Set cache TTL (time-to-live) in seconds.
     * 
     * @param {number} seconds - TTL in seconds
     */
    setCacheTTL(seconds) {
        contextCache.ttl = seconds * 1000;
        this.clearCache();
    }
}

/**
 * @type {ContextManager|null}
 */
let contextManagerInstance = null;

/**
 * Get or create a ContextManager instance.
 * 
 * @param {import('./graph-repository.js').GraphRepository} repository - Repository implementation
 * @returns {ContextManager} Context manager instance
 */
export function getContextManager(repository) {
    if (!contextManagerInstance) {
        contextManagerInstance = new ContextManager(repository);
    }

    return contextManagerInstance;
}

export default ContextManager;