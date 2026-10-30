import { lazy, Suspense, useState } from 'react';
import { accessToken } from '../auth/amplify';
import { useAuth } from '../auth/AuthContext';
import { Card, Skeleton } from '../components/ui';
import { config } from '../lib/config';

const SwaggerUI = lazy(() => import('swagger-ui-react').then(async (m) => { await import('swagger-ui-react/swagger-ui.css'); return m; }));

export function Developers() {
  const { me } = useAuth();
  const cfg = config();
  const [copied, setCopied] = useState(false);
  const [showSpec, setShowSpec] = useState(false);
  const api = cfg.publicApiUrl;

  const copyToken = async () => {
    await navigator.clipboard.writeText(await accessToken());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Developers</h1>
          <p>Everything in the UI is available over REST and WebSocket. Tokens are Cognito access tokens (1 hour); your role ({me?.user.role}) applies to API calls.</p>
        </div>
      </div>
      <div className="grid two">
        <Card title="Endpoints">
          <table className="data">
            <tbody>
              <tr><td>REST base URL</td><td className="mono">{api}/v1</td></tr>
              <tr><td>WebSocket</td><td className="mono">{api.replace('https://', 'wss://')}/ws?token=…</td></tr>
              <tr><td>OpenAPI spec</td><td><a href="/openapi.yaml">/openapi.yaml</a></td></tr>
              <tr><td>Cognito user pool</td><td className="mono">{cfg.userPoolId}</td></tr>
              <tr><td>CLI app client</td><td className="mono">{cfg.cliClientId}</td></tr>
              <tr><td>Identity pool</td><td className="mono">{cfg.identityPoolId}</td></tr>
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={() => void copyToken()}>{copied ? 'Copied' : 'Copy my access token'}</button>
            <span className="note">Treat it like a password. It expires within an hour.</span>
          </div>
        </Card>
        <Card title="Get a token from the command line">
          <pre>{`export TOKEN=$(aws cognito-idp initiate-auth \\
  --region ${cfg.region} \\
  --client-id ${cfg.cliClientId} \\
  --auth-flow USER_PASSWORD_AUTH \\
  --auth-parameters USERNAME=$EMAIL,PASSWORD="$PASSWORD" \\
  --query AuthenticationResult.AccessToken --output text)`}</pre>
        </Card>
      </div>
      <div className="grid two">
        <Card title="curl examples">
          <pre>{`# Latest 5-minute interval
curl -s -H "Authorization: Bearer $TOKEN" ${api}/v1/grid/current | jq '.load_mw, .reserves.prc_mw'

# 48-hour load forecast (Analyst)
curl -s -H "Authorization: Bearer $TOKEN" "${api}/v1/forecast/load?hours=48" | jq '.backtest'

# SQL over the lake (Analyst)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
  -d '{"sql":"SELECT dt, max(load_mw) peak FROM grid_interval WHERE dt >= '"'"'2026-10-01'"'"' GROUP BY dt ORDER BY dt"}' \\
  ${api}/v1/query/sql | jq '.rows'

# Ask the AI assistant (Analyst; synchronous)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
  -d '{"message":"Summarize grid conditions in the last 6 hours"}' ${api}/v1/ai/ask | jq -r '.answer'`}</pre>
        </Card>
        <Card title="SDKs">
          <pre>{`// TypeScript: sdk/typescript
import { GridSightClient } from '@gridsight/sdk';
const gs = new GridSightClient({ baseUrl: '${api}', token: process.env.TOKEN! });
const now = await gs.grid.current();
for await (const ev of gs.chat.stream('Why did PRC drop this evening?')) {
  if (ev.type === 'chat.delta') process.stdout.write(ev.text);
}

# Python: sdk/python
from gridsight import GridSight
gs = GridSight.login("${api}", client_id="${cfg.cliClientId}", username=..., password=...)
df = gs.sql_df("SELECT * FROM grid_interval WHERE dt = '2026-10-29'")`}</pre>
        </Card>
      </div>
      <Card title="API reference" actions={<button className="small" onClick={() => setShowSpec((s) => !s)}>{showSpec ? 'Hide' : 'Show interactive docs'}</button>}>
        {showSpec ? (
          <div className="swagger-wrap">
            <Suspense fallback={<Skeleton height={400} />}>
              <SwaggerUI url="/openapi.yaml" requestInterceptor={async (req: any) => { req.headers.Authorization = `Bearer ${await accessToken()}`; return req; }} />
            </Suspense>
          </div>
        ) : <p className="note">Interactive Swagger UI with your token pre-attached. "Try it out" calls the live API as you.</p>}
      </Card>
    </>
  );
}
