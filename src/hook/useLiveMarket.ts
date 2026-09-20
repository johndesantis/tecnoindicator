import { useCallback, useEffect, useRef, useState } from "react";
import {
  COMMODITIES,
  fetchLiveWaterPrice,
  perturbPrices,
  TICK_MS,
  WATER_POLL_MS,
  type CommodityId,
  type LiveWaterQuote,
} from "../lib/model";

interface LivePricesApiResponse {
  prices: Partial<Record<CommodityId, { price: number; source: string }>>;
  source?: string;
  asOf?: string;
}

async function fetchLivePricesFromAPI(): Promise<{ prices: Record<CommodityId, number>; source: string; asOf: string } | null> {
  try {
    const res = await fetch("/api/dynamic-prices");
    if (!res.ok) return null;
    const data = (await res.json()) as LivePricesApiResponse;
    if (!data.prices) return null;
    const prices: Record<CommodityId, number> = {
      oil: data.prices.oil?.price ?? 0,
      electricity: data.prices.electricity?.price ?? 0,
      water: data.prices.water?.price ?? 0,
    };
    if (prices.oil === 0 || prices.electricity === 0 || prices.water === 0) return null;
    return {
      prices,
      source: data.source ?? "Dynamic AI Prices",
      asOf: data.asOf ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function getFallbackPrices(): Record<CommodityId, number> {
  return Object.fromEntries(COMMODITIES.map((c) => [c.id, c.base])) as Record<
    CommodityId,
    number
  >;
}

export interface UseLiveMarketReturn {
  prices: Record<CommodityId, number>;
  jitter: number;
  lastUpdated: Date;
  waterLive: LiveWaterQuote | null;
  waterFetching: boolean;
  isLive: boolean;
  streaming: boolean;
  pricesLoading: boolean;
  pricesSource: string;
  pricesAsOf: string | null;
  refresh: () => void;
  fetchWater: () => Promise<void>;
  fetchLivePrices: () => Promise<void>;
  toggleLive: () => void;
}

export function useLiveMarket(): UseLiveMarketReturn {
  const [prices, setPrices] = useState<Record<CommodityId, number>>({});
  const [pricesLoading, setPricesLoading] = useState(true);
  const [pricesSource, setPricesSource] = useState("");
  const [pricesAsOf, setPricesAsOf] = useState<string | null>(null);
  const [jitter, setJitter] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(() => new Date());
  const [waterLive, setWaterLive] = useState<LiveWaterQuote | null>(null);
  const [waterFetching, setWaterFetching] = useState(false);
  const [isLive, setIsLive] = useState(true);
  const [streaming, setStreaming] = useState(true);
  const tickRef = useRef<number | null>(null);
  const waterRef = useRef<number | null>(null);

  const fetchLivePrices = useCallback(async () => {
    setPricesLoading(true);
    try {
      const livePrices = await fetchLivePricesFromAPI();
      if (livePrices) {
        setPrices(livePrices.prices);
        setPricesSource(livePrices.source);
        setPricesAsOf(livePrices.asOf);
      } else {
        setPrices(getFallbackPrices());
        setPricesSource("Fallback base prices");
        setPricesAsOf(new Date().toISOString());
      }
      setLastUpdated(new Date());
    } catch (err) {
      console.error("Failed to fetch live prices:", err);
      setPrices(getFallbackPrices());
      setPricesSource("Fallback base prices");
      setPricesAsOf(new Date().toISOString());
    } finally {
      setPricesLoading(false);
    }
  }, []);

  // Refresh prices: fetch live from API first, fall back to perturbation
  const refresh = useCallback(() => {
    let triedLive = false;
    fetchLivePricesFromAPI().then((livePrices) => {
      triedLive = true;
      if (livePrices) {
        setPrices(livePrices.prices);
        setPricesSource(livePrices.source);
        setPricesAsOf(livePrices.asOf);
      } else {
        setPrices((cur) => perturbPrices(cur));
        setPricesSource("Perturbed fallback prices");
        setPricesAsOf(new Date().toISOString());
      }
      setLastUpdated(new Date());
    }).catch(() => {
      if (!triedLive) {
        setPrices((cur) => perturbPrices(cur));
        setPricesSource("Perturbed fallback prices");
        setPricesAsOf(new Date().toISOString());
        setLastUpdated(new Date());
      }
    });
  }, []);

  const fetchWater = useCallback(async () => {
    setWaterFetching(true);
    try {
      // Try to get fresh water price from API first
      const livePrices = await fetchLivePricesFromAPI();
      let waterPrice: number | null = null;
      let waterSource: string = "";
      let waterAsOf: string = "";
      
      if (livePrices && livePrices.prices.water !== undefined) {
        waterPrice = livePrices.prices.water;
        waterSource = livePrices.source;
        waterAsOf = livePrices.asOf;
      } else {
        // Fall back to simulated water price
        const quote = await fetchLiveWaterPrice();
        waterPrice = quote.price;
        waterSource = quote.source;
        waterAsOf = quote.asOf;
      }
      
      if (waterPrice !== null) {
        setWaterLive({
          price: waterPrice,
          asOf: waterAsOf,
          source: waterSource,
          range: "Live price from API/simulated"
        });
        setPrices((cur) => ({ ...cur, water: waterPrice }));
        setJitter((j) => j + Math.random());
        setLastUpdated(new Date());
      }
    } catch (err) {
      console.error("Failed to fetch live water price:", err);
      // Fall back to simulated
      const quote = await fetchLiveWaterPrice();
      setWaterLive(quote);
      setPrices((cur) => ({ ...cur, water: quote.price }));
      setJitter((j) => j + Math.random());
      setLastUpdated(new Date());
    } finally {
      setWaterFetching(false);
    }
  }, []);

  const toggleLive = useCallback(() => {
    setIsLive((prev) => !prev);
  }, []);

  // Streaming tick: use live price as anchor, apply small random walk
  const streamTick = useCallback((cur: Record<CommodityId, number>): Record<CommodityId, number> => {
    const next = {} as Record<CommodityId, number>;
    for (const id of Object.keys(cur) as CommodityId[]) {
      const price = cur[id];
      const shock = (Math.random() - 0.5) * 0.01;
      next[id] = Math.round(price * (1 + shock) * 100) / 100;
    }
    return next;
  }, []);

  // Auto-streaming mean-reverting ticks — no refresh button required
  useEffect(() => {
    const clear = () => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
      if (waterRef.current) {
        clearInterval(waterRef.current);
        waterRef.current = null;
      }
    };

    const start = () => {
      clear();
      if (!isLive || document.hidden) {
        setStreaming(false);
        return;
      }
      setStreaming(true);
      tickRef.current = window.setInterval(() => {
        setPrices(streamTick);
        setJitter((j) => j + 0.01);
        setLastUpdated(new Date());
      }, TICK_MS);

      waterRef.current = window.setInterval(() => {
        void fetchLiveWaterPrice().then((quote) => {
          setWaterLive(quote);
          setPrices((cur) => ({ ...cur, water: quote.price }));
          setLastUpdated(new Date());
        });
      }, WATER_POLL_MS);
    };

    start();

    const onVisibility = () => {
      if (document.hidden) {
        clear();
        setStreaming(false);
      } else if (isLive) {
        start();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isLive, streamTick]);

  // Initial: fetch live prices from API (fall back to hardcoded base prices on failure)
  useEffect(() => {
    void fetchLivePrices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initial water quote
  useEffect(() => {
    void fetchWater();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    prices,
    jitter,
    lastUpdated,
    waterLive,
    waterFetching,
    isLive,
    streaming,
    pricesLoading,
    pricesSource,
    pricesAsOf,
    refresh,
    fetchWater,
    fetchLivePrices,
    toggleLive,
  };
}