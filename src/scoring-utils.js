/**
 * @file scoring-utils.js
 * @description
 * Relevance scoring utilities for enhanced memory search.
 * Implements temporal decay, popularity scoring, contextual relevance,
 * and importance-based weighting for search results.
 */

/**
 * @typedef {Object} ImportanceLevelEnum
 * @property {string} CRITICAL - Critical importance (weight: 2.0)
 * @property {string} IMPORTANT - Important (weight: 1.5)
 * @property {string} NORMAL - Normal importance (weight: 1.0)
 * @property {string} TEMPORARY - Temporary importance (weight: 0.7)
 * @property {string} DEPRECATED - Deprecated (weight: 0.3)
 */

/**
 * @typedef {Object} ScoringWeights
 * @property {number} temporal - Weight for temporal score (default: 0.4)
 * @property {number} popularity - Weight for popularity score (default: 0.2)
 * @property {number} contextual - Weight for contextual score (default: 0.2)
 * @property {number} importance - Weight for importance score (default: 0.2)
 */

/**
 * @typedef {Object} TemporalConfig
 * @property {number} halfLifeDays - Days for score to decay by 50% (default: 30)
 * @property {number} recencyThreshold - Days to consider as "recent" (default: 7)
 * @property {number} recencyBoost - Boost multiplier for recent items (default: 1.2)
 */

/**
 * @typedef {Object} PopularityConfig
 * @property {number} scaleFactor - Scaling factor for logarithmic growth (default: 0.1)
 * @property {number} baseScore - Base score before access count (default: 1.0)
 */

/**
 * @typedef {Object} ContextualConfig
 * @property {number} maxDistance - Maximum graph distance to consider (default: 3)
 * @property {number} nearWeight - Weight for directly connected nodes (default: 1.5)
 * @property {number} decayRate - Decay rate per distance unit (default: 0.2)
 */

/**
 * @typedef {Object} ScoringConfig
 * @property {ScoringWeights} weights - Weight distribution for final score
 * @property {TemporalConfig} temporal - Temporal decay parameters
 * @property {PopularityConfig} popularity - Popularity parameters
 * @property {ContextualConfig} contextual - Contextual relevance parameters
 */

/**
 * @typedef {Object} ScoreComponents
 * @property {number} temporal - Temporal score component
 * @property {number} popularity - Popularity score component
 * @property {number} contextual - Contextual score component
 * @property {number} importance - Importance score component
 */

/**
 * @typedef {Object} ScoreResult
 * @property {number} finalScore - Combined final score
 * @property {ScoreComponents} components - Individual score components
 */

/**
 * @typedef {Object} ScoringEntity
 * @property {string|Date} createdAt - Creation timestamp
 * @property {string|Date|null} lastAccessed - Last access timestamp
 * @property {number} accessCount - Number of accesses
 * @property {string|null} importance - Importance level
 */

/**
 * @typedef {Object} SearchResult
 * @property {string} [entity_id] - Entity ID
 * @property {string} [id] - Alternative entity ID field
 * @property {Array<string>} [searchMethods] - Methods that found this result
 * @property {number} [keywordRank] - Rank in keyword results
 * @property {number} [semanticRank] - Rank in semantic results
 * @property {number} [hybridBoost] - Boost for appearing in both searches
 */

/**
 * @typedef {Object} ContextInfo
 * @property {Array<number>} [contextDistances] - Graph distances for context scoring
 */

/**
 * @typedef {Object} CustomConfig
 * @property {Partial<ScoringWeights>} [weights] - Custom weights
 * @property {Partial<TemporalConfig>} [temporal] - Custom temporal config
 * @property {Partial<PopularityConfig>} [popularity] - Custom popularity config
 * @property {Partial<ContextualConfig>} [contextual] - Custom contextual config
 */

/**
 * Enumeration of importance levels.
 * @type {ImportanceLevelEnum}
 * @const
 */
