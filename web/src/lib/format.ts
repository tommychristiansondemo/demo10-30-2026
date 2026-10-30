const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export const mw = (v: number) => `${nf0.format(v)} MW`;
export const gw = (v: number) => `${nf1.format(v / 1000)} GW`;
export const hz = (v: number) => `${v.toFixed(3)} Hz`;
export const usd = (v: number) => `$${v.toFixed(2)}`;
export const pct = (v: number) => `${nf1.format(v)}%`;
export const num = (v: number) => nf0.format(v);

/** ERCOT operates on Central Prevailing Time; show times in CPT with the zone label. */
const cpt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false });
const cptFull = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' });
export const timeCpt = (iso: string | number) => cpt.format(new Date(iso));
export const dateTimeCpt = (iso: string | number) => cptFull.format(new Date(iso));

export function ago(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
