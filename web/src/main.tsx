import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { configureAmplify } from './auth/amplify';
import { loadConfig } from './lib/config';
import { initTheme } from './lib/hooks';
import './styles/app.css';

initTheme();
const root = createRoot(document.getElementById('root')!);

loadConfig()
  .then((cfg) => {
    configureAmplify(cfg);
    root.render(<StrictMode><App /></StrictMode>);
  })
  .catch((err: Error) => {
    root.render(<div style={{ padding: 40, maxWidth: 640 }}><h1>GridSight AI</h1><p className="error-box">{err.message}</p></div>);
  });
