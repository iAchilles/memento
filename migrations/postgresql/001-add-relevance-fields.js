/**
 * @file 001-add-relevance-fields.js (PostgreSQL)
 * @description
 * Adds relevance fields to observations for PG: temporal tracking, access stats, importance, tags.
 */

/** @type {import('../../src/migration-manager').Migration} */
export const migration = {
    version:     1,
    description: 'Add relevance scoring fields (temporal, access, importance)',

    /**
     * @param {import('pg').PoolClient} client
     * @param {boolean} [silent=true]
     */
    async up(client, silent = true) {
        await client.query(`
            ALTER TABLE observations
                ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
                ADD COLUMN IF NOT EXISTS last_accessed TIMESTAMPTZ,
                ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0,
                ADD COLUMN IF NOT EXISTS importance VARCHAR (20) DEFAULT 'normal',
                ADD COLUMN IF NOT EXISTS tags TEXT
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_observations_created_at
                ON observations (created_at)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_observations_last_accessed
                ON observations (last_accessed)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_observations_importance
                ON observations (importance)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_observations_entity_access
                ON observations (entity_id, access_count DESC)
        `);

        await client.query(`
            UPDATE observations
            SET created_at = NOW()
            WHERE created_at IS NULL
        `);

        await client.query(`
            UPDATE observations
            SET importance = 'normal'
            WHERE importance IS NULL
        `);

        await client.query(`
            UPDATE observations
            SET access_count = 0
            WHERE access_count IS NULL
        `);

        if (!silent) {
            console.error('Added relevance scoring fields to observations table');
        }
    },

    /**
     * @param {import('pg').PoolClient} client
     * @param {boolean} [silent=true]
     */
    async down(client, silent = true) {
        await client.query(`DROP INDEX IF EXISTS idx_observations_entity_access`);
        await client.query(`DROP INDEX IF EXISTS idx_observations_importance`);
        await client.query(`DROP INDEX IF EXISTS idx_observations_last_accessed`);
        await client.query(`DROP INDEX IF EXISTS idx_observations_created_at`);

        await client.query(`
            ALTER TABLE observations
            DROP
            COLUMN IF EXISTS tags,
        DROP
            COLUMN IF EXISTS importance,
        DROP
            COLUMN IF EXISTS access_count,
        DROP
            COLUMN IF EXISTS last_accessed,
        DROP
            COLUMN IF EXISTS created_at
        `);

        if (!silent) {
            console.error('Rolled back relevance scoring fields from observations table');
        }
    }
};