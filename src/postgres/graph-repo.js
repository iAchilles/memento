/**
 * @file postgres/graph-repo.js
 * @description
 * PostgreSQL implementation of the knowledge graph repository.
 */

const VECTOR_TYPE_NAME = 'vector';

/**
 * @implements {import('../graph-repository.js').GraphRepository}
 */
export class PostgresGraphRepository {
    /**
     * @param {import('pg').Pool} pool
     */
    constructor(pool) {
        this.pool = pool;
        this.vectorEnabledPromise = this.#detectVectorSupport();
    }

    async #detectVectorSupport() {
        const client = await this.pool.connect();
        try {
            const result = await client.query(
                `SELECT 1 FROM information_schema.columns WHERE table_name = 'obs_vec' AND column_name = 'embedding' AND udt_name = $1`,
                [VECTOR_TYPE_NAME]
            );
            return result.rowCount > 0;
        } finally {
            client.release();
        }
    }

    #bufferToFloatArray(buffer) {
        return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    }

    #l2Distance(vecA, vecB) {
        const a = this.#bufferToFloatArray(vecA);
        const b = this.#bufferToFloatArray(vecB);
        const length = Math.min(a.length, b.length);
        let sum = 0;
        for (let i = 0; i < length; i++) {
            const diff = a[i] - b[i];
            sum += diff * diff;
        }
        return Math.sqrt(sum);
    }

    async #semanticRows(vector, limit) {
        const vectorEnabled = await this.vectorEnabledPromise;
        if (vectorEnabled) {
            const rows = await this.#query(
                `SELECT entity_id, embedding <-> $1::vector AS distance
                 FROM obs_vec
                 WHERE embedding IS NOT NULL
                 ORDER BY embedding <-> $1::vector
                 LIMIT $2`,
                [this.#bufferToVector(vector), limit]
            );
            return rows.map(row => ({ entity_id: Number(row.entity_id), distance: Number(row.distance) }));
        }

        const rows = await this.#query(
            `SELECT entity_id, embedding FROM obs_vec WHERE embedding IS NOT NULL`,
            []
        );
        const scored = rows.map(row => {
            const embeddingBuffer = Buffer.from(row.embedding, 'base64');
            return {
                entity_id: Number(row.entity_id),
                distance: this.#l2Distance(vector, embeddingBuffer)
            };
        });
        scored.sort((a, b) => a.distance - b.distance);
        return scored.slice(0, limit);
    }

    async #query(sql, params = []) {
        const res = await this.pool.query(sql, params);
        return res.rows;
    }

    async getEntityId(name) {
        const rows = await this.#query('SELECT id FROM entities WHERE name = $1', [name]);
        return rows.length ? rows[0].id : null;
    }

    async createEntity(name, entityType) {
        const rows = await this.#query(
            `INSERT INTO entities(name, entitytype)
             VALUES($1, $2)
             RETURNING id`,
            [name, entityType]
        );
        return rows[0].id;
    }

    async getOrCreateEntityId(name, entityType) {
        const existing = await this.getEntityId(name);
        if (existing !== null) {
            return existing;
        }

        const rows = await this.#query(
            `INSERT INTO entities(name, entitytype)
             VALUES($1, $2)
             ON CONFLICT(name)
             DO UPDATE SET entitytype = EXCLUDED.entitytype
             RETURNING id`,
            [name, entityType]
        );
        return rows[0].id;
    }

    async insertObservation(entityId, content) {
        const rows = await this.#query(
            `INSERT INTO observations(entity_id, content)
             VALUES($1, $2)
             ON CONFLICT(entity_id, content) DO NOTHING
             RETURNING id`,
            [entityId, content]
        );
        if (!rows.length) {
            const existing = await this.#query(
                `SELECT id FROM observations WHERE entity_id = $1 AND content = $2`,
                [entityId, content]
            );
            return { inserted: false, observationId: existing.length ? existing[0].id : null };
        }
        return { inserted: true, observationId: rows[0].id };
    }

    async insertObservationVectors(rows) {
        if (!rows.length) return;
        const vectorEnabled = await this.vectorEnabledPromise;
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            for (const row of rows) {
                const embeddingParam = vectorEnabled
                    ? this.#bufferToVector(row.embedding)
                    : row.embedding.toString('base64');
                await client.query(
                    vectorEnabled
                        ? `INSERT INTO obs_vec(observation_id, entity_id, embedding)
                           VALUES($1, $2, $3::vector)
                           ON CONFLICT(observation_id) DO UPDATE
                           SET embedding = EXCLUDED.embedding, entity_id = EXCLUDED.entity_id`
                        : `INSERT INTO obs_vec(observation_id, entity_id, embedding)
                           VALUES($1, $2, $3)
                           ON CONFLICT(observation_id) DO UPDATE
                           SET embedding = EXCLUDED.embedding, entity_id = EXCLUDED.entity_id`,
                    [row.observationId, row.entityId, embeddingParam]
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

    #bufferToVector(buffer) {
        const floats = Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
        return `[${floats.join(',')}]`;
    }

    async createRelation(fromId, toId, relationType) {
        const rows = await this.#query(
            `INSERT INTO relations(from_id, to_id, relationtype)
             VALUES($1, $2, $3)
             ON CONFLICT(from_id, to_id, relationtype) DO NOTHING
             RETURNING id`,
            [fromId, toId, relationType]
        );
        return rows.length > 0;
    }

    async deleteEntities(names) {
        if (!names.length) return;
        await this.#query(
            `DELETE FROM entities WHERE name = ANY($1)`,
            [names]
        );
    }

    async deleteRelations(relations) {
        for (const relation of relations) {
            const fromId = await this.getEntityId(relation.from);
            const toId = await this.getEntityId(relation.to);
            if (!fromId || !toId) continue;
            await this.#query(
                `DELETE FROM relations WHERE from_id = $1 AND to_id = $2 AND relationtype = $3`,
                [fromId, toId, relation.relationType]
            );
        }
    }

    async deleteObservations(entityId, observations) {
        if (!observations.length) return;
        await this.#query(
            `DELETE FROM observations WHERE entity_id = $1 AND content = ANY($2)`,
            [entityId, observations]
        );
    }

    async readGraph() {
        const entities = await this.#query('SELECT * FROM entities', []);
        const observations = await this.#query('SELECT entity_id, content FROM observations', []);
        const relations = await this.#query(
            `SELECT r.from_id, r.to_id, r.relationtype, ef.name AS from_name, et.name AS to_name
             FROM relations r
                      JOIN entities ef ON ef.id = r.from_id
                      JOIN entities et ON et.id = r.to_id`,
            []
        );
        return {
            entities: entities.map(entity => ({
                name: entity.name,
                entityType: entity.entitytype,
                observations: observations
                    .filter(obs => obs.entity_id === entity.id)
                    .map(obs => obs.content)
            })),
            relations: relations.map(rel => ({
                from: rel.from_name,
                to: rel.to_name,
                relationType: rel.relationtype
            }))
        };
    }

    async keywordSearch(query) {
        const ftsRows = await this.#query(
            `SELECT DISTINCT entity_id
             FROM obs_fts
             WHERE to_tsvector('english', content) @@ plainto_tsquery('english', $1)`,
            [query]
        );
        const likeRows = await this.#query(
            `SELECT DISTINCT id AS entity_id
             FROM entities
             WHERE name ILIKE $1 OR entitytype ILIKE $1`,
            [`%${query}%`]
        );
        const ids = new Set([
            ...ftsRows.map(row => Number(row.entity_id)),
            ...likeRows.map(row => Number(row.entity_id))
        ]);
        return Array.from(ids);
    }

    async semanticSearch(vector, topK) {
        return this.#semanticRows(vector, topK);
    }

    async hybridSearch(query, vector, topK, adjustedThreshold) {
        const ftsRows = await this.#query(
            `SELECT DISTINCT entity_id
             FROM obs_fts
             WHERE to_tsvector('english', content) @@ plainto_tsquery('english', $1)`,
            [query]
        );
        const vecRows = await this.#semanticRows(vector, topK * 2);

        const ftsSet = new Set(ftsRows.map(row => Number(row.entity_id)));
        const results = [];
        for (const row of vecRows) {
            const entityId = Number(row.entity_id);
            const distance = Number(row.distance);
            if (distance <= adjustedThreshold * 1.5) {
                results.push({
                    entity_id: entityId,
                    distance,
                    score: ftsSet.has(entityId) ? distance * 0.3 : distance
                });
            }
        }
        for (const row of ftsRows) {
            const entityId = Number(row.entity_id);
            if (!results.find(r => r.entity_id === entityId)) {
                results.push({
                    entity_id: entityId,
                    distance: adjustedThreshold * 0.5,
                    score: adjustedThreshold * 0.5
                });
            }
        }
        results.sort((a, b) => a.score - b.score);
        return results.slice(0, topK);
    }

    async fetchEntitiesWithDetails(entityIds) {
        if (!entityIds.length) return [];
        const normalizedIds = entityIds.map(id => Number(id));
        try {
            const rows = await this.#query(
                `SELECT
                     e.id AS entity_id,
                     e.name,
                     e.entitytype,
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
                 WHERE e.id = ANY($1)
                 GROUP BY e.id, e.name, e.entitytype`,
                [normalizedIds]
            );
            return rows;
        } catch (error) {
            if (!/cannot cast type text to integer|column "e\.id"/.test(error.message)) {
                throw error;
            }
            const fallback = [];
            for (const id of normalizedIds) {
                const entityRows = await this.#query(
                    `SELECT id AS entity_id, name, entitytype FROM entities WHERE id = $1`,
                    [id]
                );
                if (!entityRows.length) continue;
                const obsRows = await this.#query(
                    `SELECT created_at, last_accessed, access_count, importance FROM observations WHERE entity_id = $1`,
                    [id]
                );
                let minCreated = null;
                let maxAccessed = null;
                let accessSum = 0;
                let importance = 'normal';
                let latestAccessTime = null;
                for (const obs of obsRows) {
                    if (obs.created_at) {
                        const createdTime = new Date(obs.created_at).toISOString();
                        minCreated = !minCreated || createdTime < minCreated ? createdTime : minCreated;
                    }
                    if (obs.last_accessed) {
                        const accessIso = new Date(obs.last_accessed).toISOString();
                        if (!maxAccessed || accessIso > maxAccessed) {
                            maxAccessed = accessIso;
                        }
                        if (!latestAccessTime || accessIso > latestAccessTime) {
                            latestAccessTime = accessIso;
                            importance = obs.importance ?? 'normal';
                        }
                    }
                    accessSum += obs.access_count ?? 0;
                }
                fallback.push({
                    entity_id: id,
                    name: entityRows[0].name,
                    entitytype: entityRows[0].entitytype,
                    created_at: minCreated,
                    last_accessed: maxAccessed,
                    access_count: accessSum,
                    importance
                });
            }
            return fallback;
        }
    }

    async openNodes(names) {
        if (!names.length) {
            return { entities: [], relations: [] };
        }
        let entities;
        try {
            entities = await this.#query(
                `SELECT * FROM entities WHERE name = ANY($1)`,
                [names]
            );
        } catch (error) {
            entities = [];
        }
        if (!entities.length && names.length) {
            const manual = [];
            for (const name of names) {
                const rows = await this.#query(
                    `SELECT * FROM entities WHERE name = $1`,
                    [name]
                );
                manual.push(...rows);
            }
            entities = manual;
        }
        if (!entities.length) {
            return { entities: [], relations: [] };
        }
        const ids = entities.map(e => e.id);
        let observations = [];
        try {
            observations = await this.#query(
                `SELECT entity_id, content FROM observations WHERE entity_id = ANY($1)`,
                [ids]
            );
        } catch (error) {
            for (const id of ids) {
                const rows = await this.#query(
                    `SELECT entity_id, content FROM observations WHERE entity_id = $1`,
                    [id]
                );
                observations.push(...rows);
            }
        }
        let relations;
        try {
            relations = await this.#query(
                `SELECT r.from_id, r.to_id, r.relationtype, ef.name AS from_name, et.name AS to_name
                 FROM relations r
                          JOIN entities ef ON ef.id = r.from_id
                          JOIN entities et ON et.id = r.to_id
                 WHERE r.from_id = ANY($1) AND r.to_id = ANY($1)`,
                [ids]
            );
        } catch (error) {
            relations = [];
            for (const id of ids) {
                const rows = await this.#query(
                    `SELECT r.from_id, r.to_id, r.relationtype, ef.name AS from_name, et.name AS to_name
                     FROM relations r
                              JOIN entities ef ON ef.id = r.from_id
                              JOIN entities et ON et.id = r.to_id
                     WHERE r.from_id = $1 OR r.to_id = $1`,
                    [id]
                );
                relations.push(...rows);
            }
        }
        return {
            entities: entities.map(entity => ({
                name: entity.name,
                entityType: entity.entitytype,
                observations: observations
                    .filter(obs => obs.entity_id === entity.id)
                    .map(obs => obs.content)
            })),
            relations: relations.map(rel => ({
                from: rel.from_name,
                to: rel.to_name,
                relationType: rel.relationtype
            }))
        };
    }

    async getEntityIdsByNames(names) {
        if (!names.length) return new Map();
        const rows = await this.#query(
            `SELECT name, id FROM entities WHERE name = ANY($1)`,
            [names]
        );
        const map = new Map();
        for (const row of rows) {
            map.set(row.name, row.id.toString());
        }
        return map;
    }

    async getEntityNamesByIds(ids) {
        if (!ids.length) return new Map();
        const normalizedIds = ids.map(id => Number(id));
        const rows = await this.#query(
            `SELECT id, name FROM entities WHERE id = ANY($1)`,
            [normalizedIds]
        );
        const map = new Map();
        for (const row of rows) {
            map.set(row.id.toString(), row.name);
        }
        return map;
    }

    async getRelationsForEntityIds(entityIds) {
        if (!entityIds.length) return [];
        const normalizedIds = entityIds.map(id => Number(id));
        return this.#query(
            `SELECT from_id, to_id
             FROM relations
             WHERE from_id = ANY($1) OR to_id = ANY($1)`,
            [normalizedIds]
        );
    }

    async getRecentlyAccessedEntities(limit) {
        const rows = await this.#query(
            `SELECT DISTINCT entity_id
             FROM observations
             WHERE last_accessed IS NOT NULL
             ORDER BY last_accessed DESC
             LIMIT $1`,
            [limit]
        );
        return rows.map(row => row.entity_id);
    }

    async updateAccessStats(entityIds) {
        if (!entityIds.length) return;
        const normalizedIds = entityIds.map(id => Number(id));
        try {
            await this.#query(
                `UPDATE observations
                 SET access_count = COALESCE(access_count, 0) + 1,
                     last_accessed = NOW()
                 WHERE entity_id = ANY($1)`
                ,
                [normalizedIds]
            );
        } catch (error) {
            if (!/cannot cast type text to integer/.test(error.message)) {
                throw error;
            }
            for (const id of normalizedIds) {
                await this.#query(
                    `UPDATE observations
                     SET access_count = COALESCE(access_count, 0) + 1,
                         last_accessed = NOW()
                     WHERE entity_id = $1`,
                    [id]
                );
            }
        }
    }

    async setImportance(entityId, importance) {
        const rows = await this.#query(
            `UPDATE observations SET importance = $1 WHERE entity_id = $2 RETURNING id`,
            [importance, entityId]
        );
        return rows.length > 0;
    }

    async addTags(entityId, tags) {
        const rows = await this.#query(
            `SELECT id, tags FROM observations WHERE entity_id = $1 LIMIT 1`,
            [entityId]
        );
        if (!rows.length) {
            return false;
        }
        const existing = rows[0].tags ? JSON.parse(rows[0].tags) : [];
        const merged = [...new Set([...existing, ...tags])];
        await this.#query(
            `UPDATE observations SET tags = $2 WHERE entity_id = $1`,
            [entityId, JSON.stringify(merged)]
        );
        return true;
    }
}
