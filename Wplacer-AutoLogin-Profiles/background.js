/**
 * @fileoverview Auto-login & cookie relay for WPlace.
 *
 * Responsibilities:
 * - Detect presence of "j" (and optional "s") cookies on wplace.live and backend.wplace.live.
 * - Display auth status overlay in the active WPlace tab.
 * - Forward tokens to a local HTTP server (127.0.0.1:{port}/user) on triggers and intervals.
 * - Provide manual controls via content-script messages.
 *
 * Security & Privacy:
 * - Token prints are truncated only in page console; full values stay inside overlay message payloads intentionally.
 * - Storage writes are minimal (pending token + metadata).
 * - "Logout" blocks the tab from repopulating auth until explicitly refreshed.
 */

/** @constant {string} */
const WPLACE_DOMAIN = 'wplace.live';
/** @constant {string} */
const WPLACE_URL = 'https://wplace.live/';
/** @constant {string} */
const BACKEND_ORIGIN = 'https://backend.wplace.live';
/** @constant {string} */
const COOKIE_NAME = 'j';
/** @constant {string} */
const COOKIE_S_NAME = 's';

/** Tabs explicitly blocked after logout to prevent re-population. */
const blockedTabs = new Set();
/** Dedup: last token logged per tabId. */
const lastLoggedCookieByTab = new Map();

/**
 * Safely send an overlay message to a tab.
 * @param {number} tabId
 * @param {object} payload
 * @returns {void}
 */
function sendOverlay(tabId, payload) {
    try {
        chrome.tabs.sendMessage(tabId, { type: 'wplace:overlay', show: true, ...payload });
    } catch {}
}

/**
 * Execute a console.log in page context (MAIN world), best-effort.
 * @param {number} tabId
 * @param {string} label
 * @param {string} text
 * @returns {void}
 */
function logInPage(tabId, label, text) {
    try {
        chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (lbl, txt) => {
                try {
                    console.log(`[${lbl}]`, txt);
                } catch {}
            },
            args: [label, String(text || '')],
        });
    } catch {}
}

/**
 * True if the given tabId is currently blocked (post logout).
 * @param {number} tabId
 * @returns {boolean}
 */
function isBlockedTab(tabId) {
    try {
        return blockedTabs.has(tabId);
    } catch {
        return false;
    }
}

/**
 * Persist a pending token into local storage so content can read it on load.
 * @param {string|null|undefined} token
 * @param {number|null|undefined} expirationDate
 * @returns {void}
 */
function setPendingToken(token, expirationDate) {
    try {
        chrome.storage.local.set({
            wplacerPendingToken: String(token || ''),
            wplacerPendingExp: expirationDate || null,
            wplacerPendingTs: Date.now(),
        });
    } catch {}
}

/**
 * Get a cookie by URL and name as a Promise.
 * @param {string} url
 * @param {string} name
 * @returns {Promise<chrome.cookies.Cookie|null>}
 */
function getCookieBy(url, name) {
    return new Promise((resolve) => {
        try {
            chrome.cookies.get({ url, name }, (c) => resolve(c || null));
        } catch {
            resolve(null);
        }
    });
}

/**
 * Get "j" cookie from the primary front URL.
 * @returns {Promise<chrome.cookies.Cookie|null>}
 */
async function getCookieJ() {
    console.log('[AUTO-LOGIN EXTENSION] getCookieJ: querying cookie', COOKIE_NAME, 'for', WPLACE_URL);
    try {
        const cookie = await getCookieBy(WPLACE_URL, COOKIE_NAME);
        console.log('[AUTO-LOGIN EXTENSION] getCookieJ: result:', !!cookie);
        return cookie;
    } catch (e) {
        console.warn('[AUTO-LOGIN EXTENSION] getCookieJ: error:', e?.message || e);
        return null;
    }
}

/**
 * Get "j" cookie from backend first, then front; returns first match.
 * @returns {Promise<chrome.cookies.Cookie|null>}
 */
async function getCookieJAny() {
    try {
        const backend = await getCookieBy(BACKEND_ORIGIN + '/', COOKIE_NAME);
        if (backend?.value) return backend;
    } catch {}
    try {
        const front = await getCookieBy(WPLACE_URL, COOKIE_NAME);
        if (front?.value) return front;
    } catch {}
    return null;
}

/**
 * Compute local server URL based on stored port (default 80).
 * @param {string} [path=""]
 * @returns {Promise<string>}
 */
