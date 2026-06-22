import React, { useState, useEffect, useRef } from 'react';
import { api } from '../../api';
import { FileIcon } from './Icons';

// Mirrors the server allowlist. The server is authoritative — these just give a
// friendlier early error and populate the file picker's accept filter.
const ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.md,.csv,.doc,.docx,.xls,.xlsx';
const MAX_BYTES = 25 * 1024 * 1024;

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const TEXT_EXTS  = new Set(['txt', 'md', 'csv']);
const TYPE_COLOR = {
  pdf: 'var(--red)',
  doc: '#4a90c0', docx: '#4a90c0',
  xls: 'var(--green)', xlsx: 'var(--green)', csv: 'var(--green)',
  txt: 'var(--text-secondary)', md: 'var(--text-secondary)',
};

const extOf  = (name) => { const m = /\.([^.]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; };
const fmtSize = (n) => {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
};

// Hash in the browser so the duplicate check happens before we upload bytes.
async function sha256Hex(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default function FilesModal({ characterId, characterName, onClose }) {
  const [items, setItems]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');
  const [busy, setBusy]     = useState(false);
  const [dupe, setDupe]     = useState(null);     // { file, match } awaiting a decision
  const [viewer, setViewer] = useState(null);     // { kind, entry, text? }
  const [confirmKey, setConfirmKey] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    let alive = true;
    api.listAttachments(characterId).then(res => {
      if (!alive) return;
      if (res?.error) setError(res.error);
      else setItems(res.attachments || []);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [characterId]);

  async function handleFile(file) {
    if (!file) return;
    setError('');
    const ext = extOf(file.name);
    if (!ACCEPT.split(',').includes(`.${ext}`)) { setError(`"${ext || 'this'}" files aren't allowed.`); return; }
    if (file.size > MAX_BYTES) { setError('That file is over the 25 MB limit.'); return; }

    // Non-blocking duplicate pre-check.
    try {
      const sha = await sha256Hex(file);
      const res = await api.checkAttachmentDuplicate(characterId, sha);
      if (res?.duplicate) { setDupe({ file, match: res.duplicate }); return; }
    } catch { /* hashing unavailable (e.g. insecure context) — just upload */ }

    commitUpload(file);
  }

  async function commitUpload(file) {
    setDupe(null);
    setBusy(true);
    const res = await api.uploadAttachment(characterId, file);
    setBusy(false);
    if (res?.error) { setError(res.error); return; }
    setItems(res.attachments || []);
  }

  async function remove(key) {
    setConfirmKey(null);
    const res = await api.deleteAttachment(characterId, key);
    if (res?.error) { setError(res.error); return; }
    setItems(res.attachments || []);
  }

  function openViewer(entry) {
    const ext = entry.ext || extOf(entry.name);
    if (IMAGE_EXTS.has(ext)) { setViewer({ kind: 'image', entry }); return; }
    if (ext === 'pdf')       { setViewer({ kind: 'pdf',   entry }); return; }
    if (TEXT_EXTS.has(ext)) {
      fetch(api.attachmentUrl(characterId, entry.key))
        .then(r => r.text())
        .then(text => setViewer({ kind: 'text', entry, text }))
        .catch(() => setError('Could not load that file.'));
      return;
    }
    download(entry); // office docs → download
  }

  function download(entry) {
    const a = document.createElement('a');
    a.href = api.attachmentUrl(characterId, entry.key);
    a.download = entry.name || 'file';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.[0]) handleFile(e.dataTransfer.files[0]);
  };

  const label = { fontFamily: 'var(--font-mono)', fontSize: '0.62rem', color: 'var(--text-dim)', letterSpacing: '0.1em', textTransform: 'uppercase' };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        width: 600, maxWidth: '94vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.5rem',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.1rem' }}>
          <div>
            <h2 style={{ fontSize: '0.9rem', letterSpacing: '0.1em', color: 'var(--text-accent)' }}>Files</h2>
            {characterName && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{characterName}</div>}
          </div>
          <button className="btn-ghost" onClick={onClose} style={{ padding: '0.2rem 0.5rem' }}>✕</button>
        </div>
        <div style={{ height: 1, background: 'linear-gradient(90deg, var(--accent), transparent)', marginBottom: '1.1rem' }} />

        {/* Duplicate warning (non-blocking) */}
        {dupe && (
          <div style={{
            display: 'flex', gap: '0.7rem', alignItems: 'flex-start',
            background: 'var(--accent-glow)', border: '1px solid var(--accent-dim, var(--accent))',
            borderRadius: 'var(--radius)', padding: '0.7rem 0.85rem', marginBottom: '1rem',
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '0.88rem', color: 'var(--text-primary)' }}>
                This is identical to <span style={{ color: 'var(--text-accent)' }}>{dupe.match.name}</span>
                {dupe.match.uploadedAt ? `, added ${new Date(dupe.match.uploadedAt).toLocaleDateString()}.` : '.'}
              </div>
              <div style={{ ...label, marginTop: '0.2rem' }}>matched by sha-256 · nothing was uploaded</div>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem' }}>
                <button className="btn-primary" style={{ fontSize: '0.72rem', padding: '0.25rem 0.6rem' }}
                  onClick={() => commitUpload(dupe.file)}>Upload anyway</button>
                <button className="btn-ghost" style={{ fontSize: '0.72rem', padding: '0.25rem 0.6rem' }}
                  onClick={() => setDupe(null)}>Skip</button>
              </div>
            </div>
          </div>
        )}

        {/* Dropzone */}
        <div
          onClick={() => inputRef.current && inputRef.current.click()}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          style={{
            border: `1px dashed ${dragOver ? 'var(--accent)' : 'var(--border-bright)'}`,
            borderRadius: 'var(--radius)', padding: '0.9rem', textAlign: 'center', cursor: 'pointer', marginBottom: '1rem',
            background: dragOver ? 'var(--accent-glow)' : 'transparent', transition: 'all 0.12s',
          }}>
          <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            {busy ? 'Uploading…' : 'Drag a file here or click to browse'}
          </div>
          <div style={{ ...label, marginTop: '0.25rem', textTransform: 'none', letterSpacing: 0 }}>
            pdf · docx · xlsx · txt · md · csv · images &nbsp;•&nbsp; 25 MB max
          </div>
          <input ref={inputRef} type="file" accept={ACCEPT} style={{ display: 'none' }}
            onChange={e => { handleFile(e.target.files[0]); e.target.value = ''; }} />
        </div>

        {error && <div style={{ color: 'var(--red)', fontSize: '0.8rem', marginBottom: '0.8rem' }}>{error}</div>}

        {/* Section label */}
        <div style={{ ...label, marginBottom: '0.6rem' }}>Attachments · {items.length}</div>

        {/* Grid */}
        <div style={{ overflow: 'auto' }}>
          {loading ? (
            <div style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>Loading…</div>
          ) : items.length === 0 ? (
            <div style={{ color: 'var(--text-dim)', fontSize: '0.85rem', padding: '0.5rem 0' }}>
              No files yet — add handouts, backstory, maps, or session notes.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '0.6rem' }}>
              {items.map(entry => {
                const ext = entry.ext || extOf(entry.name);
                const isImg = IMAGE_EXTS.has(ext);
                return (
                  <div key={entry.key} style={{
                    border: '1px solid var(--border)', background: 'var(--bg-raised)', borderRadius: 'var(--radius)',
                    overflow: 'hidden', position: 'relative',
                  }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-bright)'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}>
                    {/* Remove control */}
                    {confirmKey === entry.key ? (
                      <div style={{
                        position: 'absolute', inset: 0, zIndex: 2, background: 'rgba(0,0,0,0.82)',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '0.5rem',
                      }}>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-primary)', textAlign: 'center' }}>Remove this file?</div>
                        <div style={{ display: 'flex', gap: '0.4rem' }}>
                          <button className="btn-danger" style={{ fontSize: '0.68rem', padding: '0.2rem 0.5rem' }} onClick={() => remove(entry.key)}>Remove</button>
                          <button className="btn-ghost" style={{ fontSize: '0.68rem', padding: '0.2rem 0.5rem' }} onClick={() => setConfirmKey(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <button title="Remove" onClick={(e) => { e.stopPropagation(); setConfirmKey(entry.key); }}
                        style={{
                          position: 'absolute', top: 4, right: 4, zIndex: 1, width: '1.3rem', height: '1.3rem',
                          border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', lineHeight: 1,
                          background: 'rgba(0,0,0,0.5)', color: 'var(--text-secondary)', fontSize: '0.85rem',
                        }}>✕</button>
                    )}

                    <div onClick={() => openViewer(entry)} style={{ cursor: 'pointer' }}>
                      <div style={{ height: 88, background: 'var(--bg-input)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {isImg ? (
                          <img src={api.attachmentUrl(characterId, entry.key)} alt={entry.name}
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                          <FileIcon size={34} style={{ color: TYPE_COLOR[ext] || 'var(--text-secondary)' }} />
                        )}
                      </div>
                      <div style={{ padding: '0.45rem 0.5rem', borderTop: '1px solid var(--border)' }}>
                        <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                          title={entry.name}>{entry.name}</div>
                        <div style={{ ...label }}>{ext.toUpperCase()} · {fmtSize(entry.size)}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Viewers */}
      {viewer && (
        <Viewer
          viewer={viewer}
          url={api.attachmentUrl(characterId, viewer.entry.key)}
          onDownload={() => download(viewer.entry)}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}

function Viewer({ viewer, url, onDownload, onClose }) {
  const { kind, entry, text } = viewer;
  const bar = (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.7rem 1rem',
      borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)',
    }}>
      <div style={{ flex: 1, fontSize: '0.9rem', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.name}</div>
      <button className="btn-ghost" style={{ fontSize: '0.72rem', padding: '0.25rem 0.6rem' }} onClick={onDownload}>Download</button>
      <button className="btn-ghost" style={{ padding: '0.2rem 0.5rem' }} onClick={onClose}>✕</button>
    </div>
  );

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.88)', zIndex: 110,
      display: 'flex', flexDirection: 'column',
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      {bar}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.5rem' }}>
        {kind === 'image' && (
          <img src={url} alt={entry.name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        )}
        {kind === 'pdf' && (
          <iframe src={url} title={entry.name} style={{ width: '100%', height: '100%', border: '1px solid var(--border)', background: '#fff' }} />
        )}
        {kind === 'text' && (
          <pre style={{
            width: '100%', height: '100%', margin: 0, overflow: 'auto',
            background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            padding: '1rem', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: '0.8rem',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>{text}</pre>
        )}
      </div>
    </div>
  );
}
