import { kiloRouter } from "./_shared/kiloRouter.js";
import { tinyfishRouter } from "./_shared/tinyfishRouter.js";
import { getCache, setCache } from "./_shared/cache.js";
import { FACTORS_CACHE_MS } from "./_shared/http.js";
import { safeParseJson, sanitizeError } from "./_shared/validation.js";
import type { CommodityId, RegionId } from "./_shared/types.js";

const PRICES_CACHE_MS = 10 * 60 * 1000;

const COMMODITY_PRICE_QUERIES: Record<CommodityId, string[]> = {
  oil: ["Brent crude oil price USD per barrel today live", "oil price today live spot market 2026"],
  electricity: ["global electricity wholesale price MWh today live", "electricity spot price MWh today 2026"],
  water: ["water tariff price per cubic meter today", "municipal water price USD per m3 2026"],
};

const REGION_PRICE_QUERIES: Record<RegionId, Record<CommodityId, string[]>> = {
  global: COMMODITY_PRICE_QUERIES,
  asia: {
    oil: ["Dubai oil price USD per barrel today", "Asia crude oil price today 2026"],
    electricity: ["Asia electricity wholesale price MWh today", "Asia power price today 2026"],
    water: ["Asia water tariff price per cubic meter today", "Asia water price 2026"],
  },
  europe: {
    oil: ["Brent oil price USD per barrel today", "Europe crude oil price today 2026"],
    electricity: ["Europe electricity price MWh today", "Europe power price today 2026"],
    water: ["Europe water tariff price per cubic meter today", "Europe water price 2026"],
  },
  africa: {
    oil: ["West African crude oil price USD per barrel today", "Africa oil price today 2026"],
    electricity: ["Africa electricity price MWh today", "Africa power price today 2026"],
    water: ["Africa water tariff price per cubic meter today", "Africa water price 2026"],
  },
  americas: {
    oil: ["WTI oil price USD per barrel today", "Americas crude oil price today 2026"],
    electricity: ["Americas electricity price MWh today", "Americas power price today 2026"],
    water: ["Americas water tariff price per cubic meter today", "Americas water price 2026"],
  },
  oceania: {
    oil: ["Australia oil price USD per barrel today", "Oceania crude oil price today 2026"],
    electricity: ["Australia electricity price MWh today", "Oceania power price today 2026"],
    water: ["Australia water tariff price per cubic meter today", "Oceania water price 2026"],
  },
};

const PRICE_UNITS: Record<CommodityId, string> = {
  oil: "USD/bbl",
  electricity: "USD/MWh",
  water: "USD/m3",
};

const FALLBACK_PRICES: Record<CommodityId, number> = {
  oil: 104.86,
  electricity: 166,
  water: 2.5,
};

export interface PriceQuote {
  price: number;
  unit: string;
  source: string;
  asOf: string;
  isLive: boolean;
}

interface PriceExtraction {
  price: number | null;
  unit: string | null;
}

function extractPriceFromText(text: string, commodity: CommodityId): number | null {
  const patterns = [
    /\$\s*(\d+(?:\.\d+)?)[\s]*(?:per|\/|a)\s*(?:bbl|barrel|barrels|megawatt[- ]hour|megawatt hour|mwh|cubic meter|m3|tonne|ton)/gi,
    /\$\s*(\d+(?:\.\d+)?)[\s]*(?:bbl|barrel|barrels|mwh|megawatt[- ]hour|m3|cubic meter|tonne|ton)/gi,
    /(\d+(?:\.\d+)?)\s*(?:USD|US\$|dollars?)[\s]*(?:per|\/|a)\s*(?:bbl|barrel|barrels|mwh|megawatt[- ]hour|m3|cubic meter|tonne|ton)/gi,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) {
      const price = Number(match[1]);
      if (Number.isFinite(price) && price > 0) return price;
    }
  }
  return null;
}

