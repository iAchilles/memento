/**
 * @file postgres/migration-manager.js
 * @description Migration manager for PostgreSQL.
 */

export class PostgresMigrationManager {

    /** @type {*} */
    #pool;

    /**
     * Creates a new PostgresMigrationManager.
     * @param {*} pool - PostgreSQL connection pool.
     */
    constructor(pool) {
        this.#pool = pool;
    }

    /**
     * Initializes migration tracking table if it doesn't exist.
     * @async
     * @returns {Promise<void>}
     */
    async initialize() {
        await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        version     INTEGER PRIMARY KEY,
        description TEXT    NOT NULL,
        applied_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    }

    /**
     * Gets the current migration version from the database.
     * @async
     * @returns {Promise<number>}
     *   Current migration version, or 0 if no migrations have been applied.
     */
    async getCurrentVersion() {
        const { rows } = await this.#pool.query(`SELECT COALESCE(MAX(version), 0) AS version FROM migrations`);

        return Number(rows[0].version) || 0;
    }

    /**
     * Applies pending migrations up to a specified version.
     * @async
     * @param {import('../migration-manager').Migration[]} migrations
     *   Array of migration objects to apply.
     * @param {number|null} [targetVersion=null]
     *   Target version to migrate to. If null, migrates to the latest version.
     * @param {boolean} [silent=false]
     *   If true, suppresses console output.
     * @returns {Promise<void>}
     * @throws {Error} If migration fails and rolls back.
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
     * Rolls back migrations to a specified version.
     * @async
     * @param {import('../migration-manager').Migration[]} migrations
     *   Array of migration objects that can be rolled back.
     * @param {number} targetVersion
     *   Target version to roll back to.
     * @param {boolean} [silent=false]
     *   If true, suppresses console output.
     * @returns {Promise<void>}
     * @throws {Error} If rollback fails.
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