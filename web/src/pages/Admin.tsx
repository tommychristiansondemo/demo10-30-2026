import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Role } from '../api/types';
import { Card, DataTable, ErrorBox, Segmented, Skeleton } from '../components/ui';
import { dateTimeCpt } from '../lib/format';
import { useAsync } from '../lib/hooks';

const ROLES: Role[] = ['Viewer', 'Analyst', 'Operator', 'Admin'];
// `us.`/`global.` IDs use the Bedrock runtime; bare `anthropic.` IDs use the Bedrock Mantle endpoint.
const MODELS = [
  'us.anthropic.claude-opus-4-6-v1',
  'us.anthropic.claude-sonnet-4-6',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'anthropic.claude-opus-5-5',
  'anthropic.claude-sonnet-5-5',
  'anthropic.claude-opus-4-8',
];

export function Admin() {
  const [tab, setTab] = useState<'config' | 'users' | 'audit'>('config');
  return (
    <>
      <div className="page-head">
        <div><h1>Administration</h1><p>Feature flags and model settings, user roles and the audit trail. All changes are audited.</p></div>
        <span className="spacer" />
        <Segmented label="Section" value={tab} onChange={setTab} options={[{ value: 'config', label: 'Feature flags & AI' }, { value: 'users', label: 'Users & roles' }, { value: 'audit', label: 'Audit log' }]} />
      </div>
      {tab === 'config' && <ConfigEditor />}
      {tab === 'users' && <Users />}
      {tab === 'audit' && <Audit />}
    </>
  );
}

