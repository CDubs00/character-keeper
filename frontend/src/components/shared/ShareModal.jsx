import React, { useState, useEffect } from 'react';

const EXPIRY_OPTIONS = [
  { label: '1 day', value: 1 },
  { label: '3 days', value: 3 },
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
];

export default function ShareModal({ characterId, onClose, onChanged }) {
  const [permission, setPermission] = useState('view');
  const [expiresInDays, setExpiresInDays] = useState(3);
  const [link, setLink] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState('');
  const [shares, setShares] = useState([]);
  const [loadingShares, setLoadingShares] = useState(false);

  const baseUrl = window.location.origin;

  useEffect(() => {
    setLoadingShares(true);
    fetch(`/api/characters/${characterId}/shares`, { credentials: 'include' })
      .then(r => r.json())
      .then(data => { setShares(data); setLoadingShares(false); });
  }, [characterId]);

  const generate = async () => {
    setLoading(true);
    const res = await fetch(`/api/characters/${characterId}/shares`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permission, expiresInDays }),
    });
    const data = await res.json();
    setLink(`${baseUrl}/share/${data.token}`);
    setShares(prev => [...prev, data]);   // show it in Active Links right away
    setLoading(false);
    onChanged?.(true);                    // roster badge: now has an active share
  };

  const copy = () => {
    navigator.clipboard.writeText(link);
    setCopied('new');
    setTimeout(() => setCopied(''), 2000);
  };

  const revoke = async (token) => {
    await fetch(`/api/characters/${characterId}/shares/${token}`, { method: 'DELETE', credentials: 'include' });
    setShares(prev => {
      const next = prev.filter(s => s.token !== token);
      onChanged?.(next.length > 0);       // roster badge follows the remaining count
      return next;
    });
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 100,
    }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{
        width: 480, background: 'var(--bg-surface)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius)',
        padding: '1.5rem',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <h2 style={{ fontSize: '0.9rem', letterSpacing: '0.1em', color: 'var(--text-accent)' }}>Share Character</h2>
          <button className="btn-ghost" onClick={onClose} style={{ padding: '0.2rem 0.5rem' }}>✕</button>
        </div>

        <div style={{ height: '1px', background: 'linear-gradient(90deg, var(--accent), transparent)', marginBottom: '1.25rem' }} />

        {/* Permission */}
        <div style={{ marginBottom: '0.75rem' }}>
          <label>Permission</label>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
            {['view', 'edit'].map(p => (
              <button
                key={p}
                type="button"
                className={permission === p ? 'btn-primary' : 'btn-ghost'}
                onClick={() => setPermission(p)}
                style={{ flex: 1, textTransform: 'capitalize' }}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {/* Expiration */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label>Expires After</label>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
            {EXPIRY_OPTIONS.map(o => (
              <button
                key={o.value}
                type="button"
                className={expiresInDays === o.value ? 'btn-primary' : 'btn-ghost'}
                onClick={() => setExpiresInDays(o.value)}
                style={{ flex: 1 }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* Generate */}
        <button
          className="btn-primary"
          onClick={generate}
          disabled={loading}
          style={{ width: '100%', marginBottom: '1rem' }}
        >
          {loading ? 'Generating...' : 'Generate Link'}
        </button>

        {/* Generated link */}
        {link && (
          <div style={{
            background: 'var(--bg-raised)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', padding: '0.75rem',
            marginBottom: '1rem',
          }}>
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: '0.65rem',
              color: 'var(--text-dim)', wordBreak: 'break-all',
              marginBottom: '0.5rem',
            }}>
              {link}
            </div>
            <button className="btn-ghost" onClick={copy} style={{ width: '100%' }}>
              {copied === 'new' ? '✓ Copied' : 'Copy Link'}
            </button>
          </div>
        )}

        {/* Existing shares */}
        {shares.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
            <div style={{
            fontFamily: 'var(--font-mono)', fontSize: '0.65rem',
            color: 'var(--text-dim)', letterSpacing: '0.1em',
            textTransform: 'uppercase', marginBottom: '0.5rem'
            }}>
            Active Links
            </div>
            {shares.map(s => (
            <div key={s.token} style={{
                background: 'var(--bg-raised)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius)', padding: '0.6rem 0.75rem',
                marginBottom: '0.4rem', display: 'flex',
                justifyContent: 'space-between', alignItems: 'center',
            }}>
                <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--text-accent)', textTransform: 'capitalize' }}>
                    {s.permission}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--text-dim)' }}>
                    Expires {new Date(s.expiresAt).toLocaleDateString()}
                </div>
                </div>
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                <button className="btn-ghost" style={{ fontSize: '0.65rem', padding: '0.2rem 0.5rem' }}
                    onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}/share/${s.token}`);
                    setCopied(s.token);
                    setTimeout(() => setCopied(''), 2000);
                    }}>
                    {copied === s.token ? '✓' : 'Copy'}
                </button>
                <button className="btn-danger" style={{ fontSize: '0.65rem', padding: '0.2rem 0.5rem' }}
                    onClick={() => revoke(s.token)}>
                    Revoke
                </button>
                </div>
            </div>
            ))}
        </div>
        )}
      </div>
    </div>
  );
}