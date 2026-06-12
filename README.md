# Memento
***Some memories are best persisted.***

Provides persistent memory capabilities through a SQLite-based knowledge graph that stores entities, observations, and relationships with semantic search using BGE-M3 embeddings for intelligent context retrieval across conversations.
## Features

- Semantic vector search (sqlite-vec/pgvector, 1024d)
- Offline embedding model (`bge-m3`)
- Modular repository layer with SQLite and PostgreSQL backends
- Enhanced Relevance Scoring with temporal, popularity, contextual, and importance factors
- Structured graph of `entities`, `observations`, and `relations`
- Easy integration with Claude Desktop (via MCP)

## Prerequisites

### System SQLite Version Check

Memento requires SQLite 3.38+. Most macOS and Linux distros ship `sqlite3` out of the box, but double-check that it's there and new enough:

```bash
sqlite3 --version       # should print a version string, e.g. 3.46.0
```

**Important Note:** This check is just to verify SQLite is installed on your system. Memento does NOT use the sqlite3 CLI for its operation it uses the Node.js sqlite3 module internally.

If you see "command not found" (or your version is older than 3.38), install SQLite:

| Platform             | Install command                               |
| -------------------- | --------------------------------------------- |
| **macOS (Homebrew)** | `brew install sqlite`                         |
| **Debian / Ubuntu**  | `sudo apt update && sudo apt install sqlite3` |


## Configuration

Memento now supports pluggable storage backends. Configuration is controlled
entirely through environment variables so it remains easy to embed inside MCP
workflows.

| Variable | Description |
| --- | --- |
| `MEMORY_DB_DRIVER` | Optional selector for the database backend. Defaults to `sqlite`. Set to `postgres` to enable the PostgreSQL manager. |
| `MEMORY_DB_PATH` | Filesystem path for the SQLite database file (only used when the driver is `sqlite`). |
| `SQLITE_VEC_PATH` | Optional absolute path to a pre-built `sqlite-vec` extension shared library. |
| `MEMORY_DB_DSN` / `DATABASE_URL` | PostgreSQL connection string consumed by the `pg` client. |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | Individual PostgreSQL connection parameters. Used when no DSN is provided. |
| `PGSSLMODE` | When set to `require`, SSL will be enabled with `rejectUnauthorized: false`. |
| `MEMENTO_WRITE_HOOK_PATH` | Optional path to a JSON Lines file. When set, Memento appends one event after each successful graph mutation. |

### Write hook events

Set `MEMENTO_WRITE_HOOK_PATH` when another process needs to react to memory writes without polling the full graph:

```bash
MEMENTO_WRITE_HOOK_PATH=/tmp/memento-events.jsonl memento
```

Each line is a JSON object with an ISO `timestamp`, an `operation`, and the changed entity/relation payload. Example:

```json
{"timestamp":"2026-05-05T16:33:16.619Z","operation":"create_entity","entity":{"name":"Hook Test","entityType":"test"}}
```

Supported operations are `create_entity`, `add_observations`, `create_relation`, `delete_entities`, `delete_relations`, `delete_observations`, and `set_importance`. Delete events are emitted only for records that were actually removed.

Hook write failures are logged to stderr but do not fail the graph mutation that already succeeded. Consumers that require strict reconciliation should combine the hook with occasional `read_graph` or targeted `open_nodes` checks.

### PostgreSQL notes

- The PostgreSQL manager requires the [`pgvector`](https://github.com/pgvector/pgvector)
  extension. It is automatically initialized with `CREATE EXTENSION IF NOT EXISTS vector`.

Claude Desktop:

```
{
  "mcpServers": {
    "memory": {
      "description": "Custom memory backed by SQLite + vec + FTS5",
      "command": "npx",
      "args": [
        "@iachilles/memento@latest"
      ],
      "env": {
        "MEMORY_DB_PATH": "/Path/To/Your/memory.db"
      },
      "options": {
        "autoStart": true,
        "restartOnCrash": true
      }
    }
  }
}
```

## Troubleshooting

### sqlite-vec Extension Issues

**Important:** Memento loads the sqlite-vec extension programmatically through Node.js, NOT through the sqlite3 CLI.

Common misconceptions:
- ❌ Creating shell aliases for sqlite3 CLI won't affect Memento
- ❌ Loading extensions in sqlite3 CLI won't help Memento
- ✅ Use the npm-installed sqlite-vec or set `SQLITE_VEC_PATH` environment variable if automatic detection fails. This should point to the Node.js-compatible version of the extension, typically found in your `node_modules` directory.

If automatic vec loading fails:
```bash
# Find the Node.js-compatible vec extension
find node_modules -name "vec0.dylib"  # macOS
find node_modules -name "vec0.so"     # Linux

# Use it via environment variable
SQLITE_VEC_PATH="/full/path/to/node_modules/sqlite-vec-darwin-x64/vec0.dylib" memento
```

## API Overview

This server exposes the following MCP tools:
- `create_entities`
- `create_relations`
- `add_observations`
- `delete_entities`
- `delete_relations`
- `delete_observations`
- `read_graph`
- `search_nodes`
- `open_nodes`
- `set_importance` - Set importance level (critical/important/normal/temporary/deprecated)

When `MEMENTO_WRITE_HOOK_PATH` is configured, mutating tools also append JSONL write events for downstream consumers.
#### An example of an instruction set that an LLM should know for effective memory handling (see MEMORY_PROTOCOL.md)

## Embedding Model

This project uses [@xenova/transformers](https://www.npmjs.com/package/@xenova/transformers), with a quantized version of `bge-m3`, running fully offline in Node.js.


## License

MIT
