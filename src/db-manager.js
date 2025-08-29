/**
 * @file db-manager.js
 * @description
 * Provides database initialization and management for SQLite with FTS5 and sqlite-vec support.
 * Handles opening the database, enabling foreign keys, loading the sqlite-vec extension,
 * and creating necessary tables for entities, observations, and relations.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { getLoadablePath, load as loadSqliteVec } from 'sqlite-vec';
import { MigrationManager } from './migration-manager.js';
import { migrations } from '../migrations/index.js';

const DEFAULT_DB_FILENAME = 'memory.db';

/**
 * Manages SQLite database connections and schema for the knowledge graph.
 * @class
 */
export class DbManager {
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
     * Creates a new DbManager.
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
