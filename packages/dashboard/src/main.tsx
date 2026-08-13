import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { captureExternalRefFromUrl } from './lib/externalRef.js';
import './styles/globals.css';
import './styles/cc-streams.css';

// Stash a landing `?ref=`/`?externalRef=` before anything renders, then strip it
// from the URL — captured once, applied to the next stream created (see
// lib/externalRef.ts). Runs here, outside React, so StrictMode can't double it.
captureExternalRefFromUrl();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
