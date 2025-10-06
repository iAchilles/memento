/**
 * @file postgres/graph-repo.js
 * @description
 * PostgreSQL implementation of the knowledge graph repository (strict pgvector).
 */


const VECTOR_TYPE_NAME = 'vector';

/**
 * @implements {import('../graph-repository.js').GraphRepository}
 */
export class PostgresGraphRepository {

    #pool = null;

    constructor(pool) {
        this.#pool = pool;
        this.vectorEnabledPromise = this.#detectVectorSupport();
    }

    async #detectVectorSupport() {
        const client = await /** @type {import('pg').Client} */ this.#pool.connect();
        try {
            const result = await client.query(
                `SELECT 1
                 FROM information_schema.columns
                 WHERE table_name = 'obs_vec'
                   AND column_name = 'embedding'
                   AND udt_name = $1`,
                [ VECTOR_TYPE_NAME ]
            );
            return result.rowCount > 0;
        } finally {
            client.release();
        }
    }

    async #requireVectorEnabled() {
        const ok = await this.vectorEnabledPromise;
        if (!ok) {
            throw new Error('pgvector is required but not available: obs_vec.embedding must be of type vector');
        }
    }

    #bufferToVector(buffer) {
        const floats = Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));

        return `[${floats.join(',')}]`;
    }

    async #query(sql, params = []) {
        const pool = /** @type {any} */ (this.#pool);
        const res = await pool.query(sql, params);

        return res.rows;
    }

    async #semanticRows(vector, limit) {
        await this.#requireVectorEnabled();

        const rows = await this.#query(
            `SELECT entity_id, embedding <=> $1::vector AS distance
             FROM obs_vec
             WHERE embedding IS NOT NULL
             ORDER BY embedding <=> $1::vector
        LIMIT $2`,
            [ this.#bufferToVector(vector), limit ]
        );

        return rows.map(r => ({ entity_id: Number(r.entity_id), distance: Number(r.distance) }));
    }

    async getEntityId(name) {
        const rows = await this.#query('SELECT id FROM entities WHERE name = $1', [ name ]);

        return rows.length
            ? rows[0].id
            : null;
    }

    async createEntity(name, entityType) {
        const rows = await this.#query(
            `INSERT INTO entities(name, entitytype)
             VALUES ($1, $2) RETURNING id`,
            [ name, entityType ]
        );

        return rows[0].id;
    }

    async getOrCreateEntityId(name, entityType) {
        const existing = await this.getEntityId(name);
        if (existing !== null) return existing;

        const rows = await this.#query(
            `INSERT INTO entities(name, entitytype)
             VALUES ($1, $2) ON CONFLICT(name)
       DO
            UPDATE SET entitytype = EXCLUDED.entitytype
                RETURNING id`,
            [ name, entityType ]
        );

        return rows[0].id;
    }

    async insertObservation(entityId, content) {
        const rows = await this.#query(
            `INSERT INTO observations(entity_id, content)
             VALUES ($1, $2) ON CONFLICT(entity_id, content) DO NOTHING
       RETURNING id`,
            [ entityId, content ]
        );

        if (!rows.length) {
            const existing = await this.#query(
                `SELECT id
                 FROM observations
                 WHERE entity_id = $1
                   AND content = $2`,
                [ entityId, content ]
            );

            return { inserted: false, observationId: existing.length ? existing[0].id : null };
        }

        return { inserted: true, observationId: rows[0].id };
    }

    async insertObservationVectors(rows) {
        if (!rows.length) {
            return;
        }

        await this.#requireVectorEnabled();

        const client = /** @type {import('pg').Client} */ await this.#pool.connect();
        try {
            await client.query('BEGIN');

            for (const row of rows) {
                const embeddingParam = this.#bufferToVector(row.embedding);

                await client.query(
                    `INSERT INTO obs_vec(observation_id, entity_id, embedding)
                     VALUES ($1, $2, $3::vector) ON CONFLICT(observation_id)
           DO
                    UPDATE SET embedding = EXCLUDED.embedding,
                        entity_id = EXCLUDED.entity_id`,
                    [ row.observationId, row.entityId, embeddingParam ]
                );
            }

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async createRelation(fromId, toId, relationType) {
        const rows = await this.#query(
            `INSERT INTO relations(from_id, to_id, relationtype)
             VALUES ($1, $2, $3) ON CONFLICT(from_id, to_id, relationtype) DO NOTHING
       RETURNING id`,
            [ fromId, toId, relationType ]
        );

        return rows.length > 0;
    }

    async deleteEntities(names) {
        if (!names.length) {
            return;
        }

        await this.#query(
            `DELETE
             FROM entities
             WHERE name = ANY ($1)`,
            [ names ]
        );
    }

    async deleteRelations(relations) {
        for (const relation of relations) {
            const fromId = await this.getEntityId(relation.from);
            const toId = await this.getEntityId(relation.to);
            if (!fromId || !toId) {
                continue;
            }

            await this.#query(
                `DELETE
                 FROM relations
                 WHERE from_id = $1
                   AND to_id = $2
                   AND relationtype = $3`,
                [ fromId, toId, relation.relationType ]
            );
        }
    }

    async deleteObservations(entityId, observations) {
        if (!observations.length) {
            return;
        }

        await this.#query(
            `DELETE
             FROM observations
             WHERE entity_id = $1
               AND content = ANY ($2)`,
            [ entityId, observations ]
        );
    }

    async readGraph() {
        /**
         * @type {[{entitytype:string, name:string, id}]}
         */
        const entities = await this.#query('SELECT * FROM entities', []);
        const observations = await this.#query('SELECT entity_id, content FROM observations', []);
        /**
         * @type {[{from_name: string, to_name: string, relationtype: string}]}
         */
        const relations = await this.#query(
            `SELECT r.from_id,
                    r.to_id,
                    r.relationtype,
                    ef.name AS from_name,
                    et.name AS to_name
             FROM relations r
                      JOIN entities ef ON ef.id = r.from_id
                      JOIN entities et ON et.id = r.to_id`,
            []
        );

        return {
            entities:  entities.map(e => ({
                name:         e.name,
                entityType:   e.entitytype,
                observations: observations
                                  .filter(o => o.entity_id === e.id)
                                  .map(o => o.content)
            })),
            relations: relations.map(rel => ({
                from:         rel.from_name,
                to:           rel.to_name,
                relationType: rel.relationtype
            }))
        };
    }

    async openNodes(names) {
        if (!names.length) {
            return { entities: [], relations: [] };
        }

        /**
         * @type {[{entitytype, id, name}]}
         */
        const entities = await this.#query(
            `SELECT *
             FROM entities
             WHERE name = ANY ($1)`,
            [ names ]
        );

        if (!entities.length) {
            return { entities: [], relations: [] };
        }

        const ids = entities.map(e => e.id);

        const observations = await this.#query(
            `SELECT entity_id, content
             FROM observations
             WHERE entity_id = ANY ($1)`,
            [ ids ]
        );

        /**
         * @type {[{name, from_name, to_name, relationtype}]}
         */
        const relations = await this.#query(
            `SELECT r.from_id,
                    r.to_id,
                    r.relationtype,
                    ef.name AS from_name,
                    et.name AS to_name
             FROM relations r
                      JOIN entities ef ON ef.id = r.from_id
                      JOIN entities et ON et.id = r.to_id
             WHERE r.from_id = ANY ($1)
               AND r.to_id = ANY ($1)`,
            [ ids ]
        );

        return {
            entities:  entities.map(e => ({
                name:         e.name,
                entityType:   e.entitytype,
                observations: observations
                                  .filter(o => o.entity_id === e.id)
                                  .map(o => o.content)
            })),
            relations: relations.map(rel => ({
                from:         rel.from_name,
                to:           rel.to_name,
                relationType: rel.relationtype
            }))
        };
    }

    async keywordSearch(query) {
        const ftsRows = await this.#query(
            `SELECT DISTINCT o.entity_id
                 FROM observations AS o
                 WHERE o.tsv @@ websearch_to_tsquery('simple', unaccent($1))`,
            [query]
        );

        const likeRows = await this.#query(
            `SELECT DISTINCT id AS entity_id
                 FROM entities
                WHERE name ILIKE $1 OR entitytype ILIKE $1`,
            [`%${query}%`]
        );

        const ids = new Set([
            ...ftsRows.map(r => Number(r.entity_id)),
            ...likeRows.map(r => Number(r.entity_id)),
        ]);

        return Array.from(ids);
    }

    async semanticSearch(vector, topK) {
        return this.#semanticRows(vector, topK);
    }

    async hybridSearch(query, vector, topK, adjustedThreshold) {
        const ftsRows = await this.#query(
            `SELECT DISTINCT o.entity_id
                 FROM observations AS o
                 WHERE o.tsv @@ websearch_to_tsquery('simple', unaccent($1))`,
            [query]
        );
        const ftsSet = new Set(ftsRows.map(r => Number(r.entity_id)));
        const vecRows = await this.#semanticRows(vector, topK * 2);
        const results = [];

        for (const row of vecRows) {
            const entityId = Number(row.entity_id);
            const distance = Number(row.distance);

            if (distance <= adjustedThreshold * 1.5) {
                results.push({
                    entity_id: entityId,
                    distance,
                    score: ftsSet.has(entityId) ? distance * 0.3 : distance,
                });
            }
        }

        for (const r of ftsRows) {
            const entityId = Number(r.entity_id);
            if (!results.find(x => x.entity_id === entityId)) {
                results.push({
                    entity_id: entityId,
                    distance: adjustedThreshold * 0.5,
                    score: adjustedThreshold * 0.5,
                });
            }
        }
        results.sort((a, b) => a.score - b.score);

        return results.slice(0, topK);
    }

    async fetchEntitiesWithDetails(entityIds) {
        if (!entityIds.length) {
            return [];
        }

        const normalizedIds = entityIds.map(id => Number(id));

        return await this.#query(
            `SELECT e.id                           AS entity_id,
                    e.name,
                    e.entitytype,
                    MIN(o.created_at)              AS created_at,
                    MAX(o.last_accessed)           AS last_accessed,
                    SUM(o.access_count)            AS access_count,
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
             WHERE e.id = ANY ($1)
             GROUP BY e.id, e.name, e.entitytype`,
            [ normalizedIds ]
        );
    }

    async getRecentlyAccessedEntities(limit) {
        const rows = await this.#query(
            `SELECT DISTINCT entity_id
             FROM observations
             WHERE last_accessed IS NOT NULL
             ORDER BY last_accessed DESC
                 LIMIT $1`,
            [ limit ]
        );

        return rows.map(r => r.entity_id);
    }

    async updateAccessStats(entityIds) {
        if (!entityIds.length) {
            return;
        }

        const normalizedIds = entityIds.map(id => Number(id));

        await this.#query(
            `UPDATE observations
             SET access_count  = COALESCE(access_count, 0) + 1,
                 last_accessed = NOW()
             WHERE entity_id = ANY ($1)`,
            [ normalizedIds ]
        );
    }

    async setImportance(entityId, importance) {
        const rows = await this.#query(
            `UPDATE observations
             SET importance = $1
             WHERE entity_id = $2 RETURNING id`,
            [ importance, entityId ]
        );

        return rows.length > 0;
    }

    async getEntityIdsByNames(names) {
        if (!names.length) {
            return new Map();
        }

        const rows = await this.#query(
            `SELECT name, id
             FROM entities
             WHERE name = ANY ($1)`,
            [ names ]
        );
        const map = new Map();
        for (const row of rows) {
            map.set(row.name, row.id.toString());
        }

        return map;
    }

    async getEntityNamesByIds(ids) {
        if (!ids.length) {
            return new Map();
        }

        const normalizedIds = ids.map(id => Number(id));
        const rows = await this.#query(
            `SELECT id, name
             FROM entities
             WHERE id = ANY ($1)`,
            [ normalizedIds ]
        );
        const map = new Map();
        for (const row of rows) {
            map.set(row.id.toString(), row.name);
        }

        return map;
    }

    async getRelationsForEntityIds(entityIds) {
        if (!entityIds.length) {
            return [];
        }

        const normalizedIds = entityIds.map(id => Number(id));

        return this.#query(
            `SELECT from_id, to_id
             FROM relations
             WHERE from_id = ANY ($1)
                OR to_id = ANY ($1)`,
            [ normalizedIds ]
        );
    }
}