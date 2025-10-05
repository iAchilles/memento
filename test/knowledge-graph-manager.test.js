import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { KnowledgeGraphManager } from '../src/knowledge-graph-manager.js';
import { SqliteGraphRepository } from '../src/sqlite/graph-repo.js';
import { PostgresGraphRepository } from '../src/postgres/graph-repo.js';
import { newDb } from 'pg-mem';

class TestSqliteGraphRepository extends SqliteGraphRepository {
    async insertObservation(entityId, content) {
        const result = await super.insertObservation(entityId, content);
        if (result.observationId !== null && result.observationId !== undefined) {
            await this.db.run(
                'INSERT OR REPLACE INTO obs_fts(rowid, content, entity_id) VALUES(?, ?, ?)',
                [result.observationId, content, entityId]
            );
        }
        return result;
    }
}

class TestPostgresGraphRepository extends PostgresGraphRepository {
    async insertObservation(entityId, content) {
        const result = await super.insertObservation(entityId, content);
        if (result.observationId !== null && result.observationId !== undefined) {
            await this.pool.query(
                `INSERT INTO obs_fts(rowid, content, entity_id)
                 VALUES($1, $2, $3)
                 ON CONFLICT (rowid) DO UPDATE
                 SET content = EXCLUDED.content, entity_id = EXCLUDED.entity_id`,
                [result.observationId, content, entityId]
            );
        }
        return result;
    }
}

async function createSqliteRepository() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS entities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            entityType TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_accessed DATETIME,
            access_count INTEGER DEFAULT 0,
            importance TEXT DEFAULT 'normal',
            tags TEXT,
            UNIQUE(entity_id, content)
        );
        CREATE TABLE IF NOT EXISTS relations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
            to_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
            relationType TEXT NOT NULL,
            UNIQUE(from_id, to_id, relationType)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS obs_fts USING fts5(content, entity_id UNINDEXED);
        CREATE TABLE IF NOT EXISTS obs_vec (
            observation_id INTEGER PRIMARY KEY,
            entity_id INTEGER NOT NULL,
            embedding BLOB
        );
    `);
    return new TestSqliteGraphRepository(db);
}

async function createPostgresRepository() {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();
    await pool.query(`
        CREATE TABLE entities (
            id SERIAL PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            entitytype TEXT NOT NULL
        )
    `);
    await pool.query(`
        CREATE TABLE observations (
            id SERIAL PRIMARY KEY,
            entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            last_accessed TIMESTAMPTZ,
            access_count INTEGER DEFAULT 0,
            importance TEXT DEFAULT 'normal',
            tags TEXT,
            UNIQUE(entity_id, content)
        )
    `);
    await pool.query(`
        CREATE TABLE relations (
            id SERIAL PRIMARY KEY,
            from_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
            to_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
            relationtype TEXT NOT NULL,
            UNIQUE(from_id, to_id, relationtype)
        )
    `);
    await pool.query(`
        CREATE TABLE obs_vec (
            observation_id INTEGER PRIMARY KEY,
            entity_id INTEGER NOT NULL,
            embedding TEXT
        )
    `);
    await pool.query(`
        CREATE TABLE obs_fts (
            rowid INTEGER PRIMARY KEY,
            content TEXT NOT NULL,
            entity_id INTEGER NOT NULL
        )
    `);
    return { repository: new TestPostgresGraphRepository(pool), pool };
}

function createTestEmbedder(matchKeyword) {
    return async (texts) => {
        return texts.map(text => {
            const value = text.toLowerCase().includes(matchKeyword.toLowerCase()) ? 0.05 : 1.5;
            return Buffer.from(new Float32Array([value, value]).buffer);
        });
    };
}

test('SQLite repository supports entity creation and keyword search', async () => {
    const repository = await createSqliteRepository();
    const manager = new KnowledgeGraphManager(repository);
    manager.embedTexts = createTestEmbedder('alpha');

    await manager.createEntities([
        {
            name: 'Alpha Entity',
            entityType: 'concept',
            observations: ['Alpha insight is stored here']
        }
    ]);

    const searchResult = await manager.searchNodes({ query: 'Alpha', mode: 'keyword' });
    assert.equal(searchResult.entities.length, 1);
    assert.equal(searchResult.entities[0].name, 'Alpha Entity');

    await repository.db.close();
});

test('PostgreSQL repository supports semantic search with pgvector fallback', async () => {
    const { repository, pool } = await createPostgresRepository();
    const manager = new KnowledgeGraphManager(repository);
    manager.embedTexts = createTestEmbedder('beta');

    await manager.createEntities([
        {
            name: 'Beta Entity',
            entityType: 'concept',
            observations: ['Beta insight captured here']
        },
        {
            name: 'Gamma Entity',
            entityType: 'concept',
            observations: ['Gamma note unrelated']
        }
    ]);

    const searchResult = await manager.searchNodes({ query: 'Beta signal', mode: 'semantic', topK: 3, threshold: 0.9 });
    const openCheck = await repository.openNodes(['Beta Entity']);
    assert.equal(searchResult.entities.length, 1);
    assert.equal(searchResult.entities[0].name, 'Beta Entity');
    assert.equal(openCheck.entities.length, 1);
    assert.equal(openCheck.entities[0].name, 'Beta Entity');

    await pool.end();
});
