import React from 'react';

const DIES = ['d4', 'd6', 'd8', 'd10', 'd12'];

// Die selector button group
export function DieSelector({ value, onChange }) {
  return (
    <div className="die-selector">
      {DIES.map(d => (
        <button
          key={d}
          type="button"
          className={`die-btn ${value === d ? 'active' : ''}`}
          onClick={() => onChange(d)}
        >{d}</button>
      ))}
    </div>
  );
}

// Tracker (filled dots)
export function Tracker({ value = 0, max, onChange, redFrom }) {
  return (
    <div className="tracker">
      {Array.from({ length: max }).map((_, i) => {
        const filled = i < value;
        const isRed = redFrom !== undefined && i >= redFrom;
        return (
          <div
            key={i}
            className={`tracker-dot ${filled ? 'filled' : ''} ${filled && isRed ? 'red-dot' : ''}`}
            onClick={() => onChange(filled ? i : i + 1)}
            title={`${i + 1}/${max}`}
          />
        );
      })}
      {onChange && value > 0 && (
        <button type="button" className="btn-ghost" style={{ padding: '0.1rem 0.4rem', fontSize: '0.65rem' }}
          onClick={() => onChange(0)}>✕</button>
      )}
    </div>
  );
}

// Section wrapper
export function Section({ title, children, action }) {
  return (
    <div className="sheet-section">
      <div className="section-header">
        <span>{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

// Derived stat chip
export function StatChip({ label, value }) {
  return (
    <div className="derived-chip">
      <label>{label}</label>
      <div className="value">{value}</div>
    </div>
  );
}

// Field with label
export function Field({ label, children }) {
  return (
    <div className="field-group">
      <label>{label}</label>
      {children}
    </div>
  );
}

// Simple text field
export function TextField({ label, value, onChange, placeholder }) {
  return (
    <Field label={label}>
      <input
        type="text"
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder || ''}
      />
    </Field>
  );
}

// Number field
export function NumberField({ label, value, onChange, min = 0, style }) {
  return (
    <Field label={label}>
      <input
        type="number"
        value={value ?? 0}
        onChange={e => onChange(Number(e.target.value))}
        min={min}
        style={style}
      />
    </Field>
  );
}

// Select field
export function SelectField({ label, value, onChange, options }) {
  return (
    <Field label={label}>
      <select value={value || ''} onChange={e => onChange(e.target.value)}>
        {options.map(o => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </Field>
  );
}

// Textarea field
export function TextareaField({ label, value, onChange, placeholder }) {
  return (
    <Field label={label}>
      <textarea
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder || ''}
      />
    </Field>
  );
}

// Toast notification
export function Toast({ message }) {
  if (!message) return null;
  return <div className="toast">{message}</div>;
}
