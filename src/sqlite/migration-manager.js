/**
 * @file sqlite/migration-manager.js
 * @description
 * Manages database schema migrations for Memento.
 * Ensures safe upgrades for existing users' databases.
 */

export class SQLiteMigrationManager {
    /**
     * @type {import('sqlite').Database}
     */
    #db = null;

    /**
     * Creates an instance of MigrationManager.
     * @param {import('sqlite').Database} db - An opened SQLite database connection.
     */
    constructor(db) {
        this.#db = db;
    }

    /**
     * Initializes migration tracking table if it doesn't exist.
     * @returns {Promise<void>}
     */
    async initialize() {
        await this.#db.exec(`
            CREATE TABLE IF NOT EXISTS migrations (
                version INTEGER PRIMARY KEY,
                description TEXT NOT NULL,
                applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
    }

    /**
     * Gets the current migration version.
     * @returns {Promise<number>} Current version or 0 if no migrations applied
     */
    async getCurrentVersion() {
        const result = await this.#db.get(
            "SELECT MAX(version) as version FROM migrations"
        );

        return result?.version || 0;
    }

    /**
     * Applies migrations up to the specified version.
     * @param {Migration[]} migrations - Array of migrations to apply
     * @param {number|null} [targetVersion] - Target version (defaults to latest)
     * @param {boolean} [silent=false] - Suppress console output (for MCP compatibility)
     * @returns {Promise<void>}
     */
    async migrate(migrations, targetVersion = null, silent = false) {
        await this.#db.exec("PRAGMA busy_timeout=5000;");
        await this.#db.exec("BEGIN IMMEDIATE TRANSACTION");

        try {
            const currentVersion = await this.getCurrentVersion();
            const target = targetVersion || Math.max(...migrations.map(m => m.version));
            const sorted = [...migrations].sort((a, b) => a.version - b.version);

            let applied = 0;

            for (const migration of sorted) {
                if (migration.version > currentVersion && migration.version <= target) {
                    if (!silent) console.error(`Applying migration ${migration.version}: ${migration.description}`);

                    await migration.up(this.#db, silent);
                    await this.#db.run(
                        "INSERT INTO migrations (version, description) VALUES (?, ?)",
                        [migration.version, migration.description]
                    );

                    if (!silent) console.error(`✓ Migration ${migration.version} applied successfully`);
                    applied++;
                }
            }

            await this.#db.exec("COMMIT");

            if (!silent) {
                if (applied === 0) {
                    console.error("Database is already up to date");
                } else {
                    const newVersion = await this.getCurrentVersion();
                    console.error(`Database migrated from version ${currentVersion} to ${newVersion}`);
                }
            }
        } catch (error) {
            await this.#db.exec("ROLLBACK");
            if (!silent) console.error("Migration failed:", error.message);
            throw error;
        }
    }

    /**
     * Rolls back to a specific version.
     * @param {Migration[]} migrations - Array of migrations
     * @param {number} targetVersion - Target version to rollback
     * @param {boolean} [silent=false] - Suppress console output (for MCP compatibility)
     * @returns {Promise<void>}
     */
    async rollback(migrations, targetVersion, silent = false) {
        const currentVersion = await this.getCurrentVersion();

        if (targetVersion >= currentVersion) {
            if (!silent) {
                console.error("Nothing to rollback");
            }

            return;
        }

        const sortedMigrations = migrations.sort((a, b) => b.version - a.version);

        for (const migration of sortedMigrations) {
            if (migration.version > targetVersion && migration.version <= currentVersion) {
                if (!silent) {
                    console.error(`Rolling back migration ${migration.version}: ${migration.description}`);
                }

                await this.#db.exec("BEGIN TRANSACTION");
                try {
                    await migration.down(this.#db, silent);
                    await this.#db.run(
                        "DELETE FROM migrations WHERE version = ?",
                        [migration.version]
                    );

                    await this.#db.exec("COMMIT");
                    if (!silent) {
                        console.error(`✓ Migration ${migration.version} rolled back successfully`);
                    }
                } catch (error) {
                    await this.#db.exec("ROLLBACK");
                    if (!silent) {
                        console.error(`✗ Rollback of migration ${migration.version} failed:`, error.message);
                    }

                    throw error;
                }
            }
        }

        if (!silent) {
            console.error(`Database rolled back to version ${targetVersion}`);
        }
    }
}
