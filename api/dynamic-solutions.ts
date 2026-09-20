import { kiloRouter } from "./_shared/kiloRouter.js";
import { tinyfishRouter } from "./_shared/tinyfishRouter.js";
import { REGION_NAMES, type Region } from "./_shared/regions.js";
import { getGlobalAnalytics, getRegionalAnalytics } from "./_shared/deterministicAnalytics.js";
import { FACTORS_CACHE_MS } from "./_shared/http.js";
import { getCache, setCache } from "./_shared/cache.js";
import { safeParseJson, sanitizeError } from "./_shared/validation.js";
import type { Solution, RegionId } from "./_shared/types.js";
import { buildFallbackSolutions } from "./_shared/solutions.js";

export const MAX_SOLUTIONS = 3;

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
  "adb.org", "asean.org", "europa.eu", "gov.au", "govt.nz", "gov.za",
  "gov.ng", "gov.in", "gov.cn", "gov.br", "gov.mx", "gov.ar", "gov.eg",
  "gov.ae", "gov.sa", "gov.qa", "gov.tr", "gov.id", "gov.my", "gov.ph",
  "gov.vn", "ieeewrc.org", "irena.org", "cdn.irena.org", "globalpetrolprices.com",
  "waterplaza.nl", "waterworld.com", "wateronline.com", "energyinst.org",
  "enerdata.net", "platts.com", "gulfnews.com", "thenationalnews.com",
  "thegazette.co.jm", "businessday.ng", "allafrica.com", "africanews.com",
];

const RECENT_MONTH = () => new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });

function isRecentPublishedAt(value: string | undefined): boolean {
  if (!value) return true;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return true;
  return date >= Date.now() - 180 * 24 * 60 * 60 * 1000;
}

