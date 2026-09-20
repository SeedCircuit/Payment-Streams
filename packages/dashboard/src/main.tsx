import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { captureExternalRefFromUrl } from './lib/externalRef.js';
import './styles/globals.css';
import './styles/cc-streams.css';

captureExternalRefFromUrl();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
