import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { live } from '../api/live';
import type { Alert } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorBox, Segmented, SeverityBadge, Skeleton } from '../components/ui';
import { ago, dateTimeCpt } from '../lib/format';
import { useAsync } from '../lib/hooks';

type Status = Alert['status'];

export function Alerts() {
  const { can } = useAuth();
  const [status, setStatus] = useState<Status>('OPEN');
  const [severity, setSeverity] = useState<'ALL' | 'CRITICAL' | 'WARNING'>('ALL');
  const { data, error, loading, reload } = useAsync(() => api.get<{ alerts: Alert[] }>(`/v1/alerts?status=${status}&limit=200`), [status]);
  useEffect(() => live.subscribe((m) => { if (m.type === 'alert.new' || m.type === 'alert.updated') void reload(); }), [reload]);
  const alerts = (data?.alerts ?? []).filter((a) => severity === 'ALL' || a.severity === severity);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Alerts</h1>
          <p>Raised by the anomaly detectors, contingency events and operators. Every acknowledgement and resolution is written to the audit log.</p>
        </div>
        <span className="spacer" />
        <Segmented label="Severity" value={severity} onChange={setSeverity} options={[{ value: 'ALL', label: 'All' }, { value: 'CRITICAL', label: 'Critical' }, { value: 'WARNING', label: 'Warning' }]} />
        <Segmented label="Status" value={status} onChange={setStatus} options={[{ value: 'OPEN', label: 'Open' }, { value: 'ACKNOWLEDGED', label: 'Acknowledged' }, { value: 'RESOLVED', label: 'Resolved' }]} />
      </div>
      {error && <ErrorBox error={error} />}
      {loading && !data ? <Skeleton height={300} /> : (
        <div className="card">
          <div className="list">
            {alerts.map((a) => <AlertRow key={a.id} alert={a} canAct={can('Operator')} onChange={reload} />)}
            {alerts.length === 0 && <div className="empty">No {status.toLowerCase()} alerts</div>}
          </div>
        </div>
      )}
    </>
  );
}

function AlertRow({ alert: a, canAct, onChange }: { alert: Alert; canAct: boolean; onChange: () => void }) {
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const act = async (action: 'ack' | 'resolve') => {
    setBusy(true);
    setErr(undefined);
    try {
      await api.post(`/v1/alerts/${encodeURIComponent(a.id)}/${action}`, { note: note || undefined });
      setNote('');
      onChange();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="list-item" style={{ flexDirection: 'column', gap: 6 }}>
      <div className="row" style={{ width: '100%' }}>
        <SeverityBadge severity={a.severity} />
        <span className="title">{a.title}</span>
        <span className="badge">{a.type.replace(/_/g, ' ')}</span>
        {a.zone && <span className="badge">{a.zone.replace('_', ' ')}</span>}
        <span style={{ flex: 1 }} />
        <span className="meta" title={dateTimeCpt(a.ts)}>{dateTimeCpt(a.ts)} · {ago(a.ts)}</span>
        <button className="ghost small" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'Hide' : 'Details'}</button>
      </div>
      <div className="meta" style={{ color: 'var(--text-secondary)' }}>{a.message}</div>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
          <div className="meta mono">id {a.id}{a.value !== undefined && ` · value ${a.value}`}{a.expected !== undefined && ` · expected ${a.expected}`}{a.score !== undefined && ` · score ${a.score}`}</div>
          {(a.notes ?? []).map((n, i) => <div key={i} className="meta">{dateTimeCpt(n.at)} · {n.by}: {n.text}</div>)}
          {canAct && a.status !== 'RESOLVED' && (
            <div className="row">
              <input placeholder="Note (optional): cause, action taken…" value={note} onChange={(e) => setNote(e.target.value)} style={{ maxWidth: 520 }} />
              {a.status === 'OPEN' && <button disabled={busy} onClick={() => void act('ack')}>Acknowledge</button>}
              <button className="primary" disabled={busy} onClick={() => void act('resolve')}>Resolve</button>
            </div>
          )}
          {!canAct && a.status !== 'RESOLVED' && <div className="note">Operators can acknowledge and resolve alerts.</div>}
          {err && <div className="error-box">{err}</div>}
        </div>
      )}
    </div>
  );
}
