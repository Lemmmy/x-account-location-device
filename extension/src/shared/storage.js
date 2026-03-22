/**
 * Storage Abstraction Layer
 * Uses chrome.storage/browser.storage API with LRU cache support
 */

import browserAPI from "./browser-api.js";
import { STORAGE_KEYS, CACHE_CONFIG, DEFAULT_SETTINGS } from "./constants.js";
import { LRUCache } from "./lru-cache.js";

/**
 * User cache data storage with per-entry expiry tracking
 */
class UserCacheStorage {
  constructor() {
    this.cache = new LRUCache(CACHE_CONFIG.MAX_ENTRIES);
    this.expiryMap = new Map(); // Track individual entry expiry times
    this.dirty = false;
    this.loaded = false;
    this.saveTimeoutId = null;
  }

  async load() {
    try {
      const result = await browserAPI.storage.local.get(STORAGE_KEYS.CACHE);
      const stored = result[STORAGE_KEYS.CACHE];

      if (stored && typeof stored === "object") {
        const now = Date.now();
        let loadedCount = 0;
        let expiredCount = 0;

        // Load non-expired entries with their original expiry times
        for (const [key, data] of Object.entries(stored)) {
          if (data && data.expiry > now && data.value) {
            this.cache.set(key, data.value);
            this.expiryMap.set(key, data.expiry); // Preserve original expiry
            loadedCount++;
          } else if (data && data.expiry <= now) {
            expiredCount++;
          }
        }

        console.log(`📦 Loaded ${loadedCount} cached user entries (${expiredCount} expired)`);
      }

      this.loaded = true;
    } catch (error) {
      console.error("Failed to load user cache:", error);
      this.loaded = true; // Mark as loaded even on error to prevent blocking
    }
  }

  async save(force = false) {
    if (!this.dirty && !force) return;

    // Clear any pending save
    if (this.saveTimeoutId) {
      clearTimeout(this.saveTimeoutId);
      this.saveTimeoutId = null;
    }

    try {
      const now = Date.now();
      const defaultExpiry = now + CACHE_CONFIG.EXPIRY_MS;
      const exportData = {};

      for (const [key, value] of this.cache.entries()) {
        // Use existing expiry if available, otherwise use default
        const expiry = this.expiryMap.get(key) || defaultExpiry;
        exportData[key] = { value, expiry };
      }

      await browserAPI.storage.local.set({
        [STORAGE_KEYS.CACHE]: exportData,
      });

      this.dirty = false;
    } catch (error) {
      console.error("Failed to save user cache:", error);
    }
  }

  scheduleSave() {
    if (this.saveTimeoutId) return;

    this.saveTimeoutId = setTimeout(() => {
      this.saveTimeoutId = null;
      this.save();
    }, CACHE_CONFIG.SAVE_INTERVAL_MS);
  }

  get(screenName) {
    return this.cache.get(screenName);
  }

  set(screenName, data) {
    this.cache.set(screenName, data);
    // Set fresh expiry for new/updated entries
    this.expiryMap.set(screenName, Date.now() + CACHE_CONFIG.EXPIRY_MS);
    this.dirty = true;
    this.scheduleSave();
  }

  has(screenName) {
    return this.cache.has(screenName);
  }

  delete(screenName) {
    const result = this.cache.delete(screenName);
    if (result) {
      this.expiryMap.delete(screenName);
      this.dirty = true;
      this.scheduleSave();
    }
    return result;
  }

  async clear() {
    this.cache.clear();
    this.expiryMap.clear();
    this.dirty = true;
    await this.save(true);
  }

  get size() {
    return this.cache.size;
  }

  getAll() {
    return Array.from(this.cache.entries()).map(([key, value]) => ({
      screenName: key,
      ...value,
    }));
  }
}

/**
 * Blocked countries storage
 */
class BlockedCountriesStorage {
  constructor() {
    this.countries = new Set();
    this.loaded = false;
  }

  async load() {
    try {
      const result = await browserAPI.storage.local.get(STORAGE_KEYS.BLOCKED_COUNTRIES);
      const stored = result[STORAGE_KEYS.BLOCKED_COUNTRIES];

      if (Array.isArray(stored)) {
        this.countries = new Set(stored);
        console.log(`🚫 Loaded ${this.countries.size} blocked countries`);
      }

      this.loaded = true;
    } catch (error) {
      console.error("Failed to load blocked countries:", error);
      this.loaded = true;
    }
  }

  async save() {
    try {
      const array = Array.from(this.countries);
      await browserAPI.storage.local.set({
        [STORAGE_KEYS.BLOCKED_COUNTRIES]: array,
      });
      console.log(`💾 Saved ${array.length} blocked countries`);
    } catch (error) {
      console.error("Failed to save blocked countries:", error);
    }
  }

