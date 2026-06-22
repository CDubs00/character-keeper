import React, { useState } from 'react';

export default function Setup({ onSetup }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm,  setConfirm]  = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setError('');
    if (password.length < 8) { setError('Password must be at least 10 characters'); return; }
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setLoading(true);
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || 'Setup failed');
      else onSetup(data);
    } catch (e) {
      setError('Could not reach server');
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
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
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
            First-Run Setup
          </h1>
          <div style={{ height: '1px', background: 'linear-gradient(90deg, transparent, var(--accent), transparent)', marginTop: '0.75rem' }} />
        </div>

        <p style={{
          fontSize: '0.8rem',
          color: 'var(--text-dim)',
          textAlign: 'center',
          marginBottom: '1.5rem',
          lineHeight: 1.5,
        }}>
          No accounts exist yet. Create your admin account to get started.
        </p>

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
        <div style={{ marginBottom: '0.75rem' }}>
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          />
        </div>
        <div style={{ marginBottom: '1.25rem' }}>
          <label>Confirm Password</label>
          <input
            type="password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
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
          {loading ? 'Creating...' : 'Create Admin Account'}
        </button>
      </div>
    </div>
  );
}