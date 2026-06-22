import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams } from 'react-router-dom';
import CharacterList from './components/shared/CharacterList';
import CharacterSheet from './components/CharacterSheet';
import Login from './components/shared/Login';
import Setup from './components/shared/Setup';
import ShareView from './components/shared/ShareView';
import { applyTheme } from './theme';

function RequireAuth({ user, children }) {
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function SheetRoute({ user, onLogout }) {
  const { id } = useParams();
  const navigate = useNavigate();
  return (
    <CharacterSheet
      charId={id}
      onBack={() => navigate('/characters')}
      user={user}
    />
  );
}

function AppRoutes({ user, setUser, needsSetup, setNeedsSetup }) {
  const navigate = useNavigate();

  const logout = async () => {
    await fetch('/api/logout', { method: 'POST' });
    setUser(null);
    navigate('/login');
  };

  const openSheet = (id) => navigate(`/characters/${id}`);

  return (
    <Routes>
      <Route path="/setup" element={
        needsSetup && !user
          ? <Setup onSetup={(u) => {
              setNeedsSetup(false);
              setUser(u);
              applyTheme(u?.theme || 'tavern');
              navigate('/characters');
            }} />
          : <Navigate to={user ? '/characters' : '/login'} replace />
      } />
      <Route path="/login" element={
        needsSetup ? <Navigate to="/setup" replace />
          : user ? <Navigate to="/characters" replace />
          : <Login onLogin={(u) => { setUser(u); applyTheme(u?.theme || 'tavern'); navigate('/characters'); }} />
      } />
      <Route path="/characters" element={
        <RequireAuth user={user}>
          <CharacterList onSelect={openSheet} onNew={openSheet} user={user} onUser={setUser} onLogout={logout} />
        </RequireAuth>
      } />
      <Route path="/characters/:id" element={
        <RequireAuth user={user}>
          <SheetRoute user={user} />
        </RequireAuth>
      } />
      <Route path="/share/:token" element={<ShareView />} />
      <Route path="*" element={
        <Navigate to={needsSetup ? '/setup' : (user ? '/characters' : '/login')} replace />
      } />
    </Routes>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    fetch('/api/me')
      .then(r => r.ok ? r.json() : null)
      .then(async data => {
        if (data) {
          setUser(data);
          applyTheme(data.theme || 'tavern');           // personal theme
        } else {
          // Not logged in. Is this a fresh, user-less install?
          try {
            const s = await fetch('/api/setup').then(r => r.ok ? r.json() : null);
            if (s?.needsSetup) setNeedsSetup(true);
          } catch {}
          // Logged out / share page — use the admin default theme.
          fetch('/api/settings')
            .then(r => r.ok ? r.json() : null)
            .then(s => applyTheme(s?.theme || 'tavern'))
            .catch(() => {});
        }
        setChecking(false);
      })
      .catch(() => setChecking(false));
  }, []);

  if (checking) return null;

  return (
    <BrowserRouter>
      <AppRoutes user={user} setUser={setUser} needsSetup={needsSetup} setNeedsSetup={setNeedsSetup} />
    </BrowserRouter>
  );
}