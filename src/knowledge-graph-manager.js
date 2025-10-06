/**
 * @file knowledge-graph-manager.js
 * @description
 * Backend-agnostic knowledge graph manager that coordinates CRUD and search
 * operations through a repository abstraction.
 */

import { pipeline } from '@xenova/transformers';
import { SearchContextManager } from './search-context-manager.js';

export class KnowledgeGraphManager {
    /**
     * @type {import('./graph-repository.js').GraphRepository}
     */
    #repository;

    /** @type {any} */
    #embedder = null;

    /** @type {SearchContextManager} */
    #searchContextManager;

    /**
     * Creates a new KnowledgeGraphManager.
     * @param {import('./graph-repository.js').GraphRepository} repository
     *   Graph repository implementation for data persistence.
     */
    constructor(repository) {
        this.#repository = repository;
        this.#searchContextManager = new SearchContextManager(repository);
    }

    /**
     * Creates multiple entities in the knowledge graph.
     * @async
     * @param {Array<{name: string, entityType: string, observations?: string[]}>} entities
     *   Array of entities to create with optional observations.
     * @returns {Promise<Array<{name: string, entityType: string}>>}
     *   Array of successfully created entities.
     */
    async createEntities(entities) {
        const created = [];
        for (const entity of entities) {
            const existingId = await this.#repository.getEntityId(entity.name);
            if (!existingId) {
                await this.#repository.createEntity(entity.name, entity.entityType);
                created.push(entity);
            }
            if (entity.observations?.length) {
                await this.addObservations([{ entityName: entity.name, contents: entity.observations }]);
            }
        }
        return created;
    }

    /**
     * Adds observations to entities and generates embeddings for them.
     * @async
     * @param {Array<{entityName: string, contents: string[]}>} list
     *   Array of objects containing entity names and their observations.
     * @returns {Promise<Array<{entityName: string, addedObservations: string[]}>>}
     *   Array of results showing which observations were added to each entity.
     */
    async addObservations(list) {
        const results = [];
        for (const { entityName, contents } of list) {
            const entityId = await this.#repository.getOrCreateEntityId(entityName, 'Unknown');
            const inserted = [];
            for (const content of contents) {
                const { inserted: wasInserted, observationId } = await this.#repository.insertObservation(entityId, content);
                if (wasInserted && observationId !== null && observationId !== undefined) {
                    inserted.push({ observationId, content });
                }
            }
            if (inserted.length) {
                const embeddings = await this.embedTexts(inserted.map(row => row.content));
                const vectorRows = inserted.map((row, index) => ({
                    observationId: row.observationId,
                    entityId,
                    embedding: embeddings[index]
                }));
                await this.#repository.insertObservationVectors(vectorRows);
            }
            results.push({ entityName, addedObservations: inserted.map(item => item.content) });
        }
        return results;
    }

    /**
     * Creates relations between entities in the knowledge graph.
     * @async
     * @param {Array<{from: string, to: string, relationType: string}>} relations
     *   Array of relations to create.
     * @returns {Promise<Array<{from: string, to: string, relationType: string}>>}
     *   Array of successfully created relations.
     */
    async createRelations(relations) {
        const created = [];
        for (const relation of relations) {
            const fromId = await this.#repository.getOrCreateEntityId(relation.from, 'Unknown');
            const toId = await this.#repository.getOrCreateEntityId(relation.to, 'Unknown');
            const inserted = await this.#repository.createRelation(fromId, toId, relation.relationType);
            if (inserted) {
                created.push(relation);
            }
        }
        return created;
    }

    /**
     * Deletes entities from the knowledge graph by their names.
     * @async
     * @param {string[]} names - Array of entity names to delete.
     * @returns {Promise<void>}
     */
    async deleteEntities(names) {
        await this.#repository.deleteEntities(names);
    }

    /**
     * Deletes relations between entities.
     * @async
     * @param {Array<{from: string, to: string, relationType: string}>} relations
     *   Array of relations to delete.
     * @returns {Promise<void>}
     */
    async deleteRelations(relations) {
        await this.#repository.deleteRelations(relations);
    }

    /**
     * Deletes specific observations from entities.
     * @async
     * @param {Array<{entityName: string, observations: string[]}>} list
     *   Array of objects containing entity names and observations to delete.
     * @returns {Promise<void>}
     */
    async deleteObservations(list) {
        for (const { entityName, observations } of list) {
            const entityId = await this.#repository.getEntityId(entityName);
            if (!entityId) continue;
            await this.#repository.deleteObservations(entityId, observations);
        }
    }

    /**
     * Retrieves the complete knowledge graph.
     * @async
     * @returns {Promise<{entities: Array<{name: string, entityType: string, observations: string[]}>, relations: Array<{from: string, to: string, relationType: string}>}>}
     *   Object containing all entities and relations in the graph.
     */
    readGraph() {
        return this.#repository.readGraph();
    }

