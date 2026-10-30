// GRIDSIGHT_API=https://api.dev.gridsight.awsteach.com GRIDSIGHT_CLIENT_ID=... GRIDSIGHT_USERNAME=... GRIDSIGHT_PASSWORD=... npm run example -w sdk/typescript
import { GridSightClient } from '../src/index.js';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`Set ${k}`); return v; };

const token = await GridSightClient.login({ region: 'us-east-1', clientId: env('GRIDSIGHT_CLIENT_ID'), username: env('GRIDSIGHT_USERNAME'), password: env('GRIDSIGHT_PASSWORD') });
const gs = new GridSightClient({ baseUrl: env('GRIDSIGHT_API'), token });

const now = await gs.grid.current();
console.log(`Load ${Math.round(now.load_mw)} MW · PRC ${Math.round(now.reserves.prc_mw)} MW · λ $${now.system_lambda}/MWh`);

const peaks = await gs.query.sql(`SELECT dt, max(load_mw) AS peak FROM grid_interval WHERE dt >= cast(current_date - interval '7' day AS varchar) GROUP BY dt ORDER BY dt`);
console.table(peaks.rows);

for await (const ev of gs.chat.stream('In two sentences: how tight are reserves right now, and why?')) {
  if (ev.type === 'chat.tool' && ev.status === 'running') console.log(`\n[tool] ${ev.name}`);
  if (ev.type === 'chat.delta') process.stdout.write(ev.text);
  if (ev.type === 'chat.error') console.error(ev.message);
}
console.log();