  isBlocked(country) {
    if (!country) return false;
    return this.countries.has(country.trim().toLowerCase());
  }

  add(country) {
    const normalized = country.trim().toLowerCase();
    if (!this.countries.has(normalized)) {
      this.countries.add(normalized);
      this.save();
      return true;
    }
    return false;
  }

  remove(country) {
    const normalized = country.trim().toLowerCase();
    if (this.countries.has(normalized)) {
      this.countries.delete(normalized);
      this.save();
      return true;
    }
    return false;
  }

  toggle(country) {
    const normalized = country.trim().toLowerCase();
    if (this.countries.has(normalized)) {
      this.countries.delete(normalized);
    } else {
      this.countries.add(normalized);
    }
    this.save();
    return this.countries.has(normalized);
  }

  clear() {
    this.countries.clear();
    return this.save();
  }

  get size() {
    return this.countries.size;
  }

  getAll() {
    return Array.from(this.countries);
  }

  has(country) {
    return this.isBlocked(country);
  }
}

/**
 * Blocked regions storage (similar to blocked countries but for regions)
 */
class BlockedRegionsStorage {
  constructor() {
    this.regions = new Set();
    this.loaded = false;
  }

  async load() {
    try {
      const result = await browserAPI.storage.local.get(STORAGE_KEYS.BLOCKED_REGIONS);
      const stored = result[STORAGE_KEYS.BLOCKED_REGIONS];

      if (Array.isArray(stored)) {
        this.regions = new Set(stored);
        console.log(`🚫 Loaded ${this.regions.size} blocked regions`);
      }

      this.loaded = true;
    } catch (error) {
      console.error("Failed to load blocked regions:", error);
      this.loaded = true;
    }
  }

  async save() {
    try {
      const array = Array.from(this.regions);
      await browserAPI.storage.local.set({
        [STORAGE_KEYS.BLOCKED_REGIONS]: array,
      });
      console.log(`💾 Saved ${array.length} blocked regions`);
    } catch (error) {
      console.error("Failed to save blocked regions:", error);
    }
  }

  isBlocked(region) {
    if (!region) return false;
    return this.regions.has(region.trim().toLowerCase());
  }

  add(region) {
    const normalized = region.trim().toLowerCase();
    if (!this.regions.has(normalized)) {
      this.regions.add(normalized);
      this.save();
      return true;
    }
    return false;
  }

  remove(region) {
    const normalized = region.trim().toLowerCase();
    if (this.regions.has(normalized)) {
      this.regions.delete(normalized);
      this.save();
      return true;
    }
    return false;
  }

  toggle(region) {
    const normalized = region.trim().toLowerCase();
    if (this.regions.has(normalized)) {
      this.regions.delete(normalized);
    } else {
      this.regions.add(normalized);
    }
    this.save();
    return this.regions.has(normalized);
  }

  clear() {
    this.regions.clear();
    return this.save();
  }

  get size() {
    return this.regions.size;
  }

  getAll() {
    return Array.from(this.regions);
  }

  has(region) {
    return this.isBlocked(region);
  }
}

/**
 * Blocked tags storage (for emoji/symbol-based blocking)
 * Tags are stored as-is (emoji characters, symbols, or short text patterns)
 */
class BlockedTagsStorage {
  constructor() {
    this.tags = new Set();
    this.loaded = false;
  }

  async load() {
    try {
      const result = await browserAPI.storage.local.get(STORAGE_KEYS.BLOCKED_TAGS);
      const stored = result[STORAGE_KEYS.BLOCKED_TAGS];

      if (Array.isArray(stored)) {
        this.tags = new Set(stored);
        console.log(`🏷️ Loaded ${this.tags.size} blocked tags`);
      }

      this.loaded = true;
    } catch (error) {
      console.error("Failed to load blocked tags:", error);
      this.loaded = true;
    }
  }

  async save() {
    try {
      const array = Array.from(this.tags);
      await browserAPI.storage.local.set({
        [STORAGE_KEYS.BLOCKED_TAGS]: array,
      });
      console.log(`💾 Saved ${array.length} blocked tags`);
    } catch (error) {
      console.error("Failed to save blocked tags:", error);
    }
  }

  /**
   * Check if a tag is blocked
   * @param {string} tag - The tag to check
   * @returns {boolean} - True if blocked
   */
  isBlocked(tag) {
    if (!tag) return false;
    return this.tags.has(tag);
  }

  /**
   * Check if any of the given tags are blocked
   * @param {string[]} tagsToCheck - Array of tags to check
   * @returns {string|null} - The first blocked tag found, or null
   */
  findBlockedTag(tagsToCheck) {
    if (!tagsToCheck || !Array.isArray(tagsToCheck)) return null;
    for (const tag of tagsToCheck) {
      if (this.tags.has(tag)) {
        return tag;
      }
    }
    return null;
  }