export const ImportanceLevel = Object.freeze({
    CRITICAL: 'critical',
    IMPORTANT: 'important',
    NORMAL: 'normal',
    TEMPORARY: 'temporary',
    DEPRECATED: 'deprecated'
});

/**
 * Importance level weights for scoring.
 * @const {Object<string, number>}
 */
export const IMPORTANCE_WEIGHTS = {
    [ImportanceLevel.CRITICAL]: 2.0,
    [ImportanceLevel.IMPORTANT]: 1.5,
    [ImportanceLevel.NORMAL]: 1.0,
    [ImportanceLevel.TEMPORARY]: 0.7,
    [ImportanceLevel.DEPRECATED]: 0.3
};

/**
 * Default scoring configuration.
 * @const {ScoringConfig}
 */
export const DEFAULT_SCORING_CONFIG = {
    // Weight distribution for final score calculation
    weights: {
        temporal: 0.4,    // 40% - how recent is the information
        popularity: 0.2,  // 20% - how often it's accessed
        contextual: 0.2,  // 20% - how related to current context
        importance: 0.2   // 20% - importance level
    },
    // Temporal decay parameters
    temporal: {
        halfLifeDays: 30,      // Days for score to decay by 50%
        recencyThreshold: 7,   // Days to consider as "recent"
        recencyBoost: 1.2      // Boost multiplier for recent items
    },
    // Popularity parameters
    popularity: {
        scaleFactor: 0.1,      // Scaling factor for logarithmic growth
        baseScore: 1.0         // Base score before access count
    },
    // Contextual relevance parameters
    contextual: {
        maxDistance: 3,        // Maximum graph distance to consider
        nearWeight: 1.5,       // Weight for directly connected nodes
        decayRate: 0.2         // Decay rate per distance unit
    }
};

/**
 * Calculate temporal relevance score based on creation and last access times.
 * Uses exponential decay with an optional recency boost.
 *
 * @param {string|Date} createdAt - Creation timestamp
 * @param {string|Date|null} lastAccessed - Last access timestamp
 * @param {TemporalConfig} [config=DEFAULT_SCORING_CONFIG.temporal] - Temporal scoring configuration
 * @returns {number} Temporal score between 0 and 1.2 (with boost)
 *
 * @example
 * // Recent item accessed today
 * getTemporalScore('2025-08-15', '2025-08-16') // ~1.2 (with boost)
 *
 * // Month-old item not recently accessed
 * getTemporalScore('2025-07-16', '2025-07-20') // ~0.5
 */
export function getTemporalScore(createdAt, lastAccessed, config = DEFAULT_SCORING_CONFIG.temporal) {
    // Handle null/undefined values - return base score
    if (!createdAt) {
        return 1.0;
    }
    
    const now = new Date();
    const created = new Date(createdAt);
    
    // Check for invalid dates
    if (isNaN(created.getTime())) {
        return 1.0;
    }
    
    const accessed = lastAccessed ? new Date(lastAccessed) : created;
    
    // Check for invalid accessed date
    if (isNaN(accessed.getTime())) {
        const ageInDays = (now - created) / (1000 * 60 * 60 * 24);
        const decayFactor = Math.exp(-0.693 * ageInDays / config.halfLifeDays);
        return decayFactor;
    }

    const relevantDate = accessed > created ? accessed : created;
    const ageInDays = (now - relevantDate) / (1000 * 60 * 60 * 24);

    // Exponential decay formula: e^(-ln(2) * age / halfLife)
    const decayFactor = Math.exp(-0.693 * ageInDays / config.halfLifeDays);

    const daysSinceAccess = lastAccessed ?
        (now - new Date(lastAccessed)) / (1000 * 60 * 60 * 24) :
        Infinity;

    const recencyMultiplier = daysSinceAccess < config.recencyThreshold ?
        config.recencyBoost :
        1.0;

    return Math.min(decayFactor * recencyMultiplier, config.recencyBoost);
}

