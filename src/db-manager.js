/**
 * @file db-manager.js
 */
import { PostgresDbManager } from './postgres/db-manager.js';
import { SqliteDbManager }   from './sqlite/db-manager.js';

const DEFAULT_DRIVER = 'sqlite';


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
            host:             options.postgres?.host ?? process.env.PGHOST,
            port:             options.postgres?.port ?? process.env.PGPORT,
            user:             options.postgres?.user ?? process.env.PGUSER,
            password:         options.postgres?.password ?? process.env.PGPASSWORD,
            database:         options.postgres?.database ?? process.env.PGDATABASE,
            ssl:              options.postgres?.ssl ?? (process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined)
        };

        return new PostgresDbManager(postgresOptions);
    }

    return new SqliteDbManager(
        options.sqlite?.dbPath ?? process.env.MEMORY_DB_PATH ?? null,
        options.sqlite?.sqliteVecPath ?? process.env.SQLITE_VEC_PATH ?? null
    );
}