async function getLocalServerUrl(path = '') {
    try {
        const { wplacerPort } = await chrome.storage.local.get(['wplacerPort']);
        const port = wplacerPort || 80;
        return `http://127.0.0.1:${port}${path}`;
    } catch {
        return `http://127.0.0.1:80${path}`;
    }
}

/**
 * POST cookies and metadata to local server endpoint /user.
 * @param {string} jValue
 * @param {string|null} sValue
 * @param {number|null} expirationDate
 * @returns {Promise<number>} HTTP status code or 0 on failure.
 */
async function sendCookieToLocalServer(jValue, sValue, expirationDate) {
    try {
        const url = await getLocalServerUrl('/user');
        const meta = await (async () => {
            try {
                const { profileName, profilePath } = await chrome.storage.local.get(['profileName', 'profilePath']);
                return { profileName: profileName || null, profilePath: profilePath || null };
            } catch {
                return { profileName: null, profilePath: null };
            }
        })();

        /** @type {{ cookies: { j: string; s?: string }, expirationDate: number|null, profileName: string|null, profilePath: string|null }} */
        const body = { cookies: { j: jValue }, expirationDate, ...meta };
        if (sValue) body.cookies.s = sValue;

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return res.status;
    } catch (e) {
        console.warn('[AUTO-LOGIN EXTENSION] sendCookieToLocalServer failed', e?.message || e);
        return 0;
    }
}

/**
 * Send token to local server; logs into page, updates overlay with send status.
 * @param {number} tabId
 * @param {string} token
 * @param {number|null} expirationDate
 * @returns {Promise<number>} HTTP status code or 0 on failure.
 */
async function sendTokenToServer(tabId, token, expirationDate) {
    if (!token) return 0;
    let status = 0;
    try {
        const s = await getCookieBy(BACKEND_ORIGIN + '/', COOKIE_S_NAME);
        status = await sendCookieToLocalServer(token, s?.value || null, expirationDate || null);
        logInPage(tabId, 'J TOKEN SEND', `status=${status} ${token ? token.slice(0, 16) + '…' : ''}`);
    } catch (e) {
        logInPage(tabId, 'J TOKEN SEND ERROR', String(e?.message || 'ERR'));
    }
    try {
        const ok = status >= 200 && status < 300;
        sendOverlay(tabId, {
            text: ok ? 'Authorized' : 'Send failed',
            auth: ok ? 'Authorized' : 'Not authorized',
            send: ok ? 'Success' : 'Failed',
            token,
            tokenFull: token,
        });
    } catch {}
    return status;
}

/**
 * Push full-token info to page (console + overlay) and kick a best-effort send.
 * Respects blockedTabs; also stores pending token for content read.
 * @param {number} tabId
 * @param {string} value
 * @returns {void}
 */
function postLogCookieToTab(tabId, value) {
    try {
        if (isBlockedTab(tabId)) return;
        setPendingToken(value, null);
        logInPage(tabId, 'J COOKIE', String(value || ''));
        sendOverlay(tabId, { text: 'Authorized', auth: 'Authorized', token: String(value), tokenFull: String(value) });
        try {
            sendTokenToServer(tabId, value, null);
        } catch {}
    } catch (e) {
        console.warn('[AUTO-LOGIN EXTENSION] postLogCookieToTab: execScript failed', e?.message || e);
        try {
            chrome.tabs.sendMessage(tabId, { type: 'wplace:log-j', value });
        } catch {}
    }
}

/**
 * Await the presence of cookie "j" with a timeout. Listens for abort messages.
 * @param {number} [timeoutMs=180000]
 * @returns {Promise<chrome.cookies.Cookie|null>}
 */
async function waitForCookie(timeoutMs = 180000) {
    console.log('[AUTO-LOGIN EXTENSION] waitForCookie: start, timeoutMs=', timeoutMs);
    const start = Date.now();
    let aborted = false;

    /** @param {any} msg */
    const onAbort = (msg) => {
        if (msg && msg.type === 'wplace:abort') {
            aborted = true;
            console.warn('[AUTO-LOGIN EXTENSION] waitForCookie: abort signal received:', msg.reason);
        }
    };
    chrome.runtime.onMessage.addListener(onAbort);

    try {
        while (Date.now() - start < timeoutMs) {
            if (aborted) {
                return null;
            }
            const cookie = await getCookieJ();
            if (cookie?.value) {
                console.log('[AUTO-LOGIN EXTENSION] waitForCookie: cookie found');
                return cookie;
            }
            await new Promise((r) => setTimeout(r, 500));
            const elapsed = Date.now() - start;
            if (elapsed % 5000 < 600) {
                console.log('[AUTO-LOGIN EXTENSION] waitForCookie: still waiting...', Math.floor(elapsed / 1000), 's');
            }
        }
        console.warn('[AUTO-LOGIN EXTENSION] waitForCookie: timeout');
        return null;
    } finally {
        try {
            chrome.runtime.onMessage.removeListener(onAbort);
        } catch {}
    }
}

