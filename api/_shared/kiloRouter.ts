import { sanitizeError } from "./validation.js";
import {
  KILO_GATEWAY_MODELS_URL,
  KILO_GATEWAY_CHAT_URL,
  DEFAULT_KILO_MODEL_ID,
  KILO_KEY_ENV_NAMES,
  ACCESS_PROBE_CACHE_MS,
  MODEL_CACHE_MS,
  readConfiguredKeys,
  isGlobalRateLimitStatus,
} from "./http.js";
import { getCache, setCache } from "./cache.js";
import { KiloResponse, KiloStatus } from "./types.js";

function makeId(prefix = "chatcmpl"): string {
  try {
    const arr = crypto.getRandomValues(new Uint32Array(3));
    return `${prefix}-${Array.from(arr).map((v) => v.toString(16).padStart(8, "0")).join("").slice(0, 24)}`;
  } catch {
    return `${prefix}-${Math.random().toString(36).substring(2, 11)}`;
  }
}

export interface KiloKeyState {
  keyIndex: number;
  envName: string;
  endpointUrl: string;
  inputPrice: number | null;
  outputPrice: number | null;
  zeroCostVerified: boolean;
  available: boolean;
  rateLimited: boolean;
  rateLimitScope: "key" | "model" | "global" | "unknown" | null;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
}

export interface ModelCandidate {
  modelId: string;
  inputPrice: number | null;
  outputPrice: number | null;
  zeroCostVerified: boolean;
  available: boolean;
  rateLimited: boolean;
  rateLimitScope: "key" | "model" | "global" | "unknown" | null;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
}

interface KiloModelCatalogEntry {
  id: string;
  pricing?: {
    prompt?: number | null;
    input?: number | null;
    completion?: number | null;
    output?: number | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface KiloInferPayload {
  messages: Array<{ role: string; content: string }>;
  model?: string;
  max_tokens?: number;
  temperature?: number;
  response_format?: unknown;
}

export class KiloRouter {
  private keyStates: KiloKeyState[] = [];
  private modelCandidates: ModelCandidate[] = [];
  private initialized: boolean = false;
  private catalogLastRefresh: string | null = null;

  async initKiloRouter(): Promise<void> {
    if (this.initialized) return;

    const keys = readConfiguredKeys(KILO_KEY_ENV_NAMES);
    this.keyStates = keys.map((key, index) => ({
      keyIndex: index,
      envName: key.envName,
      endpointUrl: KILO_GATEWAY_CHAT_URL,
      inputPrice: null,
      outputPrice: null,
      zeroCostVerified: false,
      available: false,
      rateLimited: false,
      rateLimitScope: null,
      rateLimitRemaining: null,
      rateLimitResetAt: null,
      lastCheckedAt: new Date().toISOString(),
      lastSuccessAt: null,
    }));

    await this.refreshKiloModels(true);

    // Probe every configured key against eligible zero-cost models
    const probes = this.modelCandidates
      .filter((m) => m.zeroCostVerified && m.available)
      .flatMap((modelCandidate) =>
        this.keyStates.map((keyState) =>
          this.probeKeyModel(keyState, modelCandidate).catch(() => null)
        )
      );
    const results = await Promise.allSettled(probes);
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        // probe succeeded; state already updated by probeKeyModel
      }
    }

    this.initialized = true;
  }

