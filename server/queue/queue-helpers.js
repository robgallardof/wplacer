/**
 * @typedef {import('../types').QueueEntry} QueueEntry
 * @typedef {import('../types').QueueStatusResult} QueueStatusResult
 * @typedef {import('../types').ChargePrediction} ChargePrediction
 * @typedef {import('../types').UserRecord} UserRecord
 */

/**
 * Derives the queue status for a user based on their prediction data and activity flags.
 *
 * @param {Object} params
 * @param {UserRecord} params.user
 * @param {ChargePrediction | null} params.prediction
 * @param {number} params.nowMs
 * @param {boolean} params.isActive
 * @param {boolean} params.isSuspended
 * @param {number} params.chargeThreshold
 * @param {boolean} params.alwaysDrawOnCharge
 * @returns {QueueStatusResult}
 */
export function deriveQueueStatus({
    user,
    prediction,
    nowMs,
    isActive,
    isSuspended,
    chargeThreshold,
    alwaysDrawOnCharge,
}) {
    if (isSuspended) {
        const suspensionMs = Math.max(0, (user.suspendedUntil ?? 0) - nowMs);
        return {
            status: 'suspended',
            cooldownSeconds: Math.ceil(suspensionMs / 1000),
            readyIncrement: 0,
        };
    }

    if (isActive) {
        return { status: 'active', cooldownSeconds: null, readyIncrement: 0 };
    }

    if (!prediction) {
        return { status: 'no-data', cooldownSeconds: null, readyIncrement: 0 };
    }

    const minThreshold = alwaysDrawOnCharge ? 1 : Math.max(1, Math.floor(prediction.max * chargeThreshold));
    const availableCharges = Math.floor(prediction.count);

    if (availableCharges >= minThreshold) {
        return { status: 'ready', cooldownSeconds: null, readyIncrement: 1 };
    }

    const deficit = Math.max(0, minThreshold - availableCharges);
    const cooldownMs = deficit * (prediction.cooldownMs ?? 30000);

    return {
        status: 'cooldown',
        cooldownSeconds: Math.ceil(cooldownMs / 1000),
        readyIncrement: 0,
    };
}

/**
 * Builds a queue entry enriched with prediction and droplet insights for the dashboard.
 *
 * @param {Object} params
 * @param {string} params.id
 * @param {UserRecord} params.user
 * @param {ChargePrediction | null} params.prediction
 * @param {QueueStatusResult} params.statusResult
 * @param {number} params.dropletReserve
 * @param {number} params.defaultMaxRetry
 * @returns {QueueEntry}
 */
export function buildQueueEntry({ id, user, prediction, statusResult, dropletReserve, defaultMaxRetry }) {
    const rawDroplets = Number(user?.userInfo?.droplets ?? 0);
    const availableDroplets = Math.max(0, rawDroplets - dropletReserve);

    return {
        id,
        name: user?.name || `User #${id}`,
        charges: prediction
            ? {
                  current: Math.floor(prediction.count),
                  max: prediction.max,
                  percentage: Math.round((prediction.count / prediction.max) * 100),
              }
            : null,
        droplets: {
            total: rawDroplets,
            available: availableDroplets,
        },
        status: statusResult.status,
        cooldownTime: statusResult.cooldownSeconds,
        retryCount: user?.retryCount ?? 0,
        maxRetryCount: user?.settings?.maxRetryCount ?? defaultMaxRetry,
        lastErrorTime: user?.lastErrorTime ?? null,
    };
}

/**
 * Sorts queue entries by status priority and available droplets.
 *
 * @param {QueueEntry[]} queue
 * @returns {QueueEntry[]}
 */
export function sortQueue(queue) {
    const statusPriority = {
        active: 1,
        ready: 2,
        cooldown: 3,
        waiting: 4,
        suspended: 5,
        'no-data': 6,
    };

    return queue.sort((a, b) => {
        const dropletDelta = (b.droplets?.available ?? 0) - (a.droplets?.available ?? 0);
        if (dropletDelta !== 0) {
            return dropletDelta;
        }

        const aPriority = statusPriority[a.status] ?? 7;
        const bPriority = statusPriority[b.status] ?? 7;

        if (aPriority !== bPriority) {
            return aPriority - bPriority;
        }

        if (a.charges && b.charges) {
            const chargeDelta = b.charges.current - a.charges.current;
            if (chargeDelta !== 0) {
                return chargeDelta;
            }
        }

        if (a.charges && !b.charges) return -1;
        if (!a.charges && b.charges) return 1;

        return a.id.localeCompare(b.id);
    });
}
