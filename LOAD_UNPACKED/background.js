/**
 * Alarm identifiers used by the extension.
 * These must stay stable to avoid orphaned alarms after updates.
 */
const POLL_ALARM_NAME = 'wplacer-poll-alarm';
const COOKIE_ALARM_NAME = 'wplacer-cookie-alarm';
const SAFETY_REFRESH_ALARM_NAME = 'wplacer-safety-refresh-alarm';
const TOKEN_TIMEOUT_ALARM_NAME = 'wplacer-token-timeout-alarm';
const AUTO_RELOAD_ALARM_NAME = 'wplacer-auto-reload-alarm';
const FRONT_ORIGIN = 'https://wplace.live/';
const BACKEND_ORIGIN = 'https://backend.wplace.live/';
const AUTH_COOKIE_NAME = 'j';

/** Internal state flags and timing constants */
let LP_ACTIVE = false;
let TOKEN_IN_PROGRESS = false;
let LAST_RELOAD_AT = 0;

/** Minimum delay between reload attempts (ms). Prevents rapid churn. */
const MIN_RELOAD_INTERVAL_MS = 5000;
/** Max wait for a token before retrying (ms). */
const TOKEN_TIMEOUT_MS = 25000;
/** Fast-retry spacing and cap. */
const FAST_RETRY_DELAY_MS = 7000;
const FAST_RETRY_MAX = 3;

let TOKEN_TIMEOUT_ID = null;
let fastRetriesLeft = 0;

/**
 * Sleep helper.
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>}
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Determines whether a messaging error indicates the frame is not yet ready.
 * Chrome reports several different messages for this situation depending on
 * timing, so we normalise them into a single retryable signal.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
const isRetryableMessagingError = (error) => {
    if (!error) return false;
    const message = typeof error === 'string' ? error : error?.message || '';
    if (!message) return false;
    return (
        message.includes('Frame') ||
        message.includes('No tab with id') ||
        message.includes('Receiving end does not exist') ||
        message.includes('Could not establish connection')
    );
};

/**
 * Attempts to notify the content script that a token refresh is required
 * without forcing a full tab reload. A couple of retries are performed to
 * give the page script time to finish booting before we fall back to a reload.
 *
 * @param {number} tabId
 * @param {number} [attempts=3]
 * @returns {Promise<boolean>} true when the content script confirmed it will
 *   handle the request without a reload.
 */
const requestTokenViaContent = async (tabId, attempts = 3) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            const response = await chrome.tabs.sendMessage(tabId, { action: 'reloadForToken' });
            return response?.handled === true;
        } catch (error) {
            if (!isRetryableMessagingError(error) || attempt === attempts - 1) {
                if (error && !isRetryableMessagingError(error)) {
                    console.warn('wplacer: token bridge message failed', error?.message || error);
                }
                break;
            }
            await wait(250 * (attempt + 1));
        }
    }
    return false;
};

/**
 * Safely clears an existing timeout handle if present.
 */
const clearTokenTimeout = () => {
    try {
        if (TOKEN_TIMEOUT_ID) {
            clearTimeout(TOKEN_TIMEOUT_ID);
            TOKEN_TIMEOUT_ID = null;
        }
    } catch {}
};

/**
 * Safely clears an alarm by name.
 * @param {string} name
 * @returns {Promise<void>}
 */
const clearAlarm = async (name) => {
    try {
        await chrome.alarms.clear(name);
    } catch {}
};

/**
 * Reads current extension settings from local storage.
 * Defaults are applied if not present.
 * @returns {Promise<{port:number,host:string,autoReloadInterval:number}>}
 */
const getSettings = async () => {
    const result = await chrome.storage.local.get(['wplacerPort', 'wplacerAutoReload']);
    return {
        port: result.wplacerPort ?? 80,
        host: '127.0.0.1',
        autoReloadInterval: result.wplacerAutoReload ?? 0,
    };
};

/**
 * Builds the server URL used by the local helper service.
 * @param {string} [path=''] - Optional path to append.
 * @returns {Promise<string>}
 */
const getServerUrl = async (path = '') => {
    const { host, port } = await getSettings();
    return `http://${host}:${port}${path}`;
};

const setCookiePromise = (details) => new Promise((resolve, reject) => {
    try {
        chrome.cookies.set(details, (cookie) => {
            const err = chrome.runtime.lastError;
            if (err || !cookie) {
                reject(new Error(err?.message || 'Failed to set cookie'));
            } else {
                resolve(cookie);
            }
        });
    } catch (error) {
        reject(error);
    }
});

const setAuthCookieForUrl = async (url, value) => {
    const base = {
        url,
        name: AUTH_COOKIE_NAME,
        value,
        path: '/',
    };
    try {
        return await setCookiePromise({
            ...base,
            secure: true,
            httpOnly: true,
            sameSite: 'no_restriction',
        });
    } catch (error) {
        console.warn('wplacer: strict cookie set failed, retrying without advanced flags for', url, error?.message || error);
        return await setCookiePromise(base);
    }
};

const normaliseAccountsList = (raw) => {
    if (Array.isArray(raw)) {
        return raw.filter((item) => item != null);
    }
    if (raw && typeof raw === 'object') {
        return Object.values(raw).filter((item) => item != null);
    }
    return [];
};

const fetchStoredAccounts = async () => {
    try {
        const { wplacerAccounts } = await chrome.storage.local.get(['wplacerAccounts']);
        return normaliseAccountsList(wplacerAccounts);
    } catch (error) {
        console.warn('wplacer: failed to read stored accounts', error?.message || error);
        return [];
    }
};

/**
 * Creates/updates the auto-reload alarm based on user settings.
 * If interval is 0 or falsy, alarm is removed.
 * @returns {Promise<void>}
 */
