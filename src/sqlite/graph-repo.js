/**
 * @file sqlite/graph-repo.js
 * @description
 * SQLite implementation of the knowledge graph repository.
 */

/**
 * @implements {import('../graph-repository.js').GraphRepository}
 */
export class SqliteGraphRepository {
    /**
     * Creates a new SqliteGraphRepository.
     * @param {import('sqlite').Database} db - SQLite database instance.
     */
    constructor(db) {
        this.db = db;
    }

    /**
     * Retrieves entity ID by name.
     * @async
     * @param {string} name - Entity name to look up.
     * @returns {Promise<number|null>}
     *   Entity ID if found, null otherwise.
     */
    async getEntityId(name) {
        const row = await this.db.get('SELECT id FROM entities WHERE name = ?', [name]);

        return row ? row.id : null;
    }

    /**
     * Creates a new entity.
     * @async
     * @param {string} name - Entity name.
     * @param {string} entityType - Entity type.
     * @returns {Promise<number>}
     *   The ID of the created entity.
     */
    async createEntity(name, entityType) {
        const result = await this.db.run(
            'INSERT INTO entities(name, entityType) VALUES(?, ?)',
            [name, entityType]
        );

        return result.lastID;
    }

    /**
     * Gets or creates an entity ID.
     * @async
     * @param {string} name - Entity name.
     * @param {string} entityType - Entity type.
     * @returns {Promise<number>}
     *   Existing or newly created entity ID.
     */
    async getOrCreateEntityId(name, entityType) {
        const existing = await this.getEntityId(name);
        if (existing !== null) {
            return existing;
        }

        return this.createEntity(name, entityType);
    }

    /**
     * Inserts an observation for an entity.
     * @async
     * @param {number} entityId - Entity ID.
     * @param {string} content - Observation content.
     * @returns {Promise<{inserted: boolean, observationId: number|null}>}
     *   Object indicating if observation was inserted and its ID.
     */
    async insertObservation(entityId, content) {
        const result = await this.db.run(
            'INSERT OR IGNORE INTO observations(entity_id, content) VALUES(?, ?)',
            [entityId, content]
        );

        if (!result.changes) {
            const existing = await this.db.get(
                'SELECT id FROM observations WHERE entity_id = ? AND content = ?',
                [entityId, content]
            );
            return { inserted: false, observationId: existing ? existing.id : null };
        }

        return { inserted: true, observationId: result.lastID };
    }

    /**
     * Inserts or updates observation embeddings in the vector table.
     * @async
     * @param {Array<{observationId: number, entityId: number, embedding: Buffer}>} rows
     *   Array of observation vectors to insert.
     * @returns {Promise<void>}
     */
    async insertObservationVectors(rows) {
        if (!rows.length) {
            return;
        }

        await this.db.exec('BEGIN TRANSACTION');
        try {
            for (const { observationId, entityId, embedding } of rows) {
                await this.db.run(
                    'INSERT OR REPLACE INTO obs_vec(rowid, entity_id, embedding) VALUES(?, ?, ?)',
                    [observationId, entityId, embedding]
                );
            }
            await this.db.exec('COMMIT');
        } catch (error) {
            await this.db.exec('ROLLBACK');
            throw error;
        }
    }

    /**
     * Creates a relation between two entities.
     * @async
     * @param {number} fromId - Source entity ID.
     * @param {number} toId - Target entity ID.
     * @param {string} relationType - Type of relation.
     * @returns {Promise<boolean>}
     *   True if relation was created, false if it already exists.
     */
    async createRelation(fromId, toId, relationType) {
        const result = await this.db.run(
            'INSERT OR IGNORE INTO relations(from_id, to_id, relationType) VALUES(?, ?, ?)',
            [fromId, toId, relationType]
        );

        return Boolean(result.changes);
    }

    /**
     * Deletes entities by their names.
     * @async
     * @param {string[]} names - Array of entity names to delete.
     * @returns {Promise<void>}
     */
    async deleteEntities(names) {
        if (!names.length) {
            return;
        }

        const placeholders = names.map(() => '?').join(',');
        await this.db.run(`DELETE FROM entities WHERE name IN (${placeholders})`, names);
    }

