/**
 * @file knowledge-graph-manager.js
 * @description
 * Provides methods to manage a knowledge graph stored in SQLite, including entities,
 * observations, and relations. Uses FTS5 and sqlite-vec for keyword and semantic search.
 * Embeddings are generated via @xenova/transformers.
 */

import { pipeline } from '@xenova/transformers';
import { SearchContextManager } from './search-context-manager.js';

/**
 * Manages a knowledge graph persisted in SQLite.
 * Supports creating, reading, updating, and deleting entities, observations, and relations,
 * as well as performing keyword and semantic searches over observations.
 */
export class KnowledgeGraphManager {
    /**
     * @type {import('sqlite').Database}
     */
    #db = null;

    /**
     * @type {import('@xenova/transformers').Pipeline|null}
     */
    #embedder = null;

    /**
     * @type {SearchContextManager|null}
     */
    #searchContextManager = null;

    /**
     * Creates an instance of KnowledgeGraphManager.
     * @param {import('sqlite').Database} db - An opened SQLite database connection.
     */
    constructor(db) {
        this.#db = db;
        this.#searchContextManager = new SearchContextManager(db);
    }

    /**
     * Inserts or ignores multiple entities into the database.
     * Also adds any provided observations for each entity.
     * @param {Array<{ name: string, entityType: string, observations?: string[] }>} entities
     *   List of entities to create.
     * @returns {Promise<Array<{ name: string, entityType: string, observations?: string[] }>>}
     *   The subset of input entities that were newly created.
     */
    async createEntities(entities) {
        const created = [];
        for (const e of entities) {
            const existing = await this.#db.get(
                "SELECT id FROM entities WHERE name = ?",
                [e.name]
            );
            
            if (!existing) {
                const res = await this.#db.run(
                    "INSERT INTO entities(name, entityType) VALUES(?, ?)",
                    [e.name, e.entityType]
                );
                created.push(e);
            }
            
