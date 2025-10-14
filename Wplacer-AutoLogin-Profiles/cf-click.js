/* eslint-disable no-console */
console.log('[AUTO-LOGIN EXTENSION] cf-click.js loaded');

/**
 * Runtime configuration for polling and observation.
 * Timings are intentionally close to the original behavior.
 */
const RUNTIME_CONFIG = {
    /** Interval between DOM checks (ms). */
    POLL_INTERVAL_MS: 100,
    /** Delay before assisting once the target is found (ms). */
    ASSIST_DELAY_MS: 50,
    /** Maximum number of polling attempts before giving up. */
    MAX_POLL_ATTEMPTS: 100, // ≈10s total
    /** Timeout for the initial DOM observer (ms). */
    OBSERVER_TIMEOUT_MS: 5000,
    /** Visual highlight duration (ms). */
    HIGHLIGHT_DURATION_MS: 2200,
};

/** Selector used by official Turnstile container. */
const SELECTOR_TURNSTILE_CONTAINER = '.cf-turnstile';
/** Candidate iframe selectors commonly used by Turnstile. */
const SELECTORS_TURNSTILE_IFRAME = ['iframe[src*="challenges.cloudflare.com"]', 'iframe[src*="turnstile"]'];

/**
 * Attempt to locate a Turnstile element (container, iframe, or a best-effort handle).
 * @returns {Element|null} A focusable/visible element related to Turnstile, or null if not found.
 */
function locateTurnstileElement() {
    // 1) Official container
    const container = document.querySelector(SELECTOR_TURNSTILE_CONTAINER);
    if (container) return container;

    // 2) Known iframe patterns
    for (const sel of SELECTORS_TURNSTILE_IFRAME) {
        const frame = document.querySelector(sel);
        if (frame) return frame;
    }

    // 3) Best effort: checkbox/label inside a body shadowRoot (rare)
    try {
        const body = document.querySelector('body');
        const input = body && body.shadowRoot && body.shadowRoot.querySelector('input[type=checkbox]');
        if (input) {
            const label = body.shadowRoot.querySelector('label');
            return label || input;
        }
    } catch {}
    return null;
}

/**
 * Scroll an element into view (center) and attempt to focus it.
 * @param {Element} element
 * @returns {void}
 */
function revealAndFocusElement(element) {
    try {
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    } catch {}
    try {
        if (element instanceof HTMLElement) element.focus({ preventScroll: true });
    } catch {}
}

/**
 * Briefly outline the element to draw user attention.
 * @param {Element} element
 * @param {number} [durationMs=RUNTIME_CONFIG.HIGHLIGHT_DURATION_MS]
 * @returns {void}
 */
function highlightElement(element, durationMs = RUNTIME_CONFIG.HIGHLIGHT_DURATION_MS) {
    try {
        if (!(element instanceof HTMLElement)) return;
        const previousOutline = element.style.outline;
        element.style.outline = '3px solid rgba(255, 200, 0, 0.95)';
        setTimeout(() => {
            try {
                element.style.outline = previousOutline;
            } catch {}
        }, durationMs);
    } catch {}
}

/**
 * Announce a short ARIA message for screen readers.
 * @param {string} message
 * @returns {void}
 */
function announceAria(message) {
    try {
        let liveRegion = document.getElementById('wplace-aria-live');
        if (!liveRegion) {
            liveRegion = document.createElement('div');
            liveRegion.id = 'wplace-aria-live';
            liveRegion.setAttribute('role', 'status');
            liveRegion.setAttribute('aria-live', 'polite');
            liveRegion.style.cssText = 'position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden;';
            document.body.appendChild(liveRegion);
        }
        liveRegion.textContent = '';
        setTimeout(() => {
            try {
                liveRegion.textContent = message;
            } catch {}
        }, 50);
    } catch {}
}

/**
 * Perform non-invasive assistance on the detected Turnstile widget:
 * scroll, focus, highlight, and ARIA announce. No synthetic input is dispatched.
 * @param {Element} widgetElement
 * @returns {boolean} true if assistance was performed.
 */
