/**
 * @file write-hook.js
 * @description
 * Optional durable write event sink for consumers that need to react to
 * knowledge graph mutations without polling the full graph.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Appends knowledge graph mutation events to a JSON Lines file.
 */
export class WriteHook {
    /**
     * @param {{ path?: string|null }} [options]
     */
    constructor(options = {}) {
        this.path = options.path || process.env.MEMENTO_WRITE_HOOK_PATH || null;
    }

    /**
     * @returns {boolean} True when event output is configured.
     */
    get enabled() {
        return Boolean(this.path);
    }

    /**
     * Emits an event after a successful mutation.
     *
     * Hook failures are logged but do not fail the already-committed graph write.
     * Consumers that require reconciliation should combine this with periodic reads.
     *
     * @param {object} event
     * @returns {Promise<void>}
     */
    async notify(event) {
        if (!this.path) {
            return;
        }

        try {
            await mkdir(path.dirname(this.path), { recursive: true });
            await appendFile(
                this.path,
                `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
                'utf8'
            );
        } catch (error) {
            console.error('Memento write hook failed:', error?.message ?? error);
        }
    }
}