            if (e.observations?.length) {
                await this.addObservations([{ entityName: e.name, contents: e.observations }]);
            }
        }

        return created;
    }

    /**
     * Adds observations (text) to existing entities and indexes them for FTS and semantic search.
     * @param {Array<{ entityName: string, contents: string[] }>} arr
     *   Array of objects specifying which observations to add for which entity.
     * @returns {Promise<Array<{ entityName: string, addedObservations: string[] }>>}
     *   For each input, the list of observations actually added.
     */
    async addObservations(arr) {
        const results = [];
        for (const { entityName, contents } of arr) {
            const eid      = await this.getEntityId(entityName, "Unknown", true);
            const newTexts = [];
            for (const t of contents) {
                const res = await this.#db.run(
                    "INSERT OR IGNORE INTO observations(entity_id, content) VALUES(?, ?)",
                    [ eid, t ]
                );
                if (res.changes) {
                    newTexts.push(t);
                }
            }

            if (newTexts.length) {
                const vecs = await this.embedTexts(newTexts);
                
                await this.#db.exec("BEGIN TRANSACTION");
                try {
                    for (let i = 0; i < newTexts.length; i++) {
                        const obsRow = await this.#db.get(
                            "SELECT id FROM observations WHERE entity_id = ? AND content = ?",
                            [eid, newTexts[i]]
                        );
                        
                        if (obsRow && vecs[i]) {
                            await this.#db.run(
                                "INSERT INTO obs_vec VALUES(?, ?, ?)",
                                [obsRow.id, eid, vecs[i]]
                            );
                        }
                    }
                    await this.#db.exec("COMMIT");
                } catch (error) {
                    await this.#db.exec("ROLLBACK");
                    console.error("Error inserting vectors:", error.message);
                    throw error;
                }
            }

            results.push({ entityName, addedObservations: newTexts });
        }

        return results;
    }

    /**
     * Creates directed relations between existing or new entities.
     * @param {Array<{ from: string, to: string, relationType: string }>} relations
     *   List of relations to create.
     * @returns {Promise<Array<{ from: string, to: string, relationType: string }>>}
     *   The subset of input relations that were newly created.
     */
    async createRelations(relations) {
        const created = [];
        for (const r of relations) {
            const fromId = await this.getEntityId(r.from, "Unknown", true);
            const toId   = await this.getEntityId(r.to, "Unknown", true);
            const res    = await this.#db.run(
                "INSERT OR IGNORE INTO relations(from_id, to_id, relationType) VALUES(?,?,?)",
                [ fromId, toId, r.relationType ]
            );

            if (res.changes) {
                created.push(r);
            }
        }

        return created;
    }

    /**
     * Deletes entities by their names.
     * @param {string[]} names - Array of entity names to delete.
     * @returns {Promise<void>}
     */
    async deleteEntities(names) {
        const placeholders = names.map(() => "?").join(",");
        await this.#db.run(
            `DELETE
             FROM entities
             WHERE name IN (${placeholders})`,
            names
        );
    }

    /**
     * Deletes specified relations.
     * @param {Array<{ from: string, to: string, relationType: string }>} relations
     *   List of relations to remove.
     * @returns {Promise<void>}
     */
    async deleteRelations(relations) {
        for (const r of relations) {
            const fromId = await this.getEntityId(r.from);
            const toId   = await this.getEntityId(r.to);
            if (fromId && toId) {
                await this.#db.run(
                    `DELETE
                     FROM relations
                     WHERE from_id = ?
                       AND to_id = ?
                       AND relationType = ?`,
                    [ fromId, toId, r.relationType ]
                );
            }
        }
    }

    /**
     * Deletes specified observations for entities.
     * @param {Array<{ entityName: string, observations: string[] }>} list
     *   Which observations to delete for which entity.
     * @returns {Promise<void>}
     */
    async deleteObservations(list) {
        for (const { entityName, observations } of list) {
            const eid = await this.getEntityId(entityName);
            if (!eid) {
                continue;
            }

            const placeholders = observations.map(() => "?").join(",");
            await this.#db.run(
                `DELETE
                 FROM observations
                 WHERE entity_id = ?
                   AND content IN (${placeholders})`,
                [ eid, ...observations ]
            );
        }
    }

    /**
     * Reads the entire knowledge graph (entities, observations, relations).
     * @returns {Promise<{ entities: Array<{ name: string, entityType: string, observations: string[] }>, relations: Array<{ from: string, to: string, relationType: string }> }>}
     */
    async readGraph() {
        const ents    = await this.#db.all("SELECT * FROM entities");
        const obs     = await this.#db.all(
            "SELECT entity_id, content FROM observations"
        );
        const relRows = await this.#db.all(
            `SELECT r.from_id, r.to_id, r.relationType, ef.name AS fn, et.name AS tn
             FROM relations r
                      JOIN entities ef ON ef.id = r.from_id
                      JOIN entities et ON et.id = r.to_id`
        );

        return {
            entities:  ents.map(e => ({
                name:         e.name,
                entityType:   e.entityType,
                observations: obs
                                  .filter(o => o.entity_id === e.id)
                                  .map(o => o.content)
            })),
            relations: relRows.map(r => ({
                from:         r.fn,
                to:           r.tn,
                relationType: r.relationType
            }))
        };
    }

    /**
     * Searches for entities matching a query, either by keyword or semantically.
     * @param {{ query: string, mode?: "keyword" | "semantic" | "hybrid", topK?: number, threshold?: number, includeScoreDetails?: boolean, scoringProfile?: string|Object }}
     *   Search options.
     * @returns {Promise<{ entities: Array<{ name: string, entityType: string, observations: string[], score?: number, scoreComponents?: Object }>, relations: Array<{ from: string, to: string, relationType: string }> }>}
     */
    async searchNodes({ query, mode = "keyword", topK = 8, threshold = 0.35, includeScoreDetails = false, scoringProfile = 'balanced' }) {
        let adjustedThreshold = threshold;
        if (mode === "semantic" || mode === "hybrid") {
            adjustedThreshold = 2 * (1 - threshold);
        }
        
        if (mode === "keyword") {
            const ftsRows = await this.#db.all(
                `SELECT DISTINCT entity_id 
                 FROM obs_fts 
                 WHERE obs_fts MATCH ?`,
                [this.#escapeFTSQuery(query)]
            );
            
            const q = `%${this.#escapeLikeQuery(query.toLowerCase())}%`;
            const entityRows = await this.#db.all(
                `SELECT DISTINCT id as entity_id
                 FROM entities
                 WHERE LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(entityType) LIKE ? ESCAPE '\\'`,
                [q, q]
            );
            
            const allIds = [...new Set([
                ...ftsRows.map(r => r.entity_id),
                ...entityRows.map(r => r.entity_id)
            ])];
            
            if (allIds.length === 0) {
                return { entities: [], relations: [] };
            }
            
            
            return this.#applyScoring(allIds, query, includeScoreDetails, scoringProfile);
        }
        
        try {
            const [qVec] = await this.embedTexts([query]);
            
            let rows;
            if (mode === "semantic") {
                rows = await this.#db.all(
                    `SELECT entity_id, vec_distance_L2(embedding, ?) AS d
                     FROM obs_vec
                     WHERE embedding IS NOT NULL
                     ORDER BY d 
                     LIMIT ?`,
                    [qVec, topK]
                );
            } else {
                const ftsRows = await this.#db.all(
                    `SELECT DISTINCT entity_id FROM obs_fts WHERE obs_fts MATCH ?`,
                    [this.#escapeFTSQuery(query)]
                );
                
                const vecRows = await this.#db.all(
                    `SELECT entity_id, vec_distance_L2(embedding, ?) AS d
                     FROM obs_vec
                     WHERE embedding IS NOT NULL
                     ORDER BY d 
                     LIMIT ?`,
                    [qVec, topK * 2]
                );
                
                const ftsSet = new Set(ftsRows.map(r => r.entity_id));
                const hybridResults = [];
                
                for (const row of vecRows) {
                    if (row.d <= adjustedThreshold * 1.5) {
                        hybridResults.push({
                            entity_id: row.entity_id,
                            score: ftsSet.has(row.entity_id) ? row.d * 0.3 : row.d,
                            d: row.d
                        });
                    }
                }
                
                for (const ftsRow of ftsRows) {
                    if (!hybridResults.find(r => r.entity_id === ftsRow.entity_id)) {
                        hybridResults.push({
                            entity_id: ftsRow.entity_id,
                            score: adjustedThreshold * 0.5,
                            d: adjustedThreshold * 0.5
                        });
                    }
                }
                
                hybridResults.sort((a, b) => a.score - b.score);
                rows = hybridResults.slice(0, topK);
            }
            
            const ids = rows.filter(r => r.d <= adjustedThreshold).map(r => r.entity_id);
            
            if (ids.length === 0) {
                return { entities: [], relations: [] };
            }
            
            
            return this.#applyScoring(ids, query, includeScoreDetails, scoringProfile);
            
        } catch (error) {
            console.error(`Search error in ${mode} mode:`, error.message);
            
            if (error.message.includes('no such function')) {
                console.error('sqlite-vec functions are not available. Verify that the extension has been successfully loaded.');
                
                return this.searchNodes({ query, mode: 'keyword', topK, threshold });
            }
            
            throw error;
        }
    }

    /**
     * Retrieves full entity and relation details for given entity names.
     * @param {string[]} names - Array of entity names to open.
     * @returns {Promise<{ entities: Array<{ name: string, entityType: string, observations: string[] }>, relations: Array<{ from: string, to: string, relationType: string }> }>}
     */
    async openNodes(names) {
        if (!names.length) {
            return { entities: [], relations: [] };
        }

        const placeholders = names.map(() => "?").join(",");
        const ents         = await this.#db.all(
            `SELECT *
             FROM entities
             WHERE name IN (${placeholders})`,
            names
        );
        const ids          = ents.map(e => e.id);
        const obs          = await this.#db.all(
            `SELECT entity_id, content
             FROM observations
             WHERE entity_id IN (${ids.map(() => "?").join(",")})`,
            ids
        );
        const rel          = await this.#db.all(
            `SELECT r.from_id, r.to_id, r.relationType, ef.name fn, et.name tn
             FROM relations r
                      JOIN entities ef ON ef.id = r.from_id
                      JOIN entities et ON et.id = r.to_id
             WHERE r.from_id IN (${ids.map(() => "?").join(",")})
               AND r.to_id IN (${ids.map(() => "?").join(",")})`,
            [ ...ids, ...ids ]
        );

        return {
            entities:  ents.map(e => ({
                name:         e.name,
                entityType:   e.entityType,
                observations: obs
                                  .filter(o => o.entity_id === e.id)
                                  .map(o => o.content)
            })),
            relations: rel.map(r => ({
                from:         r.fn,
                to:           r.tn,
                relationType: r.relationType
            }))
        };
    }

    /**
     * Generates embeddings for an array of texts using a Transformer pipeline.
     * @param {string[]} textArr - Array of raw text strings to embed.
     * @returns {Promise<Buffer[]>} Array of raw embedding buffers (Float32 LE).
     */
    async embedTexts(textArr) {
        if (!this.#embedder) {
        this.#embedder = await pipeline(
                "feature-extraction",
                "Xenova/bge-m3",
                { quantized: true }
            );
        }
        const outs = [];
        for (const t of textArr) {
            const out = await this.#embedder(t, { pooling: "mean", normalize: true });
            outs.push(Buffer.from(Float32Array.from(out.data).buffer));
        }

        return outs;
    }

    /**
     * Escapes LIKE query string to prevent wildcard injection.
     * Escapes %, _, and \ characters which have special meaning in LIKE.
     * @param {string} query - Raw search query
     * @returns {string} Safely escaped LIKE query
     */
    #escapeLikeQuery(query) {
        return query.replace(/[\\%_]/g, '\\$&');
    }

    /**
     * Escapes FTS5 query string to prevent SQL injection.
     * Wraps the query in double quotes and escapes internal quotes.
     * @param {string} query - Raw search query
     * @returns {string} Safely escaped FTS5 query
     */
    #escapeFTSQuery(query) {
        const escaped = query.replace(/"/g, '""');
        return `"${escaped}"`;
    }

    /**
     * Applies relevance scoring to search results and formats output
     * @private
     * @param {number[]} entityIds - Array of entity IDs from search
     * @param {string} query - Original search query
     * @param {boolean} includeScoreDetails - Whether to include score components
     * @param {string|Object} scoringProfile - Scoring profile name or custom weights
     * @returns {Promise<{ entities: Array<{ name: string, entityType: string, observations: string[], score?: number, scoreComponents?: Object }>, relations: Array<{ from: string, to: string, relationType: string }> }>}
     */
    async #applyScoring(entityIds, query, includeScoreDetails = false, scoringProfile = 'balanced') {
        if (!entityIds || entityIds.length === 0) {
            return { entities: [], relations: [] };
        }

        const entityData = await this._performBaseSearch(entityIds);
        
        // Convert entity_id from number to string for compatibility
        const entityDataForScoring = entityData.map(entity => ({
            ...entity,
            entity_id: String(entity.entity_id)
        }));
        
        const searchContext = await this.#searchContextManager.prepareSearchContext(query, {
            contextSize: 5,
            preloadDepth: 2
        });
        const scoredResults = await this.#searchContextManager.scoreSearchResults(
            entityDataForScoring,
            searchContext,
            { 
                includeComponents: includeScoreDetails,
                scoringProfile: scoringProfile
            }
        );
        
        scoredResults.sort((a, b) => (b.score || 0) - (a.score || 0));
        
        // Convert entity_id back to numbers for updateAccessStats
        const foundIds = scoredResults.map(r => Number(r.entity_id));

        if (foundIds.length > 0) {
            await this.#searchContextManager.updateAccessStats(foundIds);
        }
        
        const entityNames = scoredResults.map(r => r.name);
        const fullDetails = await this.openNodes(entityNames);
        
        if (includeScoreDetails) {
            // Create new array with score details added
            const entitiesWithScores = fullDetails.entities.map((entity, idx) => ({
                ...entity,
                score: scoredResults[idx]?.score,
                scoreComponents: scoredResults[idx]?.scoreComponents
            }));
            
            return {
                entities: entitiesWithScores,
                relations: fullDetails.relations
            };
        }
        
        return fullDetails;
    }

    /**
     * Performs base search and retrieves entities with metadata for scoring
     * @private
     * @param {number[]} entityIds - Array of entity IDs from search
     * @returns {Promise<Array<{entity_id: number, name: string, entityType: string, created_at: string|null, last_accessed: string|null, access_count: number, importance: string}>>}
     */
    async _performBaseSearch(entityIds) {
        if (!entityIds || entityIds.length === 0) {
            return [];
        }

        const placeholders = entityIds.map(() => "?").join(",");
        const results = await this.#db.all(
            `SELECT 
                e.id as entity_id,
                e.name,
                e.entityType,
                MIN(o.created_at) as created_at,
                MAX(o.last_accessed) as last_accessed,
                SUM(o.access_count) as access_count,
                COALESCE(
                    (SELECT o2.importance 
                     FROM observations o2 
                     WHERE o2.entity_id = e.id 
                     ORDER BY o2.last_accessed DESC 
                     LIMIT 1),
                    'normal'
                ) as importance
            FROM entities e
            LEFT JOIN observations o ON o.entity_id = e.id
            WHERE e.id IN (${placeholders})
            GROUP BY e.id, e.name, e.entityType`,
            entityIds
        );

        return results;
    }

    /**
     * Retrieves the numeric ID for an entity by name, optionally creating it.
     * @param {string} name - Entity name to look up.
     * @param {string} [type="Unknown"] - Entity type when creating.
     * @param {boolean} [create=false] - If true, creates the entity if it does not exist.
     * @returns {Promise<number|null>} The entity ID, or null if not found and not created.
     */
    async getEntityId(name, type = "Unknown", create = false) {
        const row = await this.#db.get(
            "SELECT id FROM entities WHERE name = ?",
            name
        );
        if (row) {
            return row.id;
        }

        if (create) {
            const r = await this.#db.run(
                "INSERT INTO entities(name, entityType) VALUES(?, ?)",
                [ name, type ]
            );

            return r.lastID;
        }

        return null;
    }

    /**
     * Sets the importance level for an entity.
     * 
     * @param {string} entityName - Name of the entity
     * @param {string} importance - Importance level ('critical', 'important', 'normal', 'temporary', 'deprecated')
     * @returns {Promise<Object>} Result with success status
     * 
     * @example
     * await kgm.setImportance('Project_MEMENTO', 'critical');
     */
    async setImportance(entityName, importance) {
        try {
            const entityId = await this.getEntityId(entityName, null, false);
            if (!entityId) {
                return {
                    success: false,
                    error: `Entity "${entityName}" not found`
                };
            }

            const success = await this.#searchContextManager.setImportance(entityId, importance);
            
            return {
                success,
                entityName,
                importance,
                message: success ? 
                    `Importance set to '${importance}' for entity '${entityName}'` :
                    `Failed to set importance for entity '${entityName}'`
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Adds tags to an entity.
     * 
     * @param {string} entityName - Name of the entity
     * @param {Array<string>|string} tags - Tags to add
     * @returns {Promise<Object>} Result with success status
     * 
     * @example
     * await kgm.addTags('Session_2025-08-29', ['completed', 'phase5']);
     */
    async addTags(entityName, tags) {
        try {
            const entityId = await this.getEntityId(entityName, null, false);
            if (!entityId) {
                return {
                    success: false,
                    error: `Entity "${entityName}" not found`
                };
            }

            const success = await this.#searchContextManager.addTags(entityId, tags);
            
            return {
                success,
                entityName,
                tags: Array.isArray(tags) ? tags : [tags],
                message: success ? 
                    `Tags added to entity '${entityName}'` :
                    `Failed to add tags to entity '${entityName}'`
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
}
