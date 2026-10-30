import { useEffect, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { live, type LiveStatus } from '../api/live';
import type { Role } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { config } from '../lib/config';
import { useThemePref } from '../lib/hooks';
import { Logo } from '../pages/Login';
import { ChatPanel } from './ChatPanel';
import { Icon } from './ui';

const NAV: { to: string; label: string; icon: string; role: Role }[] = [
  { to: '/', label: 'Overview', icon: 'overview', role: 'Viewer' },
  { to: '/forecast', label: 'Forecast', icon: 'forecast', role: 'Analyst' },
  { to: '/alerts', label: 'Alerts', icon: 'alert', role: 'Viewer' },
  { to: '/explorer', label: 'Data explorer', icon: 'sql', role: 'Analyst' },
  { to: '/assistant', label: 'AI assistant', icon: 'chat', role: 'Analyst' },
  { to: '/developers', label: 'Developers', icon: 'code', role: 'Viewer' },
  { to: '/admin', label: 'Admin', icon: 'admin', role: 'Admin' },
];

export function Layout({ children }: { children: ReactNode }) {
  const { me, can, signOut, feature } = useAuth();
  const [status, setStatus] = useState<LiveStatus>('closed');
  const [drawer, setDrawer] = useState(false);
  const [theme, setTheme] = useThemePref();
  useEffect(() => live.onStatus(setStatus), []);
  const aiAvailable = can('Analyst') && feature('aiChat') && me?.config.ai.enabled;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><Logo /> <div>GridSight AI<small>ERCOT grid intelligence</small></div></div>
        <nav className="nav" aria-label="Main">
          {NAV.filter((n) => n.role !== 'Admin' || can('Admin')).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
              <Icon name={n.icon} /> {n.label}
              {!can(n.role) && <span className="lock" title={`Requires ${n.role}`}>{n.role}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">Synthetic data · {config().env} environment</div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className={`live ${status}`} title="Live updates via WebSocket"><span className="pulse" />{status === 'open' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline'}</span>
          <span className="badge env-badge">{config().env}</span>
          <span className="spacer" />
          {aiAvailable && <button onClick={() => setDrawer(true)}><Icon name="sparkle" /> Ask GridSight</button>}
          <button className="ghost" aria-label="Toggle theme" title={`Theme: ${theme}`} onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')}>
            <Icon name={theme === 'dark' ? 'moon' : 'sun'} /> <span className="note">{theme}</span>
          </button>
          <span className="badge" title={me?.user.groups.join(', ')}>{me?.user.email ?? me?.user.username} · {me?.user.role}</span>
          <button className="ghost small" onClick={() => void signOut()}>Sign out</button>
        </header>
        <main className="content">{children}</main>
      </div>
      {drawer && (
        <>
          <div className="drawer-backdrop" onClick={() => setDrawer(false)} />
          <aside className="drawer" aria-label="AI assistant">
            <div className="drawer-head"><Icon name="sparkle" /><h2>GridSight assistant</h2><span className="spacer" style={{ flex: 1 }} /><button className="ghost" aria-label="Close" onClick={() => setDrawer(false)}><Icon name="close" /></button></div>
            <ChatPanel />
          </aside>
        </>
      )}
    </div>
  );
}

export function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { can, me } = useAuth();
  if (can(role)) return <>{children}</>;
  return (
    <div className="card" style={{ padding: 24 }}>
      <h1>{role} access required</h1>
      <p className="note">You are signed in as {me?.user.role}. Ask an administrator to grant the {role} role (Admin → Users).</p>
    </div>
  );
}