    /**
     * Searches the knowledge graph using semantic search.
     * @async
     * @param {object} options - Search configuration options.
     * @param {string} options.query - Search query string.
     * @param {number} [options.topK=10] - Maximum number of results to return.
     * @param {number} [options.threshold=0.75] - Threshold
     * @param {boolean} [options.includeScoreDetails=false] - Include score components in results.
     * @param {string} [options.scoringProfile='balanced'] - Scoring profile to use.
     * @returns {Promise<{entities: Array, relations: Array}>}
     *   Search results with entities and their relations.
     */
    async searchNodes({
                          query,
                          topK = 10,
                          threshold = 0.75,
                          includeScoreDetails = false,
                          scoringProfile = 'balanced'
                      }) {

        try {
            const [ rawVectorBuf ] = await this.embedTexts([ query ]);
            const rawVector = Array.from(new Float32Array(rawVectorBuf.buffer, rawVectorBuf.byteOffset, rawVectorBuf.byteLength / 4));
            const unitVector = normalizeVector(rawVector);
            const limit = Math.max(topK * 2, topK + 5);
            const rows = await this.#repository.semanticSearch(unitVector, limit);

            const ids = rows
                .filter(r => Number(r.similarity) >= Number(threshold))
                .slice(0, topK)
                .map(r => r.entity_id);

            if (!ids.length) {
                return { entities: [], relations: [] }
            }

            return this.#applyScoring(ids, query, includeScoreDetails, scoringProfile);

        } catch (error) {
            console.error(`Search error:`, error?.message ?? error);

            throw error;
        }

        function normalizeVector(v) {
            let sum = 0;
            for (let i = 0; i < v.length; i += 1) {
                sum += v[i] * v[i];
            }
            const norm = Math.sqrt(sum)
            if (!isFinite(norm) || norm === 0) {
                return v;
            }

            const out = new Array(v.length)
            for (let i = 0; i < v.length; i += 1) {
                out[i] = v[i] / norm;
            }

            return out;
        }
    }

    /**
     * Retrieves detailed information for specified entities by their names.
     * @async
     * @param {string[]} names - Array of entity names to retrieve.
     * @returns {Promise<{entities: Array<{name: string, entityType: string, observations: string[]}>, relations: Array<{from: string, to: string, relationType: string}>}>}
     *   Object containing specified entities with observations and their relations.
     */
    async openNodes(names) {
        return this.#repository.openNodes(names);
    }

    /**
     * Generates embeddings for an array of text strings using the configured model.
     * @async
     * @param {string[]} textArr - Array of text strings to embed.
     * @returns {Promise<Buffer[]>}
     *   Array of embedding vectors as Buffers.
     */
    async embedTexts(textArr) {
        if (!this.#embedder) {
            this.#embedder = await pipeline('feature-extraction', 'Xenova/bge-m3', { quantized: true });
        }
        const outputs = [];
        for (const text of textArr) {
            const result = await this.#embedder(text, { pooling: 'mean', normalize: true });
            outputs.push(Buffer.from(Float32Array.from(result.data).buffer));
        }

        return outputs;
    }

    /**
     * Applies relevance scoring to search results using context and access patterns.
     * @async
     * @private
     * @param {number[]} entityIds - Array of entity IDs from search results.
     * @param {string} query - Original search query for context.
     * @param {boolean} includeScoreDetails - Whether to include score components.
     * @param {string} scoringProfile - Scoring profile to use.
     * @returns {Promise<{entities: Array, relations: Array}>}
     *   Scored and sorted results with entities and relations.
     */
    async #applyScoring(entityIds, query, includeScoreDetails, scoringProfile) {
        if (!entityIds?.length) {
            return { entities: [], relations: [] };
        }
        const entityData = await this.#repository.fetchEntitiesWithDetails(entityIds);
        const normalized = entityData.map(row => ({ ...row, entity_id: String(row.entity_id) }));
        const searchContext = await this.#searchContextManager.prepareSearchContext(query, {
            contextSize: 5,
            preloadDepth: 2
        });
        const scored = await this.#searchContextManager.scoreSearchResults(normalized, searchContext, {
            includeComponents: includeScoreDetails,
            scoringProfile
        });
        scored.sort((a, b) => (b.score || 0) - (a.score || 0));
        const foundIds = scored.map(row => Number(row.entity_id));

        if (foundIds.length) {
            await this.#searchContextManager.updateAccessStats(foundIds);
        }

        const entityNames = scored.map(row => row.name);
        const fullDetails = await this.openNodes(entityNames);

        if (includeScoreDetails) {
            const withScores = fullDetails.entities.map((entity, index) => ({
                ...entity,
                score: scored[index]?.score,
                scoreComponents: scored[index]?.scoreComponents
            }));
            return { entities: withScores, relations: fullDetails.relations };
        }

        return fullDetails;
    }

    /**
     * Retrieves or optionally creates an entity ID by name.
     * @async
     * @param {string} name - Entity name to look up.
     * @param {string} [type='Unknown'] - Entity type to use if creating.
     * @param {boolean} [create=false] - Whether to create the entity if not found.
     * @returns {Promise<number|null>}
     *   Entity ID if found or created, null if not found and create is false.
     */
    async getEntityId(name, type = 'Unknown', create = false) {
        const existing = await this.#repository.getEntityId(name);
        if (existing !== null) {
            return existing;
        }
        if (!create) {
            return null;
        }

        return this.#repository.getOrCreateEntityId(name, type);
    }

    /**
     * Sets the importance level for an entity.
     * @async
     * @param {string} entityName - Name of the entity to update.
     * @param {string} importance - Importance level (e.g., 'critical', 'important', 'normal').
     * @returns {Promise<{success: boolean, entityName?: string, importance?: string, message?: string, error?: string}>}
     *   Object indicating operation success and details or error message.
     */
    async setImportance(entityName, importance) {
        try {
            const entityId = await this.getEntityId(entityName);

            if (!entityId) {
                return { success: false, error: `Entity "${entityName}" not found` };
            }

            const success = await this.#searchContextManager.setImportance(entityId, importance);

            return {
                success,
                entityName,
                importance,
                message: success
                    ? `Importance set to '${importance}' for entity '${entityName}'`
                    : `Failed to set importance for entity '${entityName}'`
            };

        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}
