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
     * @param {import('./graph-repository.js').GraphRepository} repository
     */
    constructor(repository) {
        this.#repository = repository;
        this.#searchContextManager = new SearchContextManager(repository);
    }

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

    async deleteEntities(names) {
        await this.#repository.deleteEntities(names);
    }

    async deleteRelations(relations) {
        await this.#repository.deleteRelations(relations);
    }

    async deleteObservations(list) {
        for (const { entityName, observations } of list) {
            const entityId = await this.#repository.getEntityId(entityName);
            if (!entityId) continue;
            await this.#repository.deleteObservations(entityId, observations);
        }
    }

    readGraph() {
        return this.#repository.readGraph();
    }

    async searchNodes({
                          query,
                          mode = 'keyword',
                          topK = 10,                 // было 8
                          threshold = 0.35,          // трактуем как cosine distance cap
                          includeScoreDetails = false,
                          scoringProfile = 'balanced',
                      }) {
        const distanceCap = threshold;

        if (mode === 'keyword') {
            const ids = await this.#repository.keywordSearch(query);
            if (!ids.length) return { entities: [], relations: [] };
            return this.#applyScoring(ids, query, includeScoreDetails, scoringProfile);
        }

        try {
            const [vector] = await this.embedTexts([query]);

            let rows;
            if (mode === 'semantic') {
                rows = await this.#repository.semanticSearch(vector, Math.max(topK * 2, topK + 5));
            } else {
                rows = await this.#repository.hybridSearch(query, vector, Math.max(topK * 3, topK + 10), distanceCap);
            }

            const ids = rows
                .filter(r => Number(r.distance) <= distanceCap)
                .slice(0, topK)               // после фильтра оставляем topK
                .map(r => r.entity_id);

            if (!ids.length) return { entities: [], relations: [] };
            return this.#applyScoring(ids, query, includeScoreDetails, scoringProfile);
        } catch (error) {
            console.error(`Search error in ${mode} mode:`, error.message);
            throw error;
        }
    }

    async openNodes(names) {
        return this.#repository.openNodes(names);
    }

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
