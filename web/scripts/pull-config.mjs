// Local development: fetch the deployed runtime config and point API calls at the public API domain.
//   npm run pull-config -w web -- https://dev.gridsight.awsteach.com
import { writeFileSync } from 'node:fs';
const base = process.argv[2] ?? 'https://dev.gridsight.awsteach.com';
const res = await fetch(`${base}/config.json`);
if (!res.ok) throw new Error(`Failed to fetch ${base}/config.json: ${res.status}`);
const cfg = await res.json();
cfg.apiBaseUrl = cfg.publicApiUrl;
cfg.wsUrl = cfg.wsUrlDirect;
writeFileSync(new URL('../public/config.json', import.meta.url), JSON.stringify(cfg, null, 2));
console.log('wrote web/public/config.json (API:', cfg.apiBaseUrl, ')');