const updateAutoReloadAlarm = async () => {
    try {
        await clearAlarm(AUTO_RELOAD_ALARM_NAME);
        const { autoReloadInterval } = await getSettings();
        if (autoReloadInterval > 0) {
            // settings are in seconds; chrome.alarms expects minutes
            const minutes = autoReloadInterval / 60;
            await chrome.alarms.create(AUTO_RELOAD_ALARM_NAME, {
                delayInMinutes: minutes,
                periodInMinutes: minutes,
            });
            console.log(`wplacer: Auto-reload alarm set for ${autoReloadInterval} seconds`);
        } else {
            console.log('wplacer: Auto-reload disabled');
        }
    } catch (error) {
        console.error('wplacer: Failed to update auto-reload alarm:', error);
    }
};

/**
 * Auto-reloads all open wplace.live tabs with cache bypass, injecting Pawtect first.
 * Errors on individual tabs won't stop the rest.
 * @returns {Promise<void>}
 */
const performAutoReload = async () => {
    try {
        const tabs = await chrome.tabs.query({ url: 'https://wplace.live/*' });
        if (!tabs?.length) return;

        console.log(`wplacer: Auto-reloading ${tabs.length} wplace.live tab(s)`);

        await Promise.allSettled(
            tabs.map(async (tab) => {
                try {
                    await injectPawtectIntoTab(tab.id);
                    await chrome.tabs.reload(tab.id, { bypassCache: true });
                } catch (error) {
                    console.warn(`wplacer: Failed to reload tab ${tab.id}:`, error);
                }
            })
        );
    } catch (error) {
        console.error('wplacer: Auto-reload failed:', error);
    }
};

/**
 * Long-poll the local server for token demand.
 * When demand is detected, it triggers a reload cycle and enters fast-retry mode.
 * Runs until LP_ACTIVE is set to false.
 * @returns {Promise<void>}
 */
async function startLongPoll() {
    if (LP_ACTIVE) return;
    LP_ACTIVE = true;

    while (LP_ACTIVE) {
        try {
            const url = await getServerUrl('/token-needed/long');
            const r = await fetch(url, { cache: 'no-store' });
            if (r.ok) {
                const data = await r.json();
                if (data.needed) {
                    await maybeInitiateReload();
                    fastRetriesLeft = FAST_RETRY_MAX;
                    scheduleFastRetry();
                }
            } else {
                await wait(1000);
            }
        } catch {
            await wait(2000);
        }
    }
}

/**
 * Resets token-waiting state and clears fast-retry progression.
 * Idempotent and safe to call even if not waiting.
 */
const clearTokenWait = () => {
    clearTokenTimeout();
    TOKEN_IN_PROGRESS = false;
    fastRetriesLeft = 0;
};

/**
 * If no token-reload is in progress and minimum spacing elapsed,
 * initiate a reload cycle and arm timeout/backup alarm.
 * @returns {Promise<void>}
 */
const maybeInitiateReload = async () => {
    const now = Date.now();
    if (TOKEN_IN_PROGRESS) return;
    if (now - LAST_RELOAD_AT < MIN_RELOAD_INTERVAL_MS) return;

    TOKEN_IN_PROGRESS = true;
    await initiateReload();
    LAST_RELOAD_AT = Date.now();

    clearTokenTimeout();
    TOKEN_TIMEOUT_ID = setTimeout(() => {
        console.warn('wplacer: token wait timed out, retrying...');
        clearTokenWait();
        // trigger next cycle quickly
        pollForTokenRequest();
        fastRetriesLeft = FAST_RETRY_MAX;
        scheduleFastRetry();
    }, TOKEN_TIMEOUT_MS);

    // Backup alarm in case the service worker sleeps
    await clearAlarm(TOKEN_TIMEOUT_ALARM_NAME);
    try {
        await chrome.alarms.create(TOKEN_TIMEOUT_ALARM_NAME, { delayInMinutes: 1 });
    } catch {}
};

/**
 * Schedules a short series of fast retries to reduce idle gaps in token acquisition.
 * Uses chained timeouts instead of setInterval to keep order predictable.
 */
const scheduleFastRetry = () => {
    if (fastRetriesLeft <= 0) return;

    setTimeout(async () => {
        if (fastRetriesLeft <= 0) return;
        if (!TOKEN_IN_PROGRESS) {
            await maybeInitiateReload();
        }
        fastRetriesLeft -= 1;
        if (fastRetriesLeft > 0) scheduleFastRetry();
    }, FAST_RETRY_DELAY_MS);
};

/**
 * Polls the local server once for a token request.
 * Kicks off reload/fast-retry if needed.
 * @returns {Promise<void>}
 */
const pollForTokenRequest = async () => {
    console.log('wplacer: Polling server for token request...');
    try {
        const url = await getServerUrl('/token-needed');
        const response = await fetch(url);
        if (!response.ok) {
            console.warn(`wplacer: Server poll failed with status: ${response.status}`);
            return;
        }
        const data = await response.json();
        if (data.needed) {
            console.log('wplacer: Server requires a token. Initiating reload.');
            await initiateReload();
            fastRetriesLeft = FAST_RETRY_MAX;
            scheduleFastRetry();
        }
    } catch (error) {
        console.error('wplacer: Could not connect to the server to poll for tokens.', error?.message ?? error);
    }
};

/**
 * Injects the Pawtect hook into a target tab, executing in the MAIN world.
 * Fails silently if the tab goes away or scripting is unavailable.
 * @param {number} tabId - The ID of the tab to inject into.
 * @returns {Promise<void>}
 */
