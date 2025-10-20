/*
 * Legacy extension state shim. The modern dashboard handles state inlined in
 * index.js, but older front-end widgets still attempt to fetch this file.
 */
window.wplacerExtensionState = window.wplacerExtensionState || {};
console.info('wplacer: extensionState.js placeholder applied');
