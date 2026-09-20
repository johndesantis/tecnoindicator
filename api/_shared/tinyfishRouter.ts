import {
  TINYFISH_KEY_ENV_NAMES,
  readConfiguredKeys,
  sanitizeUrl,
} from "./http.js";
import { getCache, setCache } from "./cache.js";
import type { Region } from "./regions.js";

export interface TinyFishKeyState {
  keyIndex: number;
  envName: string;
  available: boolean;
  rateLimited: boolean;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
}

interface SearchResult {
  position: number;
  site_name: string;
  title: string;
  snippet: string;
  url: string;
  publishedAt?: string;
}

interface TinyFishSearchResponse {
  results: SearchResult[];
  total: number;
  keyIndex: number;
}

interface ScrapedContent {
  url: string;
  title: string;
  text: string;
  keyIndex: number;
}

const SEARCH_URL = "https://api.search.tinyfish.ai";
const FETCH_URL = "https://api.fetch.tinyfish.ai";

function buildSearchUrl(query: string, limit: number): string {
  const params = new URLSearchParams({ query, limit: String(limit) });
  return `${SEARCH_URL}?${params.toString()}`;
}

export class TinyFishRouter {
  private keyStates: TinyFishKeyState[] = [];
  private initialized: boolean = false;

  async refreshTinyfishStatus(force: boolean = false): Promise<void> {
    if (!force && this.initialized && this.keyStates.length > 0) return;

    const keys = readConfiguredKeys(TINYFISH_KEY_ENV_NAMES);
    this.keyStates = keys.map((key, index) => ({
      keyIndex: index,
      envName: key.envName,
      available: false, // Will be verified on first use
      rateLimited: false,
      rateLimitRemaining: null,
      rateLimitResetAt: null,
      lastCheckedAt: null,
      lastSuccessAt: null,
    }));

    // Probe all keys in parallel with timeout
    const probes = this.keyStates.map(async (keyState) => {
      try {
        const testKey = process.env[keyState.envName];
        if (!testKey) {
          keyState.available = false;
          return;
        }

        const response = await fetch(buildSearchUrl("test", 1), {
          headers: {
            "X-API-Key": testKey,
          },
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          keyState.available = true;
          keyState.lastCheckedAt = new Date().toISOString();
          keyState.lastSuccessAt = keyState.lastCheckedAt;
          const remaining = response.headers.get("x-ratelimit-remaining");
          if (remaining) {
            const parsed = Number(remaining);
            if (Number.isFinite(parsed)) keyState.rateLimitRemaining = parsed;
          }
        } else if (response.status === 401 || response.status === 403) {
          keyState.available = false;
          keyState.lastCheckedAt = new Date().toISOString();
        } else if (response.status === 429) {
          keyState.rateLimited = true;
          keyState.lastCheckedAt = new Date().toISOString();
          this.parseRateLimitHeaders(keyState, response);
        }
      } catch {
        keyState.available = false;
        keyState.lastCheckedAt = new Date().toISOString();
      }
    });

    await Promise.allSettled(probes);

    this.initialized = true;
  }

  private parseRateLimitHeaders(
    keyState: TinyFishKeyState,
    response: Response
  ): void {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) {
        keyState.rateLimitResetAt = new Date(Date.now() + seconds * 1000).toISOString();
      }
    }
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (remaining) {
      const parsed = Number(remaining);
      if (Number.isFinite(parsed)) keyState.rateLimitRemaining = parsed;
    }
  }

  private selectKey(): TinyFishKeyState | null {
    const available = this.keyStates.filter(
      k => k.available && !k.rateLimited
    );

    if (available.length === 0) return null;

    const maxRemaining = Math.max(
      ...available.map(k => k.rateLimitRemaining ?? 0)
    );
    const topQuota = available.filter(
      k => (k.rateLimitRemaining ?? 0) === maxRemaining
    );

    return topQuota[0];
  }

  private rotateKey(failedKey: TinyFishKeyState): TinyFishKeyState | null {
    failedKey.rateLimited = true;
    failedKey.lastCheckedAt = new Date().toISOString();
    return this.selectKey();
  }

  async tinyfishSearch(
    query: string,
    options: { limit?: number; region?: Region } = {}
  ): Promise<TinyFishSearchResponse> {
    if (!this.initialized) {
      await this.refreshTinyfishStatus(true);
    }

    const cacheKey = `tinyfish:search:${query}:${options.region ?? "global"}`;
    const cached = await getCache<TinyFishSearchResponse>(cacheKey, 10 * 60 * 1000);
    if (cached) return cached;

    let keyState = this.selectKey();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (!keyState) {
        await this.backoff(attempt);
        keyState = this.selectKey();
        if (!keyState) break;
      }

      try {
        const testKey = process.env[keyState.envName];
        if (!testKey) {
          keyState = this.rotateKey(keyState);
          continue;
        }

        const region = options.region ?? "global";
        const regionPrefix = region !== "global" ? `[${region}] ` : "";

        const response = await fetch(buildSearchUrl(`${regionPrefix}${query}`, options.limit ?? 10), {
          headers: {
            "X-API-Key": testKey,
          },
          signal: AbortSignal.timeout(30000),
        });

        const status = response.status;

        if (status === 200) {
          const data = await response.json();
          const results: SearchResult[] = Array.isArray(data.results)
            ? data.results.map((r: any) => ({
                position: r.position ?? 0,
                site_name: r.site_name ?? "",
                title: r.title ?? "",
                snippet: r.snippet ?? "",
                url: r.url ?? "",
                publishedAt: r.published_at ?? undefined,
              }))
            : [];
          const result: TinyFishSearchResponse = {
            results,
            total: data.total_results ?? 0,
            keyIndex: keyState.keyIndex,
          };

          keyState.lastCheckedAt = new Date().toISOString();
          keyState.lastSuccessAt = keyState.lastCheckedAt;
          const remaining = response.headers.get("x-ratelimit-remaining");
          if (remaining) {
            const parsed = Number(remaining);
            if (Number.isFinite(parsed)) keyState.rateLimitRemaining = parsed;
          }

          await setCache(cacheKey, result, 10 * 60 * 1000);
          return result;
        }

        if (status === 401 || status === 403) {
          keyState.available = false;
          keyState.lastCheckedAt = new Date().toISOString();
          keyState = this.rotateKey(keyState);
          continue;
        }

        if (status === 429) {
          this.parseRateLimitHeaders(keyState, response);
          keyState = this.rotateKey(keyState);
          lastError = new Error("Rate limited");
          continue;
        }

        lastError = new Error(`TinyFish search failed with status ${status}`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      keyState = this.selectKey();
    }

    const cachedFallback = await getCache<TinyFishSearchResponse>(
      cacheKey,
      60 * 60 * 1000
    );
    if (cachedFallback) return cachedFallback;

    console.error("TinyFish search failed:", lastError?.message);
    return { results: [], total: 0, keyIndex: -1 };
  }

  async tinyfishScrape(url: string): Promise<ScrapedContent | null> {
    if (!this.initialized) {
      await this.refreshTinyfishStatus(true);
    }

    const safeUrl = sanitizeUrl(url);
    if (!safeUrl) return null;
    const cacheKey = `tinyfish:scrape:${safeUrl}`;
    const cached = await getCache<ScrapedContent>(cacheKey, 10 * 60 * 1000);
    if (cached) return cached;

    let keyState = this.selectKey();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (!keyState) {
        await this.backoff(attempt);
        keyState = this.selectKey();
        if (!keyState) break;
      }

      try {
        const testKey = process.env[keyState.envName];
        if (!testKey) {
          keyState = this.rotateKey(keyState);
          continue;
        }

        const response = await fetch(FETCH_URL, {
          method: "POST",
          headers: {
            "X-API-Key": testKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            urls: [safeUrl],
          }),
          signal: AbortSignal.timeout(30000),
        });

        const status = response.status;

        if (status === 200) {
          const data = await response.json();
          const firstResult = Array.isArray(data.results) && data.results.length > 0
            ? data.results[0]
            : null;
          const result: ScrapedContent = {
            url: safeUrl,
            title: firstResult?.title ?? "",
            text: typeof firstResult?.text === "string" ? firstResult.text.slice(0, 10000) : "",
            keyIndex: keyState.keyIndex,
          };

          keyState.lastCheckedAt = new Date().toISOString();
          keyState.lastSuccessAt = keyState.lastCheckedAt;

          await setCache(cacheKey, result, 10 * 60 * 1000);
          return result;
        }

        if (status === 401 || status === 403) {
          keyState.available = false;
          keyState.lastCheckedAt = new Date().toISOString();
          keyState = this.rotateKey(keyState);
          continue;
        }

        if (status === 429) {
          this.parseRateLimitHeaders(keyState, response);
          keyState = this.rotateKey(keyState);
          lastError = new Error("Rate limited");
          continue;
        }

        lastError = new Error(`TinyFish scrape failed with status ${status}`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      keyState = this.selectKey();
    }

    console.error("TinyFish scrape failed:", lastError?.message);
    return null;
  }

  async getTinyfishStatus(): Promise<{
    available: boolean;
    configuredKeys: number;
    usableKeys: number;
    rateLimitedKeys: number[];
  }> {
    if (!this.initialized) {
      await this.refreshTinyfishStatus(true);
    }

    return {
      available: this.keyStates.some(k => k.available && !k.rateLimited),
      configuredKeys: this.keyStates.length,
      usableKeys: this.keyStates.filter(k => k.available && !k.rateLimited).length,
      rateLimitedKeys: this.keyStates
        .map((k, i) => (k.rateLimited ? i : -1))
        .filter(i => i >= 0),
    };
  }

  private async backoff(attempt: number): Promise<void> {
    const delays = [1000, 2000, 4000];
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 4000;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

export const tinyfishRouter = new TinyFishRouter();