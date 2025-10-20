/**
 * @fileoverview Turnstile token coordinator for the wplacer backend.
 * The manager encapsulates queueing, expiry handling and signalling so
 * downstream paint jobs can await a valid token without duplicating logic.
 */

const DEFAULT_TOKEN_LIFETIME_MS = 4 * 60 * 1000; // 4 minutes for safety margin
const DEFAULT_MAX_QUEUE_SIZE = 5;

/**
 * Formats a millisecond duration into a concise human readable string.
 *
 * @param {number} ms Duration in milliseconds.
 * @returns {string} Human readable string such as "1m 30s".
 */
const formatDuration = (ms) => {
    if (!Number.isFinite(ms) || ms <= 0) return '0s';
    const totalSeconds = Math.floor(ms / 1000);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    const parts = [];
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(' ');
};

/**
 * Lightweight instrumentation store for token related events.
 */
class TokenMetrics {
    constructor() {
        this.received = 0;
        this.deduplicated = 0;
        this.expired = 0;
        this.dropped = 0;
        this.served = 0;
        this.consumed = 0;
        this.invalidated = 0;
    }

    snapshot() {
        return {
            received: this.received,
            deduplicated: this.deduplicated,
            expired: this.expired,
            dropped: this.dropped,
            served: this.served,
            consumed: this.consumed,
            invalidated: this.invalidated,
        };
    }
}

/**
 * Token manager that keeps a cache of Turnstile tokens and signals when a
 * fresh token is required. The implementation intentionally mirrors the legacy
 * interface (getToken/setToken/consumeToken/invalidateToken) while enhancing
 * expiry checks, deduplication and observability.
 */
export default class TurnstileTokenManager {
    /**
     * @param {Object} [options]
     * @param {(msg: string) => void} [options.log] Callback used for textual logs.
     * @param {() => void} [options.notifyTokenNeeded] Callback fired when the
     * token pool becomes empty and workers should refresh a token.
     * @param {number} [options.tokenLifetimeMs] Milliseconds a token stays valid.
     * @param {number} [options.maxQueueSize] Maximum tokens kept in memory.
     */
    constructor({
        log = () => {},
        notifyTokenNeeded = () => {},
        tokenLifetimeMs = DEFAULT_TOKEN_LIFETIME_MS,
        maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
    } = {}) {
        this.log = log;
        this.notifyTokenNeeded = notifyTokenNeeded;
        this.tokenLifetimeMs = tokenLifetimeMs;
        this.maxQueueSize = Math.max(1, Number(maxQueueSize) || DEFAULT_MAX_QUEUE_SIZE);

        this.tokenQueue = [];
        this.waiters = [];
        this.inFlight = new Map();
        this.isTokenNeeded = false;
        this._lastNeededAt = 0;
        this.metrics = new TokenMetrics();
    }

    /**
     * Emits a log entry if a logging callback was provided.
     * @param {string} message
     */
    _log(message) {
        try {
            this.log(message);
        } catch (_) {}
    }

    /**
     * Creates a consumer-facing lease object that omits the raw token value
     * when possible but still returns a shallow copy of metadata.
     *
     * @param {{token:string,meta:Object,receivedAt:number,expiresAt:number}} entry
     * @returns {{token:string,meta:Object,receivedAt:number,expiresAt:number}}
     */
    _buildLease(entry) {
        return {
            token: entry.token,
            meta: entry.meta ? { ...entry.meta } : {},
            receivedAt: entry.receivedAt,
            expiresAt:
                entry.expiresAt ?? entry.receivedAt + this.tokenLifetimeMs,
        };
    }

    /**
     * Signals that a new token is required and notifies listeners once when
     * transitioning into the needed state.
     */
    _markTokenNeeded() {
        if (this.isTokenNeeded) return;
        this.isTokenNeeded = true;
        this._lastNeededAt = Date.now();
        try {
            this.notifyTokenNeeded();
        } catch (_) {}
    }

    /**
     * Clears the token-needed flag.
     */
    _clearTokenNeeded() {
        if (!this.isTokenNeeded) return;
        this.isTokenNeeded = false;
    }

    /**
     * Removes expired tokens from the queue.
     */
    _purgeExpiredTokens() {
        const now = Date.now();
        let expired = 0;

        if (this.tokenQueue.length) {
            const filtered = [];
            for (const entry of this.tokenQueue) {
                const expiresAt = entry.expiresAt ?? entry.receivedAt + this.tokenLifetimeMs;
                if (now < expiresAt) {
                    filtered.push(entry);
                } else {
                    expired++;
                }
            }
            if (filtered.length !== this.tokenQueue.length) {
                this.tokenQueue = filtered;
            }
        }

        if (this.inFlight.size) {
            for (const [token, entry] of Array.from(this.inFlight.entries())) {
                const expiresAt = entry.expiresAt ?? entry.receivedAt + this.tokenLifetimeMs;
                if (now >= expiresAt) {
                    this.inFlight.delete(token);
                    expired++;
                }
            }
        }

        if (expired) {
            this.metrics.expired += expired;
            this._log(
                `🛡️ TOKEN_MANAGER: Purged ${expired} expired token${expired === 1 ? '' : 's'} (queue+in-flight).`
            );
        }

        if (!this.tokenQueue.length) {
            this._markTokenNeeded();
        } else {
            this._clearTokenNeeded();
        }
    }

