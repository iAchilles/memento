# Memento

A local, fully-offline MCP memory server using SQLite + FTS5 + `sqlite-vec` with embedding support via [@xenova/transformers](https://www.npmjs.com/package/@xenova/transformers).

## Features

- Fast keyword search (FTS5)
- Semantic vector search (sqlite-vec, 768d)
- Offline embedding model (`bge-small-en-v1.5`)
- Structured graph of `entities`, `observations`, and `relations`
- Easy integration with Claude Desktop (via MCP)

## Installation

```bash
npm install -g @iachilles/memento
```

Make sure the platform-specific `sqlite-vec` subpackage is installed automatically (e.g. `sqlite-vec-darwin-x64`). You can verify or force install via:

```bash
npm i sqlite-vec
```

## Usage

```bash
MEMORY_DB_PATH=/path/to/memory.db node src/memory-sqlite-server.js
```

Claude Desktop:

```
{
  "mcpServers": {
    "memory-sqlite": {
      "description": "Custom memory backed by SQLite + vec + FTS5",
      "command": "npx",
      "args": [
        "-y",
        "mcp-memory-sqlite"
      ],
      "env": {
        "MEMORY_DB_PATH": "/Your/path/to/memory.db"
      },
      "options": {
        "autoStart": true,
        "restartOnCrash": true
      }
    }
  }
}
```


### Optional:

Use `SQLITE_VEC_PATH=/full/path/to/vec0.dylib` if automatic detection fails.

## API Overview

This server exposes the following MCP tools:

- `create_entities`
- `create_relations`
- `add_observations`
- `delete_entities`
- `delete_relations`
- `delete_observations`
- `read_graph`
- `search_nodes` (mode: `keyword`, `semantic`)
- `open_nodes`

## Embedding Model

This project uses [@xenova/transformers](https://www.npmjs.com/package/@xenova/transformers), with a quantized version of `bge-small-en-v1.5`, running fully offline in Node.js.

## License

MIT