    /**
     * Deletes relations between entities.
     * @async
     * @param {Array<{from: string, to: string, relationType: string}>} relations
     *   Array of relations to delete with entity names and relation type.
     * @returns {Promise<void>}
     */
    async deleteRelations(relations) {
        for (const relation of relations) {
            const fromId = await this.getEntityId(relation.from);
            const toId = await this.getEntityId(relation.to);
            if (!fromId || !toId) continue;
            await this.db.run(
                `DELETE FROM relations WHERE from_id = ? AND to_id = ? AND relationType = ?`,
                [fromId, toId, relation.relationType]
            );
        }
    }

    /**
     * Deletes specific observations from an entity.
     * @async
     * @param {number} entityId - Entity ID from which to delete observations.
     * @param {string[]} observations - Array of observation content strings to delete.
     * @returns {Promise<void>}
     */
    async deleteObservations(entityId, observations) {
        if (!observations.length) {
            return;
        }

        const placeholders = observations.map(() => '?').join(',');
        await this.db.run(
            `DELETE FROM observations WHERE entity_id = ? AND content IN (${placeholders})`,
            [entityId, ...observations]
        );
    }

    /**
     * Retrieves the complete knowledge graph including all entities and relations.
     * @async
     * @returns {Promise<{entities: Array<{name: string, entityType: string, observations: string[]}>, relations: Array<{from: string, to: string, relationType: string}>}>}
     *   Object containing all entities with their observations and all relations.
     */
    async readGraph() {
        const entities = await this.db.all('SELECT * FROM entities');
        const observations = await this.db.all('SELECT entity_id, content FROM observations');
        /**
         *
         * @type {[{from_name, to_name, relationType}]}
         */
        const relations = await this.db.all(`
            SELECT r.from_id, r.to_id, r.relationType, ef.name AS from_name, et.name AS to_name
            FROM relations r
                     JOIN entities ef ON ef.id = r.from_id
                     JOIN entities et ON et.id = r.to_id
        `);

        return {
            entities: entities.map(entity => ({
                name: entity.name,
                entityType: entity.entityType,
                observations: observations
                    .filter(obs => obs.entity_id === entity.id)
                    .map(obs => obs.content)
            })),
            relations: relations.map(rel => ({
                from: rel.from_name,
                to: rel.to_name,
                relationType: rel.relationType
            }))
        };
    }

