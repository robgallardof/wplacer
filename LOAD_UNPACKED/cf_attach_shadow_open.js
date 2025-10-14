/**
 * Force every call to Element#attachShadow to use `{ mode: "open" }`.
 *
 * Why:
 * - Guarantees access to shadow roots that would otherwise be `closed`.
 *
 * Notes:
 * - Idempotent: running it multiple times will not stack patches.
 * - Safe: preserves other init options (e.g., `delegatesFocus`) and does not mutate caller input.
 * - Revertible: call `forceOpenAttachShadow.restore()` to restore the native behavior.
 */
const forceOpenAttachShadow = (() => {
  /** Symbol key to stash the original function without leaking a global name. */
  const KEY = Symbol.for('wplacer.attachShadow.original');

  /**
   * Patch installer. No-op if `attachShadow` is missing or already patched.
   */
  function install() {
    const proto = Element.prototype;
    const original = proto.attachShadow;

    if (typeof original !== 'function') return;                         // Nothing to patch
    if (original[KEY]) return;                                          // Already patched

    const patched = function attachShadowPatched(init) {
      // Ensure we don’t throw on non-object/undefined input and avoid mutating the caller’s object
      const base = (init && typeof init === 'object') ? init : {};
      const next = Object.assign({}, base, { mode: 'open' });           // force open, preserve other fields
      return Reflect.apply(original, this, [next]);
    };

    // Mark the patch and remember the original
    Object.defineProperty(patched, KEY, { value: original });

    // Preserve descriptor shape if possible (writable/configurable/enumerable)
    const desc = Object.getOwnPropertyDescriptor(proto, 'attachShadow');
    try {
      Object.defineProperty(proto, 'attachShadow', {
        ...desc,
        value: patched
      });
    } catch {
      // Fallback for environments that don’t allow redefining the descriptor cleanly
      proto.attachShadow = patched;
    }
  }

  /**
   * Restore the native Element#attachShadow if it was patched.
   */
  function restore() {
    const proto = Element.prototype;
    const current = proto.attachShadow;
    const original = current && current[Symbol.for('wplacer.attachShadow.original')];
    if (!original) return;

    const desc = Object.getOwnPropertyDescriptor(proto, 'attachShadow');
    try {
      Object.defineProperty(proto, 'attachShadow', {
        ...desc,
        value: original
      });
    } catch {
      proto.attachShadow = original;
    }
  }

  // Install immediately
  install();

  // Public API
  return { restore };
})();
