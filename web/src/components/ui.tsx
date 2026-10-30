import { useState, type ReactNode } from 'react';
import type { Severity } from '../api/types';

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const p: Record<string, ReactNode> = {
    overview: <path d="M3 13h4v8H3zM10 3h4v18h-4zM17 9h4v12h-4z" />,
    forecast: <path d="M3 17l6-6 4 4 8-8M15 7h6v6" fill="none" />,
    alert: <path d="M12 3l10 18H2zM12 10v5M12 18v.5" fill="none" />,
    sql: <path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" fill="none" />,
    chat: <path d="M4 5h16v11H8l-4 4z" fill="none" />,
    code: <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" fill="none" />,
    admin: <path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z" fill="none" />,
    sun: <path d="M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6L4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 7a5 5 0 100 10 5 5 0 000-10z" fill="none" />,
    moon: <path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z" fill="none" />,
    critical: <path d="M12 2a10 10 0 100 20 10 10 0 000-20zM12 7v6M12 16.5v.5" fill="none" />,
    warning: <path d="M12 3l10 18H2zM12 10v5M12 18v.5" fill="none" />,
    info: <path d="M12 2a10 10 0 100 20 10 10 0 000-20zM12 11v6M12 7.5v.5" fill="none" />,
    good: <path d="M12 2a10 10 0 100 20 10 10 0 000-20zM7.5 12.5l3 3 6-6.5" fill="none" />,
    send: <path d="M3 11l18-8-8 18-2-8z" fill="none" />,
    close: <path d="M6 6l12 12M18 6L6 18" fill="none" />,
    table: <path d="M3 5h18v14H3zM3 10h18M9 5v14" fill="none" />,
    sparkle: <path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" fill="none" />,
    refresh: <path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7" fill="none" />,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" fill="currentColor" aria-hidden="true">
      {p[name]}
    </svg>
  );
}

const SEV: Record<string, { icon: string; label: string }> = {
  CRITICAL: { icon: 'critical', label: 'Critical' },
  WARNING: { icon: 'warning', label: 'Warning' },
  INFO: { icon: 'info', label: 'Info' },
  GOOD: { icon: 'good', label: 'Normal' },
};

/** Status is never color-alone: icon + text label + color. */
export function SeverityBadge({ severity, label }: { severity: Severity | 'GOOD'; label?: string }) {
  const s = SEV[severity];
  return (
    <span className={`badge sev-${severity}`}>
      <Icon name={s.icon} size={13} />
      {label ?? s.label}
    </span>
  );
}

export function Card({ title, sub, actions, children, flush }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {sub && <span className="sub">{sub}</span>}
          <span className="spacer" />
          {actions}
        </div>
      )}
      <div className={`card-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

/** Chart card with a table-view toggle (accessibility relief for low-contrast series colors). */
export function ChartCard<R extends Record<string, unknown>>({ title, sub, actions, chart, rows, columns }: {
  title: string; sub?: ReactNode; actions?: ReactNode; chart: ReactNode;
  rows: R[]; columns: { key: keyof R & string; label: string; num?: boolean; format?: (v: any) => string }[];
}) {
  const [table, setTable] = useState(false);
  return (
    <Card
      title={title}
      sub={sub}
      actions={
        <div className="row">
          {actions}
          <button className="ghost small" onClick={() => setTable((t) => !t)} aria-pressed={table} title="Toggle table view">
            <Icon name="table" size={14} /> {table ? 'Chart' : 'Table'}
          </button>
        </div>
      }
    >
      {table ? <DataTable rows={rows.slice(-300).reverse()} columns={columns} /> : chart}
    </Card>
  );
}

export function DataTable<R extends Record<string, unknown>>({ rows, columns }: { rows: R[]; columns: { key: keyof R & string; label: string; num?: boolean; format?: (v: any) => string }[] }) {
  if (!rows.length) return <div className="empty">No rows</div>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>{columns.map((c) => <th key={c.key} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.key} className={c.num ? 'num' : ''}>{c.format ? c.format(r[c.key]) : String(r[c.key] ?? '')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Kpi({ label, value, unit, detail, status }: { label: string; value: ReactNode; unit?: string; detail?: ReactNode; status?: ReactNode }) {
  return (
    <div className="card kpi">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="label">{label}</span>
        {status}
      </div>
      <div className="value">{value}{unit && <small>{unit}</small>}</div>
      {detail && <div className="detail">{detail}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: Error }) {
  return <div className="error-box" role="alert">{error.message}</div>;
}

export function Skeleton({ height = 280 }: { height?: number }) {
  return <div className="skeleton" style={{ height }} aria-busy="true" />;
}

export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}
