
/**
 * @typedef {Object} Migration
 * @property {number} version - Migration version number
 * @property {string} description - Human-readable description
 * @property {function(import('sqlite').Database, silent: boolean): Promise<void>} up - Upgrade function
 * @property {function(import('sqlite').Database, silent: boolean): Promise<void>} down - Rollback function
 */

export {}