  add(tag) {
    if (!tag || typeof tag !== "string") return false;
    const trimmed = tag.trim();
    if (!trimmed) return false;

    if (!this.tags.has(trimmed)) {
      this.tags.add(trimmed);
      this.save();
      return true;
    }
    return false;
  }

  remove(tag) {
    if (!tag) return false;
    const trimmed = tag.trim();
    if (this.tags.has(trimmed)) {
      this.tags.delete(trimmed);
      this.save();
      return true;
    }
    return false;
  }

  toggle(tag) {
    if (!tag) return false;
    const trimmed = tag.trim();
    if (!trimmed) return false;

    if (this.tags.has(trimmed)) {
      this.tags.delete(trimmed);
    } else {
      this.tags.add(trimmed);
    }
    this.save();
    return this.tags.has(trimmed);
  }

  clear() {
    this.tags.clear();
    return this.save();
  }

  get size() {
    return this.tags.size;
  }

  getAll() {
    return Array.from(this.tags);
  }

  has(tag) {
    return this.isBlocked(tag);
  }
}

/**
 * Settings storage
 */
class SettingsStorage {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.loaded = false;
    this.listeners = new Set();
  }

  async load() {
    try {
      const result = await browserAPI.storage.local.get(STORAGE_KEYS.SETTINGS);
      const stored = result[STORAGE_KEYS.SETTINGS];

      if (stored && typeof stored === "object") {
        this.settings = { ...DEFAULT_SETTINGS, ...stored };
      }

      this.loaded = true;
      console.log("⚙️ Settings loaded:", this.settings);
    } catch (error) {
      console.error("Failed to load settings:", error);
      this.loaded = true;
    }
  }

  async save() {
    try {
      await browserAPI.storage.local.set({
        [STORAGE_KEYS.SETTINGS]: this.settings,
      });
      this.notifyListeners();
    } catch (error) {
      console.error("Failed to save settings:", error);
    }
  }

  get(key) {
    if (key) {
      return this.settings[key];
    }
    return { ...this.settings };
  }

  set(key, value) {
    if (typeof key === "object") {
      // Bulk set
      this.settings = { ...this.settings, ...key };
    } else {
      this.settings[key] = value;
    }
    return this.save();
  }

  toggle(key) {
    if (typeof this.settings[key] === "boolean") {
      this.settings[key] = !this.settings[key];
      return this.save();
    }
    return Promise.resolve();
  }

  addListener(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notifyListeners() {
    for (const listener of this.listeners) {
      try {
        listener(this.settings);
      } catch (error) {
        console.error("Settings listener error:", error);
      }
    }
  }

  get isEnabled() {
    return this.settings.enabled;
  }
}

/**
 * Captured headers storage (for API authentication)
 */
class HeadersStorage {
  constructor() {
    this.headers = null;
  }

  async load() {
    try {
      const result = await browserAPI.storage.local.get(STORAGE_KEYS.HEADERS);
      this.headers = result[STORAGE_KEYS.HEADERS] || null;

      if (this.headers) {
        console.log("🔑 Loaded cached API headers");
      }
    } catch (error) {
      console.error("Failed to load headers:", error);
    }
  }

  async save(headers) {
    try {
      this.headers = headers;
      await browserAPI.storage.local.set({
        [STORAGE_KEYS.HEADERS]: headers,
      });
      console.log("🔑 Saved API headers");
    } catch (error) {
      console.error("Failed to save headers:", error);
    }
  }

  get() {
    return this.headers;
  }

  clear() {
    this.headers = null;
    return browserAPI.storage.local.remove(STORAGE_KEYS.HEADERS);
  }

  hasHeaders() {
    return this.headers !== null && this.headers.authorization;
  }
}

// Export singleton instances
export const userCache = new UserCacheStorage();
export const blockedCountries = new BlockedCountriesStorage();
export const blockedRegions = new BlockedRegionsStorage();
export const blockedTags = new BlockedTagsStorage();
export const settings = new SettingsStorage();
export const headersStorage = new HeadersStorage();

// Export classes for testing
export {
  LRUCache,
  UserCacheStorage,
  BlockedCountriesStorage,
  BlockedRegionsStorage,
  BlockedTagsStorage,
  SettingsStorage,
  HeadersStorage,
};

/**
 * Initialize all storage modules
 */
export async function initializeStorage() {
  await Promise.all([
    userCache.load(),
    blockedCountries.load(),
    blockedRegions.load(),
    blockedTags.load(),
    settings.load(),
    headersStorage.load(),
  ]);

  console.log("💾 All storage modules initialized");
}
