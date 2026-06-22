import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// ---------------------------------------------------------------------------
// CSRF: echo the server-issued XSRF-TOKEN cookie back as an X-CSRF-Token header
// on same-origin, state-changing requests. Installed once, globally, BEFORE the
// app mounts, so every fetch in the app — api.js methods and the raw fetches in
// components (Portrait, DiceTray, ShareModal, CharacterList, SheetRenderer) —
// carries the token without per-call wiring. This pairs with the validator in
// server.js (active when CSRF_ENFORCE=true).
//
// Deliberately scoped:
//   • GET/HEAD are left untouched (no state change, nothing to protect).
//   • Cross-origin requests never receive the token — it stays on our origin.
//   • If there's no cookie (logged-out, or an external share viewer), no header
//     is added; the server exempts those flows, so nothing breaks.
(function installCsrfInterceptor() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  const origFetch = window.fetch.bind(window);

  const readToken = () => {
    const m = document.cookie.match(/(?:^|; )XSRF-TOKEN=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : null;
  };
  const sameOrigin = (url) => {
    try { return new URL(url, window.location.origin).origin === window.location.origin; }
    catch { return false; }
  };

  window.fetch = (input, init = {}) => {
    const url    = typeof input === 'string' ? input : input?.url;
    const method = (init.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && url && sameOrigin(url)) {
      const token = readToken();
      if (token) {
        const headers = new Headers(
          init.headers || (typeof input !== 'string' ? input.headers : undefined) || {}
        );
        if (!headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token);
        init = { ...init, headers };
      }
    }
    return origFetch(input, init);
  };
})();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
