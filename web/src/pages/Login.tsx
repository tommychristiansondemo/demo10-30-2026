import { confirmSignIn, signIn, signInWithRedirect, signUp } from 'aws-amplify/auth';
import { useState, type FormEvent } from 'react';
import type { Role } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { config } from '../lib/config';

type Mode = 'signIn' | 'newPassword' | 'totp' | 'signUp';

const ROLE_HELP: Record<Role, string> = {
  Viewer: 'Read-only dashboards and alerts',
  Analyst: 'Viewer + AI assistant, forecasts, SQL and knowledge search',
  Operator: 'Analyst + acknowledge, resolve and create alerts',
  Admin: 'Everything, including model settings, audit log and user roles',
};
const ROLE_OPTIONS = Object.keys(ROLE_HELP) as Role[];

export function Login() {
  const { refresh, error: authError } = useAuth();
  const [mode, setMode] = useState<Mode>('signIn');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('Analyst');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();
  const cfg = config();

  const run = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try { await fn(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  const handleStep = async (step: string) => {
    if (step === 'DONE') return refresh();
    if (step === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') { setPassword(''); return setMode('newPassword'); }
    if (step === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') { setCode(''); return setMode('totp'); }
    throw new Error(`Unsupported sign-in step: ${step}`);
  };

  // Accounts are auto-confirmed by the pre sign-up trigger, so sign in straight away.
  const createAccount = async () => {
    await signUp({ username: username.trim(), password, options: { userAttributes: { 'custom:role': role } } });
    await handleStep((await signIn({ username: username.trim(), password })).nextStep.signInStep);
  };

  const switchTo = (m: Mode) => (e: React.MouseEvent) => { e.preventDefault(); setError(undefined); setInfo(undefined); setMode(m); };

  return (
    <div className="auth-page">
      <section className="auth-hero">
        <div className="brand" style={{ color: '#fff' }}>
          <Logo /> GridSight AI <span className="badge env-badge">{cfg.env}</span>
        </div>
        <div>
          <h1>Grid operations intelligence for ERCOT engineers.</h1>
          <p>Real-time and historical grid awareness, AI-assisted anomaly detection and load forecasting, natural-language queries over grid data and operating knowledge, all behind an audited, role-based platform you can extend.</p>
          <ul>
            <li>5-minute load, generation mix, frequency, reserves and prices</li>
            <li>Claude-powered assistant with SQL, forecasting and RAG tools</li>
            <li>REST and WebSocket APIs with OpenAPI docs</li>
          </ul>
        </div>
        <p style={{ fontSize: 12 }}>All grid data in this environment is synthetic and generated for demonstration.</p>
      </section>
      <section className="auth-panel">
        {mode === 'signIn' && (
          <form className="auth-form" onSubmit={run(async () => handleStep((await signIn({ username: username.trim(), password })).nextStep.signInStep))}>
            <h1>Sign in</h1>
            {cfg.federatedProviders.map((p) => (
              <button type="button" key={p} onClick={() => void signInWithRedirect({ provider: { custom: p } })}>Continue with {p}</button>
            ))}
            {cfg.federatedProviders.length > 0 && <div className="divider">or</div>}
            <label className="field">Username<input autoComplete="username" autoCapitalize="none" spellCheck={false} required value={username} onChange={(e) => setUsername(e.target.value)} /></label>
            <label className="field">Password<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <Feedback error={error ?? authError} info={info} />
            <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
            <p className="note">New here? <a href="#" onClick={switchTo('signUp')}>Create an account</a> with any role. It takes a few seconds and needs no email.</p>
          </form>
        )}
        {mode === 'newPassword' && (
          <form className="auth-form" onSubmit={run(async () => handleStep((await confirmSignIn({ challengeResponse: password })).nextStep.signInStep))}>
            <h1>Set a new password</h1>
            <p className="note">Your account uses a temporary password. Choose a new one of at least 6 characters.</p>
            <label className="field">New password<input type="password" autoComplete="new-password" minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <Feedback error={error} />
            <button className="primary" disabled={busy}>Save and continue</button>
          </form>
        )}
        {mode === 'totp' && (
          <form className="auth-form" onSubmit={run(async () => handleStep((await confirmSignIn({ challengeResponse: code })).nextStep.signInStep))}>
            <h1>Authenticator code</h1>
            <label className="field">6-digit code<input inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} /></label>
            <Feedback error={error} />
            <button className="primary" disabled={busy}>Verify</button>
          </form>
        )}
        {mode === 'signUp' && (
          <form className="auth-form" onSubmit={run(createAccount)}>
            <h1>Create account</h1>
            <p className="note">Pick any username and a password of at least 6 characters. Create one account per role to compare what each can do.</p>
            <label className="field">Username<input autoComplete="username" autoCapitalize="none" spellCheck={false} required pattern="[A-Za-z0-9._@+\-]{3,64}" title="3–64 letters, digits or . _ @ + -" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
            <label className="field">Password<input type="password" autoComplete="new-password" minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <fieldset className="field role-picker">
              <legend>Role</legend>
              {ROLE_OPTIONS.map((r) => (
                <label key={r} className="role-option">
                  <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} />
                  <span><strong>{r}</strong><small>{ROLE_HELP[r]}</small></span>
                </label>
              ))}
            </fieldset>
            <Feedback error={error} />
            <button className="primary" disabled={busy}>{busy ? 'Creating…' : `Create ${role} account`}</button>
            <a href="#" onClick={switchTo('signIn')}>Back to sign in</a>
          </form>
        )}
      </section>
    </div>
  );
}

function Feedback({ error, info }: { error?: string; info?: string }) {
  if (error) return <div className="error-box" role="alert">{error}</div>;
  if (info) return <div className="note" role="status">{info}</div>;
  return null;
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#0d366b" />
      <path d="M4 20h5l3-9 4 14 4-18 3 13h5" fill="none" stroke="#86b6ef" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
