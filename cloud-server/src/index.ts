import "dotenv/config";
import { Hono, Context } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { basicAuth } from "hono/basic-auth";
import Redis from "ioredis";

const app = new Hono();

const CONFIG = {
  MAX_BATCH_SIZE: 100,
  MAX_CONTRIBUTE_BATCH: 500,
  MAX_USERNAME_LENGTH: 50,
  RATE_LIMIT_PER_MINUTE: 120,
  UPSTREAM_CACHE_URL: process.env.UPSTREAM_CACHE_URL || "https://x-posed-cache.xaitax.workers.dev",
  UPSTREAM_TIMEOUT_MS: 5000,
};

interface CacheEntry {
  l: string;
  d: string;
  a: boolean;
  t: number;
}

interface ContributeBody {
  entries: Record<
    string,
    {
      l?: string;
      d?: string;
      a?: boolean;
      location?: string;
      device?: string;
      locationAccurate?: boolean;
    }
  >;
}

interface Stats {
  totalContributions: number;
  totalEntries: number;
  localLookups: number;
  cloudflareDelegated: number;
  lastUpdated: string;
}

interface CloudflareStats {
  totalEntries: number;
  fetchedAt: number;
}

let cloudflareStatsCache: CloudflareStats | null = null;
const CLOUDFLARE_STATS_TTL = 6 * 60 * 60 * 1000; // 6 hours

let redis: Redis;

async function initRedis() {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  redis = new Redis(redisUrl);

  redis.on("error", (err: Error) => console.error("Redis Client Error", err));

  console.log("Redis connected");
}

app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    maxAge: 86400,
  }),
);

if (process.env.BASIC_AUTH_USERNAME && process.env.BASIC_AUTH_PASSWORD) {
  app.use(
    "/*",
    basicAuth({
      username: process.env.BASIC_AUTH_USERNAME,
      password: process.env.BASIC_AUTH_PASSWORD,
    }),
  );
  console.log("Basic auth enabled");
}

app.get("/lookup", async (c: Context) => {
  const usersParam = c.req.query("users");

  if (!usersParam) {
    return c.json({ error: "Missing users parameter" }, 400);
  }

  const usernames = usersParam
    .split(",")
    .map((u: string) => u.trim().toLowerCase())
    .filter((u: string) => u.length > 0 && u.length <= CONFIG.MAX_USERNAME_LENGTH)
    .slice(0, CONFIG.MAX_BATCH_SIZE);

  if (usernames.length === 0) {
    return c.json({ error: "No valid usernames provided" }, 400);
  }

  const results: Record<string, CacheEntry> = {};
  const misses: string[] = [];

  const lookups = await Promise.all(
    usernames.map(async (username: string) => {
      try {
        const data = await redis.get(username);
        return { username, data: data ? JSON.parse(data) : null };
      } catch {
        return { username, data: null };
      }
    }),
  );

  let localHits = 0;
  for (const { username, data } of lookups) {
    if (data) {
      results[username] = data;
      localHits++;
    } else {
      misses.push(username);
    }
  }

  // Track local lookups
  if (localHits > 0) {
    updateStats(0, localHits, 0).catch((err) => console.error("Stats update failed:", err));
  }

  // If we have cache misses, attempt to fetch from upstream cache
  if (misses.length > 0) {
    try {
      const upstreamResults = await fetchFromUpstreamCache(misses);
      const upstreamHits = Object.keys(upstreamResults).length;

      // Track Cloudflare delegations
      if (misses.length > 0) {
        updateStats(0, 0, misses.length).catch((err) => console.error("Stats update failed:", err));
      }

      // Populate local cache and results with upstream data
      const cachePromises: Promise<any>[] = [];
      for (const [username, entry] of Object.entries(upstreamResults)) {
        results[username] = entry;
        cachePromises.push(redis.set(username, JSON.stringify(entry)));
      }

      // Store in Redis without blocking the response
      if (cachePromises.length > 0) {
        Promise.all(cachePromises).catch((err) => {
          console.error("Failed to cache upstream results:", err);
        });
      }

      // Update misses to only include usernames still not found
      const foundUsernames = new Set(Object.keys(upstreamResults));
      const remainingMisses = misses.filter((u) => !foundUsernames.has(u));

      return c.json({
        results,
        misses: remainingMisses,
        count: Object.keys(results).length,
      });
    } catch (upstreamError) {
      // Gracefully handle upstream fetch failures - just return original results
      console.error("Upstream cache fetch failed:", upstreamError);
    }
  }

  return c.json({
    results,
    misses,
    count: Object.keys(results).length,
  });
});

