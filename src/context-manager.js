/**
 * @file context-manager.js
 * @description
 * Manages contextual information for relevance scoring.
 * Tracks recently accessed entities and provides context-aware scoring support.
 */

import { ImportanceLevel } from './scoring-utils.js';

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
     * Database connection for querying recent entities.
     * @private
     * @type {import('sqlite').Database|null}
     */
    #db = null;

    /**
     * Creates a new ContextManager.
     * @param {import('sqlite').Database} db - Database connection
     */
    constructor(db) {
        this.#db = db;
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
            const query = `
                SELECT DISTINCT entity_id 
                FROM observations 
                WHERE last_accessed IS NOT NULL 
                ORDER BY last_accessed DESC 
                LIMIT ?
            `;
            
            const results = await this.#db.all(query, [Math.min(limit, contextCache.maxRecentEntities)]);
            
            contextCache.recentEntities = results.map(r => r.entity_id);
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
     * @param {Array<string>} entityIds - Entity IDs to update
     * @returns {Promise<void>}
     * 
     * @example
     * await contextManager.updateAccessStats(['Entity1', 'Entity2']);
     */
    async updateAccessStats(entityIds) {
        if (!entityIds || entityIds.length === 0) {
            return;
        }
        
        try {
            const placeholders = entityIds.map(() => '?').join(',');

            const updateQuery = `
                UPDATE observations 
                SET access_count = COALESCE(access_count, 0) + 1,
                    last_accessed = datetime('now')
                WHERE entity_id IN (${placeholders})
            `;
            
            await this.#db.run(updateQuery, entityIds);
            contextCache.lastUpdate = null;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Calculate graph distance between two entities using BFS.
     * Limited to a maximum depth to prevent expensive searches.
     * 
     * @param {string} fromEntityId - Source entity ID
     * @param {string} toEntityId - Target entity ID
     * @param {number} [maxDepth=3] - Maximum search depth
     * @returns {Promise<number|null>} Distance or null if not connected
     * 
     * @example
     * const distance = await contextManager.calculateGraphDistance('Entity1', 'Entity2');
     * // Returns: 2 (two hops away)
     */
    async calculateGraphDistance(fromEntityId, toEntityId, maxDepth = 3) {
        if (fromEntityId === toEntityId) {
            return 0;
        }
        
        try {
            const visited = new Set([fromEntityId]);
            const queue = [{ entityId: fromEntityId, depth: 0 }];
            
            while (queue.length > 0) {
                const { entityId, depth } = queue.shift();
                
                if (depth >= maxDepth) {
                    break;
                }

                const query = `
                    SELECT DISTINCT target_entity_id as connected
                    FROM relations 
                    WHERE source_entity_id = ?
                    UNION
                    SELECT DISTINCT source_entity_id as connected
                    FROM relations 
                    WHERE target_entity_id = ?
                `;

                /** @type {Array<{connected: string}>} */
                const connections = await this.#db.all(query, [entityId, entityId]);
                
                for (const conn of connections) {
                    if (conn.connected === toEntityId) {
                        return depth + 1;
                    }
                    
                    if (!visited.has(conn.connected)) {
                        visited.add(conn.connected);
                        queue.push({ entityId: conn.connected, depth: depth + 1 });
                    }
                }
            }
            
            return null;

        } catch (error) {
            return null;
        }
    }

    /**
     * Get contextual scores for multiple entities based on their distance
     * from recently accessed entities.
     * 
     * @param {Array<string>} entityIds - Entity IDs to score
     * @param {Array<string>} [contextEntityIds=null] - Context entities (or use recent)
     * @returns {Promise<Map<string, number>>} Map of entity ID to minimum distance
     * 
     * @example
     * const distances = await contextManager.getContextualDistances(['E1', 'E2', 'E3']);
     * // Returns: Map { 'E1' => 1, 'E2' => 2, 'E3' => null }
     */
    async getContextualDistances(entityIds, contextEntityIds = null) {
        const distances = new Map();
        const contextEntities = contextEntityIds ||
            await this.getRecentlyAccessedEntities();
        
        if (contextEntities.length === 0) {
            entityIds.forEach(id => distances.set(id, null));

            return distances;
        }
        
        for (const entityId of entityIds) {
            let minDistance = null;
            
            for (const contextId of contextEntities) {
                const distance = await this.calculateGraphDistance(contextId, entityId);
                
                if (distance !== null) {
                    minDistance = minDistance === null ? 
                        distance : 
                        Math.min(minDistance, distance);
                }
                
                if (minDistance === 1) {
                    break;
                }
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
     * 
     * @example
     * await contextManager.setImportance('Project_MEMENTO', ImportanceLevel.CRITICAL);
     * // Also accepts string values for backward compatibility
     * await contextManager.setImportance('Session_2025', 'normal');
     */
    async setImportance(entityId, importance) {
        const validLevels = Object.values(ImportanceLevel);
        
        if (!validLevels.includes(importance)) {
            throw new Error(`Invalid importance level: ${importance}. Use ImportanceLevel enum values.`);
        }
        
        try {
            const query = `
                UPDATE observations 
                SET importance = ?
                WHERE entity_id = ?
            `;
            
            const result = await this.#db.run(query, [importance, entityId]);

            return result.changes > 0;
        } catch (error) {
            return false;
        }
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
            const currentQuery = `
                SELECT id, tags 
                FROM observations 
                WHERE entity_id = ? 
                LIMIT 1
            `;

            /** @type {{id: number, tags: string}} */
            const current = await this.#db.get(currentQuery, [entityId]);
            if (!current) {
                return false;
            }
            
            const existingTags = current.tags ? JSON.parse(current.tags) : [];
            const newTags = [...new Set([...existingTags, ...tags])];

            const updateQuery = `
                UPDATE observations 
                SET tags = ?
                WHERE entity_id = ?
            `;
            
            await this.#db.run(updateQuery, [JSON.stringify(newTags), entityId]);

            return true;

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
 * @param {import('sqlite').Database} db - Database connection
 * @returns {ContextManager} Context manager instance
 */
export function getContextManager(db) {
    if (!contextManagerInstance) {
        contextManagerInstance = new ContextManager(db);
    }

    return contextManagerInstance;
}

export default ContextManager;