    /**
     * Enforces the configured queue size limit.
     */
    _trimQueue() {
        while (this.tokenQueue.length > this.maxQueueSize) {
            const removed = this.tokenQueue.shift();
            this.metrics.dropped++;
            const age = removed && removed.receivedAt ? formatDuration(Date.now() - removed.receivedAt) : 'unknown';
            this._log(
                `🛡️ TOKEN_MANAGER: Dropped oldest token to maintain queue size ${this.maxQueueSize} (age: ${age}).`
            );
        }
    }

    /**
     * Resolves pending waiters when new tokens become available.
     */
    _dispatchWaiters() {
        if (!this.waiters.length || !this.tokenQueue.length) {
            if (!this.tokenQueue.length) {
                this._markTokenNeeded();
            } else {
                this._clearTokenNeeded();
            }
            return;
        }

        while (this.waiters.length && this.tokenQueue.length) {
            const waiter = this.waiters.shift();
            const entry = this.tokenQueue.shift();
            this.inFlight.set(entry.token, entry);
            this.metrics.served++;
            try {
                waiter.resolve(this._buildLease(entry));
            } catch (error) {
                try {
                    waiter.reject?.(error);
                } catch (_) {}
            }
        }

        if (this.tokenQueue.length) {
            this._clearTokenNeeded();
        } else {
            this._markTokenNeeded();
        }
    }

    /**
     * Returns the next token lease if available, or waits for the next token
     * to arrive. Mirrors the legacy behaviour where only a single waiter is
     * tracked at once but now returns metadata alongside the token value.
     *
     * @returns {Promise<{token:string,meta:Object,receivedAt:number,expiresAt:number}>}
     */
    getToken() {
        this._purgeExpiredTokens();
        if (this.tokenQueue.length > 0) {
            const entry = this.tokenQueue.shift();
            this.inFlight.set(entry.token, entry);
            this.metrics.served++;
            if (!this.tokenQueue.length) {
                this._markTokenNeeded();
            }
            return Promise.resolve(this._buildLease(entry));
        }

        this._log('🛡️ TOKEN_MANAGER: Waiting for a fresh token...');
        this._markTokenNeeded();
        return new Promise((resolve, reject) => {
            this.waiters.push({ resolve, reject });
        });
    }

    /**
     * Adds or refreshes a token within the queue and resolves any pending
     * waiter.
     *
     * @param {string} token Turnstile token value.
     * @param {Object} [meta] Additional metadata preserved with the token.
     */
    setToken(token, meta = {}) {
        if (token == null) return;
        const normalized = typeof token === 'string' ? token.trim() : String(token);
        if (!normalized) return;

        this._purgeExpiredTokens();

        const now = Date.now();
        const expiresAtCandidate = (() => {
            const explicit = Number(meta?.expiresAt);
            if (Number.isFinite(explicit) && explicit > now) return explicit;
            const ttlOverride = Number(meta?.ttlMs ?? meta?.ttl);
            if (Number.isFinite(ttlOverride) && ttlOverride > 0) {
                return now + ttlOverride;
            }
            return now + this.tokenLifetimeMs;
        })();
        const entry = {
            token: normalized,
            receivedAt: now,
            expiresAt: expiresAtCandidate,
            meta: meta && typeof meta === 'object' ? { ...meta } : {},
        };

        const existingIndex = this.tokenQueue.findIndex((item) => item.token === normalized);
        if (existingIndex !== -1) {
            this.tokenQueue[existingIndex] = entry;
            this.metrics.deduplicated++;
            this._log(
                `🛡️ TOKEN_MANAGER: Refreshed queued token. Queue size: ${this.tokenQueue.length}.`
            );
        } else if (this.inFlight.has(normalized)) {
            this.inFlight.set(normalized, entry);
            this.metrics.deduplicated++;
            this._log('🛡️ TOKEN_MANAGER: Updated metadata for in-flight token.');
        } else {
            this.tokenQueue.push(entry);
            this.metrics.received++;
            this._trimQueue();
            this._log(`🛡️ TOKEN_MANAGER: Token received. Queue size: ${this.tokenQueue.length}.`);
        }

        this._clearTokenNeeded();
        this._dispatchWaiters();
    }

