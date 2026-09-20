import { kiloRouter } from "../_shared/kiloRouter.js";
import { tinyfishRouter } from "../_shared/tinyfishRouter.js";
import { REGION_NAMES, type Region } from "../_shared/regions.js";
import { getGlobalAnalytics, getRegionalAnalytics } from "../_shared/deterministicAnalytics.js";
import { FACTORS_CACHE_MS } from "../_shared/http.js";
import { getCache, setCache } from "../_shared/cache.js";
import { safeParseJson, sanitizeError } from "../_shared/validation.js";
import type { Factor, Solution, RegionId } from "../_shared/types.js";
import { runSolutionAnalysis } from "../_shared/solutions.js";

const MAX_FACTORS = 8;
const MAX_SOLUTIONS = 3;
const REGIONS: Region[] = ["asia", "europe", "africa", "americas", "oceania"];

const SYSTEM_PROMPT_GLOBAL =
  "You are a Senior Commodity Risk Analyst. You are provided with current global market analytics, an existing list of global price factors, and fresh validated news excerpts collected through TinyFish.\n\nValidate each candidate trend against the supplied current global market conditions and source evidence.\n\nDetermine whether each candidate is a legitimate market-moving trend or noise at a global scale. Reject stale, duplicate, promotional, speculative, unsupported, irrelevant, or weakly evidenced claims.\n\nFor each legitimate trend, evaluate its expected effect on global oil, electricity, or water prices. Assign an integer importance score from 0 to 100 based on evidence quality, geographic scope, affected commodities, expected price impact, duration, and immediacy.\n\nExplain why each approved trend is legitimate and globally relevant right now. Use only the supplied analytics, factors, excerpts, and source URLs. Do not invent sources or facts.\n\nReturn strict JSON only. Do not return markdown or commentary outside JSON.\n\nThe response must contain exactly eight validated global factors matching the required schema. If a new legitimate trend is identified, include its new factor details. The deterministic server-side application logic will handle duplicate detection, importance thresholds, timestamps, and removal of the oldest factor.";

const SYSTEM_PROMPT_REGIONAL = (regionName: string) =>
  `You are a Senior Commodity Risk Analyst specializing in ${regionName} energy and water markets. You are provided with current ${regionName}-specific market analytics, an existing list of ${regionName} price factors, and fresh validated news excerpts collected through TinyFish that are relevant to ${regionName}.\n\nValidate each candidate trend against the supplied current ${regionName} market conditions and source evidence.\n\nDetermine whether each candidate is a legitimate market-moving trend or noise within ${regionName}. Reject stale, duplicate, promotional, speculative, unsupported, irrelevant, or weakly evidenced claims. Reject any trend that is purely global with no demonstrated ${regionName}-specific price impact.\n\nFor each legitimate trend, evaluate its expected effect on ${regionName} oil, electricity, or water prices specifically. Assign an integer importance score from 0 to 100 based on evidence quality, ${regionName} geographic scope, affected commodities, expected regional price impact, duration, and immediacy within ${regionName}.\n\nExplain why each approved trend is legitimate and relevant to ${regionName} right now. Use only the supplied analytics, factors, excerpts, and source URLs. Do not invent sources or facts.\n\nReturn strict JSON only. Do not return markdown or commentary outside JSON.\n\nThe response must contain exactly eight validated ${regionName} factors matching the required schema. If a new legitimate trend is identified for ${regionName}, include its new factor details. The deterministic server-side application logic will handle duplicate detection, importance thresholds, timestamps, and removal of the oldest factor.`;

const GLOBAL_QUERIES = [
  "global oil market prices OPEC supply demand 2026",
  "global electricity power prices renewable energy grid 2026",
  "global water prices scarcity drought utilities 2026",
];