app.post("/contribute", async (c: Context) => {
  let body: ContributeBody;

  try {
    body = await c.req.json();
  } catch (parseError: any) {
    console.error("JSON parse error:", parseError);
    return c.json({ error: "Invalid JSON", details: parseError.message }, 400);
  }

  if (!body.entries || typeof body.entries !== "object") {
    console.error("Missing entries object. Body:", JSON.stringify(body).substring(0, 200));
    return c.json({ error: "Missing entries object" }, 400);
  }

  let entries: [string, any][];
  try {
    entries = Object.entries(body.entries);
  } catch (entriesError: any) {
    console.error("Object.entries error:", entriesError);
    return c.json({ error: "Invalid entries format", details: entriesError.message }, 400);
  }

  if (entries.length === 0) {
    return c.json({ error: "No entries provided" }, 400);
  }

  if (entries.length > CONFIG.MAX_CONTRIBUTE_BATCH) {
    return c.json({ error: `Max ${CONFIG.MAX_CONTRIBUTE_BATCH} entries per request` }, 400);
  }

  let accepted = 0;
  let rejected = 0;
  let unchanged = 0;
  const puts: Promise<any>[] = [];

  for (const [username, data] of entries) {
    try {
      if (!username || typeof username !== "string") {
        rejected++;
        continue;
      }

      const cleanUsername = username.trim().toLowerCase();
      if (cleanUsername.length === 0 || cleanUsername.length > CONFIG.MAX_USERNAME_LENGTH) {
        rejected++;
        continue;
      }

      if (!data || typeof data !== "object") {
        rejected++;
        continue;
      }

      const location = data.l || data.location;
      const device = data.d || data.device || "";
      const accurate =
        data.a !== undefined
          ? data.a !== false
          : data.locationAccurate !== undefined
            ? data.locationAccurate !== false
            : true;

      if (!location || typeof location !== "string" || location.trim().length === 0) {
        rejected++;
        continue;
      }

      if (location.length > 100) {
        rejected++;
        continue;
      }

      if (location.includes("<") || location.includes(">") || location.includes("javascript:")) {
        rejected++;
        continue;
      }

      if (device && (typeof device !== "string" || device.length > 100)) {
        rejected++;
        continue;
      }

      const newEntry: CacheEntry = {
        l: String(location).trim(),
        d: String(device || "").trim(),
        a: Boolean(accurate),
        t: Math.floor(Date.now() / 1000),
      };

      const existingData = await redis.get(cleanUsername);
      if (existingData) {
        const existing: CacheEntry = JSON.parse(existingData);
        if (existing.l === newEntry.l && existing.d === newEntry.d && existing.a === newEntry.a) {
          unchanged++;
          continue;
        }
      }

      puts.push(redis.set(cleanUsername, JSON.stringify(newEntry)));
      accepted++;
    } catch (entryError) {
      console.error("Entry processing error for", username, ":", entryError);
      rejected++;
    }
  }

  if (puts.length > 0) {
    try {
      await Promise.all(puts);
    } catch (kvError: any) {
      console.error("Redis put error:", kvError);
      return c.json(
        {
          error: "Failed to store entries",
          details: kvError.message,
          accepted: 0,
          rejected: entries.length,
        },
        500,
      );
    }
  }

  try {
    updateStats(accepted);
  } catch (statsError) {
    console.error("Stats update error:", statsError);
  }

  return c.json({
    accepted,
    rejected,
    unchanged,
    message: `Stored ${accepted} new/updated entries, ${unchanged} unchanged`,
  });
});

