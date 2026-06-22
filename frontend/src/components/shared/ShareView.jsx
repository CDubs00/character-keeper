import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import SheetRenderer from '../SheetRenderer';
import { Toast } from './UI';

export default function ShareView() {
  const { token } = useParams();
  const [char, setChar] = useState(null);
  const [permission, setPermission] = useState('view');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const saveTimer = useRef(null);

  useEffect(() => {
    fetch(`/api/share/${token}`)
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
      .then(data => {
        setChar(data.char);
        setPermission(data.permission);
      })
      .catch(e => setError(e.error || 'Something went wrong'));
  }, [token]);

  const doSave = useCallback(async (current) => {
    const res = await fetch(`/api/share/${token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(current),
    });
    if (res.ok) {
      setToast('Saved');
      setTimeout(() => setToast(''), 2000);
    }
  }, [token]);

  // SheetRenderer passes the full new char object (not a patch),
  // so update replaces state directly and schedules a save
  const update = useCallback((newChar) => {
    if (permission !== 'edit') return;
    setChar(newChar);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => doSave(newChar), 800);
  }, [permission, doSave]);

  if (error) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.2rem', color: 'var(--text-accent)' }}>
        {error === 'Link expired' ? 'This link has expired' : 'Link not found'}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
        Ask the character owner to generate a new share link
      </div>
    </div>
  );

  if (!char) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
      Loading...
    </div>
  );

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '1.5rem 1rem 4rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--text-dim)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          Character Keeper — {permission === 'edit' ? 'Shared (Editable)' : 'Shared (View Only)'}
        </div>
        {permission === 'edit' && (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--accent)' }}>
            Editing enabled — changes save automatically
          </div>
        )}
      </div>

      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.5rem', color: 'var(--text-accent)', letterSpacing: '0.08em' }}>
          {char.info?.name || 'Character'}
        </h1>
        {char.info?.concept && (
          <div style={{ fontFamily: 'var(--font-body)', fontStyle: 'italic', color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
            {char.info.concept}
          </div>
        )}
        <div style={{ height: '1px', background: 'linear-gradient(90deg, var(--accent), transparent)', marginTop: '0.5rem' }} />
      </div>

      <SheetRenderer char={char} update={update} charId={char.id} readOnly={permission !== 'edit'} />
      <Toast message={toast} />
    </div>
  );
}