/**
 * Ensure the user is logged in on an existing WPlace tab.
 * - Prefers the provided tabId if it is a WPlace tab; otherwise picks any open WPlace tab.
 * - Does not create new tabs.
 * - Triggers content-script flow and waits for "j" cookie.
 * @param {number} [triggerTabId]
 * @returns {Promise<{status: 'already'|'no_tab'|'ok'}|{status: 'ok', cookie: string}>}
 * @throws {"cookie_not_set"} when no cookie is found after waiting.
 */
async function ensureLoggedIn(triggerTabId) {
    console.log('[AUTO-LOGIN EXTENSION] ensureLoggedIn: invoked, triggerTabId=', triggerTabId);
    const existing = await getCookieJ();
    if (existing?.value) {
        console.log('[AUTO-LOGIN EXTENSION] ensureLoggedIn: already logged in');
        return { status: 'already' };
    }

    /** @param {string} url */
    function isWplace(url) {
        try {
            const u = new URL(url);
            return u.hostname.endsWith(WPLACE_DOMAIN);
        } catch {
            return false;
        }
    }

    // Determine target WPlace tab
    const targetTab = await new Promise((resolve) => {
        if (typeof triggerTabId === 'number') {
            chrome.tabs.get(triggerTabId, (tab) => {
                if (tab && tab.url && isWplace(tab.url)) resolve(tab);
                else resolve(null);
            });
        } else resolve(null);
    });

    let wplaceTab = targetTab;
    if (!wplaceTab) {
        wplaceTab = await new Promise((resolve) => {
            chrome.tabs.query({}, (tabs) => {
                const found = (tabs || []).find((t) => t.url && isWplace(t.url));
                resolve(found || null);
            });
        });
    }

    if (!wplaceTab) {
        console.warn(
            '[AUTO-LOGIN EXTENSION] ensureLoggedIn: no wplace tab found; aborting (no new tab will be created)'
        );
        return { status: 'no_tab' };
    }

    console.log('[AUTO-LOGIN EXTENSION] ensureLoggedIn: triggering content flow in tab', wplaceTab.id);
    try {
        await new Promise((r) => setTimeout(r, 500));
        await new Promise((resolve) => {
            chrome.tabs.sendMessage(wplaceTab.id, { type: 'wplace:start' }, (resp) => {
                const err = chrome.runtime.lastError;
                if (err) console.warn('[AUTO-LOGIN EXTENSION] ensureLoggedIn: sendMessage error:', err.message);
                else console.log('[AUTO-LOGIN EXTENSION] ensureLoggedIn: content response:', resp);
                resolve();
            });
        });
    } catch {}

    // Light navigation observer (log-only)
    const onUpdated = (tabId, changeInfo) => {
        if (!wplaceTab || tabId !== wplaceTab.id) return;
        if (changeInfo.url && changeInfo.url.startsWith('https://')) {
            console.log('[AUTO-LOGIN EXTENSION] onUpdated: tab navigated:', changeInfo.url);
        }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);

    const cookie = await waitForCookie();
    try {
        chrome.tabs.onUpdated.removeListener(onUpdated);
    } catch {}

    if (cookie?.value) {
        try {
            const reloadId = (wplaceTab && wplaceTab.id) || triggerTabId;
            if (typeof reloadId === 'number') {
                console.log('[AUTO-LOGIN EXTENSION] ensureLoggedIn: reloading tab', reloadId);
                chrome.tabs.reload(reloadId);
            }
        } catch {}
        return { status: 'ok', cookie: cookie.value };
    }
    console.warn('[AUTO-LOGIN EXTENSION] ensureLoggedIn: cookie not set after waiting');
    throw new Error('cookie_not_set');
}

