import React, { useRef } from 'react';

export default function Portrait({ characterId, portraitUrl, onUpload }) {
  const inputRef = useRef(null);

  const handleClick = () => inputRef.current.click();

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('portrait', file);

    const res = await fetch(`/api/characters/${characterId}/portrait`, {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();
    if (data.portrait) onUpload(data.portrait);
  };

  return (
    <div
      onClick={handleClick}
      style={{
        width: 120,
        height: 150,
        border: `2px dashed var(--border-bright)`,
        borderRadius: 'var(--radius)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        overflow: 'hidden',
        flexShrink: 0,
        background: 'var(--bg-raised)',
        transition: 'border-color 0.15s',
      }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-bright)'}
    >
      {portraitUrl ? (
        <img
          src={portraitUrl}
          alt="Character portrait"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <span style={{
          fontSize: '2rem',
          color: 'var(--border-bright)',
          lineHeight: 1,
          userSelect: 'none',
        }}>+</span>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp,.gif"
        style={{ display: 'none' }}
        onChange={handleFile}
      />
    </div>
  );
}