#!/usr/bin/env node

/**
 * @file migrate.js
 * @description
 * CLI tool to manually run database migrations for Memento.
 * Usage: node migrate.js [options]
 * 
 * Options:
 *   --db-path <path>     Path to the database file (default: memory.db)
 *   --target <version>   Target migration version (default: latest)
 *   --rollback <version> Rollback to specific version
 *   --status             Show current migration status
 *   --help               Show help
 */

import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { MigrationManager } from '../src/migration-manager.js';
import { migrations, getLatestVersion } from '../migrations/index.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Parses command line arguments.
 * @returns {Object} Parsed arguments
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        dbPath: path.join(__dirname, '..', 'memory.db'),
        target: null,
        rollback: null,
        status: false,
        help: false
    };
    
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--db-path':
                options.dbPath = path.isAbsolute(args[i + 1]) 
                    ? args[i + 1] 
                    : path.join(process.cwd(), args[i + 1]);
                i++;
                break;
            case '--target':
                if (!args[i + 1]) {
                    console.error('Error: Target requires a version number');
                    console.error('Usage: --target <version>');
                    console.error('Example: --target 2');
                    process.exit(1);
                }
                const targetVersion = parseInt(args[i + 1]);
                if (isNaN(targetVersion)) {
                    console.error(`Error: Invalid target version '${args[i + 1]}'`);
                    console.error('Version must be a number (e.g., --target 2)');
                    process.exit(1);
                }
                options.target = targetVersion;
                i++;
                break;
            case '--rollback':
                if (!args[i + 1]) {
                    console.error('Error: Rollback requires a version number');
                    console.error('Usage: --rollback <version>');
                    console.error('Example: --rollback 0 (removes all migrations)');
                    process.exit(1);
                }
                const version = parseInt(args[i + 1]);
                if (isNaN(version)) {
                    console.error(`Error: Invalid rollback version '${args[i + 1]}'`);
                    console.error('Version must be a number (e.g., --rollback 0)');
                    process.exit(1);
                }
                options.rollback = version;
                i++;
                break;
            case '--status':
                options.status = true;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
        }
    }
    
    return options;
}

/**
 * Shows help message.
 */
function showHelp() {
    console.error(`
Memento Database Migration Tool

Usage: node cli/migrate.js [options]

Options:
  --db-path <path>     Path to the database file (default: memory.db)
  --target <version>   Migrate to specific version (default: latest)
  --rollback <version> Rollback to specific version (e.g., 0 for no migrations)
  --status             Show current migration status
  --help, -h           Show this help message

Examples:
  node cli/migrate.js                           # Migrate to latest version
  node cli/migrate.js --status                  # Show current version
  node cli/migrate.js --target 3                # Migrate to version 3
  node cli/migrate.js --rollback 0              # Remove all migrations
  node cli/migrate.js --rollback 1              # Rollback to version 1
  node cli/migrate.js --db-path /path/to/db.db  # Use custom database path
`);
}

/**
 * Main migration runner.
 */
async function main() {
    const options = parseArgs();
    
    if (options.help) {
        showHelp();
        process.exit(0);
    }
    
    const db = await open({
        filename: options.dbPath,
        driver: sqlite3.Database
    });
    
    await db.exec('PRAGMA foreign_keys=ON;');
    
    const migrationManager = new MigrationManager(db);
    await migrationManager.initialize();
    
    try {
        if (options.status) {
            const currentVersion = await migrationManager.getCurrentVersion();
            const latestVersion = getLatestVersion();
            
            console.error(`Database: ${options.dbPath}`);
            console.error(`Current version: ${currentVersion}`);
            console.error(`Latest version: ${latestVersion}`);
            
            if (currentVersion < latestVersion) {
                console.error(`\n${latestVersion - currentVersion} migration(s) pending`);
                const pending = migrations.filter(m => m.version > currentVersion);
                pending.forEach(m => {
                    console.error(`  - Version ${m.version}: ${m.description}`);
                });
            } else {
                console.error('\nDatabase is up to date');
            }
        } else if (options.rollback !== null) {
            if (options.rollback < 0) {
                console.error('Error: Rollback version cannot be negative');
                process.exit(1);
            }
            console.error(`Rolling back to version ${options.rollback}...`);
            await migrationManager.rollback(migrations, options.rollback);
        } else {
            const target = options.target || getLatestVersion();
            console.error(`Migrating to version ${target}...`);
            await migrationManager.migrate(migrations, target);
        }
    } catch (error) {
        console.error('Migration failed:', error.message);
        process.exit(1);
    } finally {
        await db.close();
    }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}