/**
 * Try to focus an existing tab that matches the target URL (no tab creation).
 * @param {string} targetUrl
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
function openOrActivateTab(targetUrl) {
    console.log('[AUTO-LOGIN EXTENSION] openOrActivateTab:', targetUrl);
    return new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) => {
            const existing = (tabs || []).find((t) => t.url && t.url.startsWith(targetUrl));
            if (existing) {
                console.log('[AUTO-LOGIN EXTENSION] openOrActivateTab: activating existing tab', existing.id);
                chrome.tabs.update(existing.id, { active: true }, (tab) => resolve(tab));
            } else {
                console.log(
                    '[AUTO-LOGIN EXTENSION] openOrActivateTab: no existing tab found; will not create new tab (stay in same window)'
                );
                resolve(null);
            }
        });
    });
}

/* ------------------------- Runtime Listeners ------------------------- */

/** React to early "abort" signals from content: try to print cookie if present. */
chrome.runtime.onMessage.addListener((msg, sender) => {
    try {
        if (msg && msg.type === 'wplace:abort' && sender && sender.tab && typeof sender.tab.id === 'number') {
            (async () => {
                try {
                    const c = await getCookieJAny();
                    if (c?.value) {
                        console.log(
                            '[AUTO-LOGIN EXTENSION] onMessage: abort received, j cookie present; logging to page'
                        );
                        postLogCookieToTab(sender.tab.id, c.value);
                    } else {
                        console.log('[AUTO-LOGIN EXTENSION] onMessage: abort received, j cookie not found');
                    }
                } catch {}
            })();
        }
    } catch {}
});

/** Toolbar install: schedule periodic auth checks and trigger initial send. */
chrome.runtime.onInstalled.addListener(() => {
    console.log('[AUTO-LOGIN EXTENSION] onInstalled: creating periodic alarm');
    chrome.alarms.create('wplace-check', { periodInMinutes: 5 });
    setTimeout(() => {
        try {
            attemptInitialSendOnce();
        } catch {}
    }, 500);
});

/** Alarm tick: background auth check. */
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== 'wplace-check') return;
    console.log('[AUTO-LOGIN EXTENSION] onAlarm: wplace-check fired');
    try {
        await ensureLoggedIn();
    } catch (e) {
        console.warn('[AUTO-LOGIN EXTENSION] onAlarm: ensureLoggedIn error:', e?.message || e);
    }
});

/** Tab navigation observer: auth overlay + token propagation. */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (!tab?.url) return;
    let urlObj;
    try {
        urlObj = new URL(tab.url);
    } catch {
        return;
    }
    if (!urlObj.hostname.endsWith(WPLACE_DOMAIN)) return;

    if (changeInfo.status === 'loading') {
        try {
            blockedTabs.delete(tabId);
        } catch {}
        sendOverlay(tabId, { text: 'Checking auth…', auth: 'Unknown' });
        try {
            const c0 = await getCookieJAny();
            if (c0?.value) {
                setPendingToken(c0.value, c0.expirationDate);
                postLogCookieToTab(tabId, c0.value);
            }
        } catch {}
        return;
    }

    if (changeInfo.status === 'complete') {
        try {
            console.log('[AUTO-LOGIN EXTENSION] tabs.onUpdated: wplace tab completed, tabId=', tabId);
            sendOverlay(tabId, { text: 'Checking auth…', auth: 'Unknown' });
            try {
                await ensureLoggedIn(tabId);
            } catch (e) {
                console.warn('[AUTO-LOGIN EXTENSION] tabs.onUpdated: ensureLoggedIn error:', e?.message || e);
            }

            const start = Date.now();
            let sent = false;
            while (Date.now() - start < 5000) {
                try {
                    const c = await getCookieJAny();
                    if (c?.value) {
                        setPendingToken(c.value, c.expirationDate);
                        postLogCookieToTab(tabId, c.value);
                        await sendTokenToServer(tabId, c.value, c.expirationDate);
                        sent = true;
                        break;
                    }
                } catch {}
                await new Promise((r) => setTimeout(r, 250));
            }
            if (!sent) {
                try {
                    const c = await getCookieJAny();
                    if (c?.value) {
                        setPendingToken(c.value, c.expirationDate);
                        postLogCookieToTab(tabId, c.value);
                        await sendTokenToServer(tabId, c.value, c.expirationDate);
                    } else {
                        sendOverlay(tabId, { text: 'Not authorized', auth: 'Not authorized' });
                    }
                } catch {}
            }
        } catch {}
    }
});