    /**
     * Escapes special characters in LIKE patterns.
     * @private
     * @param {string} query - Query string to escape.
     * @returns {string} Escaped query string.
     */
    #escapeLike(query) {
        return query.replace(/[\\%_]/g, '\\$&');
    }

    /**
     * Escapes FTS5 query syntax special characters.
     * @private
     * @param {string} query - Query string to escape.
     * @returns {string} FTS5-safe quoted query string.
     */
    #escapeFts(query) {
        const escaped = query.replace(/"/g, '""');

        return `"${escaped}"`;
    }

    /**
     * Performs keyword-based search across entity names, types, and observations.
     * @async
     * @param {string} query - Search query string.
     * @returns {Promise<number[]>}
     *   Array of entity IDs matching the search query.
     */
    async keywordSearch(query) {
        const escapedFts = this.#escapeFts(query);
        const ftsRows = await this.db.all(
            'SELECT DISTINCT entity_id FROM obs_fts WHERE obs_fts MATCH ?',
            [escapedFts]
        );
        const likePattern = `%${this.#escapeLike(query.toLowerCase())}%`;
        const entityRows = await this.db.all(
            `SELECT DISTINCT id AS entity_id FROM entities WHERE LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(entityType) LIKE ? ESCAPE '\\'`,
            [likePattern, likePattern]
        );

        const ids = new Set([
            ...ftsRows.map(row => row.entity_id),
            ...entityRows.map(row => row.entity_id)
        ]);

        return Array.from(ids);
    }

    /**
     * Performs semantic search using vector similarity.
     * @async
     * @param {Buffer} vector - Embedding vector as Buffer.
     * @param {number} topK - Maximum number of results to return.
     * @returns {Promise<Array<{entity_id: number, distance: number}>>}
     *   Array of entity IDs with their L2 distances.
     */
    async semanticSearch(vector, topK) {
        return this.db.all(
            `SELECT entity_id, vec_distance_L2(embedding, ?) AS distance
             FROM obs_vec
             WHERE embedding IS NOT NULL
             ORDER BY distance
             LIMIT ?`,
            [vector, topK]
        );
    }

    /**
     * Performs hybrid search combining keyword and semantic approaches.
     * @async
     * @param {string} query - Text query for keyword search.
     * @param {Buffer} vector - Embedding vector for semantic search.
     * @param {number} topK - Maximum number of results to return.
     * @param {number} adjustedThreshold - Distance threshold for filtering results.
     * @returns {Promise<Array<{entity_id: number, distance: number, score: number}>>}
     *   Array of entity IDs with distances and combined scores.
     */
    async hybridSearch(query, vector, topK, adjustedThreshold) {
        const escapedFts = this.#escapeFts(query);
        const ftsRows = await this.db.all(
            'SELECT DISTINCT entity_id FROM obs_fts WHERE obs_fts MATCH ?',
            [escapedFts]
        );
        const vecRows = await this.db.all(
            `SELECT entity_id, vec_distance_L2(embedding, ?) AS distance
             FROM obs_vec
             WHERE embedding IS NOT NULL
             ORDER BY distance
             LIMIT ?`,
            [vector, topK * 2]
        );

        const ftsSet = new Set(ftsRows.map(row => row.entity_id));
        const results = [];
        for (const row of vecRows) {
            if (row.distance <= adjustedThreshold * 1.5) {
                results.push({
                    entity_id: row.entity_id,
                    distance: row.distance,
                    score: ftsSet.has(row.entity_id) ? row.distance * 0.3 : row.distance
                });
            }
        }

        for (const ftsRow of ftsRows) {
            if (!results.find(row => row.entity_id === ftsRow.entity_id)) {
                results.push({
                    entity_id: ftsRow.entity_id,
                    distance: adjustedThreshold * 0.5,
                    score: adjustedThreshold * 0.5
                });
            }
        }

        results.sort((a, b) => a.score - b.score);
        return results.slice(0, topK);
    }

    /**
     * Fetches detailed metadata for specified entities including access statistics.
     * @async
     * @param {number[]} entityIds - Array of entity IDs to fetch details for.
     * @returns {Promise<Array<{entity_id: number, name: string, entityType: string, created_at: string, last_accessed: string, access_count: number, importance: string}>>}
     *   Array of entities with their metadata and access statistics.
     */
    async fetchEntitiesWithDetails(entityIds) {
        if (!entityIds.length) {
            return [];
        }

        const placeholders = entityIds.map(() => '?').join(',');
        /**
         *
         * @type {{entity_id, name, entityType, created_at, last_accessed, access_count, importance}[]}
         */
        const rows = await this.db.all(
            `SELECT
                 e.id AS entity_id,
                 e.name,
                 e.entityType,
                 MIN(o.created_at) AS created_at,
                 MAX(o.last_accessed) AS last_accessed,
                 SUM(o.access_count) AS access_count,
                 COALESCE(
                     (SELECT o2.importance
                      FROM observations o2
                      WHERE o2.entity_id = e.id
                      ORDER BY o2.last_accessed DESC
                      LIMIT 1),
                     'normal'
                 ) AS importance
             FROM entities e
                      LEFT JOIN observations o ON o.entity_id = e.id
             WHERE e.id IN (${placeholders})
             GROUP BY e.id, e.name, e.entityType`,
            entityIds
        );

        return rows;
    }

    /**
     * Retrieves detailed information for specified entities by their names.
     * @async
     * @param {string[]} names - Array of entity names to retrieve.
     * @returns {Promise<{entities: Array<{name: string, entityType: string, observations: string[]}>, relations: Array<{from: string, to: string, relationType: string}>}>}
     *   Object containing specified entities with observations and relations between them.
     */
    async openNodes(names) {
        if (!names.length) {
            return { entities: [], relations: [] };
        }

        const placeholders = names.map(() => '?').join(',');
        const entities = await this.db.all(
            `SELECT * FROM entities WHERE name IN (${placeholders})`,
            names
        );

        if (!entities.length) {
            return { entities: [], relations: [] };
        }

        const ids = entities.map(e => e.id);
        const idPlaceholders = ids.map(() => '?').join(',');
        const observations = await this.db.all(
            `SELECT entity_id, content FROM observations WHERE entity_id IN (${idPlaceholders})`,
            ids
        );
        /**
         *
         * @type {[{from_name, to_name, relationType}]}
         */
        const relations = await this.db.all(
            `SELECT r.from_id, r.to_id, r.relationType, ef.name AS from_name, et.name AS to_name
             FROM relations r
                      JOIN entities ef ON ef.id = r.from_id
                      JOIN entities et ON et.id = r.to_id
             WHERE r.from_id IN (${idPlaceholders}) AND r.to_id IN (${idPlaceholders})`,
            [...ids, ...ids]
        );

        return {
            entities: entities.map(entity => ({
                name: entity.name,
                entityType: entity.entityType,
                observations: observations
                    .filter(obs => obs.entity_id === entity.id)
                    .map(obs => obs.content)
            })),
            relations: relations.map(relation => ({
                from: relation.from_name,
                to: relation.to_name,
                relationType: relation.relationType
            }))
        };
    }

    /**
     * Retrieves entity IDs for a list of entity names.
     * @async
     * @param {string[]} names - Array of entity names to look up.
     * @returns {Promise<Map<string, string>>}
     *   Map of entity names to their IDs as strings.
     */
    async getEntityIdsByNames(names) {
        if (!names.length) return new Map();
        const placeholders = names.map(() => '?').join(',');
        const rows = await this.db.all(
            `SELECT name, id FROM entities WHERE name IN (${placeholders})`,
            names
        );
        const map = new Map();

        for (const row of rows) {
            map.set(row.name, row.id.toString());
        }

        return map;
    }

    /**
     * Retrieves entity names for a list of entity IDs.
     * @async
     * @param {number[]} ids - Array of entity IDs to look up.
     * @returns {Promise<Map<string, string>>}
     *   Map of entity IDs (as strings) to their names.
     */
    async getEntityNamesByIds(ids) {
        if (!ids.length) return new Map();
        const placeholders = ids.map(() => '?').join(',');
        const rows = await this.db.all(
            `SELECT id, name FROM entities WHERE id IN (${placeholders})`,
            ids
        );
        const map = new Map();

        for (const row of rows) {
            map.set(row.id.toString(), row.name);
        }

        return map;
    }

    /**
     * Retrieves all relations involving specified entities.
     * @async
     * @param {number[]} entityIds - Array of entity IDs to get relations for.
     * @returns {Promise<Array<{from_id: number, to_id: number}>>}
     *   Array of relations where entity is either source or target.
     */
    async getRelationsForEntityIds(entityIds) {
        if (!entityIds.length) {
            return [];
        }
        const placeholders = entityIds.map(() => '?').join(',');

        return this.db.all(
            `SELECT from_id, to_id
             FROM relations
             WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`,
            [...entityIds, ...entityIds]
        );
    }

    /**
     * Retrieves entity IDs that were recently accessed, sorted by last access time.
     * @async
     * @param {number} limit - Maximum number of entity IDs to return.
     * @returns {Promise<number[]>}
     *   Array of recently accessed entity IDs, most recent first.
     */
    async getRecentlyAccessedEntities(limit) {
        const rows = await this.db.all(
            `SELECT DISTINCT entity_id
             FROM observations
             WHERE last_accessed IS NOT NULL
             ORDER BY last_accessed DESC
             LIMIT ?`,
            [limit]
        );

        return rows.map(row => row.entity_id);
    }

    /**
     * Updates access statistics for specified entities.
     * @async
     * @param {number[]} entityIds - Array of entity IDs to update.
     * @returns {Promise<void>}
     */
    async updateAccessStats(entityIds) {
        if (!entityIds.length) {
            return;
        }

        const placeholders = entityIds.map(() => '?').join(',');
        await this.db.run(
            `UPDATE observations
             SET access_count = COALESCE(access_count, 0) + 1,
                 last_accessed = datetime('now')
             WHERE entity_id IN (${placeholders})`,
            entityIds
        );
    }

    /**
     * Sets the importance level for all observations of an entity.
     * @async
     * @param {number} entityId - Entity ID to update importance for.
     * @param {string} importance - Importance level (e.g., 'critical', 'important', 'normal').
     * @returns {Promise<boolean>}
     *   True if any observations were updated, false otherwise.
     */
    async setImportance(entityId, importance) {
        const result = await this.db.run(
            'UPDATE observations SET importance = ? WHERE entity_id = ?',
            [importance, entityId]
        );

        return result.changes > 0;
    }
}
