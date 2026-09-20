import { useCallback, useEffect, useMemo, useState } from "react";
import Navbar from "./components/Navbar";
import Hero from "./components/Hero";
import ForecastTool from "./components/ForecastTool";
import RegionalEvaluation from "./components/RegionalEvaluation";
import FactorsSection from "./components/FactorsSection";
import SolutionsSection from "./components/SolutionsSection";
import AboutSection from "./components/AboutSection";
import Footer from "./components/Footer";
import { useLiveMarket } from "./hook/useLiveMarket";
import { generateForecast, type RegionId, FACTORS, EVAL_REGIONS, type Factor, type Solution } from "./lib/model";

const ANALYTICS_POLL_MS = 60_000;
const FACTORS_POLL_MS = 120_000;
const SOLUTIONS_POLL_MS = 180_000;
const HEALTH_POLL_MS = 5 * 60_000;
const REGION_STAGGER_MS = 8_000;

export default function App() {
  const [horizon, setHorizon] = useState(7);
  const [region, setRegion] = useState<RegionId>("global");

  const {
    prices,
    jitter,
    lastUpdated,
    waterLive,
    waterFetching,
    isLive,
    streaming,
    refresh,
    fetchWater,
    toggleLive,
  } = useLiveMarket();

  const [healthStatus, setHealthStatus] = useState<"Initializing AI" | "Online Model Connected" | "Offline Model">("Initializing AI");
  const [_onlineModelConnected, setOnlineModelConnected] = useState(false);
  const [globalFactors, setGlobalFactors] = useState<Factor[]>(FACTORS);
  const [regionalFactors, setRegionalFactors] = useState<Record<string, Factor[]>>({});
  const [_regionalAnalytics, setRegionalAnalytics] = useState<Record<string, unknown>>({});
  const [globalSolutions, setGlobalSolutions] = useState<Solution[]>([]);
  const [regionalSolutions, setRegionalSolutions] = useState<Record<string, Solution[]>>({});
  const [solutionsLoading, setSolutionsLoading] = useState(false);
  const [solutionsAiCurated, setSolutionsAiCurated] = useState(false);

  const points = useMemo(
    () => generateForecast(prices, horizon, jitter, region),
    [prices, horizon, jitter, region],
  );

  // Poll health endpoint
  useEffect(() => {
    let active = true;
    const pollHealth = async () => {
      try {
        const res = await fetch("/api/health");
        if (!res.ok) throw new Error("Health check failed");
        const data = await res.json();
        if (active) {
          setOnlineModelConnected(data.onlineModelConnected === true);
          setHealthStatus(data.onlineModelConnected === true ? "Online Model Connected" : "Offline Model");
        }
      } catch {
        if (active) {
          setOnlineModelConnected(false);
          setHealthStatus("Offline Model");
        }
      }
    };
    pollHealth();
    const id = setInterval(pollHealth, HEALTH_POLL_MS);
    return () => { active = false; clearInterval(id); };
  }, []);

  // Poll analytics (global + regional)
  useEffect(() => {
    let active = true;
    const pollAnalytics = async () => {
      try {
        const res = await fetch("/api/analytics");
        if (res.ok) {
          const data = await res.json();
          if (active) setRegionalAnalytics(prev => ({ ...prev, global: data }));
        }
      } catch { /* ignore */ }
      for (const r of EVAL_REGIONS) {
        try {
          const res = await fetch(`/api/regional-analytics?region=${r.id}`);
          if (res.ok) {
            const data = await res.json();
            if (active) setRegionalAnalytics(prev => ({ ...prev, [r.id]: data }));
          }
        } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, REGION_STAGGER_MS));
      }
    };
    pollAnalytics();
    const id = setInterval(pollAnalytics, ANALYTICS_POLL_MS);
    return () => { active = false; clearInterval(id); };
  }, []);

  // Poll dynamic factors (global + regional)
  useEffect(() => {
    let active = true;
    const pollFactors = async () => {
      try {
        const res = await fetch("/api/dynamic-factors");
        if (res.ok) {
          const data = await res.json();
          if (active && Array.isArray(data.factors) && data.factors.length === 8) {
            setGlobalFactors(data.factors);
          }
        }
      } catch { /* ignore */ }
      for (const r of EVAL_REGIONS) {
        try {
          const res = await fetch(`/api/regional-factors?region=${r.id}`);
          if (res.ok) {
            const data = await res.json();
            if (active && Array.isArray(data.factors) && data.factors.length === 8) {
              setRegionalFactors(prev => ({ ...prev, [r.id]: data.factors }));
            }
          }
        } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, REGION_STAGGER_MS));
      }
    };
    pollFactors();
    const id = setInterval(pollFactors, FACTORS_POLL_MS);
    return () => { active = false; clearInterval(id); };
  }, []);

  // Fetch solutions from API - used for initial load and manual refresh
  const fetchLiveSolutions = useCallback(async () => {
    setSolutionsLoading(true);
    try {
      // Fetch global solutions
      const globalRes = await fetch("/api/dynamic-solutions?force=true");
      if (globalRes.ok) {
        const data = await globalRes.json();
        if (Array.isArray(data.solutions) && data.solutions.length > 0) {
          setGlobalSolutions(data.solutions);
          setSolutionsAiCurated(data.aiCurated === true);
        }
      }
      // Fetch regional solutions with stagger
      for (const r of EVAL_REGIONS) {
        try {
          const res = await fetch(`/api/regional-solutions?region=${r.id}&force=true`);
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.solutions) && data.solutions.length > 0) {
              setRegionalSolutions(prev => ({ ...prev, [r.id]: data.solutions }));
            }
          }
        } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, REGION_STAGGER_MS));
      }
    } catch { /* ignore */ }
    finally {
      setSolutionsLoading(false);
    }
  }, []);

  // Poll dynamic solutions (global + regional) — background refresh
  useEffect(() => {
    let active = true;
    const pollSolutions = async () => {
      try {
        const res = await fetch("/api/dynamic-solutions?force=true");
        if (res.ok && active) {
          const data = await res.json();
          if (Array.isArray(data.solutions) && data.solutions.length > 0) {
            setGlobalSolutions(data.solutions);
            setSolutionsAiCurated(data.aiCurated === true);
          }
        }
        for (const r of EVAL_REGIONS) {
          try {
            const res = await fetch(`/api/regional-solutions?region=${r.id}&force=true`);
            if (res.ok && active) {
              const data = await res.json();
              if (Array.isArray(data.solutions) && data.solutions.length > 0) {
                setRegionalSolutions(prev => ({ ...prev, [r.id]: data.solutions }));
              }
            }
          } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, REGION_STAGGER_MS));
        }
      } catch { /* ignore */ }
    };
    // Initial fetch
    fetchLiveSolutions();
    // Background polling
    const id = setInterval(pollSolutions, SOLUTIONS_POLL_MS);
    return () => { active = false; clearInterval(id); };
  }, [fetchLiveSolutions]);

  return (
    <div className="min-h-screen bg-base font-sans text-slate-200 antialiased">
      <Navbar />
      <main>
        <Hero prices={prices} />
        <ForecastTool
          horizon={horizon}
          onHorizon={setHorizon}
          prices={prices}
          points={points}
          lastUpdated={lastUpdated}
          onRefresh={refresh}
          onFetchWater={fetchWater}
          waterFetching={waterFetching}
          waterLive={waterLive}
          isLive={isLive}
          streaming={streaming}
          onToggleLive={toggleLive}
          region={region}
          onRegion={setRegion}
        />
        <RegionalEvaluation
          prices={prices}
          horizon={horizon}
          jitter={jitter}
          region={region}
          onRegion={setRegion}
          dynamicFactors={regionalFactors}
          healthStatus={healthStatus}
        />
        <FactorsSection
          horizon={horizon}
          dynamicFactors={globalFactors}
          healthStatus={healthStatus}
        />
        <SolutionsSection
          globalSolutions={globalSolutions}
          regionalSolutions={regionalSolutions}
          loading={solutionsLoading}
          aiCurated={solutionsAiCurated}
          onRefresh={fetchLiveSolutions}
        />
        <AboutSection />
      </main>
      <Footer lastUpdated={lastUpdated} />
    </div>
  );
}