/** Periodic cookie logger every 5s across all WPlace tabs (dedup per tab). */
setInterval(async () => {
    try {
        const tabs = await new Promise((resolve) => chrome.tabs.query({}, resolve));
        for (const t of tabs || []) {
            try {
                if (!t.url) continue;
                const u = new URL(t.url);
                if (!u.hostname.endsWith(WPLACE_DOMAIN)) continue;
                const c = await getCookieJAny();
                if (c?.value) {
                    const prev = lastLoggedCookieByTab.get(t.id);
                    if (prev !== c.value) {
                        console.log('[AUTO-LOGIN EXTENSION] periodic cookie log for tab', t.id);
                        postLogCookieToTab(t.id, c.value);
                        lastLoggedCookieByTab.set(t.id, c.value);
                    }
                } else {
                    sendOverlay(t.id, { text: 'Not authorized', auth: 'Not authorized' });
                }
            } catch {}
        }
    } catch {}
}, 5000);

/**
 * Handle manual actions triggered from content script (overlay buttons, settings).
 * Supported types:
 *  - wplace:sync
 *  - wplace:set-port
 *  - wplace:logout
 *  - wplace:set-profile
 *  - wplace:manual-refresh
 *  - wplace:manual-send
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
        const tabId = sender && sender.tab && sender.tab.id;
        if (!msg || typeof tabId !== 'number') return;

        // wplace:sync — refresh overlay/token from current cookie if available
        if (msg.type === 'wplace:sync') {
            (async () => {
                try {
                    if (isBlockedTab(tabId)) {
                        const { wplacerPendingToken } = await chrome.storage.local.get(['wplacerPendingToken']);
                        if (!wplacerPendingToken) blockedTabs.delete(tabId);
                    }
                    if (isBlockedTab(tabId)) {
                        sendOverlay(tabId, {
                            text: 'Not authorized',
                            auth: 'Not authorized',
                            token: '-',
                            tokenFull: '-',
                        });
                    } else {
                        const c = await getCookieJAny();
                        if (c?.value) {
                            setPendingToken(c.value, c.expirationDate);
                            postLogCookieToTab(tabId, c.value);
                        } else {
                            sendOverlay(tabId, { text: 'Not authorized', auth: 'Not authorized' });
                        }
                    }
                } catch {}
                try {
                    sendResponse && sendResponse({ ok: true });
                } catch {}
            })();
            return true;
        }

        // wplace:set-port — persist local server port (validated)
        if (msg.type === 'wplace:set-port') {
            (async () => {
                try {
                    const port = typeof msg.port === 'number' && msg.port > 0 && msg.port <= 65535 ? msg.port : 80;
                    await chrome.storage.local.set({ wplacerPort: port });
                    try {
                        sendResponse && sendResponse({ ok: true, port });
                    } catch {}
                } catch {
                    try {
                        sendResponse && sendResponse({ ok: false });
                    } catch {}
                }
            })();
            return true;
        }

        // wplace:logout — block this tab, clear storage (except profileName), show not authorized
        if (msg.type === 'wplace:logout') {
            (async () => {
                try {
                    blockedTabs.add(tabId);
                    try {
                        const all = await chrome.storage.local.get(null);
                        const keys = Object.keys(all || {}).filter((k) => k !== 'profileName');
                        if (keys.length > 0) await chrome.storage.local.remove(keys);
                    } catch {}
                    try {
                        lastLoggedCookieByTab.delete(tabId);
                    } catch {}
                } catch {}
                try {
                    sendOverlay(tabId, { text: 'Not authorized', auth: 'Not authorized', token: '-', tokenFull: '-' });
                } catch {}
                try {
                    sendResponse && sendResponse({ ok: true });
                } catch {}
            })();
            return true;
        }

        // wplace:set-profile — seed or set profileName; returns merged values
        if (msg.type === 'wplace:set-profile') {
            (async () => {
                try {
                    const incomingName = typeof msg.profileName === 'string' ? msg.profileName.trim() : '';
                    const isSeed = !!msg.isSeed;
                    const current = await chrome.storage.local.get(['profileName']);
                    /** @type {Record<string, any>} */
                    let toSave = {};
                    if (isSeed) {
                        if (!current.profileName && incomingName) toSave.profileName = incomingName;
                    } else {
                        if (typeof msg.profileName !== 'undefined') toSave.profileName = incomingName;
                    }
                    if (Object.keys(toSave).length > 0) await chrome.storage.local.set(toSave);
                    try {
                        sendResponse && sendResponse({ ok: true, ...current, ...toSave });
                    } catch {}
                } catch {
                    try {
                        sendResponse && sendResponse({ ok: false });
                    } catch {}
                }
            })();
            return true;
        }

        // wplace:manual-refresh — re-check cookie, ensure login, send token
        if (msg.type === 'wplace:manual-refresh') {
            (async () => {
                sendOverlay(tabId, { text: 'Refreshing…' });
                try {
                    const c0 = await getCookieJAny();
                    if (c0?.value) postLogCookieToTab(tabId, c0.value);
                } catch {}
                try {
                    await ensureLoggedIn(tabId);
                } catch {}
                try {
                    const c = await getCookieJAny();
                    if (c?.value) {
                        setPendingToken(c.value, c.expirationDate);
                        postLogCookieToTab(tabId, c.value);
                        await sendTokenToServer(tabId, c.value, c.expirationDate);
                    } else {
                        sendOverlay(tabId, { text: 'Not authorized', auth: 'Not authorized' });
                    }
                } catch {}
                try {
                    sendResponse && sendResponse({ ok: true });
                } catch {}
            })();
            return true;
        }

        // wplace:manual-send — send provided token or current cookie to local server
        if (msg.type === 'wplace:manual-send') {
            (async () => {
                sendOverlay(tabId, { text: 'Sending…', send: 'Sending…' });
                let status = 0;
                try {
                    const providedToken = typeof msg.token === 'string' && msg.token.trim() ? msg.token.trim() : null;
                    if (providedToken) {
                        setPendingToken(providedToken, null);
                        status = await sendTokenToServer(tabId, providedToken, null);
                    } else {
                        const j = await getCookieBy(BACKEND_ORIGIN + '/', COOKIE_NAME);
                        if (j?.value) {
                            setPendingToken(j.value, j.expirationDate);
                            status = await sendTokenToServer(tabId, j.value, j.expirationDate);
                        }
                    }
                } catch (e) {
                    console.warn('[AUTO-LOGIN EXTENSION] manual-send failed', e?.message || e);
                    logInPage(tabId, 'J TOKEN SEND ERROR', String(e?.message || 'ERR'));
                }
                try {
                    const ok = status >= 200 && status < 300;
                    sendOverlay(tabId, {
                        text: ok ? 'Authorized' : 'Send failed',
                        auth: ok ? 'Authorized' : 'Not authorized',
                        send: ok ? 'Success' : 'Failed',
                    });
                } catch {}
                try {
                    sendResponse && sendResponse({ ok: true, status });
                } catch {}
            })();
            return true;
        }
    } catch {}
});