  async refreshKiloModels(force: boolean = false): Promise<void> {
    const cached = await getCache<{ models: KiloModelCatalogEntry[]; timestamp: number }>(
      "kilo:model-catalog",
      MODEL_CACHE_MS
    );

    if (!force && cached && Date.now() - cached.timestamp < MODEL_CACHE_MS) {
      this.modelCandidates = this.buildCandidatePool(cached.models);
      return;
    }

    try {
      const response = await fetch(KILO_GATEWAY_MODELS_URL, {
        headers: {
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`Model catalog request failed with status ${response.status}`);
      }

      const data = await response.json();
      const models: KiloModelCatalogEntry[] = Array.isArray(data.data)
        ? data.data
        : Array.isArray(data)
          ? data
          : [];

      this.modelCandidates = this.buildCandidatePool(models);
      this.catalogLastRefresh = new Date().toISOString();
      await setCache("kilo:model-catalog", { models, timestamp: Date.now() }, MODEL_CACHE_MS);
    } catch (error) {
      console.error("Kilo model catalog refresh failed:", error);
    }
  }

  private buildCandidatePool(models: KiloModelCatalogEntry[]): ModelCandidate[] {
    const candidates: ModelCandidate[] = [];

    for (const model of models) {
      const modelId = typeof model.id === "string" ? model.id : "";
      if (!modelId) continue;

      const pricing = model.pricing ?? {};
      const inputPrice = this.parsePrice(pricing.prompt ?? pricing.input);
      const outputPrice = this.parsePrice(pricing.completion ?? pricing.output);

      const zeroCostVerified =
        inputPrice !== null &&
        outputPrice !== null &&
        inputPrice === 0 &&
        outputPrice === 0;

      if (zeroCostVerified) {
        candidates.push({
          modelId,
          inputPrice,
          outputPrice,
          zeroCostVerified,
          available: true,
          rateLimited: false,
          rateLimitScope: null,
          rateLimitRemaining: null,
          rateLimitResetAt: null,
          lastCheckedAt: null,
          lastSuccessAt: null,
        });
      }
    }

    // Prefer default model first
    candidates.sort((a, b) => {
      const aDefault = a.modelId === DEFAULT_KILO_MODEL_ID ? 0 : 1;
      const bDefault = b.modelId === DEFAULT_KILO_MODEL_ID ? 0 : 1;
      return aDefault - bDefault;
    });

    return candidates;
  }

  private parsePrice(value: unknown): number | null {
    if (typeof value !== "number" && typeof value !== "string") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private async probeKeyModel(
    keyState: KiloKeyState,
    modelCandidate: ModelCandidate
  ): Promise<{
    success: boolean;
    inputPrice?: number | null;
    outputPrice?: number | null;
    rateLimitScope?: "key" | "model" | "global" | "unknown" | null;
  }> {
    const probeKey = `kilo:access-probe:${keyState.keyIndex}:${modelCandidate.modelId}`;
    const cached = await getCache<{ success: boolean; inputPrice: number | null; outputPrice: number | null }>(
      probeKey,
      ACCESS_PROBE_CACHE_MS
    );

    if (cached) {
      return cached;
    }

    try {
      const response = await fetch(KILO_GATEWAY_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env[keyState.envName] ?? ""}`,
        },
        body: JSON.stringify({
          model: modelCandidate.modelId,
          messages: [
            {
              role: "system",
              content: "You are a test assistant. Reply with exactly: probe-ok",
            },
            {
              role: "user",
              content: "probe-ok",
            },
          ],
          max_tokens: 4,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(10000),
      });

      const status = response.status;
      const responseHeaders = response.headers;
      const retryAfter = responseHeaders.get("retry-after");
      const rateLimitRemaining = responseHeaders.get("x-ratelimit-remaining");
      const rateLimitReset = responseHeaders.get("x-ratelimit-reset");

      if (status === 200) {
        const result = {
          success: true,
          inputPrice: modelCandidate.inputPrice,
          outputPrice: modelCandidate.outputPrice,
        };
        await setCache(probeKey, result, ACCESS_PROBE_CACHE_MS);
        return result;
      }

      if (status === 401 || status === 403) {
        keyState.available = false;
        keyState.lastCheckedAt = new Date().toISOString();
        return { success: false };
      }

      if (status === 429 || isGlobalRateLimitStatus(status)) {
        let scope: "key" | "model" | "global" | "unknown" | null = "unknown";
        const body = await response.text();
        const code = this.extractRateLimitCode(body);

        if (code.includes("key") || code.includes("rate_limit_key")) {
          scope = "key";
        } else if (code.includes("model") || code.includes("rate_limit_model")) {
          scope = "model";
        } else if (code.includes("global") || code.includes("ip")) {
          scope = "global";
        }

        const resetAt = this.parseResetAt(retryAfter, rateLimitReset);

        if (scope === "global") {
          // Mark all keys and models as globally rate-limited
          for (const key of this.keyStates) {
            key.rateLimited = true;
            key.rateLimitScope = "global";
            key.rateLimitResetAt = resetAt;
            key.rateLimitRemaining = this.parseRateLimitRemaining(rateLimitRemaining);
            key.lastCheckedAt = new Date().toISOString();
          }
          for (const model of this.modelCandidates) {
            model.rateLimited = true;
            model.rateLimitScope = "global";
            model.rateLimitResetAt = resetAt;
          }
        } else if (scope === "key") {
          keyState.rateLimited = true;
          keyState.rateLimitScope = "key";
          keyState.rateLimitResetAt = resetAt;
          keyState.rateLimitRemaining = this.parseRateLimitRemaining(rateLimitRemaining);
          keyState.lastCheckedAt = new Date().toISOString();
        } else if (scope === "model") {
          modelCandidate.rateLimited = true;
          modelCandidate.rateLimitScope = "model";
          modelCandidate.rateLimitResetAt = resetAt;
          modelCandidate.rateLimitRemaining = this.parseRateLimitRemaining(rateLimitRemaining);
          modelCandidate.lastCheckedAt = new Date().toISOString();
        } else {
          keyState.rateLimited = true;
          keyState.rateLimitScope = "unknown";
          keyState.rateLimitResetAt = resetAt;
          keyState.lastCheckedAt = new Date().toISOString();
          modelCandidate.rateLimited = true;
          modelCandidate.rateLimitScope = "unknown";
          modelCandidate.lastCheckedAt = new Date().toISOString();
        }

        return {
          success: false,
          inputPrice: modelCandidate.inputPrice,
          outputPrice: modelCandidate.outputPrice,
          rateLimitScope: scope,
        };
      }

      // Other errors - mark key as unavailable
      keyState.available = false;
      keyState.lastCheckedAt = new Date().toISOString();
      return { success: false };
    } catch (error) {
      // Network errors or timeouts
      console.error("Kilo access probe failed:", sanitizeError(String(error)));
      keyState.available = false;
      keyState.lastCheckedAt = new Date().toISOString();
      return { success: false };
    }
  }

  private extractRateLimitCode(body: string): string {
    try {
      const data = JSON.parse(body);
      return JSON.stringify(data).toLowerCase();
    } catch {
      return body.toLowerCase();
    }
  }

  private parseRateLimitRemaining(value: string | null): number | null {
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private parseResetAt(retryAfter: string | null, rateLimitReset: string | null): string | null {
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) {
        return new Date(Date.now() + seconds * 1000).toISOString();
      }
    }
    if (rateLimitReset) {
      const parsed = Date.parse(rateLimitReset);
      if (!Number.isNaN(parsed)) {
        return new Date(parsed).toISOString();
      }
    }
    return null;
  }

  async kiloInfer(payload: KiloInferPayload): Promise<KiloResponse> {
    // Use Promise.race to add overall timeout to prevent hanging
    return Promise.race([
      this._kiloInferInternal(payload),
      new Promise<KiloResponse>((_, reject) =>
        setTimeout(() => reject(new Error("Kilo inference timeout")), 30000)
      )
    ]);
  }

  private async _kiloInferInternal(payload: KiloInferPayload): Promise<KiloResponse> {
    if (!this.initialized) {
      await this.initKiloRouter();
    }

    // Force refresh before returning complete Kilo-unavailable
    const hasAnyUsable = this.keyStates.some(k => k.available && !k.rateLimited) &&
      this.modelCandidates.some(m => m.zeroCostVerified && m.available && !m.rateLimited);

    if (!hasAnyUsable) {
      await this.refreshKiloModels(true);
    }

    const keys = this.keyStates
      .filter(k => k.available && !k.rateLimited)
      .map((_k, i) => i);

    const models = this.modelCandidates
      .filter(m => m.zeroCostVerified && m.available && !m.rateLimited)
      .map((_m, i) => i);

    if (keys.length === 0 || models.length === 0) {
      throw new Error("No available Kilo Gateway key/model combinations");
    }

    // Shuffle keys and models using crypto-secure random
    const shuffledKeys = this.shuffle(keys);
    const shuffledModels = this.shuffle(models);

    let lastError: Error | null = null;

    for (const keyIndex of shuffledKeys) {
      const keyState = this.keyStates[keyIndex];
      for (const modelIndex of shuffledModels) {
        const modelCandidate = this.modelCandidates[modelIndex];

        try {
          const response = await fetch(KILO_GATEWAY_CHAT_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env[keyState.envName] ?? ""}`,
            },
            body: JSON.stringify({
              model: modelCandidate.modelId,
              messages: payload.messages ?? [],
              max_tokens: payload.max_tokens ?? 2048,
              temperature: payload.temperature ?? 0.7,
              response_format: payload.response_format ?? undefined,
            }),
            signal: AbortSignal.timeout(60000),
          });

          const status = response.status;

          if (status === 200) {
            const data = await response.json();
const result: KiloResponse = {
               id: data.id ?? makeId(),
               object: data.object ?? "chat.completion",
              created: data.created ?? Math.floor(Date.now() / 1000),
              model: data.model ?? modelCandidate.modelId,
              choices: Array.isArray(data.choices) && data.choices.length > 0
                ? data.choices.map((choice: any) => ({
                    index: choice.index ?? 0,
                    message: {
                      role: choice.message?.role ?? "assistant",
                      content: choice.message?.content ?? "",
                    },
                    logprobs: choice.logprobs ?? null,
                    finish_reason: choice.finish_reason ?? "stop",
                  }))
                : [],
              usage: {
                prompt_tokens: data.usage?.prompt_tokens ?? 0,
                completion_tokens: data.usage?.completion_tokens ?? 0,
                total_tokens: data.usage?.total_tokens ?? 0,
              },
            };

            keyState.lastCheckedAt = new Date().toISOString();
            keyState.lastSuccessAt = keyState.lastCheckedAt;
            keyState.rateLimited = false;
            modelCandidate.lastCheckedAt = new Date().toISOString();
            modelCandidate.lastSuccessAt = modelCandidate.lastCheckedAt;
            modelCandidate.rateLimited = false;

            return result;
          }

          if (status === 401 || status === 403) {
            keyState.available = false;
            keyState.lastCheckedAt = new Date().toISOString();
            continue;
          }

          if (status === 429 || isGlobalRateLimitStatus(status)) {
            const body = await response.text();
            const code = this.extractRateLimitCode(body);
            const retryAfter = response.headers.get("retry-after");
            const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
            const rateLimitReset = response.headers.get("x-ratelimit-reset");
            let scope: "key" | "model" | "global" | "unknown" | null = "unknown";

            if (code.includes("key") || code.includes("rate_limit_key")) {
              scope = "key";
            } else if (code.includes("model") || code.includes("rate_limit_model")) {
              scope = "model";
            } else if (code.includes("global") || code.includes("ip")) {
              scope = "global";
            }

            const resetAt = this.parseResetAt(retryAfter, rateLimitReset);

            if (scope === "global") {
              for (const key of this.keyStates) {
                key.rateLimited = true;
                key.rateLimitScope = "global";
                key.rateLimitResetAt = resetAt;
                key.rateLimitRemaining = this.parseRateLimitRemaining(rateLimitRemaining);
                key.lastCheckedAt = new Date().toISOString();
              }
              for (const model of this.modelCandidates) {
                model.rateLimited = true;
                model.rateLimitScope = "global";
                model.rateLimitResetAt = resetAt;
              }
              throw new Error("Global Kilo rate limit detected");
            } else if (scope === "key") {
              keyState.rateLimited = true;
              keyState.rateLimitScope = "key";
              keyState.rateLimitResetAt = resetAt;
              keyState.rateLimitRemaining = this.parseRateLimitRemaining(rateLimitRemaining);
              keyState.lastCheckedAt = new Date().toISOString();
            } else if (scope === "model") {
              modelCandidate.rateLimited = true;
              modelCandidate.rateLimitScope = "model";
              modelCandidate.rateLimitResetAt = resetAt;
              modelCandidate.rateLimitRemaining = this.parseRateLimitRemaining(rateLimitRemaining);
              modelCandidate.lastCheckedAt = new Date().toISOString();
            } else {
              keyState.rateLimited = true;
              keyState.rateLimitScope = "unknown";
              keyState.rateLimitResetAt = resetAt;
              keyState.lastCheckedAt = new Date().toISOString();
              modelCandidate.rateLimited = true;
              modelCandidate.rateLimitScope = "unknown";
              modelCandidate.lastCheckedAt = new Date().toISOString();
            }

            lastError = new Error(`Kilo request failed with status ${status}`);
            continue;
          }

          lastError = new Error(`Kilo request failed with status ${status}`);
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          keyState.available = false;
          keyState.lastCheckedAt = new Date().toISOString();
        }
      }
    }

    throw lastError ?? new Error("No available Kilo Gateway key/model combinations");
  }

  async getKiloStatus(): Promise<KiloStatus> {
    if (!this.initialized) {
      await this.initKiloRouter();
    }

    const zeroCostModels = this.modelCandidates
      .filter(m => m.zeroCostVerified && m.available && !m.rateLimited)
      .map(m => m.modelId);

    const usableKeys = this.keyStates.filter(k => k.available && !k.rateLimited).length;
    const rateLimitedKeys = this.keyStates
      .filter(k => k.rateLimited)
      .map((k) => k.keyIndex);

    const rateLimitedModels = this.modelCandidates
      .filter(m => m.rateLimited)
      .map(m => m.modelId);

    const globalRateLimited = this.keyStates.length > 0 &&
      this.keyStates.every(k => k.rateLimited);

    return {
      available: zeroCostModels.length > 0 && usableKeys > 0,
      zeroCostModels,
      defaultModel: DEFAULT_KILO_MODEL_ID,
      activeModel: zeroCostModels.length > 0 ? zeroCostModels[0] : null,
      configuredKeys: this.keyStates.length,
      usableKeys,
      rateLimitedKeys,
      rateLimitedModels,
      globalRateLimited,
      catalogLastRefresh: this.catalogLastRefresh,
    };
  }

  private shuffle<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const cryptoArray = crypto.getRandomValues(new Uint32Array(1));
      const j = cryptoArray[0] % (i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}

export const kiloRouter = new KiloRouter();
