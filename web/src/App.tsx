import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { live } from './api/live';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { Layout, RequireRole } from './components/Layout';
import { Skeleton } from './components/ui';
import { Admin } from './pages/Admin';
import { Alerts } from './pages/Alerts';
import { Assistant } from './pages/Assistant';
import { Developers } from './pages/Developers';
import { Explorer } from './pages/Explorer';
import { Forecast } from './pages/Forecast';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';

function Routed() {
  const { status } = useAuth();
  useEffect(() => {
    if (status === 'signedIn') live.start();
    else live.stop();
  }, [status]);

  if (status === 'loading') return <div style={{ padding: 40 }}><Skeleton height={200} /></div>;
  if (status === 'signedOut') return <Login />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/forecast" element={<RequireRole role="Analyst"><Forecast /></RequireRole>} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/explorer" element={<RequireRole role="Analyst"><Explorer /></RequireRole>} />
        <Route path="/assistant" element={<RequireRole role="Analyst"><Assistant /></RequireRole>} />
        <Route path="/developers" element={<Developers />} />
        <Route path="/admin" element={<RequireRole role="Admin"><Admin /></RequireRole>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routed />
      </AuthProvider>
    </BrowserRouter>
  );
}
