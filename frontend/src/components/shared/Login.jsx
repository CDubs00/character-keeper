import React, { useState, useRef } from 'react';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const passwordRef = useRef(null);

  // Clear the rejected password and drop the cursor back into the field so the
  // user can retype immediately. Deferred a tick so it runs after React has
  // re-rendered the now-empty input (focusing before the re-render can be lost).
  const resetPassword = () => {
    setPassword('');
    setTimeout(() => passwordRef.current?.focus(), 0);
  };

  const handleSubmit = async () => {
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Login failed');
        resetPassword();
      } else {
        onLogin(data);
      }
    } catch (e) {
      setError('Could not reach server');
      resetPassword();
    }
    setLoading(false);
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <div style={{
        width: 340,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '2rem',
      }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.65rem',
            color: 'var(--text-dim)',
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
            marginBottom: '0.4rem',
          }}>
            Character Keeper
          </div>
          <h1 style={{ fontSize: '1.5rem', color: 'var(--text-accent)', letterSpacing: '0.08em' }}>
            Sign In
          </h1>
          <div style={{ height: '1px', background: 'linear-gradient(90deg, transparent, var(--accent), transparent)', marginTop: '0.75rem' }} />
        </div>

        {/* Fields */}
        <div style={{ marginBottom: '0.75rem' }}>
          <label>Username</label>
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            autoFocus
          />
        </div>
        <div style={{ marginBottom: '1.25rem' }}>
          <label>Password</label>
          <input
            ref={passwordRef}
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          />
        </div>

        {error && (
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.75rem',
            color: 'var(--red)',
            marginBottom: '1rem',
            textAlign: 'center',
          }}>
            {error}
          </div>
        )}

        <button
          className="btn-primary"
          onClick={handleSubmit}
          disabled={loading}
          style={{ width: '100%', padding: '0.6rem' }}
        >
          {loading ? 'Signing in...' : 'Enter'}
        </button>
      </div>
    </div>
  );
}