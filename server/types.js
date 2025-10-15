/**
 * Shared type declarations for server-side modules.
 * @module server/types
 */

/**
 * @typedef {'active' | 'ready' | 'cooldown' | 'waiting' | 'suspended' | 'no-data'} QueueStatus
 */

/**
 * @typedef {Object} QueueStatusResult
 * @property {QueueStatus} status
 * @property {number | null} cooldownSeconds
 * @property {0 | 1} readyIncrement
 */

/**
 * @typedef {Object} QueueEntry
 * @property {string} id
 * @property {string} name
 * @property {{ current: number, max: number, percentage: number } | null} charges
 * @property {{ total: number, available: number }} droplets
 * @property {QueueStatus} status
 * @property {number | null} cooldownTime
 * @property {number} retryCount
 * @property {number | null} maxRetryCount
 * @property {number | null} lastErrorTime
 */

/**
 * @typedef {Object} ChargePrediction
 * @property {number} count
 * @property {number} max
 * @property {number} [cooldownMs]
 */

/**
 * @typedef {Object} UserRecord
 * @property {string} [name]
 * @property {number} [retryCount]
 * @property {number} [lastErrorTime]
 * @property {number} [suspendedUntil]
 * @property {{ droplets?: number }} [userInfo]
 * @property {{ maxRetryCount?: number }} [settings]
 */

export const types = {};
