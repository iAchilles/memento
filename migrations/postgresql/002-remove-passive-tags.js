/**
 * @file 002-remove-passive-tags.js (PostgreSQL)
 * @description
 * Drop passive tags field from observations (legacy TEXT). Down: add it back.
 */

/** @type {import('../../src/migration-manager').Migration} */
export const migration = {
    version: 2,
    description: 'Remove passive tags (TEXT) from observations',

    /**
     * @param {import('pg').PoolClient} client
     * @param {boolean} [silent=true]
     */
    async up(client, silent = true) {
        await client.query(`ALTER TABLE observations DROP COLUMN IF EXISTS tags`);

        if (!silent) {
            console.error('Removed passive tags column from observations')
        }
    },

    /**
     * @param {import('pg').PoolClient} client
     * @param {boolean} [silent=true]
     */
    async down(client, silent = true) {
        await client.query(`ALTER TABLE observations ADD COLUMN IF NOT EXISTS tags TEXT`)

        if (!silent) {
            console.error('Restored passive tags column on observations')
        }
    }
}