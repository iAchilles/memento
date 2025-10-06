/**
 * @file 002-remove-passive-tags.js
 * @description
 * Recreate observations table without passive tags column.
 * Down: add tags column back as TEXT.
 */

/** @type {import('../../src/migration-manager.js').Migration} */
export const migration = {
    version: 2,
    description: 'Remove passive tags (TEXT) from observations',

    /**
     * @param {import('sqlite').Database} db
     * @param {boolean} [silent=false]
     */
    async up(db, silent = false) {
        await db.exec(`PRAGMA foreign_keys = OFF`);
        await db.exec(`CREATE TABLE observations_new (
              id            INTEGER PRIMARY KEY AUTOINCREMENT,
              entity_id     INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
              content       TEXT NOT NULL,
              created_at    DATETIME,
              last_accessed DATETIME,
              access_count  INTEGER DEFAULT 0,
              importance    VARCHAR(20) DEFAULT 'normal',
              UNIQUE(entity_id, content))
        `);

        await db.exec(`
              INSERT INTO observations_new (id, entity_id, content, created_at, last_accessed, access_count, importance)
              SELECT id, entity_id, content, created_at, last_accessed, access_count, importance
              FROM observations`);

        await db.exec(`
           DROP INDEX IF EXISTS idx_observations_created_at;
           DROP INDEX IF EXISTS idx_observations_last_accessed;
           DROP INDEX IF EXISTS idx_observations_importance;
           DROP INDEX IF EXISTS idx_observations_entity_access;
        `);

        await db.exec(`DROP TABLE observations`);
        await db.exec(`ALTER TABLE observations_new RENAME TO observations`);

        await db.exec(`CREATE INDEX idx_observations_created_at ON observations(created_at)`);
        await db.exec(`CREATE INDEX idx_observations_last_accessed ON observations(last_accessed)`);
        await db.exec(`CREATE INDEX idx_observations_importance ON observations(importance)`);
        await db.exec(`CREATE INDEX idx_observations_entity_access ON observations(entity_id, access_count DESC)`);
        await db.exec(`PRAGMA foreign_keys = ON`)

        if (!silent) {
            console.error('Removed passive tags column from observations')
        }
    },

    /**
     * @param {import('sqlite').Database} db
     * @param {boolean} [silent=false]
     */
    async down(db, silent = false) {
        await db.exec(`ALTER TABLE observations ADD COLUMN tags TEXT`)

        if (!silent) {
            console.error('Restored passive tags column on observations')
        }
    }
}