function guideUserToWidget(widgetElement) {
    console.log('[AUTO-LOGIN EXTENSION] Turnstile element detected; guiding user');
    revealAndFocusElement(widgetElement);
    highlightElement(widgetElement);
    announceAria('Security check required. Please complete the verification.');
    return true;
}

/**
 * Poll the DOM for a Turnstile element and assist once when found.
 * Promise<boolean> to preserve the original contract.
 * @returns {Promise<boolean>} true if assistance occurred; false on timeout/failure.
 */
function assistTurnstileOnce() {
    return new Promise((resolve) => {
        console.log('[AUTO-LOGIN EXTENSION] Starting Turnstile element lookup');

        let attemptCount = 0;
        let isTimerCleared = false;

        const pollTimer = setInterval(() => {
            attemptCount++;

            if (attemptCount > RUNTIME_CONFIG.MAX_POLL_ATTEMPTS) {
                console.warn('[AUTO-LOGIN EXTENSION] Timeout: element not found after', attemptCount, 'attempts');
                clearInterval(pollTimer);
                isTimerCleared = true;
                resolve(false);
                return;
            }

            try {
                const widget = locateTurnstileElement();
                if (widget) {
                    console.log('[AUTO-LOGIN EXTENSION] ✓ Element found after', attemptCount, 'attempts');
                    clearInterval(pollTimer);
                    isTimerCleared = true;

                    setTimeout(() => {
                        const ok = guideUserToWidget(widget);
                        resolve(ok);
                    }, RUNTIME_CONFIG.ASSIST_DELAY_MS);
                }
            } catch (error) {
                console.error('[AUTO-LOGIN EXTENSION] Error during lookup:', error);
                clearInterval(pollTimer);
                isTimerCleared = true;
                resolve(false);
            }
        }, RUNTIME_CONFIG.POLL_INTERVAL_MS);

        // Hard cleanup to avoid orphaned intervals
        setTimeout(
            () => {
                if (!isTimerCleared) {
                    clearInterval(pollTimer);
                    console.warn('[AUTO-LOGIN EXTENSION] Forced interval cleanup');
                    resolve(false);
                }
            },
            RUNTIME_CONFIG.MAX_POLL_ATTEMPTS * RUNTIME_CONFIG.POLL_INTERVAL_MS + 1000
        );
    });
}

/**
 * Initialize the content script once the DOM is reasonably ready.
 * Preserves readiness checks and observer fallback.
 * @returns {void}
 */
function initializeAssist() {
    if (document && document.documentElement && document.head) {
        console.log('[AUTO-LOGIN EXTENSION] DOM ready, starting immediately');
        assistTurnstileOnce();
    } else {
        console.log('[AUTO-LOGIN EXTENSION] Waiting for DOM readiness');

        let isArmed = false;
        let observerTimeoutId = null;

        const domObserver = new MutationObserver(() => {
            if (!isArmed && document.head) {
                isArmed = true;
                console.log('[AUTO-LOGIN EXTENSION] DOM ready, starting lookup');
                assistTurnstileOnce();
                domObserver.disconnect();
                if (observerTimeoutId) clearTimeout(observerTimeoutId);
            }
        });

        domObserver.observe(document, { childList: true, subtree: true });

        observerTimeoutId = setTimeout(() => {
            if (!isArmed) {
                console.warn('[AUTO-LOGIN EXTENSION] Observer timeout, disconnecting');
                domObserver.disconnect();
            }
        }, RUNTIME_CONFIG.OBSERVER_TIMEOUT_MS);
    }
}

/* Backward-compatibility: keep original name that callers may rely on. */
/**
 * Legacy alias kept for compatibility with previous integrations.
 * @returns {Promise<boolean>}
 */
function clickCheckbox() {
    return assistTurnstileOnce();
}

// Entry point
initializeAssist();
