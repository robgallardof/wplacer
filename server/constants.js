/**
 * @fileoverview Shared configuration constants for the wplacer server runtime.
 * Centralising file-system paths and palette definitions keeps server.js focused
 * on request handling responsibilities.
 */

import path from 'node:path';

export const DATA_DIR = './data';
export const HEAT_MAPS_DIR = path.join(DATA_DIR, 'heat_maps');
export const BACKUPS_ROOT_DIR = path.join(DATA_DIR, 'backups');
export const USERS_BACKUPS_DIR = path.join(BACKUPS_ROOT_DIR, 'users');
export const PROXIES_BACKUPS_DIR = path.join(BACKUPS_ROOT_DIR, 'proxies');

export const RECENT_LOGS_LIMIT = 5000;

export const BASIC_COLORS = {
    '0,0,0': 1,
    '60,60,60': 2,
    '120,120,120': 3,
    '210,210,210': 4,
    '255,255,255': 5,
    '96,0,24': 6,
    '237,28,36': 7,
    '255,127,39': 8,
    '246,170,9': 9,
    '249,221,59': 10,
    '255,250,188': 11,
    '14,185,104': 12,
    '19,230,123': 13,
    '135,255,94': 14,
    '12,129,110': 15,
    '16,174,166': 16,
    '19,225,190': 17,
    '40,80,158': 18,
    '64,147,228': 19,
    '96,247,242': 20,
    '107,80,246': 21,
    '153,177,251': 22,
    '120,12,153': 23,
    '170,56,185': 24,
    '224,159,249': 25,
    '203,0,122': 26,
    '236,31,128': 27,
    '243,141,169': 28,
    '104,70,52': 29,
    '149,104,42': 30,
    '248,178,119': 31,
};

export const PREMIUM_COLORS = {
    '170,170,170': 32,
    '165,14,30': 33,
    '250,128,114': 34,
    '228,92,26': 35,
    '214,181,148': 36,
    '156,132,49': 37,
    '197,173,49': 38,
    '232,212,95': 39,
    '74,107,58': 40,
    '90,148,74': 41,
    '132,197,115': 42,
    '15,121,159': 43,
    '187,250,242': 44,
    '125,199,255': 45,
    '77,49,184': 46,
    '74,66,132': 47,
    '122,113,196': 48,
    '181,174,241': 49,
    '219,164,99': 50,
    '209,128,81': 51,
    '255,197,165': 52,
    '155,82,73': 53,
    '209,128,120': 54,
    '250,182,164': 55,
    '123,99,82': 56,
    '156,132,107': 57,
    '51,57,65': 58,
    '109,117,141': 59,
    '179,185,209': 60,
    '109,100,63': 61,
    '148,140,107': 62,
    '205,197,158': 63,
};

export const PALETTE = { ...BASIC_COLORS, ...PREMIUM_COLORS };
export const COLOR_BITMAP_SHIFT = Object.keys(BASIC_COLORS).length + 1;

