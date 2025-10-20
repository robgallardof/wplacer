const RELOAD_FLAG = 'wplacer_reload_in_progress';

// Ensure any leftover pawtect chunk cache is cleared on page load
try { localStorage.removeItem('wplacerPawtectChunk'); } catch {}

console.log("✅ wplacer: Content script loaded.");

if (sessionStorage.getItem(RELOAD_FLAG)) {
    sessionStorage.removeItem(RELOAD_FLAG);
    console.log("wplacer: Page reloaded to capture a new token.");
}

const sentTokens = new Set();
const pending = { turnstile: null, pawtect: null };
let pendingFallbackTimer = null;

const PAWTECT_FALLBACK_DELAY_MS = 2500;

const clearPendingTimer = () => {
    if (pendingFallbackTimer) {
        try {
            clearTimeout(pendingFallbackTimer);
        } catch {}
        pendingFallbackTimer = null;
    }
};

const resetPendingState = () => {
    clearPendingTimer();
    pending.turnstile = null;
    pending.pawtect = null;
};

const scheduleFallbackPair = () => {
    clearPendingTimer();
    if (!pending.turnstile) return;
    pendingFallbackTimer = setTimeout(() => {
        const token = pending.turnstile;
        const fallbackPawtect = pending.pawtect || window.wplacerPawtectToken || null;
        resetPendingState();
        postToken(token, fallbackPawtect);
    }, PAWTECT_FALLBACK_DELAY_MS);
};
const USERSCRIPT_SOURCE = 'my-userscript';
const EXTENSION_SOURCE = 'extension';

const BRIDGE_REQUEST_FLAG = 'requestToken';
const BRIDGE_RESPONSE_FLAG = 'responseToken';

const injectTokenBridge = () => {
    try {
        const markerId = 'wplacer-token-bridge';
        if (document.documentElement?.hasAttribute('data-wplacer-token-bridge')) return;
        const script = document.createElement('script');
        script.id = markerId;
        script.type = 'text/javascript';
        script.textContent = `(() => {
            try {
                if (window.__wplacerTokenBridgeInstalled) return;
                window.__wplacerTokenBridgeInstalled = true;

                const getManager = () => {
                    const candidates = [
                        window.WPlaceTokenManager,
                        window.globalTokenManager,
                        window.TokenManager,
                    ];
                    for (const candidate of candidates) {
                        if (candidate && typeof candidate.ensureToken === 'function') {
                            return candidate;
                        }
                    }
                    return null;
                };

                const respond = (requestId, payload) => {
                    window.postMessage({
                        __wplacerBridge: '${BRIDGE_RESPONSE_FLAG}',
                        requestId: requestId ?? null,
                        ...payload,
                    }, '*');
                };

                window.addEventListener('message', async (event) => {
                    try {
                        if (event.source !== window) return;
                        const data = event.data;
                        if (!data || data.__wplacerBridge !== '${BRIDGE_REQUEST_FLAG}') return;

                        const requestId = data.requestId || null;
                        const manager = getManager();
                        if (!manager) {
                            respond(requestId, { ok: false, error: 'manager-unavailable' });
                            return;
                        }

                        const force = data.force === true;
                        const token = await manager.ensureToken(force);
                        if (typeof token === 'string' && token.length > 10) {
                            let fingerprint = null;
                            try {
                                if (typeof manager.getFingerprint === 'function') {
                                    fingerprint = manager.getFingerprint();
                                } else if (manager.lastFingerprint) {
                                    fingerprint = manager.lastFingerprint;
                                }
                            } catch {}

                            respond(requestId, {
                                ok: true,
                                token,
                                fingerprint: typeof fingerprint === 'string' ? fingerprint : null,
                            });
                        } else {
                            respond(requestId, { ok: false, error: 'empty-token' });
                        }
                    } catch (error) {
                        const message = error && error.message ? error.message : String(error || 'unknown');
                        respond(event?.data?.requestId || null, { ok: false, error: message });
                    }
                });
            } catch (error) {
                console.warn('wplacer: token bridge failed to install', error);
            }
        })();`;
        document.documentElement?.setAttribute('data-wplacer-token-bridge', '1');
        (document.head || document.documentElement).appendChild(script);
        script.remove();
    } catch (error) {
        console.warn('wplacer: failed to inject token bridge', error);
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectTokenBridge, { once: true });
} else {
    injectTokenBridge();
}