const injectPawtectIntoTab = async (tabId) => {
    if (typeof tabId !== 'number') return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => {
                if (window.__wplacerPawtectHooked) return;
                window.__wplacerPawtectHooked = true;
                const backend = 'https://backend.wplace.live';
                const findPawtectChunk = async () => {
                    if (typeof window.__wplacerPawtectChunk === 'string' && window.__wplacerPawtectChunk) {
                        return window.__wplacerPawtectChunk;
                    }

                    const cacheKey = 'wplacer_pawtect_chunk';
                    const cacheTimeKey = 'wplacer_pawtect_chunk_ts';
                    const cacheExpiry = 5 * 60 * 1000;

                    try {
                        const cached = localStorage.getItem(cacheKey);
                        const tsRaw = localStorage.getItem(cacheTimeKey);
                        const ts = tsRaw ? parseInt(tsRaw, 10) : NaN;
                        if (cached && Number.isFinite(ts) && Date.now() - ts < cacheExpiry) {
                            window.__wplacerPawtectChunk = cached;
                            return cached;
                        }
                    } catch {}

                    const links = Array.from(
                        document.querySelectorAll('link[rel="modulepreload"][href$=".js"]')
                    ).map((l) => l.getAttribute('href')).filter(Boolean);

                    for (const href of links) {
                        try {
                            const absolute = new URL(href, location.origin);
                            const res = await fetch(absolute.href);
                            const text = await res.text();
                            if (text.includes('get_pawtected_endpoint_payload')) {
                                const chunkPath = absolute.pathname;
                                window.__wplacerPawtectChunk = chunkPath;
                                try {
                                    localStorage.setItem(cacheKey, chunkPath);
                                    localStorage.setItem(cacheTimeKey, Date.now().toString());
                                } catch {}
                                return chunkPath;
                            }
                        } catch {}
                    }
                    return null;
                };
                const computeInstall = async () => {
                    const chunkPath = await findPawtectChunk();
                    if (!chunkPath) return;
                    const pawtectPath = new URL(chunkPath, location.origin).href;
                    const mod = await import(pawtectPath);
                    const originalFetch = window.fetch.bind(window);
                    const computePawtect = async (url, bodyStr) => {
                        if (!mod || typeof mod._ !== 'function') return null;
                        const wasm = await mod._();
                        try {
                            const me = await fetch(`${backend}/me`, { credentials: 'include' }).then((r) =>
                                r.ok ? r.json() : null
                            );
                            if (me?.id) {
                                for (const key of Object.keys(mod)) {
                                    const fn = mod[key];
                                    if (typeof fn === 'function') {
                                        try {
                                            const s = fn.toString();
                                            if (/[\w$]+\s*\.\s*set_user_id\s*\(/.test(s)) {
                                                fn(me.id);
                                                break;
                                            }
                                        } catch {}
                                    }
                                }
                            }
                        } catch {}
                        if (typeof mod.r === 'function') mod.r(url);
                        const enc = new TextEncoder();
                        const dec = new TextDecoder();
                        const bytes = enc.encode(bodyStr);
                        const inPtr = wasm.__wbindgen_malloc(bytes.length, 1);
                        new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);
                        const out = wasm.get_pawtected_endpoint_payload(inPtr, bytes.length);
                        let token;
                        if (Array.isArray(out)) {
                            const [ptr, len] = out;
                            token = dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len));
                            try {
                                wasm.__wbindgen_free(ptr, len, 1);
                            } catch {}
                        } else if (typeof out === 'string') token = out;
                        else if (out && typeof out.ptr === 'number' && typeof out.len === 'number') {
                            token = dec.decode(new Uint8Array(wasm.memory.buffer, out.ptr, out.len));
                            try {
                                wasm.__wbindgen_free(out.ptr, out.len, 1);
                            } catch {}
                        }
                        window.postMessage({ type: 'WPLACER_PAWTECT_TOKEN', token, origin: 'pixel' }, '*');
                        return token;
                    };
                    window.fetch = async (...args) => {
                        try {
                            const input = args[0];
                            const init = args[1] || {};
                            const req = new Request(input, init);
                            if (req.method === 'POST' && /\/s0\/pixel\//.test(req.url)) {
                                const raw = typeof init.body === 'string' ? init.body : null;
                                if (raw) computePawtect(req.url, raw);
                                else {
                                    try {
                                        const clone = req.clone();
                                        const text = await clone.text();
                                        computePawtect(req.url, text);
                                    } catch {}
                                }
                            }
                        } catch {}
                        return originalFetch(...args);
                    };
                };
                computeInstall().catch(() => {});
            },
        });
    } catch (e) {
        console.warn('wplacer: injectPawtectIntoTab failed', e);
    }
};

/**
 * Ensures there is at least one wplace.live tab, injects Pawtect, and triggers a reload.
 * Falls back to direct URL update if reload fails (e.g., due to navigation).
 * @returns {Promise<void>}
 */