const REGION_QUERIES: Record<Region, string[]> = {
  asia: [
    "Asia oil market prices China India demand OPEC 2026",
    "Asia electricity power prices renewables grid China India 2026",
    "Asia water prices scarcity drought urbanization 2026",
  ],
  europe: [
    "Europe oil market prices Brent Russian supply sanctions 2026",
    "Europe electricity power prices carbon ETS renewables gas 2026",
    "Europe water prices drought scarcity Alpine hydropower 2026",
  ],
  africa: [
    "Africa oil market prices Nigeria Angola production exports 2026",
    "Africa electricity power prices diesel gensets grid reliability 2026",
    "Africa water prices drought scarcity Sahel utilities 2026",
  ],
  americas: [
    "Americas oil market prices WTI shale LNG exports 2026",
    "Americas electricity power prices hydro drought Henry Hub 2026",
    "Americas water prices drought California Southwest utilities 2026",
  ],
  oceania: [
    "Oceania oil market prices LNG import parity Australia 2026",
    "Oceania electricity power prices NEM NZ wholesale drought 2026",
    "Oceania water prices drought Sydney Melbourne utilities 2026",
  ],
};

const REPUTABLE_HOSTS = [
  "opec.org", "iea.org", "eia.gov", "worldbank.org", "un.org", "unep.org",
  "wri.org", "wrm.org", "oecd.org", "imf.org", "reuters.com", "apnews.com",
  "ft.com", "bloomberg.com", "energy.gov", "eurostat.europa.eu", "afdb.org",
  "adb.org", "asean.org", "europa.eu", "gov.au", "govt.nz", "gov.za", "gov.ng",
  "gov.in", "gov.cn", "gov.br", "gov.mx", "gov.ar", "gov.eg", "gov.ae", "gov.sa",
  "gov.qa", "gov.tr", "gov.id", "gov.my", "gov.ph", "gov.vn", "ieeewrc.org",
  "irena.org", "cdn.irena.org", "globalpetrolprices.com", "waterplaza.nl",
  "waterworld.com", "wateronline.com", "energyinst.org", "enerdata.net",
  "platts.com", "gulfnews.com", "thenationalnews.com", "thegazette.co.jm",
  "businessday.ng", "allafrica.com", "africanews.com", "screendaily.com",
];

const RECENT_MONTH = () =>
  new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });

function isReputableSource(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return REPUTABLE_HOSTS.some((prefix) => host === prefix || host.endsWith(`.${prefix}`));
  } catch {
    return false;
  }
}

function isRecentPublishedAt(value: string | undefined): boolean {
  if (!value) return true;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return true;
  const cutoff = Date.now() - 180 * 24 * 60 * 60 * 1000;
  return date >= cutoff;
}

