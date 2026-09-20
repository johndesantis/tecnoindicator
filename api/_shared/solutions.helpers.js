import { runSolutionAnalysis, replaceOldestSolutions } from "./_shared/solutions.js";
import { getCache, setCache } from "./cache.js";
import { FACTORS_CACHE_MS } from "./http.js";
import { getGlobalAnalytics } from "./deterministicAnalytics.js";
import { buildFallbackSolutions } from "./_shared/solutions.js";
import { getCacheOrSet, invalidateCache } from "./cache.js";
import type { RegionId } from "./types.js";

export const SOLUTIONS_CACHE_MS = 10 * 60 * 1000;
export const MAX_SOLUTIONS = 3;

export const isValidRegionId = (value: string | null): value is RegionId => {
  if (!value) return true;
  const validRegionIds: RegionId[] = [
    "global",
    "americas",
    "europe",
    "asia",
    "africa",
    "oceania",
  ];
  return validRegionIds.includes(value as RegionId);
};

export async function getOrCreateSolutions(scope: RegionId): Promise<unknown[]> {
  const cacheKey = `dynamic-solutions:${scope}`;
  const cached = await getCache<unknown[]>(cacheKey, SOLUTIONS_CACHE_MS);
  if (cached && cached.length > 0) return cached;

  const region = scope === "global" ? null : scope as any;
  const factors = await getDynamicFactors(scope);
  const solutions = await runSolutionAnalysis(scope, region, factors);
  await setCache(cacheKey, solutions, SOLUTIONS_CACHE_MS);
  return solutions;
}

export async function getDynamicFactors(scope: RegionId): Promise<unknown[]> {
  const factorCacheKey = `dynamic-factors:${scope}`;
  const cached = await getCache<unknown[]>(factorCacheKey, FACTORS_CACHE_MS);
  if (cached && cached.length > 0) return cached;

  const fallback = await buildFallbackSolutions(scope);
  return fallback;
}

export async function refreshSolutions(scope: RegionId): Promise<unknown[]> {
  const region = scope === "global" ? null : scope as any;
  const factors = await getDynamicFactors(scope);
  const solutions = await runSolutionAnalysis(scope, region, factors);
  const cacheKey = `dynamic-solutions:${scope}`;
  await setCache(cacheKey, solutions, SOLUTIONS_CACHE_MS);
  return solutions;
}
