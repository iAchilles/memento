#!/usr/bin/env node

import { createRequire } from 'module';
import { DbManager } from './src/db-manager.js';
import { KnowledgeGraphManager } from './src/knowledge-graph-manager.js';
import { Server } from './src/server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const require = createRequire(import.meta.url);
const { name, version, engines } = require('./package.json');

const SERVER_NAME = name || 'memento';
const SERVER_VERSION = version;

if (engines?.node) {
    const nodeVersion = process.version;
    const requiredVersion = engines.node.replace('>=', '');
    if (nodeVersion < `v${requiredVersion}`) {
        console.error(`⚠️  Warning: Node.js ${requiredVersion}+ required, current: ${nodeVersion}`);
    }
}

const dbManager = new DbManager(
    process.env.MEMORY_DB_PATH,
    process.env.SQLITE_VEC_PATH
);
const db = await dbManager.db();
const knowledgeGraphManager = new KnowledgeGraphManager(db);
const transport = new StdioServerTransport();

console.error(`Starting ${SERVER_NAME} v${SERVER_VERSION}...`);

const server = new Server({
    name: SERVER_NAME,
    version: SERVER_VERSION
}, knowledgeGraphManager);

await server.connect(transport);
console.error(`${SERVER_NAME} v${SERVER_VERSION} is ready!`);