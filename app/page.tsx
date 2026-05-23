'use client';

import { useState } from 'react';

const SCENARIOS = [
  { value: 1, label: '30-day overdue — friendly reminder' },
  { value: 2, label: '60-day overdue — firm payment request' },
  { value: 3, label: '90-day overdue — escalated collections' },
];

export default function DemoPage() {
  const [form, setForm] = useState({ name: '', phone: '', companyName: '', scenario: '' });
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/start-demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, scenario: Number(form.scenario) }),
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

  if (success) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', textAlign: 'center', padding: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '1rem' }}>Your phone is ringing.</h1>
        <p style={{ fontSize: '1.125rem', color: '#555', maxWidth: '480px', lineHeight: 1.6 }}>
          Answer the call — your AI recovery agent is on the line. See how Clyintel handles collections in real time.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', padding: '2rem' }}>
      <h1 style={{ fontSize: '1.75rem', fontWeight: 700, marginBottom: '0.5rem' }}>See Clyintel in Action</h1>
      <p style={{ color: '#666', marginBottom: '2rem' }}>Enter your info and receive a live AI collections call.</p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%', maxWidth: '400px' }}>
        <input
          required
          placeholder="Your name"
          value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          style={{ padding: '0.75rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '1rem' }}
        />
        <input
          required
          placeholder="Phone number (e.g. +1 555 000 0000)"
          value={form.phone}
          onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
          style={{ padding: '0.75rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '1rem' }}
        />
        <input
          placeholder="Company name (optional)"
          value={form.companyName}
          onChange={e => setForm(f => ({ ...f, companyName: e.target.value }))}
          style={{ padding: '0.75rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '1rem' }}
        />
        <select
          required
          value={form.scenario}
          onChange={e => setForm(f => ({ ...f, scenario: e.target.value }))}
          style={{ padding: '0.75rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '1rem', background: '#fff' }}
        >
          <option value="">Select a scenario</option>
          {SCENARIOS.map(s => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        {error && <p style={{ color: '#c00', fontSize: '0.875rem', margin: 0 }}>{error}</p>}
        <button
          type="submit"
          disabled={loading}
          style={{ padding: '0.75rem', background: '#111', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '1rem', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1 }}
        >
          {loading ? 'Connecting…' : 'Start Demo Call'}
        </button>
      </form>
    </div>
  );
}