const initiateReload = async () => {
    try {
        let tabs = await chrome.tabs.query({ url: 'https://wplace.live/*' });
        if (!tabs?.length) {
            console.warn('wplacer: No wplace.live tabs found. Opening a new one for token acquisition.');
            const created = await chrome.tabs.create({ url: 'https://wplace.live/' });
            tabs = [created];
        }
        const targetTab = tabs.find((t) => t.active) || tabs[0];
        console.log(`wplacer: Preparing tab #${targetTab.id} for token reload (inject pawtect + reload)`);

        try {
            await injectPawtectIntoTab(targetTab.id);
        } catch {}
        await wait(150);

        console.log(`wplacer: Sending reload command to tab #${targetTab.id}`);
        const handledByContent = await requestTokenViaContent(targetTab.id);

        if (!handledByContent) {
            LAST_RELOAD_AT = Date.now();
            // Ensure reload even if content script didn't handle the message.
            setTimeout(async () => {
                try {
                    await chrome.tabs.update(targetTab.id, { active: true });
                } catch {}
                try {
                    await chrome.tabs.reload(targetTab.id, { bypassCache: true });
                } catch {
                    try {
                        const base = (targetTab.url || 'https://wplace.live/').replace(/[#?]$/, '');
                        const url = base + (base.includes('?') ? '&' : '?') + 'wplacer=' + Date.now();
                        await chrome.tabs.update(targetTab.id, { url });
                    } catch {}
                }
                // Second shot after ~1.5s if it didn't start loading
                setTimeout(async () => {
                    try {
                        const t = await chrome.tabs.get(targetTab.id);
                        if (t.status !== 'loading') {
                            await chrome.tabs.reload(targetTab.id, { bypassCache: true });
                        }
                    } catch {}
                }, 1500);
            }, 200);
        } else {
            console.log(`wplacer: Content script is handling token generation without reload for tab #${targetTab.id}.`);
            return;
        }
    } catch (error) {
        console.error('wplacer: Error sending reload message to tab, falling back to direct reload.', error);
        const tabs = await chrome.tabs.query({ url: 'https://wplace.live/*' });
        if (tabs?.length) {
            LAST_RELOAD_AT = Date.now();
            chrome.tabs.reload((tabs.find((t) => t.active) || tabs[0]).id);
        } else {
            LAST_RELOAD_AT = Date.now();
            await chrome.tabs.create({ url: 'https://wplace.live/' });
        }
    }
};

/**
 * Reads session cookies from backend.wplace.live and forwards them to the local server.
 * @param {(result:{success:boolean,name?:string,error?:string})=>void} [callback]
 * @returns {Promise<void>}
 */
const sendCookie = async (callback) => {
    const getCookie = (details) => new Promise((resolve) => chrome.cookies.get(details, (cookie) => resolve(cookie)));

    const [jCookie, sCookie] = await Promise.all([
        getCookie({ url: 'https://backend.wplace.live', name: 'j' }),
        getCookie({ url: 'https://backend.wplace.live', name: 's' }),
    ]);

    if (!jCookie) {
        callback?.({ success: false, error: "Cookie 'j' not found. Are you logged in?" });
        return;
    }

    const cookies = { j: jCookie.value };
    if (sCookie) cookies.s = sCookie.value;

    const url = await getServerUrl('/user');

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookies, expirationDate: jCookie.expirationDate }),
        });
        if (!response.ok) throw new Error(`Server responded with status: ${response.status}`);
        const userInfo = await response.json();
        callback?.({ success: true, name: userInfo.name });
    } catch {
        callback?.({ success: false, error: 'Could not connect to the wplacer server.' });
    }
};

/**
 * Clears browsing data for backend.wplace.live to force a fresh session, then reloads all wplace tabs.
 * @param {(result:{success:boolean,error?:string})=>void} [callback]
 */
const quickLogout = (callback) => {
    const origin = 'https://backend.wplace.live/';
    console.log(`wplacer: Clearing browsing data for ${origin}`);
    chrome.browsingData.remove(
        { origins: [origin] },
        {
            cache: true,
            cookies: true,
            fileSystems: true,
            indexedDB: true,
            localStorage: true,
            pluginData: true,
            serviceWorkers: true,
            webSQL: true,
        },
        () => {
            if (chrome.runtime.lastError) {
                console.error('wplacer: Error clearing browsing data.', chrome.runtime.lastError);
                callback?.({ success: false, error: 'Failed to clear data.' });
                return;
            }
            console.log('wplacer: Browsing data cleared successfully. Reloading wplace.live tabs.');
            chrome.tabs.query({ url: 'https://wplace.live/*' }, (tabs) => {
                if (tabs?.length) tabs.forEach((tab) => chrome.tabs.reload(tab.id));
            });
            callback?.({ success: true });
        }
    );
};

