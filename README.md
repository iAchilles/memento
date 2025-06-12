# Memento
***Some memories are best persisted.***

Provides persistent memory capabilities through a SQLite-based knowledge graph that stores entities, observations, and relationships with full-text and semantic search using BGE-M3 embeddings for intelligent context retrieval across conversations.
## Features

- Fast keyword search (FTS5)
- Semantic vector search (sqlite-vec, 1024d)
- Offline embedding model (`bge-m3`)
- Structured graph of `entities`, `observations`, and `relations`
- Easy integration with Claude Desktop (via MCP)

## Prerequisite: `sqlite3` CLI

Most macOS and Linux distros ship `sqlite3` out of the box, but double-check that it’s there and new enough (≥ 3.38 for proper FTS5).

```bash
sqlite3 --version       # should print a version string, e.g. 3.46.0
```

If you see “command not found” (or your version is older than 3.38), install the CLI:

| Platform             | Install command                               |
| -------------------- | --------------------------------------------- |
| **macOS (Homebrew)** | `brew install sqlite`                         |
| **Debian / Ubuntu**  | `sudo apt update && sudo apt install sqlite3` |


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
MEMORY_DB_PATH="/Your/Path/To/memory.db" memento

## Starting @iachilles/memento v0.3.3...
## @iachilles/memento v0.3.3 is ready!
```


Claude Desktop:

```
{
  "mcpServers": {
    "memory": {
      "description": "Custom memory backed by SQLite + vec + FTS5",
      "command": "npx",
      "args": [
        "-y",
        "memento"
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

## An example of an instruction set that an LLM should know for effective memory handling.

```markdown
## Memory and Interaction Protocol for LLMs

This assistant uses persistent memory.
All memory, context, reasoning, and decision-making are focused on supporting **technical and creative projects** of the primary user.

### 1. User Identification

* Assume interaction is with a **single primary user** unless explicitly specified otherwise.
* No user switching is expected by default.

### 2. Memory Retrieval

* At the start of each session, retrieve relevant information from memory by saying only:
  `Remembering...`
* "Memory" refers to the assistant’s internal knowledge graph built from prior interactions.

### 3. Memory Focus Areas

During interaction, prioritize capturing and updating memory related to the user’s technical and creative work, including:

#### a) **Project Architecture**

* Project names and goals
* Key modules, services, and interactions
* Technologies, languages, and tools involved

#### b) **Decisions and Rationale**

* Major design choices and justifications
* Rejected approaches and reasons
* Known trade-offs and open questions

#### c) **Code Practices**

* Coding style and patterns preferred by the user
* Naming conventions, file structure, formatting
* Practices for error handling, testing, logging, etc.

#### d) **Workflow Milestones**

* Tasks completed, bugs fixed, optimizations made
* Current phase and next steps
* Integration status with other components

#### e) **Process Preferences**

* Collaboration style (e.g., iterative, detail-oriented)
* Preferred formats and workflows
* Communication tone and instruction parsing approach

#### f) **Personal Context (secondary)**

* In addition to technical details, the assistant may store helpful contextual cues (e.g., time zone, preferred language, productivity patterns) to improve collaboration and anticipation of needs.

### 4. Memory Updates

When new information emerges during interaction:

* **Create entities** for recurring elements (e.g., projects, components, decisions)
* **Link entities** using contextual relationships
* **Store observations** as structured facts for future reasoning

### 5. Memory Initiative

The assistant is encouraged to:

* **Proactively suggest** storing information that appears strategically important
* **Identify patterns** or frequent mentions that indicate significance
* **Capture relevant insights** even if outside predefined categories, if useful for future support or automation

### 6. Context Reinforcement

When the user refers to:

* a previously described concept
* a tool or method in use
* a past decision or event

...the assistant should **automatically retrieve and apply memory** before responding.

### Recommended Entity Naming Structure

To keep memory organized and searchable, use a consistent naming convention for entities:

* `Assistant` – for assistant metadata or behavior
* `User` – stores preferences, context, habits, language use
* `Project_[NAME]` – separate entity per project, e.g., `Project_MY_PROJECT`
* `Session_[DATE]` – working session summaries or notes, e.g., `Session_2025-06-07`
* `Decision_[TOPIC]` – key decisions, e.g., `Decision_PlaylistArchitecture`
* `Feature_[NAME]` – information about specific features, e.g., `Feature_RotationRules`
* `Bug_[ID_OR_NAME]` – problems and resolution context, e.g., `Bug_DuplicateTracks`

#### How to determine the project name

Use the name of the working directory, converted to **capitalized SNAKE\_CASE**.

For example:

* `/Users/example/my_project` → `Project_MY_PROJECT`

This naming convention ensures clarity and consistency across sessions and contexts.

```
This is just an example of instructions, you can define your own rules for the model.

## Embedding Model

This project uses [@xenova/transformers](https://www.npmjs.com/package/@xenova/transformers), with a quantized version of `bge-m3`, running fully offline in Node.js.


## License

MIT
