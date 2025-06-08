/**
 * @file knowledge-graph-manager.js
 * @description
 * Provides methods to manage a knowledge graph stored in SQLite, including entities,
 * observations, and relations. Uses FTS5 and sqlite-vec for keyword and semantic search.
 * Embeddings are generated via @xenova/transformers.
 */

import { pipeline } from '@xenova/transformers';

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
     * Creates an instance of KnowledgeGraphManager.
     * @param {import('sqlite').Database} db - An opened SQLite database connection.
     */
    constructor(db) {
        this.#db = db;
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
            const res = await this.#db.run(
                "INSERT OR IGNORE INTO entities(name, entityType) VALUES(?, ?)",
                [ e.name, e.entityType ]
            );
            if (res.changes) created.push(e);
            if (e.observations?.length) {
                await this.addObservations([ { entityName: e.name, contents: e.observations } ]);
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
                if (res.changes) newTexts.push(t);
            }
            if (newTexts.length) {
                const vecs      = await this.embedTexts(newTexts);
                const insertVec = await this.#db.prepare(
                    "INSERT INTO obs_vec(entity_id, embedding) VALUES(?, ?)"
                );
                await this.#db.exec("BEGIN TRANSACTION");
                for (const v of vecs) await insertVec.run(eid, v);
                await this.#db.exec("COMMIT");
                await insertVec.finalize();
                const insertFts = await this.#db.prepare(
                    "INSERT INTO obs_fts(rowid, content, entity_id) VALUES(-1, ?, ?)"
                );
                for (const t of newTexts) await insertFts.run(t, eid);
                await insertFts.finalize();
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
            if (res.changes) created.push(r);
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
            if (!eid) continue;
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
     * @param {{ query: string, mode?: "keyword" | "semantic" | "hybrid", topK?: number, threshold?: number }}
     *   Search options.
     * @returns {Promise<{ entities: Array<{ name: string, entityType: string, observations: string[] }>, relations: Array<{ from: string, to: string, relationType: string }> }>}
     */
    async searchNodes({ query, mode = "keyword", topK = 8, threshold = 0.35 }) {
        if (mode === "keyword") {
            const q    = `%${query.toLowerCase()}%`;
            const ents = await this.#db.all(
                `SELECT DISTINCT e.*
                 FROM entities e
                          LEFT JOIN observations o ON o.entity_id = e.id
                 WHERE LOWER(e.name) LIKE ?
                    OR LOWER(e.entityType) LIKE ?
                    OR LOWER(o.content) LIKE ?`,
                [ q, q, q ]
            );

            return this.openNodes(ents.map(e => e.name));
        }
        // semantic or hybrid mode
        const [ qVec ] = await this.embedTexts([ query ]);
        const rows     = await this.#db.all(
            `SELECT entity_id, distance(embedding, ?) AS d
             FROM obs_vec
             ORDER BY d LIMIT ?`,
            [ qVec, topK ]
        );
        const ids      = rows.filter(r => r.d <= threshold).map(r => r.entity_id);

        return this.openNodes([ ...new Set(ids) ]);
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
                "Xenova/bge-small-en-v1.5",
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
}