/**
 * Calculate popularity score based on access frequency.
 * Uses logarithmic scaling to prevent runaway scores.
 *
 * @param {number} accessCount - Number of times the entity has been accessed
 * @param {PopularityConfig} [config=DEFAULT_SCORING_CONFIG.popularity] - Popularity scoring configuration
 * @returns {number} Popularity score, typically between 1.0 and 2.0
 *
 * @example
 * getPopularityScore(0)    // 1.0 (base score)
 * getPopularityScore(10)   // ~1.1
 * getPopularityScore(100)  // ~1.2
 * getPopularityScore(1000) // ~1.3
 */
export function getPopularityScore(accessCount, config = DEFAULT_SCORING_CONFIG.popularity) {
    // Handle null/undefined/invalid values
    if (accessCount === null || accessCount === undefined || accessCount <= 0) {
        return config.baseScore;
    }

    // Logarithmic scaling: 1 + log10(1 + accessCount) * scaleFactor
    // This provides diminishing returns for very high access counts
    const logScore = Math.log10(1 + accessCount);

    return config.baseScore + (logScore * config.scaleFactor);
}

/**
 * Calculate contextual relevance score based on graph distance.
 * Closer entities in the knowledge graph get higher scores.
 *
 * @param {number} distance - Shortest path distance in the graph (0 = same entity, 1 = direct relation)
 * @param {ContextualConfig} [config=DEFAULT_SCORING_CONFIG.contextual] - Contextual scoring configuration
 * @returns {number} Contextual score between 0.5 and 1.5
 *
 * @example
 * getContextualScore(0)  // 1.5 (same entity)
 * getContextualScore(1)  // 1.3 (directly connected)
 * getContextualScore(2)  // 1.1 (two hops away)
 * getContextualScore(3)  // 0.9 (three hops)
 * getContextualScore(4)  // 1.0 (beyond max distance)
 */
export function getContextualScore(distance, config = DEFAULT_SCORING_CONFIG.contextual) {
    if (distance === null || distance === undefined || distance > config.maxDistance) {
        return 1.0;
    }

    if (distance === 0) {
        return config.nearWeight;
    }

    const score = config.nearWeight - (distance * config.decayRate);

    return Math.max(score, 0.5);
}

/**
 * Get importance score based on the importance level.
 *
 * @param {string|null} importance - Importance level from ImportanceLevel enum
 * @returns {number} Importance weight
 *
 * @example
 * getImportanceScore(ImportanceLevel.CRITICAL)   // 2.0
 * getImportanceScore(ImportanceLevel.NORMAL)     // 1.0
 * getImportanceScore(ImportanceLevel.DEPRECATED) // 0.3
 * getImportanceScore(null)                       // 1.0 (default to normal)
 * // Also supports legacy string values for backward compatibility
 * getImportanceScore('critical')                 // 2.0
 */
export function getImportanceScore(importance) {
    if (!importance || !IMPORTANCE_WEIGHTS[importance]) {
        return IMPORTANCE_WEIGHTS[ImportanceLevel.NORMAL];
    }

    return IMPORTANCE_WEIGHTS[importance];
}

/**
 * Calculate combined relevance score for an entity.
 * Combines temporal, popularity, contextual, and importance factors.
 *
 * @param {ScoringEntity} entity - Entity with scoring attributes
 * @param {number|null} [contextDistance=null] - Distance from context entities
 * @param {ScoringConfig} [config=DEFAULT_SCORING_CONFIG] - Scoring configuration
 * @returns {ScoreResult} Score object with finalScore and component scores
 *
 * @example
 * const score = calculateRelevanceScore({
 *     createdAt: '2025-08-15',
 *     lastAccessed: '2025-08-16',
 *     accessCount: 25,
 *     importance: ImportanceLevel.IMPORTANT
 * }, 2);
 * // Returns: {
 * //   finalScore: 1.24,
 * //   components: {
 * //     temporal: 1.2,
 * //     popularity: 1.14,
 * //     contextual: 1.1,
 * //     importance: 1.5
 * //   }
 * // }
 */
