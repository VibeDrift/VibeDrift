/**
 * Frontend state-management consistency detector.
 *
 * Detects mixing of state strategies in React/Vue/Svelte projects:
 *   - react_hooks_local  — useState / useReducer
 *   - react_context      — React.createContext + useContext
 *   - redux              — react-redux + useSelector / useDispatch
 *   - zustand            — zustand + create()
 *   - react_query        — @tanstack/react-query useQuery
 *   - mobx               — mobx + observer
 *   - vue_pinia          — pinia store
 *   - vue_vuex           — vuex store
 *   - svelte_stores      — svelte/store writable/readable
 *
 * AI sessions love mixing these — useState in one component, redux in
 * another, zustand in a third. Per-component is fine in isolation; the
 * drift signal is the *mix* across the project. Directory-scoped vote.
 */

import type { DriftDetector, DriftContext, DriftFinding, DriftFile, Evidence } from "./types.js";
import { buildDirectoryScopedVote, buildFileAgeMap, isAnalyzableSource, pickIntentHint } from "./utils.js";

type StateStrategy =
  | "react_hooks_local"
  | "react_context"
  | "redux"
  | "zustand"
  | "react_query"
  | "mobx"
  | "vue_pinia"
  | "vue_vuex"
  | "svelte_stores";

const STRATEGY_NAMES: Record<StateStrategy, string> = {
  react_hooks_local: "useState/useReducer",
  react_context: "React Context",
  redux: "Redux",
  zustand: "Zustand",
  react_query: "React Query",
  mobx: "MobX",
  vue_pinia: "Pinia (Vue)",
  vue_vuex: "Vuex (Vue)",
  svelte_stores: "Svelte stores",
};

const PATTERNS: Record<StateStrategy, RegExp> = {
  redux: /\b(?:react-redux|useSelector|useDispatch|connect\(|configureStore|createSlice)\b/,
  zustand: /\bzustand\b|\bcreate\(\s*\((?:set|get)\b/,
  react_query: /@tanstack\/react-query|useQuery\(|useMutation\(/,
  mobx: /\bmobx\b|\bobserver\(|\bmakeAutoObservable/,
  vue_pinia: /\bpinia\b|defineStore\(/,
  vue_vuex: /\bvuex\b|createStore\(\s*\{/,
  svelte_stores: /\bsvelte\/store\b|\bwritable\(|\breadable\(|\bderived\(/,
  react_context: /React\.createContext\(|\bcreateContext\(/,
  react_hooks_local: /\buseState\(|\buseReducer\(/,
};

interface StateProfile {
  file: string;
  patterns: { pattern: StateStrategy; evidence: Evidence[] }[];
}

function analyze(file: DriftFile): StateProfile | null {
  if (!file.language) return null;
  if (file.language !== "javascript" && file.language !== "typescript") return null;
  if (!isAnalyzableSource(file.path)) return null;

  const lines = file.content.split("\n");
  const hits = new Map<StateStrategy, Evidence[]>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [strat, re] of Object.entries(PATTERNS) as [StateStrategy, RegExp][]) {
      if (re.test(line)) {
        const list = hits.get(strat) ?? [];
        if (list.length < 3) list.push({ line: i + 1, code: line.trim().slice(0, 120) });
        hits.set(strat, list);
      }
    }
  }

  if (hits.size === 0) return null;
  const patterns = [...hits.entries()].map(([pattern, evidence]) => ({ pattern, evidence }));
  return { file: file.path, patterns };
}

export const stateManagementConsistency: DriftDetector = {
  id: "state-management-consistency",
  name: "Frontend State Management Consistency",
  category: "state_management_consistency",

  detect(ctx: DriftContext): DriftFinding[] {
    const profiles: StateProfile[] = [];
    for (const file of ctx.files) {
      const p = analyze(file);
      if (p) profiles.push(p);
    }
    if (profiles.length < 3) return [];

    const votes = buildDirectoryScopedVote(profiles, STRATEGY_NAMES, {
      minGroupSize: 3,
      dominanceThreshold: 0.7,
      fileAges: buildFileAgeMap(ctx),
      seededPattern: pickIntentHint(ctx, "state_management_consistency")?.pattern,
    });

    return votes.map((v) => ({
      detector: "state-management-consistency",
      subCategory: "state_strategy",
      driftCategory: "state_management_consistency",
      severity: v.deviators.length >= 3 ? "warning" : "info",
      confidence: 0.75,
      finding: `${v.directory}/: ${v.dominantCount} files use ${STRATEGY_NAMES[v.dominant]}, ${v.deviators.length} use a different state strategy`,
      dominantPattern: STRATEGY_NAMES[v.dominant],
      dominantCount: v.dominantCount,
      totalRelevantFiles: v.totalFiles,
      consistencyScore: v.consistencyScore,
      deviatingFiles: v.deviators,
      dominantFiles: v.dominantFiles,
      recommendation: `Standardize ${v.directory}/ on ${STRATEGY_NAMES[v.dominant]}. Mixing state libraries in the same area makes data flow hard to follow.`,
    }));
  },
};