    /**
     * Removes the current head token after a successful paint turn.
     */
    consumeToken(token) {
        this._purgeExpiredTokens();

        if (!token && this.inFlight.size) {
            const [firstToken] = this.inFlight.keys();
            token = firstToken;
        }

        if (token && this.inFlight.has(token)) {
            this.inFlight.delete(token);
            this.metrics.consumed++;
            this._log(
                `🛡️ TOKEN_MANAGER: Consumed token. ${this.tokenQueue.length} queued, ${this.inFlight.size} in-flight.`
            );
        } else if (this.tokenQueue.length > 0) {
            const removed = this.tokenQueue.shift();
            if (removed) {
                this.metrics.consumed++;
            }
            this._log(
                `🛡️ TOKEN_MANAGER: Consumed token from queue fallback. ${this.tokenQueue.length} remaining.`
            );
        } else {
            this._log('🛡️ TOKEN_MANAGER: consumeToken called but no token was tracked.');
        }

        if (!this.tokenQueue.length) {
            this._markTokenNeeded();
        } else {
            this._clearTokenNeeded();
        }
    }

    /**
     * Discards the current head token, typically when Cloudflare rejects it.
     */
    invalidateToken(token) {
        this._purgeExpiredTokens();

        if (!token && this.inFlight.size) {
            const [firstToken] = this.inFlight.keys();
            token = firstToken;
        }

        if (token && this.inFlight.delete(token)) {
            this.metrics.invalidated++;
            this._log(
                `🛡️ TOKEN_MANAGER: Invalidated in-flight token. ${this.tokenQueue.length} queued.`
            );
        } else if (token) {
            const idx = this.tokenQueue.findIndex((item) => item.token === token);
            if (idx !== -1) {
                this.tokenQueue.splice(idx, 1);
                this.metrics.invalidated++;
                this._log(
                    `🛡️ TOKEN_MANAGER: Invalidated queued token. ${this.tokenQueue.length} remaining.`
                );
            } else {
                this._log('🛡️ TOKEN_MANAGER: invalidateToken called but token not found.');
            }
        } else if (this.tokenQueue.length > 0) {
            this.tokenQueue.shift();
            this.metrics.invalidated++;
            this._log(
                `🛡️ TOKEN_MANAGER: Invalidated head token. ${this.tokenQueue.length} remaining.`
            );
        } else {
            this._log('🛡️ TOKEN_MANAGER: invalidateToken called but queue is empty.');
        }

        if (!this.tokenQueue.length) {
            this._markTokenNeeded();
        } else {
            this._clearTokenNeeded();
        }
    }

    /**
     * Diagnostic snapshot describing the queue and instrumentation counters.
     *
     * @returns {{queueSize: number, oldestTokenAgeMs: number|null, isTokenNeeded: boolean, lastNeededAt: number, metrics: Object, inFlight: number, waiters: number, nextExpiresAt: number|null}}
     */
    getStatus() {
        this._purgeExpiredTokens();
        const head = this.tokenQueue[0];
        return {
            queueSize: this.tokenQueue.length,
            oldestTokenAgeMs: head ? Date.now() - head.receivedAt : null,
            nextExpiresAt: head ? head.expiresAt ?? head.receivedAt + this.tokenLifetimeMs : null,
            isTokenNeeded: this.isTokenNeeded,
            lastNeededAt: this._lastNeededAt,
            inFlight: this.inFlight.size,
            waiters: this.waiters.length,
            metrics: this.metrics.snapshot(),
        };
    }

    /**
     * Returns whether at least one cached token is ready for immediate use.
     *
     * @returns {boolean}
     */
    isTokenValid() {
        this._purgeExpiredTokens();
        return this.tokenQueue.length > 0;
    }

    /**
     * Convenience alias that mirrors the userscript API.
     *
     * @param {string} token
     * @param {Object} [meta]
     */
    setTurnstileToken(token, meta) {
        this.setToken(token, meta);
    }

    /**
     * Ensures a token is available, optionally dropping existing cache.
     *
     * @param {{forceRefresh?: boolean}} [options]
     * @returns {Promise<{token:string,meta:Object,receivedAt:number,expiresAt:number}>}
     */
    ensureToken(options = {}) {
        if (options && options.forceRefresh) {
            this.flush('forceRefresh');
        }
        return this.getToken();
    }

    /**
     * Removes all queued and in-flight tokens.
     *
     * @param {string} [reason]
     */
    flush(reason = 'manual flush') {
        const queued = this.tokenQueue.length;
        const inflight = this.inFlight.size;
        if (queued) {
            this.metrics.dropped += queued;
        }
        if (inflight) {
            this.metrics.invalidated += inflight;
        }
        this.tokenQueue = [];
        this.inFlight.clear();
        if (this.waiters.length) {
            for (const waiter of this.waiters.splice(0)) {
                try {
                    waiter.reject?.(new Error('Token cache flushed'));
                } catch (_) {}
            }
        }
        this._markTokenNeeded();
        this._log(
            `🛡️ TOKEN_MANAGER: Flushed tokens (${queued} queued, ${inflight} in-flight) due to ${reason}.`
        );
    }

    /**
     * Returns a shallow copy of the first queued token without leasing it.
     *
     * @returns {{token:string,meta:Object,receivedAt:number,expiresAt:number}|null}
     */
    peek() {
        this._purgeExpiredTokens();
        const head = this.tokenQueue[0];
        return head ? this._buildLease(head) : null;
    }
}