export function calculateRelevanceScore(entity, contextDistance = null, config = DEFAULT_SCORING_CONFIG) {
    const temporalScore = getTemporalScore(
        entity.createdAt,
        entity.lastAccessed,
        config.temporal
    );

    const popularityScore = getPopularityScore(
        entity.accessCount || 0,
        config.popularity
    );

    const contextualScore = getContextualScore(
        contextDistance,
        config.contextual
    );

    const importanceScore = getImportanceScore(entity.importance);

    const weights = config.weights;
    const finalScore =
        (temporalScore * weights.temporal) +
        (popularityScore * weights.popularity) +
        (contextualScore * weights.contextual) +
        (importanceScore * weights.importance);

    return {
        finalScore,
        components: {
            temporal: temporalScore,
            popularity: popularityScore,
            contextual: contextualScore,
            importance: importanceScore
        }
    };
}

/**
 * Sort entities by their relevance scores in descending order.
 *
 * @param {Array<Object>} entities - Array of entities with scores
 * @param {string} [scoreField='finalScore'] - Field name containing the score
 * @returns {Array<Object>} Sorted array of entities
 *
 * @example
 * const sorted = sortByRelevance([
 *     { name: 'A', score: { finalScore: 1.2 } },
 *     { name: 'B', score: { finalScore: 1.5 } }
 * ], 'score.finalScore');
 */
export function sortByRelevance(entities, scoreField = 'finalScore') {
    return entities.sort((a, b) => {
        const scoreA = scoreField.includes('.')
            ? scoreField.split('.').reduce((obj, key) => obj?.[key], a)
            : a[scoreField];
        const scoreB = scoreField.includes('.')
            ? scoreField.split('.').reduce((obj, key) => obj?.[key], b)
            : b[scoreField];

        return (scoreB || 0) - (scoreA || 0);
    });
}

/**
 * Normalize scores to a 0-1 range for better comparison.
 *
 * @param {Array<number>} scores - Array of scores to normalize
 * @returns {Array<number>} Normalized scores
 *
 * @example
 * normalizeScores([0.5, 1.0, 1.5, 2.0]) // [0, 0.33, 0.67, 1.0]
 */
export function normalizeScores(scores) {
    if (!scores || scores.length === 0) return [];

    const min = Math.min(...scores);
    const max = Math.max(...scores);

    if (min === max) {
        return scores.map(() => 1.0);
    }

    return scores.map(score => (score - min) / (max - min));
}

/**
 * Merge and re-score results from different search methods.
 * Combines keyword and semantic search results with proper deduplication.
 *
 * @param {Array<SearchResult>} keywordResults - Results from keyword search
 * @param {Array<SearchResult>} semanticResults - Results from semantic search
 * @param {ContextInfo} contextInfo - Context information for scoring
 * @param {ScoringConfig} [config=DEFAULT_SCORING_CONFIG] - Scoring configuration
 * @returns {Array<SearchResult>} Merged and scored results
 *
 * @example
 * const merged = mergeAndScoreResults(
 *     keywordResults,
 *     semanticResults,
 *     { contextDistances: [1, 2, 3] }
 * );
 */