async function extractPriceFromSearchResults(
  commodity: CommodityId,
  results: Array<{ title: string; snippet: string; url: string }>
): Promise<PriceExtraction> {
  const text = results
    .map((r) => `${r.title}. ${r.snippet}`)
    .join("\n");

  const directPrice = extractPriceFromText(text, commodity);
  if (directPrice !== null) {
    return { price: directPrice, unit: PRICE_UNITS[commodity] };
  }

  const prompt =
    `You are a financial data extraction assistant. Extract the current spot price for ${commodity} ` +
    `from the following search results. Return strict JSON only: {"price": number, "unit": string}. ` +
    `If no price can be extracted, return {"price": null, "unit": null}. Use only numbers explicitly present in the text.\n\n` +
    text.slice(0, 3000);

  try {
    const response = await kiloRouter.kiloInfer({
      messages: [{ role: "user", content: prompt }],
      max_tokens: 128,
      temperature: 0,
    });
    const content = response.choices?.[0]?.message?.content ?? "";
    const parsed = safeParseJson<PriceExtraction>(content);
    const price = parsed?.price;
    if (typeof price === "number" && Number.isFinite(price) && price > 0) {
      return { price, unit: parsed?.unit ?? PRICE_UNITS[commodity] };
    }
  } catch {
    // Fall back to regex extraction below
  }

  return { price: null, unit: null };
}

async function fetchPriceForCommodity(
  commodity: CommodityId,
  scope: RegionId
): Promise<PriceQuote> {
  const queries =
    scope === "global"
      ? COMMODITY_PRICE_QUERIES[commodity]
      : (REGION_PRICE_QUERIES[scope]?.[commodity] ?? COMMODITY_PRICE_QUERIES[commodity]);

  for (const query of queries) {
    try {
      const search = await tinyfishRouter.tinyfishSearch(`${query} ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}`, { limit: 5 });
      const results = search.results
        .filter((r) => r.url && r.title)
        .map((r) => ({ title: r.title, snippet: r.snippet ?? "", url: r.url }))
        .slice(0, 3);

      if (results.length === 0) continue;

      const extracted = await extractPriceFromSearchResults(commodity, results);
      if (extracted.price !== null) {
        return {
          price: extracted.price,
          unit: extracted.unit ?? PRICE_UNITS[commodity],
          source: results[0].url,
          asOf: new Date().toISOString(),
          isLive: true,
        };
      }
    } catch {
      // Try the next query
    }
  }

  return {
    price: FALLBACK_PRICES[commodity],
    unit: PRICE_UNITS[commodity],
    source: "Static fallback benchmark (EIA, IEA, OPEC, UN-Water)",
    asOf: new Date().toISOString(),
    isLive: false,
  };
}

async function fetchLivePrices(scope: RegionId): Promise<Record<CommodityId, PriceQuote>> {
  const [oil, electricity, water] = await Promise.all([
    fetchPriceForCommodity("oil", scope),
    fetchPriceForCommodity("electricity", scope),
    fetchPriceForCommodity("water", scope),
  ]);
  return { oil, electricity, water };
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const scope = (url.searchParams.get("scope") ?? "global") as RegionId;
  const validScopes: RegionId[] = ["global", "asia", "europe", "africa", "americas", "oceania"];

  if (!validScopes.includes(scope)) {
    return Response.json({ error: "Invalid scope. Must be one of: global, asia, europe, africa, americas, oceania" }, { status: 400 });
  }

  try {
    const force = url.searchParams.get("force") === "true";
    const cacheKey = `dynamic-prices:${scope}`;
    if (!force) {
      const cached = await getCache<Record<CommodityId, PriceQuote>>(cacheKey, PRICES_CACHE_MS);
      if (cached) {
        return Response.json({ prices: cached, scope, count: 3, cacheKey, updatedAt: new Date().toISOString() }, { status: 200 });
      }
    }

    const prices = await fetchLivePrices(scope);
    await setCache(cacheKey, prices, PRICES_CACHE_MS);
    return Response.json({ prices, scope, count: 3, cacheKey, updatedAt: new Date().toISOString() }, { status: 200 });
  } catch (error) {
    console.error("Dynamic prices error:", sanitizeError(String(error)));
    const prices = await fetchLivePrices(scope).catch(() => ({
      oil: { price: FALLBACK_PRICES.oil, unit: PRICE_UNITS.oil, source: "Static fallback", asOf: new Date().toISOString(), isLive: false },
      electricity: { price: FALLBACK_PRICES.electricity, unit: PRICE_UNITS.electricity, source: "Static fallback", asOf: new Date().toISOString(), isLive: false },
      water: { price: FALLBACK_PRICES.water, unit: PRICE_UNITS.water, source: "Static fallback", asOf: new Date().toISOString(), isLive: false },
    }));
    return Response.json({ prices, scope, count: 3, error: "Live prices temporarily unavailable; static fallback returned", updatedAt: new Date().toISOString() }, { status: 200 });
  }
}
