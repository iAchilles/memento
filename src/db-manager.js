/**
 * @file db-manager.js
 * @description
 * Provides database initialization and management for different storage backends.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { getLoadablePath, load as loadSqliteVec } from 'sqlite-vec';
import { MigrationManager } from './migration-manager.js';
import { migrations } from '../migrations/index.js';
import pg from 'pg';

const { Pool } = pg;

const DEFAULT_DB_FILENAME = 'memory.db';
const DEFAULT_DRIVER = 'sqlite';

/**
 * Manages SQLite database connections and schema for the knowledge graph.
 * @class
 */
export class SqliteDbManager {
    /**
     * Absolute path to the SQLite database file.
     * @private
     * @type {?string}
     */
    #dbPath = null;

    /**
     * Optional path to a custom sqlite-vec extension.
     * @private
     * @type {string|null}
     */
    #sqliteVecPath = null;

    /**
     * The opened SQLite database instance.
     * @private
     * @type {import('sqlite').Database|null}
     */
    #db = null;

    /**
     * Creates a new SqliteDbManager.
     * @param {string|null} [dbPath=null]
     *   Path to the SQLite database file. If null, uses the default location.
     * @param {string|null} [sqliteVecPath=null]
     *   Path to the sqlite-vec extension library. If null, loads via package.
     */
    constructor(dbPath = null, sqliteVecPath = null) {
        this.#dbPath = !dbPath
                       ? this.defaultDbPath
                       : this.#normalizeDbPath(dbPath);
        this.#sqliteVecPath = sqliteVecPath;
    }

    /**
     * Opens or returns the existing database connection, enables foreign keys,
     * loads the sqlite-vec extension, and creates required tables.
     * @async
     * @returns {Promise<import('sqlite').Database>}
     *   The initialized SQLite database instance.
     * @throws {Error} If loading the sqlite-vec extension fails.
     */
    async db() {
        if (!this.#db) {
            this.#db = await open({ filename: this.#dbPath, driver: sqlite3.Database });
            await this.#db.exec('PRAGMA foreign_keys=ON;');

            try {
                if (this.#sqliteVecPath) {
                    await this.#db.loadExtension(this.#sqliteVecPath);
                    console.error(`Loaded sqlite-vec extension from ENV: ${this.#sqliteVecPath}`);
                } else {
                    await loadSqliteVec(this.#db);
                    console.error(`Loaded sqlite-vec extension via package (${getLoadablePath()})`);
                }
            } catch (err) {
                console.error('Failed to load sqlite-vec extension:', err.message);
                console.error('Set SQLITE_VEC_PATH=/full/path/to/vec0.so|dylib if needed');
                throw err;
            }

            await this.#createTables();
            await this.#createTriggers();
            await this.#applyMigrations();
        }

        return this.#db;
    }

    /**
     * Returns the default database file path located next to this module.
     * @type {string}
     */
    get defaultDbPath() {
        return path.join(path.dirname(fileURLToPath(import.meta.url)), DEFAULT_DB_FILENAME);
    }

    /**
     * Creates the necessary tables and virtual tables for the knowledge graph.
     * @returns {Promise<void>}
     * @private
     */
    #createTables() {
        return this.#db.exec(`
CREATE TABLE IF NOT EXISTS entities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT UNIQUE NOT NULL,
  entityType  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  UNIQUE(entity_id, content)
);
CREATE TABLE IF NOT EXISTS relations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id       INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id         INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relationType  TEXT NOT NULL,
  UNIQUE(from_id, to_id, relationType)
);
CREATE VIRTUAL TABLE IF NOT EXISTS obs_fts USING fts5(content, entity_id UNINDEXED);
CREATE VIRTUAL TABLE IF NOT EXISTS obs_vec USING vec0(entity_id INT, embedding FLOAT[1024]);
    `);
    }

    /**
     * Creates the necessary triggers.
     * @returns {Promise<void>}
     * @private
     */
    #createTriggers() {
        return this.#db.exec(`
-- Trigger for insert
CREATE TRIGGER IF NOT EXISTS obs_fts_insert AFTER INSERT ON observations
BEGIN
    INSERT INTO obs_fts(rowid, content, entity_id)
    VALUES (new.id, new.content, new.entity_id);
END;

-- Trigger for delete
CREATE TRIGGER IF NOT EXISTS obs_fts_delete AFTER DELETE ON observations
BEGIN
    DELETE FROM obs_fts WHERE rowid = old.id;
END;

-- Trigger for update
CREATE TRIGGER IF NOT EXISTS obs_fts_update AFTER UPDATE ON observations
BEGIN
    UPDATE obs_fts
    SET content = new.content, entity_id = new.entity_id
    WHERE rowid = new.id;
