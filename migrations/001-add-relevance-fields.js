/**
 * @file 001-add-relevance-fields.js
 * @description
 * Migration to add relevance scoring fields to observations table.
 * Adds temporal tracking, access statistics, and importance markers.
 */

/**
 * @type {import('../src/migration-manager').Migration}
 */
export const migration = {
    version: 1,
    description: "Add relevance scoring fields (temporal, access, importance)",
    
    /**
     * Applies the migration - adds new columns and indexes.
     * @param {import('sqlite').Database} db
     * @param {boolean} [silent=false] - Suppress console output
     * @returns {Promise<void>}
     */
    async up(db, silent = false) {
        // Add temporal tracking columns
        // SQLite doesn't support CURRENT_TIMESTAMP in ALTER TABLE
        await db.exec(`
            ALTER TABLE observations 
            ADD COLUMN created_at DATETIME
        `);
        
        await db.exec(`
            ALTER TABLE observations 
            ADD COLUMN last_accessed DATETIME
        `);
        
        // Add access statistics
        await db.exec(`
            ALTER TABLE observations 
            ADD COLUMN access_count INTEGER DEFAULT 0
        `);
        
        // Add importance and tags
        await db.exec(`
            ALTER TABLE observations 
            ADD COLUMN importance VARCHAR(20) DEFAULT 'normal'
        `);
        
        await db.exec(`
            ALTER TABLE observations 
            ADD COLUMN tags TEXT
        `);
        
        // Create indexes for performance
        await db.exec(`
            CREATE INDEX idx_observations_created_at 
            ON observations(created_at)
        `);
        
        await db.exec(`
            CREATE INDEX idx_observations_last_accessed 
            ON observations(last_accessed)
        `);
        
        await db.exec(`
            CREATE INDEX idx_observations_importance 
            ON observations(importance)
        `);
        
        await db.exec(`
            CREATE INDEX idx_observations_entity_access 
            ON observations(entity_id, access_count DESC)
        `);
        
        // Update existing records with default values
        await db.exec(`
            UPDATE observations 
            SET created_at = datetime('now')
            WHERE created_at IS NULL
        `);
        
        await db.exec(`
            UPDATE observations 
            SET importance = 'normal'
            WHERE importance IS NULL
        `);
        
        await db.exec(`
            UPDATE observations 
            SET access_count = 0
            WHERE access_count IS NULL
        `);
        
        if (!silent) {
            console.error("Added relevance scoring fields to observations table");
        }
    },
    
    /**
     * Rolls back the migration - removes added columns and indexes.
     * @param {import('sqlite').Database} db
     * @param {boolean} [silent=false] - Suppress console output
     * @returns {Promise<void>}
     */
    async down(db, silent = false) {
        // SQLite doesn't support DROP COLUMN directly
        // We need to recreate the table without the new columns
        
        await db.exec(`
            -- Create temporary table with original schema
            CREATE TABLE observations_backup (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
                content     TEXT NOT NULL,
                UNIQUE(entity_id, content)
            )
        `);
        
        await db.exec(`
            -- Copy data to backup table
            INSERT INTO observations_backup (id, entity_id, content)
            SELECT id, entity_id, content FROM observations
        `);
        
        await db.exec(`
            -- Drop indexes
            DROP INDEX IF EXISTS idx_observations_created_at;
            DROP INDEX IF EXISTS idx_observations_last_accessed;
            DROP INDEX IF EXISTS idx_observations_importance;
            DROP INDEX IF EXISTS idx_observations_entity_access;
        `);
        
        await db.exec(`
            -- Drop original table
            DROP TABLE observations
        `);
        
        await db.exec(`
            -- Rename backup to original
            ALTER TABLE observations_backup RENAME TO observations
        `);
        
        if (!silent) {
            console.error("Rolled back relevance scoring fields from observations table");
        }
    }
};