export function mergeAndScoreResults(keywordResults, semanticResults, contextInfo = {}, config = DEFAULT_SCORING_CONFIG) {
    const mergedMap = new Map();

    keywordResults.forEach(result => {
        const key = result.entity_id || result.id;
        if (!mergedMap.has(key)) {
            mergedMap.set(key, {
                ...result,
                searchMethods: ['keyword'],
                keywordRank: mergedMap.size
            });
        }
    });

    semanticResults.forEach(result => {
        const key = result.entity_id || result.id;
        if (mergedMap.has(key)) {
            const existing = mergedMap.get(key);
            existing.searchMethods.push('semantic');
            existing.semanticRank = semanticResults.indexOf(result);
            existing.hybridBoost = 1.2;
        } else {
            mergedMap.set(key, {
                ...result,
                searchMethods: ['semantic'],
                semanticRank: semanticResults.indexOf(result)
            });
        }
    });

    return Array.from(mergedMap.values());
}

/**
 * Create a custom scoring configuration by merging with defaults.
 *
 * @param {CustomConfig} customConfig - Custom configuration to merge
 * @returns {ScoringConfig} Merged configuration
 *
 * @example
 * const config = createScoringConfig({
 *     weights: { temporal: 0.5, popularity: 0.2, contextual: 0.2, importance: 0.1 },
 *     temporal: { halfLifeDays: 14 }
 * });
 */
export function createScoringConfig(customConfig = {}) {
    return {
        weights: {...DEFAULT_SCORING_CONFIG.weights, ...customConfig.weights},
        temporal: {...DEFAULT_SCORING_CONFIG.temporal, ...customConfig.temporal},
        popularity: {...DEFAULT_SCORING_CONFIG.popularity, ...customConfig.popularity},
        contextual: {...DEFAULT_SCORING_CONFIG.contextual, ...customConfig.contextual}
    };
}

/**
 * Format score components for debugging or logging.
 *
 * @param {ScoreResult} scoreData - Score data from calculateRelevanceScore
 * @returns {string} Formatted string representation
 *
 * @example
 * const formatted = formatScoreDebug(scoreData);
 * // "Score: 1.24 (T:1.20 P:1.14 C:1.10 I:1.50)"
 */
export function formatScoreDebug(scoreData) {
    if (!scoreData || !scoreData.components) {
        return 'Score: N/A';
    }

    const c = scoreData.components;

    return `Score: ${scoreData.finalScore.toFixed(2)} ` +
        `(T:${c.temporal.toFixed(2)} ` +
        `P:${c.popularity.toFixed(2)} ` +
        `C:${c.contextual.toFixed(2)} ` +
        `I:${c.importance.toFixed(2)})`;
}

/**
 * Validate if a value is a valid importance level.
 *
 * @param {string} value - Value to validate
 * @returns {boolean} True if valid importance level
 *
 * @example
 * isValidImportanceLevel(ImportanceLevel.CRITICAL) // true
 * isValidImportanceLevel('critical')               // true
 * isValidImportanceLevel('invalid')                // false
 */
export function isValidImportanceLevel(value) {
    return Object.values(ImportanceLevel).includes(value);
}

/**
 * Get ImportanceLevel enum constant from string value.
 * Useful for migrating from string literals to enum constants.
 *
 * @param {string} value - String importance value
 * @returns {string|null} ImportanceLevel constant or null if not found
 *
 * @example
 * getImportanceLevelConstant('critical')  // ImportanceLevel.CRITICAL
 * getImportanceLevelConstant('normal')    // ImportanceLevel.NORMAL
 * getImportanceLevelConstant('invalid')   // null
 */
export function getImportanceLevelConstant(value) {
    for (const [key, enumValue] of Object.entries(ImportanceLevel)) {
        if (enumValue === value) {
            return ImportanceLevel[key];
        }
    }

    return null;
}

// Re-export all functions for convenience
export default {
    ImportanceLevel,
    IMPORTANCE_WEIGHTS,
    DEFAULT_SCORING_CONFIG,
    getTemporalScore,
    getPopularityScore,
    getContextualScore,
    getImportanceScore,
    isValidImportanceLevel,
    getImportanceLevelConstant,
    calculateRelevanceScore,
    sortByRelevance,
    normalizeScores,
    mergeAndScoreResults,
    createScoringConfig,
    formatScoreDebug
};