END;
        `);
    }

    /**
     * Apply database migrations.
     * @returns {Promise<void>}
     * @private
     */
    async #applyMigrations() {
        const migrationManager = new MigrationManager(this.#db);
        await migrationManager.initialize();

        return migrationManager.migrate(migrations, null, true);  // silent=true for MCP compatibility
    }

    /**
     * Converts a relative or absolute database path to an absolute path.
     * @private
     * @param {string} dbPath - The input database path.
     * @returns {string} The normalized absolute database path.
     */
    #normalizeDbPath(dbPath) {
        return path.isAbsolute(dbPath)
               ? dbPath
               : path.join(path.dirname(fileURLToPath(import.meta.url)), dbPath);
    }
}

/**
 * Manages PostgreSQL database connections and schema.
 */
export class PostgresDbManager {
    /** @type {pg.Pool|null} */
    #pool = null;

    /** @type {pg.PoolConfig} */
    #config;

    constructor(config = {}) {
        this.#config = this.#sanitizeConfig(config);
    }

    /**
     * Returns an initialized PostgreSQL pool.
     * @returns {Promise<pg.Pool>}
     */
    async db() {
        if (!this.#pool) {
            this.#pool = new Pool(this.#config);
            await this.#initialize();
        }

        return this.#pool;
    }

    async #initialize() {
        const client = await this.#pool.connect();
        try {
            await client.query('BEGIN');
            await this.#ensureVectorExtension(client);
            await this.#createTables(client);
            await this.#createTriggers(client);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async #ensureVectorExtension(client) {
        await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    }

    async #createTables(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS entities (
                id SERIAL PRIMARY KEY,
                name TEXT UNIQUE NOT NULL,
                entitytype TEXT NOT NULL
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS observations (
                id SERIAL PRIMARY KEY,
                entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                UNIQUE(entity_id, content)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS relations (
                id SERIAL PRIMARY KEY,
                from_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
                to_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
                relationtype TEXT NOT NULL,
                UNIQUE(from_id, to_id, relationtype)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS obs_vec (
                observation_id INTEGER PRIMARY KEY,
                entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
                embedding vector(1024)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS obs_fts (
                rowid INTEGER PRIMARY KEY,
                content TEXT NOT NULL,
                entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE
            )
        `);
    }

    async #createTriggers(client) {
        await client.query(`
            CREATE OR REPLACE FUNCTION obs_fts_sync_insert() RETURNS trigger AS $$
            BEGIN
                INSERT INTO obs_fts(rowid, content, entity_id)
                VALUES (NEW.id, NEW.content, NEW.entity_id)
                ON CONFLICT (rowid) DO UPDATE
                SET content = EXCLUDED.content,
                    entity_id = EXCLUDED.entity_id;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);

        await client.query(`
            CREATE OR REPLACE FUNCTION obs_fts_sync_delete() RETURNS trigger AS $$
            BEGIN
                DELETE FROM obs_fts WHERE rowid = OLD.id;
                RETURN OLD;
            END;
            $$ LANGUAGE plpgsql;
        `);

        await client.query(`
            CREATE OR REPLACE FUNCTION obs_fts_sync_update() RETURNS trigger AS $$
            BEGIN
                UPDATE obs_fts
                SET content = NEW.content,
                    entity_id = NEW.entity_id
                WHERE rowid = NEW.id;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);

        await client.query('DROP TRIGGER IF EXISTS obs_fts_insert ON observations');
        await client.query(`
            CREATE TRIGGER obs_fts_insert
            AFTER INSERT ON observations
            FOR EACH ROW EXECUTE FUNCTION obs_fts_sync_insert()
        `);

        await client.query('DROP TRIGGER IF EXISTS obs_fts_delete ON observations');
        await client.query(`
            CREATE TRIGGER obs_fts_delete
            AFTER DELETE ON observations
            FOR EACH ROW EXECUTE FUNCTION obs_fts_sync_delete()
        `);

        await client.query('DROP TRIGGER IF EXISTS obs_fts_update ON observations');
        await client.query(`
            CREATE TRIGGER obs_fts_update
            AFTER UPDATE ON observations
            FOR EACH ROW EXECUTE FUNCTION obs_fts_sync_update()
        `);
    }

    #sanitizeConfig(config) {
        const sanitized = {};

        if (config.connectionString) {
            sanitized.connectionString = config.connectionString;
        }

        for (const [key, value] of Object.entries(config)) {
            if (key === 'connectionString') continue;
            if (value === undefined || value === null || value === '') continue;
            sanitized[key] = key === 'port' ? Number(value) : value;
        }

        return sanitized;
    }
}

/**
 * Factory helper for creating a database manager based on configuration.
 * @param {{
 *   driver?: string,
 *   sqlite?: { dbPath?: string|null, sqliteVecPath?: string|null },
 *   postgres?: {
 *     connectionString?: string,
 *     host?: string,
 *     port?: string|number,
 *     user?: string,
 *     password?: string,
 *     database?: string,
 *     ssl?: import('pg').PoolConfig['ssl']
 *   }
 * }} [options]
 * @returns {SqliteDbManager|PostgresDbManager}
 */
export function createDbManager(options = {}) {
    const driver = (options.driver || process.env.MEMORY_DB_DRIVER || DEFAULT_DRIVER).toLowerCase();

    if (driver === 'postgres' || driver === 'postgresql' || driver === 'pg') {
        const envConnectionString = process.env.MEMORY_DB_DSN || process.env.DATABASE_URL;
        const postgresOptions = {
            connectionString: options.postgres?.connectionString ?? envConnectionString,
            host: options.postgres?.host ?? process.env.PGHOST,
            port: options.postgres?.port ?? process.env.PGPORT,
            user: options.postgres?.user ?? process.env.PGUSER,
            password: options.postgres?.password ?? process.env.PGPASSWORD,
            database: options.postgres?.database ?? process.env.PGDATABASE,
            ssl: options.postgres?.ssl ?? (process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined)
        };

        return new PostgresDbManager(postgresOptions);
    }

    return new SqliteDbManager(
        options.sqlite?.dbPath ?? process.env.MEMORY_DB_PATH ?? null,
        options.sqlite?.sqliteVecPath ?? process.env.SQLITE_VEC_PATH ?? null
    );
}
