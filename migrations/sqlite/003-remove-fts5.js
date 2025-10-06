/**
 * @file 003-remove-fts5.js
 * @description
 * Drop FTS5 table `obs_fts` and all associated triggers (insert/update/delete).
 */

/** @type {import('../../src/migration-manager.js').Migration} */
export const migration = {
    version: 3,
    description: 'Remove FTS5 table obs_fts and related triggers',

    /**
     * @param {import('sqlite').Database} db
     * @param {boolean} [silent=false]
     */
    async up(db, silent = false) {
        await db.exec(`PRAGMA foreign_keys = OFF`);
        await db.exec(`
            DROP TRIGGER IF EXISTS obs_fts_insert;
            DROP TRIGGER IF EXISTS obs_fts_delete;
            DROP TRIGGER IF EXISTS obs_fts_update;
        `);
        await db.exec(`
            DROP TABLE IF EXISTS obs_fts;
        `);
        await db.exec(`PRAGMA foreign_keys = ON`);

        if (!silent) {
            console.error('Removed FTS5 table obs_fts and related triggers');
        }
    },

    /**
     * @param {import('sqlite').Database} db
     * @param {boolean} [silent=false]
     */
    async down(db, silent = false) {
        await db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS obs_fts
            USING fts5(content, entity_id UNINDEXED, content='observations', content_rowid='id');
        `);
        await db.exec(`
            CREATE TRIGGER IF NOT EXISTS obs_fts_insert AFTER INSERT ON observations
            BEGIN
                INSERT INTO obs_fts(rowid, content, entity_id)
                VALUES (new.id, new.content, new.entity_id);
            END;
        `);
        await db.exec(`
            CREATE TRIGGER IF NOT EXISTS obs_fts_delete AFTER DELETE ON observations
            BEGIN
                DELETE FROM obs_fts WHERE rowid = old.id;
            END;
        `);
        await db.exec(`
            CREATE TRIGGER IF NOT EXISTS obs_fts_update AFTER UPDATE ON observations
            BEGIN
                UPDATE obs_fts
                SET content = new.content, entity_id = new.entity_id
                WHERE rowid = new.id;
            END;
        `);

        if (!silent) {
            console.error('Restored FTS5 table obs_fts and related triggers');
        }
    }
};