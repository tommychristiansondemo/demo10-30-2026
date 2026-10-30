import { useCallback, useEffect, useRef, useState } from 'react';

/** Fetch with loading/error state and optional polling. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], opts: { refreshMs?: number; enabled?: boolean } = {}) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const enabled = opts.enabled ?? true;

  const reload = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      setData(await fnRef.current());
      setError(undefined);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void reload();
    if (!opts.refreshMs) return;
    const t = window.setInterval(() => void reload(), opts.refreshMs);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reload, opts.refreshMs]);

  return { data, error, loading, reload, setData };
}

export type ThemePref = 'system' | 'light' | 'dark';

function readPref(): ThemePref {
  try { return (localStorage.getItem('gridsight.theme') as ThemePref) || 'system'; } catch { return 'system'; }
}

export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
  try { localStorage.setItem('gridsight.theme', pref); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event('gridsight-theme'));
}

export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(readPref);
  return [pref, (p) => { setPref(p); applyTheme(p); }];
}

export function initTheme() {
  applyTheme(readPref());
}

/** Resolved CSS variable values, recomputed whenever the effective theme changes. */
export function useCssVars<T extends string>(names: readonly T[]): Record<T, string> {
  const read = () => {
    const cs = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(`--${n}`).trim()])) as Record<T, string>;
  };
  const [vars, setVars] = useState(read);
  useEffect(() => {
    const update = () => setVars(read());
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', update);
    window.addEventListener('gridsight-theme', update);
    return () => { mq.removeEventListener('change', update); window.removeEventListener('gridsight-theme', update); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return vars;
}