/** Message bus: handles one-off commands from content scripts / UI. */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'setAuthCookie') {
        (async () => {
            const value = typeof request.value === 'string' ? request.value : '';
            if (!value) {
                sendResponse?.({ ok: false, error: 'Empty cookie value' });
                return;
            }

            try {
                const results = await Promise.allSettled([
                    setAuthCookieForUrl(BACKEND_ORIGIN, value),
                    setAuthCookieForUrl(FRONT_ORIGIN, value),
                ]);
                const successes = results.filter((r) => r.status === 'fulfilled');
                if (!successes.length) {
                    const firstError = results.find((r) => r.status === 'rejected');
                    throw firstError?.reason || new Error('Failed to set cookie');
                }
                if (successes.length < results.length) {
                    console.warn('wplacer: cookie set partially succeeded', results);
                }
                sendResponse?.({ ok: true, partial: successes.length < results.length });
            } catch (error) {
                console.warn('wplacer: failed to set auth cookie', error?.message || error);
                sendResponse?.({ ok: false, error: error?.message || 'Failed to set cookie' });
            }
        })();
        return true;
    }

    if (request.action === 'getStoredAccounts') {
        (async () => {
            try {
                const accounts = await fetchStoredAccounts();
                sendResponse?.({ ok: true, accounts });
            } catch (error) {
                console.warn('wplacer: error retrieving stored accounts', error?.message || error);
                sendResponse?.({ ok: false, accounts: [], error: error?.message || 'Failed to read accounts' });
            }
        })();
        return true;
    }

    if (request.action === 'sendCookie') {
        sendCookie(sendResponse);
        return true; // async
    }

    if (request.action === 'settingsUpdated') {
        LP_ACTIVE = false;
        setTimeout(startLongPoll, 100);
        updateAutoReloadAlarm();
        sendResponse?.({ ok: true });
        return false;
    }

    if (request.action === 'injectPawtect') {
        try {
            if (sender.tab?.id) {
                chrome.scripting.executeScript({
                    target: { tabId: sender.tab.id },
                    world: 'MAIN',
                    // NOTE: This injection includes both fetch and XHR hooks, mirroring existing behavior.
                    func: () => {
                        if (window.__wplacerPawtectHooked) return;
                        window.__wplacerPawtectHooked = true;

                        const backend = 'https://backend.wplace.live';

                        const findPawtectChunk = async () => {
                            if (typeof window.__wplacerPawtectChunk === 'string' && window.__wplacerPawtectChunk) {
                                return window.__wplacerPawtectChunk;
                            }

                            const cacheKey = 'wplacer_pawtect_chunk';
                            const cacheTimeKey = 'wplacer_pawtect_chunk_ts';
                            const cacheExpiry = 5 * 60 * 1000; // 5 minutes

                            try {
                                const cached = localStorage.getItem(cacheKey);
                                const cacheTime = localStorage.getItem(cacheTimeKey);
                                const ts = cacheTime ? parseInt(cacheTime, 10) : NaN;
                                if (cached && Number.isFinite(ts) && Date.now() - ts < cacheExpiry) {
                                    window.__wplacerPawtectChunk = cached;
                                    return cached;
                                }
                            } catch {}

                            console.log('[SEARCHING for Pawtect chunk...]');
                            const links = Array.from(
                                document.querySelectorAll('link[rel="modulepreload"][href$=".js"]')
                            ).map((l) => l.getAttribute('href')).filter(Boolean);

                            for (const href of links) {
                                try {
                                    const absolute = new URL(href, location.origin);
                                    const res = await fetch(absolute.href);
                                    const text = await res.text();
                                    if (text.includes('get_pawtected_endpoint_payload')) {
                                        const chunkPath = absolute.pathname;
                                        console.log('[FOUND Pawtect chunk]:', absolute.href);
                                        window.__wplacerPawtectChunk = chunkPath;
                                        try {
                                            localStorage.setItem(cacheKey, chunkPath);
                                            localStorage.setItem(cacheTimeKey, Date.now().toString());
                                        } catch {}
                                        return chunkPath;
                                    }
                                } catch (e) {
                                    console.log('Failed to fetch', href, e);
                                }
                            }

                            return null;
                        };

                        const importModule = async () => {
                            try {
                                const chunkPath = await findPawtectChunk();
                                if (!chunkPath) {
                                    console.warn('pawtect: Could not find Pawtect chunk!');
                                    return null;
                                }

                                try {
                                    const pawtectPath = new URL(chunkPath, location.origin).href;
                                    console.log('[USING Pawtect path]:', pawtectPath);
                                    return await import(pawtectPath);
                                } catch (e) {
                                    console.log('[PATH FAILED, clearing cache and finding new one]:', e);
                                    localStorage.removeItem('wplacer_pawtect_path');
                                    localStorage.removeItem('wplacer_pawtect_cache_time');
                                    localStorage.removeItem('wplacer_pawtect_chunk');
                                    localStorage.removeItem('wplacer_pawtect_chunk_ts');
                                    window.__wplacerPawtectChunk = undefined;
                                    const retryChunk = await findPawtectChunk();
                                    if (retryChunk) {
                                        const retryPath = new URL(retryChunk, location.origin).href;
                                        return await import(retryPath);
                                    }
                                    return null;
                                }
                            } catch (e) {
                                console.warn('pawtect: module import failed', e?.message || e);
                                return null;
                            }
                        };

                        const findSetUserIdFunction = (mod) => {
                            for (const key of Object.keys(mod)) {
                                const fn = mod[key];
                                if (typeof fn === 'function') {
                                    try {
                                        const str = fn.toString();
                                        if (/[\w$]+\s*\.\s*set_user_id\s*\(/.test(str)) {
                                            return fn;
                                        }
                                    } catch {}
                                }
                            }
                            return null;
                        };

                        const computePawtect = async (url, bodyStr) => {
                            const mod = await importModule();
                            if (!mod || typeof mod._ !== 'function') return null;
                            const wasm = await mod._();
                            try {
                                const me = await fetch(`${backend}/me`, { credentials: 'include' }).then((r) =>
                                    r.ok ? r.json() : null
                                );
                                if (me?.id) {
                                    const setUserIdFn = findSetUserIdFunction(mod);
                                    if (setUserIdFn) {
                                        console.log('Set userId', me.id);
                                        setUserIdFn(me.id);
                                    }
                                }
                            } catch {}
                            if (typeof mod.r === 'function') mod.r(url);
                            const enc = new TextEncoder();
                            const dec = new TextDecoder();
                            const bytes = enc.encode(bodyStr);
                            const inPtr = wasm.__wbindgen_malloc(bytes.length, 1);
                            new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);
                            console.log('wplacer: pawtect compute start', { url, bodyLen: bodyStr.length });
                            const out = wasm.get_pawtected_endpoint_payload(inPtr, bytes.length);
                            let token;
                            if (Array.isArray(out)) {
                                const [outPtr, outLen] = out;
                                token = dec.decode(new Uint8Array(wasm.memory.buffer, outPtr, outLen));
                                try {
                                    wasm.__wbindgen_free(outPtr, outLen, 1);
                                } catch {}
                            } else if (typeof out === 'string') {
                                token = out;
                            } else if (out && typeof out.ptr === 'number' && typeof out.len === 'number') {
                                token = dec.decode(new Uint8Array(wasm.memory.buffer, out.ptr, out.len));
                                try {
                                    wasm.__wbindgen_free(out.ptr, out.len, 1);
                                } catch {}
                            } else {
                                console.warn('wplacer: unexpected pawtect out shape', typeof out);
                                token = null;
                            }
                            console.log('wplacer: pawtect compute done, tokenLen:', token ? token.length : 0);
                            window.postMessage({ type: 'WPLACER_PAWTECT_TOKEN', token, origin: 'pixel' }, '*');
                            return token;
                        };

                        const originalFetch = window.fetch.bind(window);
                        window.fetch = async (...args) => {
                            try {
                                const input = args[0];
                                const init = args[1] || {};
                                const req = new Request(input, init);
                                if (req.method === 'POST' && /\/s0\/pixel\//.test(req.url)) {
                                    const raw = typeof init.body === 'string' ? init.body : null;
                                    if (raw) {
                                        console.log(
                                            'wplacer: hook(fetch) pixel POST detected (init.body)',
                                            req.url,
                                            'len',
                                            raw.length
                                        );
                                        computePawtect(req.url, raw);
                                    } else {
                                        try {
                                            const clone = req.clone();
                                            const text = await clone.text();
                                            console.log(
                                                'wplacer: hook(fetch) pixel POST detected (clone)',
                                                req.url,
                                                'len',
                                                text.length
                                            );
                                            computePawtect(req.url, text);
                                        } catch {}
                                    }
                                }
                            } catch {}
                            return originalFetch(...args);
                        };

                        try {
                            const origOpen = XMLHttpRequest.prototype.open;
                            const origSend = XMLHttpRequest.prototype.send;
                            XMLHttpRequest.prototype.open = function (method, url) {
                                try {
                                    this.__wplacer_url = new URL(url, location.href).href;
                                    this.__wplacer_method = String(method || '');
                                } catch {}
                                return origOpen.apply(this, arguments);
                            };
                            XMLHttpRequest.prototype.send = function (body) {
                                try {
                                    if (
                                        (this.__wplacer_method || '').toUpperCase() === 'POST' &&
                                        /\/s0\/pixel\//.test(this.__wplacer_url || '')
                                    ) {
                                        const url = this.__wplacer_url;
                                        const maybeCompute = (raw) => {
                                            if (raw && typeof raw === 'string') computePawtect(url, raw);
                                        };
                                        if (typeof body === 'string') {
                                            console.log(
                                                'wplacer: hook(XHR) pixel POST detected (string)',
                                                url,
                                                'len',
                                                body.length
                                            );
                                            maybeCompute(body);
                                        } else if (body instanceof ArrayBuffer) {
                                            try {
                                                const s = new TextDecoder().decode(new Uint8Array(body));
                                                console.log(
                                                    'wplacer: hook(XHR) pixel POST detected (ArrayBuffer)',
                                                    url,
                                                    'len',
                                                    s.length
                                                );
                                                maybeCompute(s);
                                            } catch {}
                                        } else if (
                                            body &&
                                            typeof body === 'object' &&
                                            'buffer' in body &&
                                            body.buffer instanceof ArrayBuffer
                                        ) {
                                            try {
                                                const s = new TextDecoder().decode(new Uint8Array(body.buffer));
                                                console.log(
                                                    'wplacer: hook(XHR) pixel POST detected (TypedArray)',
                                                    url,
                                                    'len',
                                                    s.length
                                                );
                                                maybeCompute(s);
                                            } catch {}
                                        } else if (body && typeof body.text === 'function') {
                                            try {
                                                body.text()
                                                    .then((s) => {
                                                        console.log(
                                                            'wplacer: hook(XHR) pixel POST detected (Blob)',
                                                            url,
                                                            'len',
                                                            (s || '').length
                                                        );
                                                        maybeCompute(s);
                                                    })
                                                    .catch(() => {});
                                            } catch {}
                                        }
                                    }
                                } catch {}
                                return origSend.apply(this, arguments);
                            };
                        } catch {}
                        console.log('wplacer: pawtect fetch hook installed');
                    },
                });
            }
        } catch (e) {
            console.error('wplacer: failed to inject pawtect hook', e);
        }
        sendResponse({ ok: true });
        return true; // async
    }

    if (request.action === 'seedPawtect') {
        try {
            if (sender.tab?.id) {
                const bodyStr = String(request.bodyStr || '{"colors":[0],"coords":[1,1],"fp":"seed","t":"seed"}');
                chrome.scripting.executeScript({
                    target: { tabId: sender.tab.id },
                    world: 'MAIN',
                    func: (rawBody) => {
                        (async () => {
                            try {
                                const backend = 'https://backend.wplace.live';
                                const url = `${backend}/s0/pixel/1/1`;

                                const findPawtectChunk = async () => {
                                    if (typeof window.__wplacerPawtectChunk === 'string' && window.__wplacerPawtectChunk) {
                                        return window.__wplacerPawtectChunk;
                                    }

                                    const cacheKey = 'wplacer_pawtect_chunk';
                                    const cacheTimeKey = 'wplacer_pawtect_chunk_ts';
                                    const cacheExpiry = 5 * 60 * 1000;

                                    try {
                                        const cached = localStorage.getItem(cacheKey);
                                        const cacheTime = localStorage.getItem(cacheTimeKey);
                                        const ts = cacheTime ? parseInt(cacheTime, 10) : NaN;
                                        if (cached && Number.isFinite(ts) && Date.now() - ts < cacheExpiry) {
                                            window.__wplacerPawtectChunk = cached;
                                            return cached;
                                        }
                                    } catch {}

                                    const links = Array.from(
                                        document.querySelectorAll('link[rel="modulepreload"][href$=".js"]')
                                    ).map((l) => l.getAttribute('href')).filter(Boolean);

                                    for (const href of links) {
                                        try {
                                            const absolute = new URL(href, location.origin);
                                            const res = await fetch(absolute.href);
                                            const text = await res.text();
                                            if (text.includes('get_pawtected_endpoint_payload')) {
                                                const chunkPath = absolute.pathname;
                                                window.__wplacerPawtectChunk = chunkPath;
                                                try {
                                                    localStorage.setItem(cacheKey, chunkPath);
                                                    localStorage.setItem(cacheTimeKey, Date.now().toString());
                                                } catch {}
                                                return chunkPath;
                                            }
                                        } catch {}
                                    }

                                    return null;
                                };

                                const chunkPath = await findPawtectChunk();
                                if (!chunkPath) return;

                                const pawtectPath = new URL(chunkPath, location.origin).href;
                                const mod = await import(pawtectPath);
                                const wasm = await mod._();

                                const findSetUserIdFunction = (mod) => {
                                    for (const key of Object.keys(mod)) {
                                        const fn = mod[key];
                                        if (typeof fn === 'function') {
                                            try {
                                                const str = fn.toString();
                                                if (/[\w$]+\s*\.\s*set_user_id\s*\(/.test(str)) {
                                                    return fn;
                                                }
                                            } catch {}
                                        }
                                    }
                                    return null;
                                };

                                try {
                                    const me = await fetch(`${backend}/me`, { credentials: 'include' }).then((r) =>
                                        r.ok ? r.json() : null
                                    );
                                    if (me?.id) {
                                        const setUserIdFn = findSetUserIdFunction(mod);
                                        if (setUserIdFn) setUserIdFn(me.id);
                                    }
                                } catch {}
                                if (typeof mod.r === 'function') mod.r(url);
                                const enc = new TextEncoder();
                                const dec = new TextDecoder();
                                const bytes = enc.encode(rawBody);
                                const inPtr = wasm.__wbindgen_malloc(bytes.length, 1);
                                new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);
                                const out = wasm.get_pawtected_endpoint_payload(inPtr, bytes.length);
                                let token;
                                if (Array.isArray(out)) {
                                    const [outPtr, outLen] = out;
                                    token = dec.decode(new Uint8Array(wasm.memory.buffer, outPtr, outLen));
                                    try {
                                        wasm.__wbindgen_free(outPtr, outLen, 1);
                                    } catch {}
                                } else if (typeof out === 'string') {
                                    token = out;
                                } else if (out && typeof out.ptr === 'number' && typeof out.len === 'number') {
                                    token = dec.decode(new Uint8Array(wasm.memory.buffer, out.ptr, out.len));
                                    try {
                                        wasm.__wbindgen_free(out.ptr, out.len, 1);
                                    } catch {}
                                }
                                window.postMessage({ type: 'WPLACER_PAWTECT_TOKEN', token, origin: 'seed' }, '*');
                            } catch {}
                        })();
                    },
                    args: [bodyStr],
                });
            }
        } catch {}
        sendResponse({ ok: true });
        return true; // async
    }

    if (request.action === 'computePawtectForT') {
        try {
            if (sender.tab?.id) {
                const turnstile =
                    typeof request.bodyStr === 'string'
                        ? (() => {
                              try {
                                  return JSON.parse(request.bodyStr).t || '';
                              } catch {
                                  return '';
                              }
                          })()
                        : '';
                chrome.scripting.executeScript({
                    target: { tabId: sender.tab.id },
                    world: 'MAIN',
                    func: (tValue) => {
                        (async () => {
                            try {
                                const backend = 'https://backend.wplace.live';

                                const findPawtectChunk = async () => {
                                    if (typeof window.__wplacerPawtectChunk === 'string' && window.__wplacerPawtectChunk) {
                                        return window.__wplacerPawtectChunk;
                                    }

                                    const cacheKey = 'wplacer_pawtect_chunk';
                                    const cacheTimeKey = 'wplacer_pawtect_chunk_ts';
                                    const cacheExpiry = 5 * 60 * 1000;

                                    try {
                                        const cached = localStorage.getItem(cacheKey);
                                        const cacheTime = localStorage.getItem(cacheTimeKey);
                                        const ts = cacheTime ? parseInt(cacheTime, 10) : NaN;
                                        if (cached && Number.isFinite(ts) && Date.now() - ts < cacheExpiry) {
                                            window.__wplacerPawtectChunk = cached;
                                            return cached;
                                        }
                                    } catch {}

                                    const links = Array.from(
                                        document.querySelectorAll('link[rel="modulepreload"][href$=".js"]')
                                    ).map((l) => l.getAttribute('href')).filter(Boolean);

                                    for (const href of links) {
                                        try {
                                            const absolute = new URL(href, location.origin);
                                            const res = await fetch(absolute.href);
                                            const text = await res.text();
                                            if (text.includes('get_pawtected_endpoint_payload')) {
                                                const chunkPath = absolute.pathname;
                                                window.__wplacerPawtectChunk = chunkPath;
                                                try {
                                                    localStorage.setItem(cacheKey, chunkPath);
                                                    localStorage.setItem(cacheTimeKey, Date.now().toString());
                                                } catch {}
                                                return chunkPath;
                                            }
                                        } catch {}
                                    }

                                    return null;
                                };

                                const chunkPath = await findPawtectChunk();
                                if (!chunkPath) return;

                                const pawtectPath = new URL(chunkPath, location.origin).href;

                                const mod = await import(pawtectPath);
                                const wasm = await mod._();

                                const findSetUserIdFunction = (mod) => {
                                    for (const key of Object.keys(mod)) {
                                        const fn = mod[key];
                                        if (typeof fn === 'function') {
                                            try {
                                                const str = fn.toString();
                                                if (/[\w$]+\s*\.\s*set_user_id\s*\(/.test(str)) {
                                                    return fn;
                                                }
                                            } catch {}
                                        }
                                    }
                                    return null;
                                };

                                try {
                                    const me = await fetch(`${backend}/me`, { credentials: 'include' }).then((r) =>
                                        r.ok ? r.json() : null
                                    );
                                    if (me?.id) {
                                        const setUserIdFn = findSetUserIdFunction(mod);
                                        if (setUserIdFn) setUserIdFn(me.id);
                                    }
                                } catch {}
                                const url = `${backend}/s0/pixel/1/1`;
                                if (typeof mod.r === 'function') mod.r(url);
                                const fp =
                                    (window.wplacerFP && String(window.wplacerFP)) ||
                                    (() => {
                                        const b = new Uint8Array(16);
                                        crypto.getRandomValues(b);
                                        return Array.from(b)
                                            .map((x) => x.toString(16).padStart(2, '0'))
                                            .join('');
                                    })();
                                const rx = Math.floor(Math.random() * 1000);
                                const ry = Math.floor(Math.random() * 1000);
                                const bodyObj = { colors: [0], coords: [rx, ry], fp, t: String(tValue || '') };
                                const rawBody = JSON.stringify(bodyObj);
                                const enc = new TextEncoder();
                                const dec = new TextDecoder();
                                const bytes = enc.encode(rawBody);
                                const inPtr = wasm.__wbindgen_malloc(bytes.length, 1);
                                new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);
                                const out = wasm.get_pawtected_endpoint_payload(inPtr, bytes.length);
                                let token;
                                if (Array.isArray(out)) {
                                    const [outPtr, outLen] = out;
                                    token = dec.decode(new Uint8Array(wasm.memory.buffer, outPtr, outLen));
                                    try {
                                        wasm.__wbindgen_free(outPtr, outLen, 1);
                                    } catch {}
                                } else if (typeof out === 'string') {
                                    token = out;
                                } else if (out && typeof out.ptr === 'number' && typeof out.len === 'number') {
                                    token = dec.decode(new Uint8Array(wasm.memory.buffer, out.ptr, out.len));
                                    try {
                                        wasm.__wbindgen_free(out.ptr, out.len, 1);
                                    } catch {}
                                }
                                window.postMessage({ type: 'WPLACER_PAWTECT_TOKEN', token, origin: 'simple' }, '*');
                            } catch {}
                        })();
                    },
                    args: [turnstile],
                });
            }
        } catch {}
        sendResponse({ ok: true });
        return true; // async
    }

    if (request.action === 'quickLogout') {
        quickLogout(sendResponse);
        return true; // async
    }

    if (request.type === 'SEND_TOKEN') {
        getServerUrl('/t').then((url) => {
            fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    t: request.token,
                    pawtect: request.pawtect || null,
                    fp: request.fp || null,
                }),
            });
        });
        clearTokenWait();
        LAST_RELOAD_AT = Date.now();
    }

    return false;
});