const postToPage = (payload) => {
    try {
        window.postMessage({ source: EXTENSION_SOURCE, ...payload }, '*');
    } catch (error) {
        console.warn('wplacer: failed to post message to page script', error);
    }
};

const trySendPair = () => {
    if (!pending.turnstile || !pending.pawtect) return;
    const t = pending.turnstile;
    const p = pending.pawtect || null;
    resetPendingState();
    postToken(t, p);
};

const generateRandomHex = (length = 32) => {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
};

try {
    const fp = generateRandomHex(32);
    window.wplacerFP = fp;
    sessionStorage.setItem('wplacer_fp', fp);
    console.log('wplacer: fingerprint generated:', fp);
} catch {}

const handleTokenCapture = (token, { pawtectToken = null, fingerprint = null } = {}) => {
    if (!token || typeof token !== 'string') {
        return false;
    }

    resetPendingState();
    pending.turnstile = token;
    pending.pawtect = pawtectToken && typeof pawtectToken === 'string' ? pawtectToken : null;
    if (pending.pawtect) {
        try {
            window.wplacerPawtectToken = pending.pawtect;
        } catch {}
    }

    const fp = fingerprint && typeof fingerprint === 'string' && fingerprint.length >= 10
        ? fingerprint
        : window.wplacerFP || sessionStorage.getItem('wplacer_fp') || generateRandomHex(32);

    try {
        window.wplacerFP = fp;
        sessionStorage.setItem('wplacer_fp', fp);
    } catch {}

    try {
        const body = { colors: [0], coords: [1, 1], fp, t: token };
        chrome.runtime.sendMessage({
            action: 'computePawtectForT',
            url: 'https://backend.wplace.live/s0/pixel/1/1',
            bodyStr: JSON.stringify(body),
        });
    } catch {}

    if (pending.pawtect) {
        trySendPair();
    } else {
        scheduleFallbackPair();
    }
    return true;
};

const postToken = (token, pawtectToken) => {
    if (!token || typeof token !== 'string' || sentTokens.has(token)) {
        return;
    }
    sentTokens.add(token);
    console.log(`✅ wplacer: CAPTCHA Token Captured. Sending to server.`);
    const fp = window.wplacerFP || sessionStorage.getItem('wplacer_fp') || generateRandomHex(32);
    chrome.runtime.sendMessage({
        type: "SEND_TOKEN",
        token: token,
        pawtect: pawtectToken,
        fp
    });
};

const BRIDGE_MAX_ATTEMPTS = 8;
const BRIDGE_RETRY_DELAY_MS = 900;

const requestTokenWithoutReload = async (force = true, timeoutMs = 7500, attempt = 0) => {
    const handled = await new Promise((resolve) => {
        try {
            const requestId = `req_${generateRandomHex(8)}`;
            let settled = false;

            const cleanup = () => {
                if (settled) return;
                settled = true;
                window.removeEventListener('message', onMessage, true);
                clearTimeout(timerId);
            };

            const onMessage = (event) => {
                try {
                    if (event.source !== window) return;
                    const data = event.data;
                    if (!data || data.__wplacerBridge !== BRIDGE_RESPONSE_FLAG) return;
                    if (data.requestId !== requestId) return;

                    cleanup();
                    if (data.ok && typeof data.token === 'string' && data.token.length > 10) {
                        handleTokenCapture(data.token, {
                            pawtectToken: typeof data.pawtect === 'string' ? data.pawtect : null,
                            fingerprint: typeof data.fingerprint === 'string' ? data.fingerprint : null,
                        });
                        resolve(true);
                    } else {
                        resolve(false);
                    }
                } catch {
                    resolve(false);
                }
            };

            window.addEventListener('message', onMessage, true);

            const timerId = setTimeout(() => {
                cleanup();
                resolve(false);
            }, Math.max(1000, timeoutMs));

            postToPage({
                __wplacerBridge: BRIDGE_REQUEST_FLAG,
                type: BRIDGE_REQUEST_FLAG,
                requestId,
                force,
            });
        } catch {
            resolve(false);
        }
    });
    if (handled) {
        return { handled: true };
    }
    if (attempt >= BRIDGE_MAX_ATTEMPTS - 1) {
        const retryAfterMs = BRIDGE_RETRY_DELAY_MS * (attempt + 2);
        return {
            handled: false,
            reason: 'bridge-timeout',
            attempts: attempt + 1,
            retryAfterMs,
        };
    }
    await new Promise((r) => setTimeout(r, BRIDGE_RETRY_DELAY_MS * (attempt + 1)));
    return requestTokenWithoutReload(force, timeoutMs, attempt + 1);
};

