/**
 * @file server.js
 * @description
 * Provides an MCP server implementation that registers knowledge graph management tools
 * (entities, relations, observations, graph reading, and search operations) using McpServer.
 * Each tool is documented with descriptive names and parameter schemas to be used by clients.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * MCP server that exposes knowledge graph operations as tools for Claude or other agents.
 * @extends McpServer
 */
export class Server extends McpServer {
    /**
     * Instance of KnowledgeGraphManager that implements CRUD and search operations.
     * @private
     * @type {import('./knowledge-graph-manager').KnowledgeGraphManager}
     */
    #knowledgeGraphManager = null;

    /**
     * Constructs the Server and initializes the underlying MCP server.
     * @param {{ name: string, version: string }} serverInfo
     *   Information about this server (name and version) for registration.
     * @param {import('./knowledge-graph-manager').KnowledgeGraphManager} knowledgeGraphManager
     *   The manager instance to delegate entity, observation, and relation commands.
     */
    constructor(serverInfo, knowledgeGraphManager) {
        super(serverInfo);
        this.#knowledgeGraphManager = knowledgeGraphManager;
        this.#createTools();
    }

    /**
     * Registers all MCP tools related to knowledge graph management.
     * Each tool is described with a name, human-readable description, parameter schema,
     * and handler function that returns MCP-compatible content.
     * @private
     */
    #createTools() {
        // Tool: create_entities
        this.tool(
            'create_entities',
            'Create entities in the knowledge graph. Inserts each entity if not exists and optionally seeds it with observations.',
            {
                entities: z.array(z.object({
                    name:         z.string().describe('Unique name of the entity.'),
                    entityType:   z.string().describe('Type or category of the entity.'),
                    observations: z.array(z.string()).optional()
                                      .describe('Initial list of observations to attach to the entity.')
                })).describe('Array of entities to create.')
            },
            async ({ entities }) => ({
                content: [{
                    type: 'text',
                    text: JSON.stringify(
                        await this.#knowledgeGraphManager.createEntities(entities),
                        null,
                        2
                    )
                }]
            })
        );

        // Tool: create_relations
        this.tool(
            'create_relations',
            'Create directed relations between entities. Skips existing relations.',
            {
                relations: z.array(z.object({
                    from:         z.string().describe('Source entity name.'),
                    to:           z.string().describe('Target entity name.'),
                    relationType: z.string().describe('Label or type of the relation.')
                })).describe('Array of relations to create.')
            },
            async ({ relations }) => ({
                content: [{
                    type: 'text',
                    text: JSON.stringify(
                        await this.#knowledgeGraphManager.createRelations(relations),
                        null,
                        2
                    )
                }]
            })
        );

        // Tool: add_observations
        this.tool(
            'add_observations',
            'Add text observations to existing entities and index them for full-text and semantic search.',
            {
                observations: z.array(z.object({
                    entityName: z.string().describe('Name of the entity to annotate.'),
                    contents:   z.array(z.string()).describe('List of text observations to add.')
                })).describe('List of {entityName, contents} pairs.')
            },
            async ({ observations }) => ({
                content: [{
                    type: 'text',
                    text: JSON.stringify(
                        await this.#knowledgeGraphManager.addObservations(observations),
                        null,
                        2
                    )
                }]
            })
        );

        // Tool: delete_entities
        this.tool(
            'delete_entities',
            'Delete entities (and cascaded observations/relations) by their names.',
            {
                entityNames: z.array(z.string()).describe('Names of entities to delete.')
            },
            async ({ entityNames }) => {
                await this.#knowledgeGraphManager.deleteEntities(entityNames);
                return { content: [{ type: 'text', text: 'Entities deleted' }] };
            }
        );

        // Tool: delete_relations
        this.tool(
            'delete_relations',
            'Remove specified relations between entities without deleting the entities themselves.',
            {
                relations: z.array(z.object({
                    from:         z.string().describe('Source entity name.'),
                    to:           z.string().describe('Target entity name.'),
                    relationType: z.string().describe('Type of the relation to remove.')
                })).describe('Array of relations to delete.')
            },
            async ({ relations }) => {
                await this.#knowledgeGraphManager.deleteRelations(relations);
                return { content: [{ type: 'text', text: 'Relations deleted' }] };
            }
        );

        // Tool: delete_observations
        this.tool(
            'delete_observations',
            'Remove specific observations from entities by matching text.',
            {
                deletions: z.array(z.object({
                    entityName:   z.string().describe('Name of the entity.'),
                    observations: z.array(z.string()).describe('Exact observation texts to delete.')
                })).describe('List of {entityName, observations} deletion requests.')
            },
            async ({ deletions }) => {
                await this.#knowledgeGraphManager.deleteObservations(deletions);
                return { content: [{ type: 'text', text: 'Observations deleted' }] };
            }
        );

        // Tool: read_graph
        this.tool(
            'read_graph',
            'Retrieve the entire knowledge graph: all entities with their observations and relations.',
            {},
            async () => ({
                content: [{
                    type: 'text',
                    text: JSON.stringify(
                        await this.#knowledgeGraphManager.readGraph(),
                        null,
                        2
                    )
                }]
            })
        );

        // Tool: search_nodes
        this.tool(
            'search_nodes',
            'Search for entities and relations by keyword or semantic similarity. Supports hybrid mode.',
            {
                query:     z.string().describe('Search query string.'),
                mode:      z.enum(['keyword', 'semantic', 'hybrid'])
                               .optional()
                               .default('keyword')
                               .describe('Search mode to use.'),
                topK:      z.number().int().min(1).max(100)
                               .optional()
                               .default(8)
                               .describe('Max number of results to return.'),
                threshold: z.number().min(0).max(1)
                               .optional()
                               .default(0.35)
                               .describe('Distance threshold for semantic filtering.')
            },
            async (args) => ({
                content: [{
                    type: 'text',
                    text: JSON.stringify(
                        await this.#knowledgeGraphManager.searchNodes(args),
                        null,
                        2
                    )
                }]
            })
        );

        // Tool: open_nodes
        this.tool(
            'open_nodes',
            'Expand specified entities: return their full details including observations and relations.',
            {
                names: z.array(z.string()).describe('Names of entities to expand.')
            },
            async ({ names }) => ({
                content: [{
                    type: 'text',
                    text: JSON.stringify(
                        await this.#knowledgeGraphManager.openNodes(names),
                        null,
                        2
                    )
                }]
            })
        );

        // Tool: set_importance
        this.tool(
            'set_importance',
            'Set the importance level for an entity (critical, important, normal, temporary, deprecated).',
            {
                entityName: z.string().describe('Name of the entity.'),
                importance: z.enum(['critical', 'important', 'normal', 'temporary', 'deprecated'])
                    .describe('Importance level for the entity.')
            },
            async ({ entityName, importance }) => ({
                content: [{
                    type: 'text',
                    text: JSON.stringify(
                        await this.#knowledgeGraphManager.setImportance(entityName, importance),
                        null,
                        2
                    )
                }]
            })
        );

        // Tool: add_tags
        this.tool(
            'add_tags',
            'Add tags to an entity for better categorization and searchability.',
            {
                entityName: z.string().describe('Name of the entity.'),
                tags: z.union([
                    z.array(z.string()),
                    z.string()
                ]).describe('Tags to add (string or array of strings).')
            },
            async ({ entityName, tags }) => ({
                content: [{
                    type: 'text',
                    text: JSON.stringify(
                        await this.#knowledgeGraphManager.addTags(entityName, tags),
                        null,
                        2
                    )
                }]
            })
        );
    }
}
