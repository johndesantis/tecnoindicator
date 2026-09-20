import { getCache, setCache } from "./cache.js";
import { FACTORS_CACHE_MS } from "./http.js";
import { safeParseJson } from "./validation.js";
import { kiloRouter } from "./kiloRouter.js";
import { REGION_NAMES, type Region } from "./regions.js";
import type { CommodityId, Factor, RegionId, Solution } from "./types.js";

export const SOLUTIONS_CACHE_MS = 10 * 60 * 1000;
export const MAX_SOLUTIONS = 3;

const SYSTEM_PROMPT_GLOBAL =
  "You are a Senior Commodity Risk Analyst and Supply Chain Strategist. Based on the current validated global market factors and analytics provided, generate actionable solution recommendations for global oil, electricity, and water market participants.\n\nEach solution must be directly tied to one of the supplied factors, explain the specific action to take, and describe the expected impact. Solutions must be concrete, operationally useful, and regionally appropriate for a global audience. Do not invent facts or sources.\n\nReturn strict JSON only. Do not return markdown or commentary outside JSON.\n\nThe response must contain exactly three solution recommendations matching the required schema.";

const SYSTEM_PROMPT_REGIONAL = (regionName: string) =>
  `You are a Senior Commodity Risk Analyst and Supply Chain Strategist specializing in ${regionName} energy and water markets. Based on the current validated ${regionName}-specific market factors and analytics provided, generate actionable solution recommendations for ${regionName} oil, electricity, and water market participants.\n\nEach solution must be directly tied to one of the supplied factors, explain the specific action to take, and describe the expected impact. Solutions must be concrete, operationally useful, and tailored to ${regionName}. Do not invent facts or sources.\n\nReturn strict JSON only. Do not return markdown or commentary outside JSON.\n\nThe response must contain exactly three solution recommendations matching the required schema.`;

function isCommodity(value: unknown): value is CommodityId {
  return value === "oil" || value === "electricity" || value === "water";
}

