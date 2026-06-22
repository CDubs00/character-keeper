import React, { useState, useEffect } from 'react';
import { api } from '../../api';   // adjust the relative path if needed

// Small muted build tag. Fetches the running backend version once on mount.
// Renders nothing until it has a value, so it never flashes a placeholder.
export default function VersionTag({ style }) {
  const [version, setVersion] = useState(null);

  useEffect(() => {
    let alive = true;
    api.getVersion()
      .then(d => { if (alive && d?.version) setVersion(d.version); })
      .catch(() => {});            // version tag is cosmetic — fail silently
    return () => { alive = false; };
  }, []);

  if (!version) return null;

  return (
    <span style={{
      fontFamily: 'var(--font-mono)',
      fontSize: '0.6rem',
      color: 'var(--text-dim)',
      letterSpacing: '0.1em',
      ...style,
    }}>
      v{version}
    </span>
  );
}