/**
 * @file search-context-manager.js
 * @description
 * Extended ContextManager for search operations with optimized scoring.
 * Provides batch operations and integration helpers for searchNodes.
 */

import { ContextManager } from './context-manager.js';
import { calculateRelevanceScore, createScoringConfig } from './scoring-utils.js';

/**
 * @typedef {Object} SearchContextOptions
 * @property {number} [contextSize=5] - Number of recent entities to consider
 * @property {number} [preloadDepth=2] - Graph preload depth
 */

/**
 * @typedef {Object} QueryContext
 * @property {string} query - The search query
 * @property {Date} timestamp - When context was prepared
 * @property {number} contextSize - Size of context used
 * @property {number} preloadDepth - Depth of graph preload
 */

/**
 * @typedef {Object} SearchContext
 * @property {Array<string>} recentEntityIds - Recently accessed entity IDs
 * @property {QueryContext} queryContext - Query-specific context information
 */

/**
 * @typedef {Object} EntityData
 * @property {string|number} [id] - Entity ID
 * @property {string|number} [entity_id] - Alternative entity ID field
 * @property {string} [name] - Entity name
 * @property {string|Date} [created_at] - Creation timestamp
 * @property {string|Date} [createdAt] - Alternative creation timestamp field
 * @property {string|Date} [last_accessed] - Last access timestamp
 * @property {string|Date} [lastAccessed] - Alternative last access field
 * @property {number} [access_count] - Access count
 * @property {number} [accessCount] - Alternative access count field
 * @property {string} [importance] - Importance level
 */

/**
 * @typedef {Object} ScoredEntity
 * @property {number} score - Final relevance score
 * @property {Object} [scoreComponents] - Individual score components
 * @property {number|null} contextDistance - Distance from context
 * @property {string|number} [id] - Entity ID
 * @property {string|number} [entity_id] - Alternative entity ID field
 * @property {string} [name] - Entity name
 */

/**
 * @typedef {Object} ScoringOptions
 * @property {boolean} [includeComponents=false] - Whether to include score components
 * @property {string|Object} [scoringProfile='balanced'] - Scoring profile name or custom weights
 */

/**
 * @typedef {Object} SearchStats
 * @property {import('./context-manager.js').FullPerformanceStats} performance - Performance statistics
 * @property {import('./context-manager.js').ContextCacheStats} cache - Cache statistics
 * @property {Date} timestamp - Statistics timestamp
 */

/**
 * SearchContextManager extends ContextManager with search-specific functionality.
 * Optimized for batch scoring and search result enhancement.
 * @class
 */
export class SearchContextManager extends ContextManager {
    /**
     * Prepare search context by preloading recent entities and graph data.
     * 
     * @param {string} query - Search query (for future query-based context)
     * @param {SearchContextOptions} [options={}] - Context preparation options
     * @returns {Promise<SearchContext>} Prepared context object
     * 
     * @example
     * const context = await searchContextManager.prepareSearchContext('relevance scoring');
     * // Returns: { recentEntityIds: [...], queryContext: {...} }
     */
    async prepareSearchContext(query, options = {}) {
        const {
            contextSize = 5,
            preloadDepth = 2
        } = options;
        
        const recentEntityIds = await this.getRecentlyAccessedEntities(contextSize);

        if (recentEntityIds.length > 0) {
            await this.preloadGraphSubset(recentEntityIds, preloadDepth);
        }
        
        return {
            recentEntityIds,
            queryContext: {
                query,
                timestamp: new Date(),
                contextSize,
                preloadDepth
            }
        };
    }
    
    /**
     * Score search results with relevance scoring and context.
     * 
     * @param {Array<EntityData>} results - Search results with entity data
     * @param {SearchContext} context - Search context from prepareSearchContext
     * @param {ScoringOptions} [options={}] - Scoring options
     * @returns {Promise<Array<ScoredEntity>>} Enhanced results with scores
     * 
     * @example
     * const scoredResults = await searchContextManager.scoreSearchResults(
     *     [{ entity_id: '123', name: 'Project_MEMENTO', ... }],
     *     context
     * );
     */
    async scoreSearchResults(results, context, options = {}) {
        if (!results || results.length === 0) {
            return [];
        }
        
        // Create scoring config from profile or custom weights
        const scoringConfig = createScoringConfig(options.scoringProfile || 'balanced');
        
        const entityIds = results.map(r => r.entity_id || r.id);
        const contextDistances = await this.getContextualDistances(
            entityIds,
            context.recentEntityIds
        );
        
        const scoredResults = [];
        
        for (const result of results) {
            const entityId = result.entity_id || result.id;
            const contextDistance = contextDistances.get(entityId);
            
            const scoreData = calculateRelevanceScore(
                {
                    createdAt: result.created_at || result.createdAt,
                    lastAccessed: result.last_accessed || result.lastAccessed,
                    accessCount: result.access_count || result.accessCount || 0,
                    importance: result.importance
                },
                contextDistance,
                scoringConfig  // Pass the custom config
            );
            
            scoredResults.push({
                ...result,
                score: scoreData.finalScore,
                scoreComponents: options.includeComponents ? scoreData.components : undefined,
                contextDistance: contextDistance
            });
        }
        
        scoredResults.sort((a, b) => b.score - a.score);
        
        return scoredResults;
    }

    /**
     * Score entities in batch with all relevance factors.
     * 
     * @param {Array<EntityData>} entityData - Array of entities with metadata
     * @param {Array<string>} contextIds - Context entity IDs for distance calculation
     * @param {import('./scoring-utils.js').DEFAULT_SCORING_CONFIG} [config] - Scoring configuration
     * @returns {Promise<Array<ScoredEntity>>} Entities with added scores
     * 
     * @example
     * const scored = await searchContextManager.scoreEntitiesBatch(
     *     [{ id: '123', name: 'Entity1', created_at: '2025-08-16', ... }],
     *     ['456', '789']
     * );
     */
    async scoreEntitiesBatch(entityData, contextIds = [], config = undefined) {
        if (!entityData || entityData.length === 0) {
            return [];
        }
        
        const entityIds = entityData.map(e => e.id || e.entity_id);
        
        let contextDistances = new Map();
        if (contextIds && contextIds.length > 0) {
            contextDistances = await this.getContextualDistances(entityIds, contextIds);
        }
        
        return entityData.map(entity => {
            const entityId = entity.id || entity.entity_id;
            const contextDistance = contextDistances.get(entityId) || null;
            
            const scoreData = calculateRelevanceScore(
                {
                    createdAt: entity.created_at || entity.createdAt,
                    lastAccessed: entity.last_accessed || entity.lastAccessed,
                    accessCount: entity.access_count || entity.accessCount || 0,
                    importance: entity.importance
                },
                contextDistance,
                config
            );
            
            return {
                ...entity,
                score: scoreData.finalScore,
                scoreComponents: scoreData.components,
                contextDistance
            };
        });
    }
    
    /**
     * Get enhanced search statistics.
     * 
     * @returns {SearchStats} Combined performance and cache statistics
     */
    getSearchStats() {
        return {
            performance: this.getPerformanceStats(),
            cache: this.getCacheStats(),
            timestamp: new Date()
        };
    }
}

/**
 * Factory function to create SearchContextManager.
 * 
 * @param {import('./graph-repository.js').GraphRepository} repository - Repository implementation
 * @returns {SearchContextManager} Search context manager instance
 */
export function createSearchContextManager(repository) {
    return new SearchContextManager(repository);
}

export default SearchContextManager;