/**
 * Tab lifecycle handler: on wplace.live loads, pre-inject Pawtect and sync cookie.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    try {
        if (tab.url?.startsWith('https://wplace.live')) {
            if (changeInfo.status === 'loading') {
                // Preinstall pawtect early
                injectPawtectIntoTab(tabId).catch(() => {});
            }
            if (changeInfo.status === 'complete') {
                console.log('wplacer: wplace.live tab loaded. Sending cookie.');
                injectPawtectIntoTab(tabId).catch(() => {});
                sendCookie((response) =>
                    console.log(`wplacer: Cookie send status: ${response.success ? 'Success' : 'Failed'}`)
                );
            }
        }
    } catch {}
});

/**
 * Alarm dispatcher for polling, cookie refresh, safety refresh, token timeout backup,
 * and optional user-configured auto-reload.
 */
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === COOKIE_ALARM_NAME) {
        console.log('wplacer: Periodic alarm triggered. Sending cookie.');
        sendCookie((response) =>
            console.log(`wplacer: Periodic cookie refresh: ${response.success ? 'Success' : 'Failed'}`)
        );
        return;
    }
    if (alarm.name === POLL_ALARM_NAME) {
        if (!LP_ACTIVE) startLongPoll();
        pollForTokenRequest();
        return;
    }
    if (alarm.name === SAFETY_REFRESH_ALARM_NAME) {
        // Safety net: force refresh wplace tabs every ~45s if not already refreshing
        (async () => {
            try {
                if (TOKEN_IN_PROGRESS) return;
                const now = Date.now();
                if (now - LAST_RELOAD_AT < 45000) return;
                const tabs = await chrome.tabs.query({ url: 'https://wplace.live/*' });
                for (const tab of tabs || []) {
                    try {
                        await injectPawtectIntoTab(tab.id);
                        await chrome.tabs.reload(tab.id, { bypassCache: true });
                    } catch {}
                }
                LAST_RELOAD_AT = Date.now();
            } catch {}
        })();
        return;
    }
    if (alarm.name === TOKEN_TIMEOUT_ALARM_NAME) {
        // Backup timeout: if still waiting, retry (wrap in async IIFE)
        (async () => {
            try {
                if (!TOKEN_IN_PROGRESS) return;
                const now = Date.now();
                if (now - LAST_RELOAD_AT < 45000) return; // already retried recently
                console.warn('wplacer: token wait backup alarm fired, retrying...');
                clearTokenWait();
                await maybeInitiateReload();
            } catch {}
        })();
        return;
    }
    if (alarm.name === AUTO_RELOAD_ALARM_NAME) {
        performAutoReload();
    }
});

