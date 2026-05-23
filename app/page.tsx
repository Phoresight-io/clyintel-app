'use client';

import { useState } from 'react';

const NAVY = '#0A1628';
const ACCENT = '#4A9EFF';

const SCENARIOS = [
  { value: 1, days: '7 days', color: '#22C55E', label: 'EARLY STAGE' },
  { value: 2, days: '45 days', color: '#F59E0B', label: 'ESCALATING' },
  { value: 3, days: '90 days', color: '#EF4444', label: 'CRITICAL' },
];

function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return '';
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
}

function toE164(formatted: string): string {
  const digits = formatted.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

export default function DemoPage() {
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    companyName: 'Meridian Supply Co.',
    phoneDisplay: '',
    scenario: 0,
  });
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function handlePhone(e: React.ChangeEvent<HTMLInputElement>) {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 10);
    setForm(f => ({ ...f, phoneDisplay: formatPhone(digits) }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.scenario) {
      setError('Please select a scenario.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/start-demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: form.firstName,
          lastName: form.lastName,
          companyName: form.companyName,
          phone: toE164(form.phoneDisplay),
          scenario: form.scenario,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Something went wrong');
      }
      setSuccess(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '14px 16px',
    background: 'rgba(255,255,255,0.07)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: 10,
    color: '#fff',
    fontSize: 16,
    outline: 'none',
    boxSizing: 'border-box',
  };

  if (success) {
    return (
      <div
        style={{
          minHeight: '100dvh',
          background: NAVY,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem 1.5rem',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: '50%',
            background: 'rgba(74,158,255,0.15)',
            border: `2px solid ${ACCENT}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 28,
            fontSize: 32,
          }}
        >
          📞
        </div>
        <h1
          style={{
            color: '#fff',
            fontSize: 28,
            fontWeight: 700,
            margin: '0 0 16px',
            letterSpacing: '-0.5px',
          }}
        >
          Your phone is ringing.
        </h1>
        <p
          style={{
            color: 'rgba(255,255,255,0.65)',
            fontSize: 16,
            lineHeight: 1.65,
            maxWidth: 380,
            margin: 0,
          }}
        >
          Answer the call — your AI recovery agent is on the line. See how Clyintel handles collections in real time.
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100dvh',
        background: NAVY,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem 1.25rem',
      }}
    >
      <div style={{ width: '100%', maxWidth: 420 }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <p
            style={{
              color: ACCENT,
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: 2,
              textTransform: 'uppercase',
              margin: '0 0 10px',
            }}
          >
            Live Demo
          </p>
          <h1
            style={{
              color: '#fff',
              fontSize: 26,
              fontWeight: 700,
              margin: '0 0 10px',
              letterSpacing: '-0.5px',
            }}
          >
            See Clyintel in Action
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 14, margin: 0 }}>
            Enter your info and receive a live AI collections call.
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Name row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12, fontWeight: 500 }}>
                First Name
              </label>
              <input
                required
                placeholder="Jane"
                value={form.firstName}
                onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))}
                style={inputStyle}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12, fontWeight: 500 }}>
                Last Name
              </label>
              <input
                required
                placeholder="Smith"
                value={form.lastName}
                onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))}
                style={inputStyle}
              />
            </div>
          </div>

          {/* Company */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12, fontWeight: 500 }}>
              Company Name
            </label>
            <input
              required
              placeholder="Company Name"
              value={form.companyName}
              onChange={e => setForm(f => ({ ...f, companyName: e.target.value }))}
              style={inputStyle}
            />
          </div>

          {/* Phone */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12, fontWeight: 500 }}>
              Phone
            </label>
            <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
              <span
                style={{
                  position: 'absolute',
                  left: 14,
                  color: 'rgba(255,255,255,0.4)',
                  fontSize: 15,
                  pointerEvents: 'none',
                  userSelect: 'none',
                }}
              >
                +1
              </span>
              <input
                required
                type="tel"
                placeholder="(555) 000-0000"
                value={form.phoneDisplay}
                onChange={handlePhone}
                style={{ ...inputStyle, paddingLeft: 38 }}
              />
            </div>
          </div>

          {/* Scenario */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
            <label style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12, fontWeight: 500 }}>
              Invoice Age
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {SCENARIOS.map(s => {
                const selected = form.scenario === s.value;
                return (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, scenario: s.value }))}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '14px 16px',
                      background: selected
                        ? 'rgba(74,158,255,0.1)'
                        : 'rgba(255,255,255,0.04)',
                      border: selected
                        ? `1.5px solid ${ACCENT}`
                        : '1.5px solid rgba(255,255,255,0.1)',
                      borderRadius: 10,
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                    }}
                  >
                    <span style={{ color: '#fff', fontSize: 15, fontWeight: 500 }}>
                      {s.days}
                    </span>
                    <span
                      style={{
                        background: `${s.color}22`,
                        color: s.color,
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: 1,
                        padding: '3px 10px',
                        borderRadius: 20,
                        border: `1px solid ${s.color}55`,
                      }}
                    >
                      {s.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <p style={{ color: '#F87171', fontSize: 13, margin: '4px 0 0', textAlign: 'center' }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              marginTop: 8,
              padding: '16px',
              background: loading ? 'rgba(74,158,255,0.4)' : ACCENT,
              color: '#fff',
              border: 'none',
              borderRadius: 10,
              fontSize: 16,
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
              letterSpacing: 0.2,
              transition: 'opacity 0.15s',
            }}
          >
            {loading ? 'Connecting…' : 'Start the Demo →'}
          </button>
        </form>
      </div>
    </div>
  );
}
