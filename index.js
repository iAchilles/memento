#!/usr/bin/env node

import { DbManager } from './src/db-manager.js';
import { KnowledgeGraphManager } from './src/knowledge-graph-manager.js';
import { Server } from './src/server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const SERVER_NAME = 'memento';
const SERVER_VERSION = '0.0.1';

const dbManager = new DbManager(
    process.env.MEMORY_DB_PATH,
    process.env.SQLITE_VEC_PATH
);
const db = await dbManager.db();
const knowledgeGraphManager = new KnowledgeGraphManager(db);
const transport = new StdioServerTransport();
const server = new Server({
    name: SERVER_NAME,
    version: SERVER_VERSION
}, knowledgeGraphManager);

await server.connect(transport);
console.info(`memento MCP server running`);