/* ---------------------- One-time initial dispatch -------------------- */

let initialSendDone = false;
/**
 * One-time token discovery & send after SW loads.
 * @returns {Promise<void>}
 */
async function attemptInitialSendOnce() {
    if (initialSendDone) return;
    initialSendDone = true;
    try {
        const tabs = await new Promise((resolve) => chrome.tabs.query({}, resolve));
        for (const t of tabs || []) {
            try {
                if (!t.url) continue;
                const u = new URL(t.url);
                if (!u.hostname.endsWith(WPLACE_DOMAIN)) continue;
                const j = await getCookieJAny();
                if (j?.value) {
                    setPendingToken(j.value, j.expirationDate);
                    postLogCookieToTab(t.id, j.value);
                    await sendTokenToServer(t.id, j.value, j.expirationDate);
                }
            } catch {}
        }
    } catch {}
}
setTimeout(() => {
    try {
        attemptInitialSendOnce();
    } catch {}
}, 700);

/* ---------------------- Toolbar action handler ----------------------- */

/**
 * Toolbar click: attempt login flow on current tab.
 */
chrome.action.onClicked.addListener(async (tab) => {
    try {
        const res = await ensureLoggedIn(tab?.id);
        console.log('[AUTO-LOGIN EXTENSION] action.onClicked: result:', res);
    } catch (e) {
        console.warn('[AUTO-LOGIN EXTENSION] action.onClicked: error:', e?.message || e);
    }
});

/* -------------------------- Tab cleanup ------------------------------ */

chrome.tabs.onRemoved.addListener((tabId) => {
    try {
        lastLoggedCookieByTab.delete(tabId);
    } catch {}
    try {
        blockedTabs.delete(tabId);
    } catch {}
});
