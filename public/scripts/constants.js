/**
 * @fileoverview Global constants used across wplacer's front-end scripts.
 * Keeping shared keys here avoids scattering magic strings around individual
 * feature modules and simplifies maintenance.
 */

window.WPLACER_CONSTANTS = Object.freeze({
    PINNED_TEMPLATES_STORAGE_KEY: 'wplacer_pinned_templates_v1',
    FLAGS_CACHE_STORAGE_KEY: 'wplacer_flags_cache_v1',
    LAST_STATUS_STORAGE_KEY: 'wplacer_latest_user_status',
    LAST_TOTALS_STORAGE_KEY: 'wplacer_latest_totals_v1',
    DISCLAIMER_STORAGE_KEY: 'wplacer_disclaimer_ack_v1',
    CHANGELOG_ACK_STORAGE_KEY: 'wplacer_ack_version',
    COLORS_CACHE_STORAGE_KEY: 'wplacer_colors_cache_v1',
});