app.get("/stats", async (c: Context) => {
  try {
    let localEntries = 0;
    let cursor = "0";

    do {
      const [newCursor, keys] = await redis.scan(cursor, "MATCH", "*", "COUNT", "1000");
      cursor = newCursor;
      localEntries += keys.filter((k: string) => k !== "__stats__").length;
    } while (cursor !== "0");

    const storedStatsStr = await redis.get("__stats__");
    const storedStats: Stats = storedStatsStr
      ? JSON.parse(storedStatsStr)
      : {
          totalContributions: 0,
          totalEntries: 0,
          localLookups: 0,
          cloudflareDelegated: 0,
          lastUpdated: new Date().toISOString(),
        };

    // Fetch Cloudflare stats (cached for 6 hours)
    const cloudflareTotal = await fetchCloudflareStats();

    return c.json({
      totalEntries: localEntries + cloudflareTotal,
      localEntries,
      localLookups: storedStats.localLookups,
      cloudflareTotal,
      cloudflareDelegated: storedStats.cloudflareDelegated,
      totalContributions: storedStats.totalContributions,
      lastUpdated: storedStats.lastUpdated,
    });
  } catch (error: any) {
    console.error("Stats error:", error);
    return c.json({ error: "Failed to fetch stats", details: error.message }, 500);
  }
});

app.get("/health", (c: Context) => {
  return c.json({ status: "ok", timestamp: Date.now() });
});

async function fetchFromUpstreamCache(usernames: string[]): Promise<Record<string, CacheEntry>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.UPSTREAM_TIMEOUT_MS);

  try {
    const url = `${CONFIG.UPSTREAM_CACHE_URL}/lookup?users=${usernames.join(",")}`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "x-account-location-device-mirror/1.0",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      // Handle rate limits (429) and other errors gracefully
      if (response.status === 429) {
        console.warn("Upstream cache rate limited");
      } else {
        console.warn(`Upstream cache returned status ${response.status}`);
      }
      return {};
    }

    const data = (await response.json()) as { results?: Record<string, CacheEntry> };
    return data.results || {};
  } catch (error: any) {
    clearTimeout(timeoutId);

    // Handle timeout and network errors gracefully
    if (error.name === "AbortError") {
      console.warn("Upstream cache request timed out");
    } else if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
      console.warn("Upstream cache unreachable:", error.code);
    } else {
      console.warn("Upstream cache error:", error.message);
    }

    return {};
  }
}

async function fetchCloudflareStats(): Promise<number> {
  // Return cached stats if still fresh
  if (cloudflareStatsCache && Date.now() - cloudflareStatsCache.fetchedAt < CLOUDFLARE_STATS_TTL) {
    return cloudflareStatsCache.totalEntries;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.UPSTREAM_TIMEOUT_MS);

    const response = await fetch(`${CONFIG.UPSTREAM_CACHE_URL}/stats`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "x-account-location-device-mirror/1.0",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`Cloudflare stats fetch failed with status ${response.status}`);
      return cloudflareStatsCache?.totalEntries || 0;
    }

    const data = (await response.json()) as { totalEntries?: number };
    const totalEntries = data.totalEntries || 0;

    cloudflareStatsCache = {
      totalEntries,
      fetchedAt: Date.now(),
    };

    return totalEntries;
  } catch (error: any) {
    console.warn("Cloudflare stats fetch error:", error.message);
    return cloudflareStatsCache?.totalEntries || 0;
  }
}

async function updateStats(newEntries: number, localLookups = 0, cloudflareDelegated = 0) {
  try {
    const statsStr = await redis.get("__stats__");
    const stats: Stats = statsStr
      ? JSON.parse(statsStr)
      : {
          totalContributions: 0,
          totalEntries: 0,
          localLookups: 0,
          cloudflareDelegated: 0,
          lastUpdated: new Date().toISOString(),
        };

    stats.totalContributions += newEntries;
    stats.totalEntries += newEntries;
    stats.localLookups += localLookups;
    stats.cloudflareDelegated += cloudflareDelegated;
    stats.lastUpdated = new Date().toISOString();

    await redis.set("__stats__", JSON.stringify(stats));
  } catch (error) {
    console.error("Failed to update stats:", error);
  }
}

const port = parseInt(process.env.PORT || "3000", 10);

initRedis()
  .then(() => {
    const server = serve({
      fetch: app.fetch,
      port,
    });

    // Graceful shutdown
    process.on("SIGINT", async () => {
      console.log("\nReceived SIGINT, shutting down gracefully...");
      server.close();
      await redis.quit();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      console.log("\nReceived SIGTERM, shutting down gracefully...");
      server.close(async (err) => {
        if (err) {
          console.error("Error during shutdown:", err);
          await redis.quit();
          process.exit(1);
        }
        await redis.quit();
        process.exit(0);
      });
    });
  })
  .catch((err) => {
    console.error("Failed to initialize Redis:", err);
    process.exit(1);
  });

export default app;
