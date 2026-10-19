// src/settings.js — Folio app settings (server-side, JSON in the data dir).
// Separate from sync-settings.json. Never sent to the browser wholesale.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'app-settings.json';

export function loadAppSettings(dataDir) {
  try { return JSON.parse(readFileSync(join(dataDir, FILE), 'utf8')); }
  catch { return {}; }
}

export function saveAppSettings(dataDir, patch) {
  const next = { ...loadAppSettings(dataDir), ...patch };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, FILE), JSON.stringify(next, null, 2));
  return next;
}

export function getAppSetting(dataDir, key) {
  return loadAppSettings(dataDir)[key];
}

export function setAppSetting(dataDir, key, value) {
  return saveAppSettings(dataDir, { [key]: value })[key];
}