function normalizeSolution(raw: unknown, scope: RegionId): Solution | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const title = typeof s.title === "string" ? s.title.trim() : "";
  const description = typeof s.description === "string" ? s.description.trim() : "";
  const action = typeof s.action === "string" ? s.action.trim() : "";
  const expectedImpact = typeof s.expectedImpact === "string" ? s.expectedImpact.trim() : "";
  const category = typeof s.category === "string" && s.category.trim() ? s.category.trim() : "Market Response";
  const basedOnFactor = typeof s.basedOnFactor === "string" && s.basedOnFactor.trim() ? s.basedOnFactor.trim() : "Current market trend";
  const commodities = Array.isArray(s.commodities) ? (s.commodities as string[]).filter((c) => c === "oil" || c === "electricity" || c === "water") : [];
  if (!title || !description || !action || !expectedImpact || commodities.length === 0) return null;
  const now = new Date().toISOString();
  return {
    id: typeof s.id === "string" && s.id.trim() ? s.id.trim().slice(0, 120) : `solution-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    region: scope,
    title: title.slice(0, 140),
    description: description.slice(0, 600),
    category: category.slice(0, 80),
    commodities: Array.from(new Set(commodities)) as Solution["commodities"],
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

function replaceOldest(current: Solution[], incoming: Solution[]): Solution[] {
  let next = dedupeSolutions([...current, ...incoming]);
  if (next.length > MAX_SOLUTIONS) {
    const oldest = next.map((s) => ({ s, ts: Date.parse(s.createdAt) || 0 })).sort((a, b) => a.ts - b.ts).slice(0, next.length - MAX_SOLUTIONS);
    const oldestIds = new Set(oldest.map((o) => o.s.id));
    next = next.filter((s) => !oldestIds.has(s.id));
  }
  return next.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, MAX_SOLUTIONS);
}

async function fetchNews(scope: RegionId): Promise<Array<{ title: string; url: string; snippet: string; publishedAt?: string }>> {
  const queries = scope === "global" ? GLOBAL_QUERIES : REGION_QUERIES[scope as Region];
  const candidates: Array<{ title: string; url: string; snippet: string; publishedAt?: string }> = [];
  for (const q of queries) {
    try {
      const search = await tinyfishRouter.tinyfishSearch(`${q} ${RECENT_MONTH()}`, { limit: 4 });
      const items = search.results.filter((r) => isReputableSource(r.url) && isRecentPublishedAt(r.publishedAt)).slice(0, 3);
      for (const r of items) candidates.push({ title: r.title, url: r.url, snippet: r.snippet ?? "", publishedAt: r.publishedAt });
    } catch { /* skip */ }
  }
  return candidates.slice(0, 8);
}

async function analyzeSolutions(scope: RegionId): Promise<Solution[]> {
  const current = await getCache<Solution[]>(`dynamic-solutions:${scope}`, FACTORS_CACHE_MS);
  const analytics = scope === "global" ? await getGlobalAnalytics() : await getRegionalAnalytics(scope as Region);
  const factors = (await getCache<any[]>(`dynamic-factors:${scope}`, FACTORS_CACHE_MS)) ?? [];
  const news = await fetchNews(scope);
  const systemPrompt = scope === "global"
    ? "You are a Senior Commodity Risk Analyst and Supply Chain Strategist. Based on current global market factors, analytics, and news excerpts, generate exactly 3 actionable solution recommendations for global oil, electricity, and water market participants. Each solution must be tied to a specific factor/trend, include the concrete action to take, and describe expected impact. Solutions must be AI-generated and dynamic — no static or hardcoded solutions are permitted. Return strict JSON only (no markdown)."
    : `You are a Senior Commodity Risk Analyst specializing in ${REGION_NAMES[scope as Region]} energy and water markets. Based on current ${REGION_NAMES[scope as Region]}-specific market factors, analytics, and news excerpts, generate exactly 3 actionable solution recommendations for ${REGION_NAMES[scope as Region]} oil, electricity, and water market participants. Each solution must be tied to a specific factor/trend, include the concrete action to take, and describe expected impact. Solutions must be AI-generated and dynamic — no static or hardcoded solutions are permitted. Return strict JSON only (no markdown).`;
  const payload = { messages: [{ role: "system", content: systemPrompt }, { role: "user", content: JSON.stringify({ analytics, factors: factors.map((f: any) => ({ name: f.name, explanation: f.explanation, direction: f.direction, magnitude: f.magnitude, commodities: f.commodities, importanceScore: f.importanceScore })), news: news.map((n) => ({ title: n.title, source: n.url, snippet: n.snippet?.slice(0, 2000) })) })] } };
  const response = await kiloRouter.kiloInfer({ ...payload, max_tokens: 4096, temperature: 0.2 });
  const content = response.choices?.[0]?.message?.content ?? "";
  const parsed = safeParseJson<{ solutions?: unknown[] }>(content);
  if (!parsed?.solutions) return buildFallbackSolutions(scope);
  const normalized = parsed.solutions.map((s) => normalizeSolution(s, scope)).filter(Boolean) as Solution[];
  return replaceOldest(current ?? [], normalized);
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "true";
    const scope = (url.searchParams.get("scope") ?? "global") as RegionId;
    if (!["global", "asia", "europe", "africa", "americas", "oceania"].includes(scope)) {
      return Response.json({ error: "Invalid scope. Must be one of: global, asia, europe, africa, americas, oceania" }, { status: 400 });
    }
    const cacheKey = `dynamic-solutions:${scope}`;
    if (!force) { const cached = await getCache<Solution[]>(cacheKey, FACTORS_CACHE_MS); if (cached && cached.length > 0) return Response.json({ solutions: cached, scope, count: cached.length, aiCurated: true, cacheKey, updatedAt: new Date().toISOString() }, { status: 200 }); }
    const solutions = await analyzeSolutions(scope);
    await setCache(cacheKey, solutions, FACTORS_CACHE_MS);
    return Response.json({ solutions, scope, count: solutions.length, aiCurated: true, cacheKey, updatedAt: new Date().toISOString() }, { status: 200 });
  } catch (error) {
    console.error("Dynamic solutions error:", sanitizeError(String(error)));
    return Response.json({ error: sanitizeError(String(error)), solutions: buildFallbackSolutions("global"), scope: "global", count: 3, aiCurated: false, updatedAt: new Date().toISOString() }, { status: 200 });
  }
}