function normalizeFactor(raw: unknown, scope: "global" | Region, region: Region | null): Factor | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const name = typeof f.name === "string" ? f.name.trim() : "";
  const explanation = typeof f.explanation === "string" ? f.explanation.trim() : "";
  const source = typeof f.source === "string" ? f.source.trim() : "";
  const id = typeof f.id === "string" && f.id.trim() ? f.id.trim() : `dynamic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const category = typeof f.category === "string" && f.category.trim() ? f.category.trim() : "Market";
  const direction = f.direction === "up" || f.direction === "down" || f.direction === "mixed" ? f.direction : "mixed";
  const magnitude = f.magnitude === "High" || f.magnitude === "Medium" || f.magnitude === "Low" ? f.magnitude : "Medium";
  const bias = f.bias === "short" || f.bias === "mid" || f.bias === "long" || f.bias === "flat" ? f.bias : "flat";
  const importanceScore =
    typeof f.importanceScore === "number" && Number.isFinite(f.importanceScore)
      ? Math.max(0, Math.min(100, Math.round(f.importanceScore)))
      : 0;
  const commodities = Array.isArray(f.commodities)
    ? (f.commodities as string[]).filter((c) => c === "oil" || c === "electricity" || c === "water")
    : [];
  const regions =
    f.regions && Array.isArray(f.regions)
      ? ((f.regions as string[]).filter((r) => r === "global" || (REGION_NAMES as Record<string, string>)[r]))
      : scope === "global"
        ? ["global"]
        : region
          ? [region]
          : [];

  if (!name || !explanation || !source || importanceScore < 20 || commodities.length === 0) return null;

  return {
    id: id.slice(0, 80),
    name: name.slice(0, 160),
    category: category.slice(0, 80),
    commodities: Array.from(new Set(commodities)) as Factor["commodities"],
    explanation: explanation.slice(0, 1200),
    direction,
    magnitude,
    source,
    bias,
    drift:
      f.drift && typeof f.drift === "object"
        ? {
            ...(typeof (f.drift as Record<string, unknown>).oil === "number" && Number.isFinite((f.drift as Record<string, unknown>).oil) ? { oil: (f.drift as Record<string, unknown>).oil as number } : {}),
            ...(typeof (f.drift as Record<string, unknown>).electricity === "number" && Number.isFinite((f.drift as Record<string, unknown>).electricity) ? { electricity: (f.drift as Record<string, unknown>).electricity as number } : {}),
            ...(typeof (f.drift as Record<string, unknown>).water === "number" && Number.isFinite((f.drift as Record<string, unknown>).water) ? { water: (f.drift as Record<string, unknown>).water as number } : {}),
          }
        : {},
    regions: Array.from(new Set(regions)) as Factor["regions"],
    scope,
    importanceScore,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function dedupeFactors(factors: Factor[]): Factor[] {
  const seen = new Set<string>();
  const out: Factor[] = [];
  for (const f of factors) {
    const key = f.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function replaceOldest(factors: Factor[], incoming: Factor[]): Factor[] {
  let next = [...factors, ...incoming];
  next = dedupeFactors(next);
  const byScope = (f: Factor) => f.scope;
  const currentScope = (f: Factor): boolean =>
    f.scope === "global" || (byScope(f) as string) === (incoming[0]?.scope as string);
  next = next.filter(currentScope);
  if (next.length > MAX_FACTORS) {
    const oldest = next
      .map((f) => ({ f, ts: Date.parse(f.createdAt) || 0 }))
      .sort((a, b) => a.ts - b.ts)
      .slice(0, next.length - MAX_FACTORS);
    const oldestIds = new Set(oldest.map((o) => o.f.id));
    next = next.filter((f) => !oldestIds.has(f.id));
  }
  return next.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, MAX_FACTORS);
}

function buildFallbackFactors(scope: "global" | Region, region: Region | null): Factor[] {
  const now = new Date().toISOString();
  const names: Record<"global" | Region, string[]> = {
    global: ["OPEC+ Production Decisions", "Geopolitical Tensions & Supply Disruptions", "Demand Growth in China & India", "Renewable Energy Buildout", "Weather & Temperature Extremes", "Water Scarcity & Drought", "Desalination & Reuse Technology", "Grid & Water Infrastructure Investment"],
    asia: ["China & India Energy Demand Growth", "ASEAN Grid Interconnection", "Coal-to-Gas Switching", "Strait of Hormuz Risk", "Urbanization & Desalination", "Renewable Energy Buildout", "Monsoon & Hydropower Variability", "EV Adoption & Battery Storage"],
    europe: ["EU ETS Carbon Price", "Russian Supply Displacement", "Renewables Curtailment Risk", "Drought & Alpine Hydro", "Nuclear & Gas Generation Mix", "Energy Efficiency Mandates", "Offshore Wind Expansion", "Heat Pump Electrification"],
    africa: ["Nigeria & Angola Production", "Diesel Genset Dependence", "Drought & Sahel Scarcity", "Subsidy Reform Pressure", "Hydroelectric Reliance", "Solar Mini-Grid Deployment", "Copper & Critical Minerals Demand", "Diesel Import Parity Pricing"],
    americas: ["US Shale Productivity", "Henry Hub Gas to Power", "LatAm Hydrology & Drought", "Pipeline & Export Capacity", "California Water Stress", "Grid Resilience Investment", "EV Adoption & Battery Storage", "LNG Export Growth"],
    oceania: ["LNG Export Linkage", "NEM & NZ Wholesale Spikes", "Millennium Drought Legacy", "Remote Island Fuel Premiums", "Desalination & Reuse", "Renewable Energy Zones", "Coal Plant Retirements", "Urban Water Tariff Reform"],
  };
  const source = scope === "global" ? "Public market benchmarks (EIA, IEA, OPEC, UN-Water)" : `${REGION_NAMES[(region ?? "asia") as Region]} regional energy authorities and public benchmarks`;
  const commodities: Factor["commodities"] = ["oil", "electricity", "water"];
  return names[scope].slice(0, MAX_FACTORS).map((name, i) => ({
    id: `fallback-${scope}-${i + 1}`,
    name,
    category: i % 3 === 0 ? "Policy" : i % 3 === 1 ? "Market" : "Structural",
    commodities,
    explanation: `Static ${scope === "global" ? "global" : REGION_NAMES[(region ?? "asia") as Region]} fallback factor maintained when live AI curation is unavailable.`,
    direction: i % 3 === 2 ? "mixed" : i % 2 === 0 ? "up" : "down",
    magnitude: (["High", "Medium", "Low"] as const)[i % 3],
    source,
    bias: (["short", "mid", "long", "flat"] as const)[i % 4],
    drift: {},
    regions: scope === "global" ? ["global"] : [region ?? "global"],
    scope,
    importanceScore: 70 - i * 2,
    createdAt: now,
    updatedAt: now,
  }));
}

async function runFactorAnalysis(scope: "global" | Region, region: Region | null): Promise<Factor[]> {
  const cacheKey = `dynamic-factors:${scope}`;
  const current = await getCache<Factor[]>(cacheKey, FACTORS_CACHE_MS);
  if (current) return current;
  const analytics = scope === "global" ? await getGlobalAnalytics() : await getRegionalAnalytics(region!);
  const existing = current ?? buildFallbackFactors(scope, region);
  const searchQuery = (REGION_QUERIES[region ?? "asia"] ?? GLOBAL_QUERIES)[0];
  const search = await tinyfishRouter.tinyfishSearch(`${searchQuery} ${RECENT_MONTH()}`, { limit: 10, region: region ?? undefined });
  const candidates = search.results
    .map((r) => ({ ...r, snippet: typeof r.snippet === "string" ? r.snippet : "" }))
    .filter((r) => isReputableSource(r.url) && isRecentPublishedAt(r.publishedAt))
    .slice(0, 5);
  if (candidates.length === 0) return buildFallbackFactors(scope, region);
  const excerpts = await Promise.all(
    candidates.map(async (r) => {
      try {
        const scraped = await tinyfishRouter.tinyfishScrape(r.url);
        return scraped
          ? { ...r, text: scraped.text, title: scraped.title || r.title }
          : r;
      } catch {
        return r;
      }
    }),
  );
  const prompt =
    scope === "global"
      ? SYSTEM_PROMPT_GLOBAL
      : SYSTEM_PROMPT_REGIONAL(REGION_NAMES[(region ?? "asia") as Region]);
  const payload = {
    messages: [
      { role: "system", content: prompt },
      {
        role: "user",
        content: JSON.stringify({
          analytics,
          existingFactors: existing,
          candidates: excerpts.map((c) => ({ title: c.title, source: c.url, snippet: c.snippet?.slice(0, 2500), text: (c as any).text?.slice(0, 8000) })),
          region: region ?? null,
          month: RECENT_MONTH(),
        }),
      },
    ],
    max_tokens: 4096,
    temperature: 0.2,
  };
  const response = await kiloRouter.kiloInfer(payload);
  const content = response.choices?.[0]?.message?.content ?? "";
  const parsed = safeParseJson<{ factors?: unknown[] }>(content);
  if (!parsed?.factors) return buildFallbackFactors(scope, region);
  const normalized = parsed.factors
    .map((f) => normalizeFactor(f, scope, region))
    .filter((f): f is Factor => f !== null)
    .filter((f) => f.scope === scope || (scope === "global" && f.regions?.includes("global")))
    .slice(0, MAX_FACTORS);
  return replaceOldest(existing, normalized);
}

function buildFallbackSolutions(scope: "global" | Region): Solution[] {
  const now = new Date().toISOString();
  const regionName = scope === "global" ? "Global" : REGION_NAMES[scope];
  const titles: Record<RegionId, string[]> = {
    global: ["Diversify Supply Sources", "Adjust Procurement Timing", "Hedge Price Volatility"],
    asia: ["Rebalance Regional Sourcing", "Optimize Shipping Schedules", "Secure Flexible Contracts"],
    europe: ["Shift to Flexible Suppliers", "Align Inventory with Demand", "Use Forward Contracts"],
    africa: ["Localize Procurement", "Stagger Delivery Windows", "Monitor Fuel Costs"],
    americas: ["Reconfigure Transport Routes", "Time Purchases to Cycles", "Lock in Volume Pricing"],
    oceania: ["Prioritize Local Supply", "Schedule Around Port Windows", "Build Strategic Stockpiles"],
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

async function runSolutionCuration(scope: RegionId, region: Region | null): Promise<Solution[]> {
  const factors =
    (await getCache<Factor[]>(`dynamic-factors:${scope}`, FACTORS_CACHE_MS)) ?? [];
  return runSolutionAnalysis(scope, region, factors);
}

export default async function handler(_req: Request): Promise<Response> {
  try {
    const results: Record<string, { success: boolean; count: number; error?: string }> = {};

    // Curate global factors
    try {
      const globalFactors = await runFactorAnalysis("global", null);
      const cacheKey = `dynamic-factors:global`;
      await setCache(cacheKey, globalFactors, FACTORS_CACHE_MS);
      results.global = { success: true, count: globalFactors.length };
    } catch (error) {
      results.global = { success: false, count: 0, error: sanitizeError(String(error)) };
    }

    // Curate global solutions
    try {
      const globalSolutions = await runSolutionCuration("global", null);
      const cacheKey = `dynamic-solutions:global`;
      await setCache(cacheKey, globalSolutions, FACTORS_CACHE_MS);
      results["global-solutions"] = { success: true, count: globalSolutions.length };
    } catch (error) {
      results["global-solutions"] = { success: false, count: 0, error: sanitizeError(String(error)) };
    }

    // Curate regional factors and solutions for all regions
    for (const region of REGIONS) {
      try {
        const regionalFactors = await runFactorAnalysis(region, region);
        const cacheKey = `dynamic-factors:${region}`;
        await setCache(cacheKey, regionalFactors, FACTORS_CACHE_MS);
        results[region] = { success: true, count: regionalFactors.length };
      } catch (error) {
        results[region] = { success: false, count: 0, error: sanitizeError(String(error)) };
      }
      try {
        const regionalSolutions = await runSolutionCuration(region, region);
        const cacheKey = `dynamic-solutions:${region}`;
        await setCache(cacheKey, regionalSolutions, FACTORS_CACHE_MS);
        results[`${region}-solutions`] = { success: true, count: regionalSolutions.length };
      } catch (error) {
        results[`${region}-solutions`] = { success: false, count: 0, error: sanitizeError(String(error)) };
      }
    }

    return Response.json({ success: true, curated: results, timestamp: new Date().toISOString() }, { status: 200 });
  } catch (error) {
    console.error("Cron curation error:", sanitizeError(String(error)));
    return Response.json({ success: false, error: "Cron curation failed" }, { status: 500 });
  }
}