window.addEventListener('message', (event) => {
    if (event.origin === "https://challenges.cloudflare.com" && event.data) {
        try {
            const token = event.data.token || event.data.response || event.data['cf-turnstile-response'];
            if (token) {
                let pawtectToken = null;
                if (window.wplacerPawtectToken) {
                    pawtectToken = window.wplacerPawtectToken;
                    try { delete window.wplacerPawtectToken; } catch {}
                }
                handleTokenCapture(token, { fingerprint: null, pawtectToken });
            }
        } catch {}
        return;
    }

    try {
        if (event.source === window) {
            const data = event.data;
            if (
                data &&
                data.__wplacerBridge === BRIDGE_RESPONSE_FLAG &&
                !data.requestId &&
                data.ok &&
                typeof data.token === 'string'
            ) {
                handleTokenCapture(data.token, {
                    pawtectToken: typeof data.pawtect === 'string' ? data.pawtect : null,
                    fingerprint: typeof data.fingerprint === 'string' ? data.fingerprint : null,
                });
            }
        }
    } catch {}
}, true);

window.addEventListener('message', (event) => {
    try {
        if (event.source !== window) return;
        const data = event.data;
        if (data && data.type === 'WPLACER_PAWTECT_TOKEN' && typeof data.token === 'string') {
            pending.pawtect = data.token;
            window.wplacerPawtectToken = data.token;
            console.log('✅ wplacer: Pawtect token captured from', data.origin || 'unknown', 'waiting/pairing...');
            trySendPair();
        }
    } catch {}
}, true);

window.addEventListener('message', (event) => {
    try {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== USERSCRIPT_SOURCE) return;

        if (data.type === 'setCookie') {
            const rawValue = typeof data.value === 'string' ? data.value : '';
            if (!rawValue) {
                postToPage({ type: 'cookieSetError', error: 'Missing cookie value' });
                return;
            }

            chrome.runtime.sendMessage(
                { action: 'setAuthCookie', value: rawValue },
                (response) => {
                    const runtimeError = chrome.runtime.lastError;
                    if (runtimeError) {
                        postToPage({
                            type: 'cookieSetError',
                            error: runtimeError.message || 'Extension unavailable',
                        });
                        return;
                    }

                    if (response && response.ok) {
                        postToPage({ type: 'cookieSet' });
                    } else {
                        postToPage({
                            type: 'cookieSetError',
                            error: (response && response.error) || 'Failed to set cookie',
                        });
                    }
                }
            );
        } else if (data.type === 'getAccounts') {
            chrome.runtime.sendMessage({ action: 'getStoredAccounts' }, (response) => {
                const runtimeError = chrome.runtime.lastError;
                if (runtimeError) {
                    postToPage({
                        type: 'accountsData',
                        accounts: [],
                        error: runtimeError.message || 'Extension unavailable',
                    });
                    return;
                }

                const accounts = Array.isArray(response?.accounts)
                    ? response.accounts
                    : [];

                postToPage({ type: 'accountsData', accounts });
            });
        }
    } catch (error) {
        console.warn('wplacer: failed to process page bridge message', error);
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "reloadForToken") {
        (async () => {
            const result = await requestTokenWithoutReload(true, 8500);
            if (result?.handled) {
                console.log('wplacer: Token request handled without full reload.');
                try { sendResponse?.({ handled: true }); } catch {}
                return;
            }
            console.warn('wplacer: Token bridge unavailable after retries. Reporting back without forcing reload.');
            try {
                sendResponse?.({
                    handled: false,
                    reason: result?.reason || 'bridge-timeout',
                    attempts: result?.attempts || BRIDGE_MAX_ATTEMPTS,
                    retryAfterMs: result?.retryAfterMs || BRIDGE_RETRY_DELAY_MS * BRIDGE_MAX_ATTEMPTS,
                });
            } catch {}
        })();
        return true;
    }
});
