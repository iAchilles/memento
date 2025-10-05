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
     * @param {import('sqlite').Database} db
     */
    constructor(db) {
        this.db = db;
    }

    async getEntityId(name) {
        const row = await this.db.get('SELECT id FROM entities WHERE name = ?', [name]);
        return row ? row.id : null;
    }

    async createEntity(name, entityType) {
        const result = await this.db.run(
            'INSERT INTO entities(name, entityType) VALUES(?, ?)',
            [name, entityType]
        );
        return result.lastID;
    }

    async getOrCreateEntityId(name, entityType) {
        const existing = await this.getEntityId(name);
        if (existing !== null) {
            return existing;
        }
        return this.createEntity(name, entityType);
    }

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

    async insertObservationVectors(rows) {
        if (!rows.length) {
            return;
        }

        await this.db.exec('BEGIN TRANSACTION');
        try {
            for (const { observationId, entityId, embedding } of rows) {
                await this.db.run(
                    'INSERT OR REPLACE INTO obs_vec(observation_id, entity_id, embedding) VALUES(?, ?, ?)',
                    [observationId, entityId, embedding]
                );
            }
            await this.db.exec('COMMIT');
        } catch (error) {
            await this.db.exec('ROLLBACK');
            throw error;
        }
    }

    async createRelation(fromId, toId, relationType) {
        const result = await this.db.run(
            'INSERT OR IGNORE INTO relations(from_id, to_id, relationType) VALUES(?, ?, ?)',
            [fromId, toId, relationType]
        );
        return Boolean(result.changes);
    }

    async deleteEntities(names) {
        if (!names.length) return;
        const placeholders = names.map(() => '?').join(',');
        await this.db.run(`DELETE FROM entities WHERE name IN (${placeholders})`, names);
    }

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

    async deleteObservations(entityId, observations) {
        if (!observations.length) return;
        const placeholders = observations.map(() => '?').join(',');
        await this.db.run(
            `DELETE FROM observations WHERE entity_id = ? AND content IN (${placeholders})`,
            [entityId, ...observations]
        );
    }

    async readGraph() {
        const entities = await this.db.all('SELECT * FROM entities');
        const observations = await this.db.all('SELECT entity_id, content FROM observations');
        const relations = await this.db.all(`
            SELECT r.from_id, r.to_id, r.relationType, ef.name AS from_name, et.name AS to_name
            FROM relations r
                     JOIN entities ef ON ef.id = r.from_id
                     JOIN entities et ON et.id = r.to_id
        `);

        return {
            entities: entities.map(entity => ({
                name: entity.name,
                entityType: entity.entityType ?? entity.entitytype,
                observations: observations
                    .filter(obs => obs.entity_id === entity.id)
                    .map(obs => obs.content)
            })),
            relations: relations.map(rel => ({
                from: rel.from_name,
                to: rel.to_name,
                relationType: rel.relationType ?? rel.relationtype
            }))
        };
    }

    #escapeLike(query) {
        return query.replace(/[\\%_]/g, '\\$&');
    }

    #escapeFts(query) {
        const escaped = query.replace(/"/g, '""');
        return `"${escaped}"`;
    }

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

    async fetchEntitiesWithDetails(entityIds) {
        if (!entityIds.length) return [];
        const placeholders = entityIds.map(() => '?').join(',');
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
        return rows.map(row => ({
            ...row,
            entityType: row.entityType ?? row.entitytype
        }));
    }

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
                entityType: entity.entityType ?? entity.entitytype,
                observations: observations
                    .filter(obs => obs.entity_id === entity.id)
                    .map(obs => obs.content)
            })),
            relations: relations.map(relation => ({
                from: relation.from_name,
                to: relation.to_name,
                relationType: relation.relationType ?? relation.relationtype
            }))
        };
    }

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

    async getRelationsForEntityIds(entityIds) {
        if (!entityIds.length) return [];
        const placeholders = entityIds.map(() => '?').join(',');
        return this.db.all(
            `SELECT from_id, to_id
             FROM relations
             WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`,
            [...entityIds, ...entityIds]
        );
    }

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

    async updateAccessStats(entityIds) {
        if (!entityIds.length) return;
        const placeholders = entityIds.map(() => '?').join(',');
        await this.db.run(
            `UPDATE observations
             SET access_count = COALESCE(access_count, 0) + 1,
                 last_accessed = datetime('now')
             WHERE entity_id IN (${placeholders})`,
            entityIds
        );
    }

    async setImportance(entityId, importance) {
        const result = await this.db.run(
            'UPDATE observations SET importance = ? WHERE entity_id = ?',
            [importance, entityId]
        );
        return result.changes > 0;
    }

    async addTags(entityId, tags) {
        const row = await this.db.get(
            'SELECT id, tags FROM observations WHERE entity_id = ? LIMIT 1',
            [entityId]
        );
        if (!row) {
            return false;
        }
        const existing = row.tags ? JSON.parse(row.tags) : [];
        const merged = [...new Set([...existing, ...tags])];
        await this.db.run(
            'UPDATE observations SET tags = ? WHERE entity_id = ?',
            [JSON.stringify(merged), entityId]
        );
        return true;
    }
}
