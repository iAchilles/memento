/**
 * @file graph-repository.js
 * @description
 * Defines the interface for database-specific knowledge graph repositories.
 */

/**
 * @typedef {Object} ObservationInsertResult
 * @property {boolean} inserted - Whether the observation was newly inserted.
 * @property {number|string|null} observationId - Identifier of the observation row.
 */

/**
 * @typedef {Object} HybridSearchRow
 * @property {number|string} entity_id
 * @property {number} distance
 * @property {number} score
 */

/**
 * @typedef {Object} GraphRepository
 * @property {(name: string) => Promise<number|null>} getEntityId
 * @property {(name: string, entityType: string) => Promise<number|string>} createEntity
 * @property {(name: string, entityType: string) => Promise<number|string>} getOrCreateEntityId
 * @property {(entityId: number|string, content: string) => Promise<ObservationInsertResult>} insertObservation
 * @property {(rows: Array<{ observationId: number|string, entityId: number|string, embedding: Buffer }>) => Promise<void>} insertObservationVectors
 * @property {(fromId: number|string, toId: number|string, relationType: string) => Promise<boolean>} createRelation
 * @property {(names: string[]) => Promise<void>} deleteEntities
 * @property {(relations: Array<{ from: string, to: string, relationType: string }>) => Promise<void>} deleteRelations
 * @property {(entityId: number|string, observations: string[]) => Promise<void>} deleteObservations
 * @property {() => Promise<{ entities: Array<{ name: string, entityType: string, observations: string[] }>, relations: Array<{ from: string, to: string, relationType: string }> }>} readGraph
 * @property {(query: string) => Promise<Array<number|string>>} keywordSearch
 * @property {(vector: Buffer, topK: number) => Promise<Array<{ entity_id: number|string, distance: number }>>} semanticSearch
 * @property {(query: string, vector: Buffer, topK: number, adjustedThreshold: number) => Promise<Array<HybridSearchRow>>} hybridSearch
 * @property {(entityIds: Array<number|string>) => Promise<Array<{ entity_id: number|string, name: string, entityType: string, created_at: string|null, last_accessed: string|null, access_count: number|null, importance: string|null }>>} fetchEntitiesWithDetails
 * @property {(names: string[]) => Promise<{ entities: Array<{ name: string, entityType: string, observations: string[] }>, relations: Array<{ from: string, to: string, relationType: string }> }>} openNodes
 * @property {(names: string[]) => Promise<Map<string, string>>} getEntityIdsByNames
 * @property {(ids: Array<number|string>) => Promise<Map<string, string>>} getEntityNamesByIds
 * @property {(entityIds: Array<number|string>) => Promise<Array<{ from_id: number|string, to_id: number|string }>>} getRelationsForEntityIds
 * @property {(limit: number) => Promise<Array<number|string>>} getRecentlyAccessedEntities
 * @property {(entityIds: Array<number|string>) => Promise<void>} updateAccessStats
 * @property {(entityId: number|string, importance: string) => Promise<boolean>} setImportance
 * @property {(entityId: number|string, tags: string[]) => Promise<boolean>} addTags
 */

export {}; // Documentation only module