function ConfigEditor() {
  const { data, error, loading, reload } = useAsync(() => api.get<{ config: any; version: number }>('/v1/admin/config'), []);
  const [draft, setDraft] = useState<any>();
  const [raw, setRaw] = useState(false);
  const [rawText, setRawText] = useState('');
  const [msg, setMsg] = useState<string>();
  const [err, setErr] = useState<Error>();
  useEffect(() => { if (data) { setDraft(structuredClone(data.config)); setRawText(JSON.stringify(data.config, null, 2)); } }, [data]);
  if (loading && !draft) return <Skeleton height={400} />;
  if (error) return <ErrorBox error={error} />;
  if (!draft) return null;

  const set = (path: string[], value: unknown) => setDraft((d: any) => {
    const next = structuredClone(d);
    let o = next;
    for (const k of path.slice(0, -1)) o = o[k];
    o[path[path.length - 1]] = value;
    return next;
  });
  const save = async () => {
    setErr(undefined); setMsg(undefined);
    try {
      const body = raw ? JSON.parse(rawText) : draft;
      const r = await api.put<{ version: number }>('/v1/admin/config', body);
      setMsg(`Saved as version ${r.version}. Lambdas pick up changes within 60 seconds.`);
      void reload();
    } catch (e) { setErr(e as Error); }
  };

  return (
    <div className="grid two">
      <Card title="AI configuration" sub={`SSM parameter version ${data?.version}`} actions={<button className="small" onClick={() => setRaw((r) => !r)}>{raw ? 'Form' : 'Raw JSON'}</button>}>
        {raw ? (
          <textarea className="mono" rows={24} value={rawText} onChange={(e) => setRawText(e.target.value)} aria-label="Raw configuration JSON" />
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <Toggle label="AI features enabled (global kill switch)" checked={draft.ai.enabled} onChange={(v) => set(['ai', 'enabled'], v)} />
            <label className="field">Chat model (Bedrock model ID)
              <input list="models" value={draft.ai.chatModelId} onChange={(e) => set(['ai', 'chatModelId'], e.target.value)} />
            </label>
            <label className="field">Fallback model (used if the chat model declines)
              <input list="models" value={draft.ai.fallbackModelId} onChange={(e) => set(['ai', 'fallbackModelId'], e.target.value)} />
            </label>
            <label className="field">NL→SQL model
              <input list="models" value={draft.ai.sqlModelId} onChange={(e) => set(['ai', 'sqlModelId'], e.target.value)} />
            </label>
            <datalist id="models">{MODELS.map((m) => <option key={m} value={m} />)}</datalist>
            <div className="grid two">
              <label className="field">Effort
                <select value={draft.ai.effort} onChange={(e) => set(['ai', 'effort'], e.target.value)}>{['low', 'medium', 'high', 'xhigh', 'max'].map((x) => <option key={x}>{x}</option>)}</select>
              </label>
              <label className="field">Prompt profile
                <select value={draft.ai.promptVariant} onChange={(e) => set(['ai', 'promptVariant'], e.target.value)}>{['operations-analyst', 'developer-assistant', 'executive-brief'].map((x) => <option key={x}>{x}</option>)}</select>
              </label>
              <label className="field">Max tool iterations
                <input type="number" min={1} max={20} value={draft.ai.maxToolIterations} onChange={(e) => set(['ai', 'maxToolIterations'], Number(e.target.value))} />
              </label>
              <label className="field">Max output tokens
                <input type="number" min={1024} max={64000} step={1024} value={draft.ai.maxOutputTokens} onChange={(e) => set(['ai', 'maxOutputTokens'], Number(e.target.value))} />
              </label>
            </div>
            <h3>Agent tools</h3>
            {Object.keys(draft.ai.tools).map((t) => <Toggle key={t} label={t} mono checked={draft.ai.tools[t]} onChange={(v) => set(['ai', 'tools', t], v)} />)}
          </div>
        )}
        <div className="row" style={{ marginTop: 16 }}>
          <button className="primary" onClick={() => void save()}>Save configuration</button>
          {msg && <span className="note">{msg}</span>}
        </div>
        {err && <div style={{ marginTop: 8 }}><ErrorBox error={err} /></div>}
      </Card>
      {!raw && (
        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          <Card title="Feature flags">
            <div style={{ display: 'grid', gap: 10 }}>
              {Object.keys(draft.features).map((f) => <Toggle key={f} label={f} mono checked={draft.features[f]} onChange={(v) => set(['features', f], v)} />)}
            </div>
          </Card>
          <Card title="Anomaly detector thresholds">
            <div className="grid two">
              {Object.keys(draft.anomaly).map((k) => (
                <label key={k} className="field"><span className="mono">{k}</span>
                  <input type="number" step="any" value={draft.anomaly[k]} onChange={(e) => set(['anomaly', k], Number(e.target.value))} />
                </label>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function Toggle({ label, checked, onChange, mono }: { label: string; checked: boolean; onChange: (v: boolean) => void; mono?: boolean }) {
  return (
    <label className="row" style={{ cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ width: 16, height: 16 }} />
      <span className={mono ? 'mono' : ''}>{label}</span>
    </label>
  );
}

interface UserRow { username: string; email?: string; status: string; enabled: boolean; createdAt: string; groups: string[] }

function Users() {
  const { data, error, loading, reload } = useAsync(() => api.get<{ users: UserRow[] }>('/v1/admin/users'), []);
  const [msg, setMsg] = useState<string>();
  const [err, setErr] = useState<Error>();
  const setRole = async (u: UserRow, role: Role) => {
    setErr(undefined);
    try { const r = await api.put<{ note: string }>(`/v1/admin/users/${encodeURIComponent(u.username)}/role`, { role }); setMsg(`${u.email ?? u.username}: ${role}. ${r.note}`); void reload(); } catch (e) { setErr(e as Error); }
  };
  if (loading && !data) return <Skeleton height={300} />;
  return (
    <Card title="Users" sub="Roles map to Cognito groups; each role includes the permissions of the roles below it" flush>
      {error && <ErrorBox error={error} />}
      {err && <ErrorBox error={err} />}
      {msg && <div className="note" style={{ padding: '8px 16px' }}>{msg}</div>}
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Email</th><th>Status</th><th>Created</th><th>Role</th></tr></thead>
          <tbody>
            {(data?.users ?? []).map((u) => {
              const current = ROLES.slice().reverse().find((r) => u.groups.includes(r)) ?? 'Viewer';
              return (
                <tr key={u.username}>
                  <td>{u.email ?? u.username}</td>
                  <td>{u.status}{!u.enabled && ' (disabled)'}</td>
                  <td>{dateTimeCpt(u.createdAt)}</td>
                  <td>
                    <select value={current} onChange={(e) => void setRole(u, e.target.value as Role)} aria-label={`Role for ${u.email ?? u.username}`} style={{ width: 140 }}>
                      {ROLES.map((r) => <option key={r}>{r}</option>)}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Audit() {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const { data, error, loading } = useAsync(() => api.get<{ events: any[] }>(`/v1/admin/audit?date=${date}&limit=500`), [date]);
  return (
    <Card title="Audit log" sub="AI interactions, queries, alert workflow, config and role changes" actions={<input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 170 }} aria-label="Date" />} flush>
      {error && <ErrorBox error={error} />}
      {loading && !data ? <Skeleton height={300} /> : (
        <DataTable
          rows={(data?.events ?? []).map((e) => ({ ...e, detailsText: JSON.stringify(e.details ?? {}).slice(0, 220) }))}
          columns={[
            { key: 'ts', label: 'Time (CPT)', format: dateTimeCpt },
            { key: 'actorEmail', label: 'Actor', format: (v) => v ?? '' },
            { key: 'role', label: 'Role' },
            { key: 'action', label: 'Action' },
            { key: 'resource', label: 'Resource' },
            { key: 'outcome', label: 'Outcome' },
            { key: 'detailsText', label: 'Details' },
          ]}
        />
      )}
    </Card>
  );
}
