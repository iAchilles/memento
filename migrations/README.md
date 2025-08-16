# Database Migrations

This directory contains database schema migrations for Memento.

## For Users

When updating Memento to a new version, you may need to update your database schema. The system will automatically apply migrations when you start Memento, but you can also manually run migrations using the provided tool.

### Automatic Migration

Migrations are automatically applied when you start Memento. No action required in most cases.

### Manual Migration

To manually run migrations using npm scripts:

```bash
# Check current migration status
npm run migrate:status

# Migrate to latest version
npm run migrate

# Rollback to specific version (requires -- before version number)
npm run migrate:rollback -- 0    # Remove all migrations
npm run migrate:rollback -- 1    # Rollback to version 1
```

Or using the CLI directly:

```bash
# Check current migration status
node cli/migrate.js --status

# Migrate to latest version
node cli/migrate.js

# Migrate to specific version
node cli/migrate.js --target 2

# Rollback to specific version
node cli/migrate.js --rollback 0

# Use custom database path
node cli/migrate.js --db-path /path/to/your/memory.db
```

### Rollback

If you encounter issues after migration, you can rollback to a specific version:

```bash
# Using npm script (requires -- before version)
npm run migrate:rollback -- 0    # Remove all migrations
npm run migrate:rollback -- 1    # Rollback to version 1

# Using CLI directly
node cli/migrate.js --rollback 0    # Remove all migrations
node cli/migrate.js --rollback 1    # Rollback to version 1
```

**Note:** 
- Version 0 means no migrations applied (original schema)
- The npm script requires `--` before the version number to pass arguments correctly
- If no version is provided, the command will show an error with usage instructions

## For Developers

### Creating a New Migration

1. Create a new file in `migrations/` with naming pattern `XXX-description.js`
2. Implement the migration following the template:

```javascript
export const migration = {
    version: 2,  // Increment from last version
    description: "Brief description of changes",
    
    async up(db) {
        // Apply migration
    },
    
    async down(db) {
        // Rollback migration
    }
};
```

3. Add the migration to `migrations/index.js`

### Migration Guidelines

- Always provide both `up` and `down` methods
- Ensure migrations are idempotent (safe to run multiple times)
- Test rollback functionality
- Consider performance impact on large databases
- Use transactions where appropriate
- Document any breaking changes

## Current Migrations

| Version | Description | Added Features |
|---------|-------------|----------------|
| 1 | Add relevance scoring fields | `created_at`, `last_accessed`, `access_count`, `importance`, `tags` columns with indexes |

## Troubleshooting

### Migration Failed

If a migration fails:
1. Check the error message for details
2. Rollback to previous version: `node migrate.js --rollback 0`
3. Report the issue with error details

### Database Locked

If you get a "database is locked" error:
1. Ensure no other Memento instances are running
2. Close any SQLite clients accessing the database
3. Try the migration again

### Performance Issues

For large databases, migrations may take time. The tool shows progress for each migration step.
