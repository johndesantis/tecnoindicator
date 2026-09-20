import { useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  Globe2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import Reveal from "./Reveal";
import { COMMODITIES, EVAL_REGIONS, type CommodityId, type RegionId, type Solution } from "../lib/model";

const REGION_ORDER: RegionId[] = ["global", ...EVAL_REGIONS.map((r) => r.id)];

function SolutionCard({
  solution,
  index,
}: {
  solution: Solution;
  index: number;
}) {
  const created = new Date(solution.createdAt);
  const updated = new Date(solution.updatedAt);
  const isNew = Date.now() - created.getTime() <= 10 * 60 * 1000;

  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-line bg-panel/60 p-5 transition-all duration-300 hover:border-teal-400/40 hover:bg-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-teal-400/30 bg-teal-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-teal-300">
            {solution.category}
          </span>
          {isNew && (
            <span className="inline-flex items-center rounded-full bg-teal-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
              New
            </span>
          )}
        </div>
        <span className="font-display text-xs font-bold text-slate-600">
          {String(index + 1).padStart(2, "0")}
        </span>
      </div>

      <h3 className="mt-3 font-display text-base font-semibold text-white">
        {solution.title}
      </h3>

      <p className="mt-2 flex-1 text-xs leading-relaxed text-slate-400">
        {solution.description}
      </p>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {solution.commodities.map((id) => {
          const c = COMMODITIES.find((x) => x.id === id);
          if (!c) return null;
          return (
            <span
              key={id}
              className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style={{ color: c.color, background: `${c.color}18` }}
            >
              {c.short}
            </span>
          );
        })}
      </div>

      <div className="mt-4 rounded-xl border border-line bg-base/40 p-3">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-teal-300">
          <ArrowUpRight className="h-3.5 w-3.5" />
          Recommended action
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-300">{solution.action}</p>
      </div>

      <div className="mt-3 rounded-xl border border-line bg-base/40 p-3">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-300">
          <ShieldCheck className="h-3.5 w-3.5" />
          Expected impact
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-300">{solution.expectedImpact}</p>
      </div>

      <p className="mt-3 text-[10px] leading-relaxed text-slate-500">
        Derived from trend: <span className="text-slate-400">{solution.basedOnFactor}</span>
      </p>

      <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-[10px] text-slate-500">
        <span>Updated {updated.toLocaleDateString("en-US", { month: "short", day: "numeric" })} at {updated.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
        <span className="inline-flex items-center gap-1 text-teal-400">
          <Sparkles className="h-3 w-3" />
          AI-generated
        </span>
      </div>
    </article>
  );
}

function RegionTabs({
  selected,
  onSelect,
}: {
  selected: RegionId;
  onSelect: (region: RegionId) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {REGION_ORDER.map((id) => {
        const region = id === "global" ? { name: "Global", flag: "🌐" } : EVAL_REGIONS.find((r) => r.id === id);
        if (!region) return null;
        const label = id === "global" ? "Global" : region.name;
        const flag = id === "global" ? "🌐" : region.flag;
        const active = selected === id;
        return (
          <button
            key={id}
            onClick={() => onSelect(id)}
            className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-all duration-200 ${
              active
                ? "border-teal-400/50 bg-teal-400/15 text-teal-200"
                : "border-line bg-panel/40 text-slate-400 hover:border-teal-400/30 hover:text-slate-200"
            }`}
          >
            <span className="mr-1">{flag}</span>
            {label}
          </button>
        );
      })}
    </div>
  );
}

export default function SolutionsSection({
  globalSolutions,
  regionalSolutions,
  loading,
  aiCurated,
  onRefresh,
}: {
  globalSolutions: Solution[];
  regionalSolutions: Record<string, Solution[]>;
  loading: boolean;
  aiCurated: boolean;
  onRefresh: () => void;
}) {
  const [selectedRegion, setSelectedRegion] = useState<RegionId>("global");
  const solutions = selectedRegion === "global" ? globalSolutions : regionalSolutions[selectedRegion] ?? [];

  const regionName = selectedRegion === "global" ? "Global" : EVAL_REGIONS.find((r) => r.id === selectedRegion)?.name ?? selectedRegion;

  return (
    <section id="solutions" className="border-t border-line bg-base/40 py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <Reveal>
          <div className="mb-10 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="flex items-center gap-2 text-teal-300">
                <Bot className="h-4 w-4" />
                <span className="text-xs font-semibold uppercase tracking-widest">AI Strategy Engine</span>
              </div>
              <h2 className="mt-3 font-display text-3xl font-bold text-white sm:text-4xl">
                Dynamic Solution Cards
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-400">
                Actionable recommendations generated by AI from live market trends, news analysis, and regional conditions. Each region receives three tailored solutions that automatically refresh as new trends emerge.
              </p>
            </div>
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold ${
                  aiCurated
                    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                    : "border-amber-400/30 bg-amber-400/10 text-amber-300"
                }`}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                {loading ? "Refreshing…" : aiCurated ? "Live AI Curated" : "Fallback Mode"}
              </span>
              <button
                onClick={onRefresh}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-4 py-2 text-xs font-semibold text-slate-300 transition-all duration-200 hover:border-teal-400/40 hover:text-teal-200"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </button>
            </div>
          </div>
        </Reveal>

        <Reveal>
          <div className="mb-6">
            <RegionTabs selected={selectedRegion} onSelect={setSelectedRegion} />
          </div>
        </Reveal>

        {loading && solutions.length === 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-64 animate-pulse rounded-2xl border border-line bg-panel/40" />
            ))}
          </div>
        ) : solutions.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line bg-panel/40 p-12 text-center">
            <Globe2 className="mx-auto h-10 w-10 text-slate-600" />
            <p className="mt-4 text-sm text-slate-400">No solutions available for this region yet.</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {solutions.map((solution, index) => (
              <Reveal key={solution.id}>
                <SolutionCard solution={solution} index={index} />
              </Reveal>
            ))}
          </div>
        )}

        <p className="mt-6 text-center text-[11px] text-slate-500">
          Solutions are generated dynamically by AI based on current market conditions and are refreshed automatically. The oldest card is replaced when a new trend is detected.
        </p>
      </div>
    </section>
  );
}
