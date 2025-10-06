/**
 * @file migrations/sqlite/index.js
 * @description
 * Central registry of all database migrations.
 * Import and export all migrations in version order.
 */
import { migration as migration001 } from './001-add-relevance-fields.js';
import { migration as migration002 } from './002-remove-passive-tags.js';
import { migration as migration003 } from './003-remove-fts5.js';

/**
 * All available migrations in version order.
 * @type {import('../../src/migration-manager.js').Migration[]}
 */
export const migrations = [
    migration001,
    migration002,
    migration003
];

/**
 * Gets migrations within a version range.
 * @param {number} [fromVersion=0] - Starting version (exclusive)
 * @param {number} [toVersion=Infinity] - Ending version (inclusive)
 * @returns {import('../../src/migration-manager.js').Migration[]}
 */
export function getMigrations(fromVersion = 0, toVersion = Infinity) {
    return migrations.filter(m => m.version > fromVersion && m.version <= toVersion);
}

/**
 * Gets the latest migration version.
 * @returns {number}
 */
export function getLatestVersion() {
    return Math.max(...migrations.map(m => m.version));
}