export function normalizeSolution(
  raw: unknown,
  scope: RegionId,
  factorNames: string[],
): Solution | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const title = typeof s.title === "string" ? s.title.trim() : "";
  const description = typeof s.description === "string" ? s.description.trim() : "";
  const action = typeof s.action === "string" ? s.action.trim() : "";
  const expectedImpact = typeof s.expectedImpact === "string" ? s.expectedImpact.trim() : "";
  const category =
    typeof s.category === "string" && s.category.trim()
      ? s.category.trim()
      : "Market Response";
  const basedOnFactor =
    typeof s.basedOnFactor === "string" && s.basedOnFactor.trim()
      ? s.basedOnFactor.trim()
      : factorNames[0] ?? "Current market trend";
  const commodities = Array.isArray(s.commodities)
    ? (s.commodities as unknown[]).filter(isCommodity)
    : [];
  if (!title || !description || !action || !expectedImpact || commodities.length === 0)
    return null;

  const now = new Date().toISOString();
  return {
    id:
      typeof s.id === "string" && s.id.trim()
        ? s.id.trim().slice(0, 120)
        : `solution-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    region: scope,
    title: title.slice(0, 140),
    description: description.slice(0, 600),
    category: category.slice(0, 80),
    commodities: Array.from(new Set(commodities)),
    basedOnFactor: basedOnFactor.slice(0, 240),
    action: action.slice(0, 800),
    expectedImpact: expectedImpact.slice(0, 400),
    createdAt: now,
    updatedAt: now,
  };
}

function dedupeSolutions(solutions: Solution[]): Solution[] {
  const seen = new Set<string>();
  const out: Solution[] = [];
  for (const s of solutions) {
    const key = s.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export function replaceOldestSolutions(
  current: Solution[],
  incoming: Solution[],
  maxSolutions = MAX_SOLUTIONS,
): Solution[] {
  let next = dedupeSolutions([...current, ...incoming]);
  if (next.length > maxSolutions) {
    const oldest = next
      .map((s) => ({ s, ts: Date.parse(s.createdAt) || 0 }))
      .sort((a, b) => a.ts - b.ts)
      .slice(0, next.length - maxSolutions);
    const oldestIds = new Set(oldest.map((o) => o.s.id));
    next = next.filter((s) => !oldestIds.has(s.id));
  }
  return next
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, maxSolutions);
}

export function buildFallbackSolutions(scope: RegionId): Solution[] {
  const now = new Date().toISOString();
  const regionName = scope === "global" ? "Global" : REGION_NAMES[scope as Region];
  const titles: Record<RegionId, string[]> = {
    global: [
      "Diversify Supply Sources",
      "Adjust Procurement Timing",
      "Hedge Price Volatility",
    ],
    asia: [
      "Rebalance Regional Sourcing",
      "Optimize Shipping Schedules",
      "Secure Flexible Contracts",
    ],
    europe: [
      "Shift to Flexible Suppliers",
      "Align Inventory with Demand",
      "Use Forward Contracts",
    ],
    africa: [
      "Localize Procurement",
      "Stagger Delivery Windows",
      "Monitor Fuel Costs",
    ],
    americas: [
      "Reconfigure Transport Routes",
      "Time Purchases to Cycles",
      "Lock in Volume Pricing",
    ],
    oceania: [
      "Prioritize Local Supply",
      "Schedule Around Port Windows",
      "Build Strategic Stockpiles",
    ],
  };
  return titles[scope].map((title, index) => ({
    id: `fallback-solution-${scope}-${index + 1}`,
    region: scope,
    title,
    description: `Dynamic ${regionName.toLowerCase()} solution maintained when AI curation is temporarily unavailable.`,
    category: index % 2 === 0 ? "Supply Chain" : "Procurement",
    commodities: ["oil", "electricity", "water"],
    basedOnFactor: "Current market conditions",
    action: "Review current supplier and logistics exposure, then adjust timing or routing to reduce price risk.",
    expectedImpact: "Moderates exposure to short-term price swings while preserving operational flexibility.",
    createdAt: now,
    updatedAt: now,
  }));
}

export async function runSolutionAnalysis(
  scope: RegionId,
  region: Region | null,
  factors: Factor[] = [],
): Promise<Solution[]> {
  const current = await getCache<Solution[]>(`dynamic-solutions:${scope}`, SOLUTIONS_CACHE_MS);
  if (current && current.length > 0) return current;

  const factorCacheKey = `dynamic-factors:${scope}`;
  const cachedFactors =
    factors.length > 0
      ? factors
      : (await getCache<Factor[]>(factorCacheKey, FACTORS_CACHE_MS)) ?? [];

  const analytics =
    scope === "global"
      ? await import("./deterministicAnalytics.js").then((m) => m.getGlobalAnalytics())
      : await import("./deterministicAnalytics.js").then((m) => m.getRegionalAnalytics(region!));

  const factorNames = cachedFactors.map((f) => f.name);
  const prompt =
    scope === "global" ? SYSTEM_PROMPT_GLOBAL : SYSTEM_PROMPT_REGIONAL(REGION_NAMES[region!]);
  const payload = {
    messages: [
      { role: "system", content: prompt },
      {
        role: "user",
        content: JSON.stringify({
          analytics,
          factors: cachedFactors.map((f) => ({
            name: f.name,
            explanation: f.explanation,
            direction: f.direction,
            magnitude: f.magnitude,
            commodities: f.commodities,
            importanceScore: f.importanceScore,
            source: f.source,
          })),
          region: region ?? null,
        }),
      },
    ],
    max_tokens: 4096,
    temperature: 0.2,
  };

  const response = await kiloRouter.kiloInfer(payload);
  const content = response.choices?.[0]?.message?.content ?? "";
  const parsed = safeParseJson<{ solutions?: unknown[] }>(content);
  if (!parsed?.solutions) return buildFallbackSolutions(scope);

  const normalized = parsed.solutions
    .map((s) => normalizeSolution(s, scope, factorNames))
    .filter((s): s is Solution => s !== null)
    .slice(0, MAX_SOLUTIONS);
  if (normalized.length === 0) return buildFallbackSolutions(scope);

  return replaceOldestSolutions(current ?? [], normalized);
}

export async function getOrCreateSolutions(scope: RegionId): Promise<Solution[]> {
  const cacheKey = `dynamic-solutions:${scope}`;
  const cached = await getCache<Solution[]>(cacheKey, SOLUTIONS_CACHE_MS);
  if (cached && cached.length > 0) return cached;

  const region = scope === "global" ? null : (scope as Region);
  const solutions = await runSolutionAnalysis(scope, region);
  await setCache(cacheKey, solutions, SOLUTIONS_CACHE_MS);
  return solutions;
}