/**
 * Initializes recurring alarms: polling, cookie refresh, safety refresh,
 * and user-configured auto-reload.
 * @returns {Promise<void>}
 */
const initializeAlarms = async () => {
    try {
        await chrome.alarms.create(POLL_ALARM_NAME, {
            delayInMinutes: 0.1,
            periodInMinutes: 0.75,
        });
        await chrome.alarms.create(COOKIE_ALARM_NAME, {
            delayInMinutes: 1,
            periodInMinutes: 20,
        });
        await chrome.alarms.create(SAFETY_REFRESH_ALARM_NAME, {
            delayInMinutes: 1,
            periodInMinutes: 1,
        });
        await updateAutoReloadAlarm();
        console.log('wplacer: Alarms initialized.');
    } catch (e) {
        console.error('wplacer: Failed to initialize alarms', e);
    }
};

/** Bootstrap on browser startup/extension install */
chrome.runtime.onStartup.addListener(() => {
    console.log('wplacer: Browser startup.');
    initializeAlarms();
    startLongPoll();
});

chrome.runtime.onInstalled.addListener(() => {
    console.log('wplacer: Extension installed/updated.');
    initializeAlarms();
    startLongPoll();
});

/** Ensure long-polling is active after cold start */
startLongPoll();

/**
 * Keeps the service worker alive with a periodic no-op.
 * MV3 workers can be suspended; this helps amortize wakeups.
 */
setInterval(() => {
    try {
        /* noop tick */
    } catch {}
}, 30 * 1000);
