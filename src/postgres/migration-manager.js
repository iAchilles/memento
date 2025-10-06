/**
 * @file postgres/migration-manager.js
 * @description Migration manager for PostgreSQL.
 */

/**
 * @typedef {Object} PgMigration
 * @property {number} version
 * @property {string} description
 * @property {(client: import('pg').Client, silent: boolean) => Promise<void>} up
 * @property {(client: import('pg').Client, silent: boolean) => Promise<void>} down
 */

export class PostgresMigrationManager {

    /** @type {*} */
    #pool;

    /**
     * @param {*} pool
     */
    constructor(pool) {
        this.#pool = pool;
    }

    async initialize() {
        await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        version     INTEGER PRIMARY KEY,
        description TEXT    NOT NULL,
        applied_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    }

    async getCurrentVersion() {
        const { rows } = await this.#pool.query(`SELECT COALESCE(MAX(version), 0) AS version FROM migrations`);

        return Number(rows[0].version) || 0;
    }

    /**
     * @param {PgMigration[]} migrations
     * @param {number|null} [targetVersion]
     * @param {boolean} [silent=false]
     */
    async migrate(migrations, targetVersion = null, silent = false) {
        const client = await this.#pool.connect();
        try {
            await client.query('BEGIN');

            const currentVersion = await this.getCurrentVersion();
            const target = targetVersion ?? Math.max(0, ...migrations.map(m => m.version));
            const sorted = [...migrations].sort((a, b) => a.version - b.version);

            let applied = 0;
            for (const m of sorted) {
                if (m.version > currentVersion && m.version <= target) {
                    if (!silent) console.error(`Applying migration ${m.version}: ${m.description}`);
                    await m.up(client, silent);
                    await client.query(
                        `INSERT INTO migrations (version, description) VALUES ($1, $2)`,
                        [m.version, m.description]
                    );
                    if (!silent) console.error(`✓ Migration ${m.version} applied`);
                    applied++;
                }
            }

            await client.query('COMMIT');

            if (!silent) {
                if (applied === 0) {
                    console.error('Database is already up to date');
                } else {
                    console.error(`Database migrated from ${currentVersion} to ${await this.getCurrentVersion()}`);
                }
            }
        } catch (e) {
            await client.query('ROLLBACK');
            if (!silent) {
                console.error('Migration failed:', e.message);
            }
            throw e;
        } finally {
            client.release();
        }
    }

    /**
     * @param {PgMigration[]} migrations
     * @param {number} targetVersion
     * @param {boolean} [silent=false]
     */
    async rollback(migrations, targetVersion, silent = false) {
        const currentVersion = await this.getCurrentVersion();
        if (targetVersion >= currentVersion) {
            if (!silent) {
                console.error('Nothing to rollback');
            }

            return;
        }

        const client = await this.#pool.connect();
        try {
            const sorted = [...migrations].sort((a, b) => b.version - a.version);

            for (const m of sorted) {
                if (m.version > targetVersion && m.version <= currentVersion) {
                    if (!silent) console.error(`Rolling back migration ${m.version}: ${m.description}`);
                    await client.query('BEGIN');
                    try {
                        await m.down(client, silent);
                        await client.query(`DELETE FROM migrations WHERE version = $1`, [m.version]);
                        await client.query('COMMIT');
                        if (!silent) console.error(`✓ Migration ${m.version} rolled back`);
                    } catch (e) {
                        await client.query('ROLLBACK');
                        if (!silent) console.error(`✗ Rollback of ${m.version} failed:`, e.message);
                        throw e;
                    }
                }
            }

            if (!silent) console.error(`Database rolled back to version ${targetVersion}`);
        } finally {
            client.release();
        }
    }
}