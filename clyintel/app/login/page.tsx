'use client';

export const dynamic = 'force-dynamic';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { C } from '@/lib/theme';
import { createSupabaseBrowser } from '@/lib/supabase-browser';

type Mode = 'signin' | 'signup';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const supabase = createSupabaseBrowser();

  async function handleEmailAuth(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setMessage('Check your email to confirm your account.');
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push('/');
        router.refresh();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleAuth() {
    setError('');
    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      setError(error.message);
      setLoading(false);
    }
  }

  function toggleMode() {
    setMode(m => (m === 'signin' ? 'signup' : 'signin'));
    setError('');
    setMessage('');
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    fontSize: 15,
    color: C.text,
    background: '#fff',
    outline: 'none',
    boxSizing: 'border-box',
    fontFamily: C.sans,
  };

  const btnPrimary: React.CSSProperties = {
    width: '100%',
    padding: '11px 16px',
    background: loading ? C.textDim : C.blue,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 15,
    fontWeight: 600,
    cursor: loading ? 'not-allowed' : 'pointer',
    fontFamily: C.sans,
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: C.bg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2rem 1.25rem',
      fontFamily: C.sans,
    }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        {/* Brand */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.navy, letterSpacing: '-0.5px' }}>
            Clyintel
          </div>
          <div style={{ color: C.textMid, fontSize: 14, marginTop: 6 }}>
            {mode === 'signin' ? 'Sign in to your account' : 'Create your account'}
          </div>
        </div>

        {/* Card */}
        <div style={{
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          padding: '28px',
        }}>
          {/* Google */}
          <button
            onClick={handleGoogleAuth}
            disabled={loading}
            style={{
              width: '100%',
              padding: '11px 16px',
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              background: '#fff',
              color: C.text,
              fontSize: 15,
              fontWeight: 500,
              cursor: loading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              marginBottom: 20,
              fontFamily: C.sans,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
              <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
              <path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/>
              <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.163 6.656 3.58 9 3.58z"/>
            </svg>
            Continue with Google
          </button>

          {/* Divider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
            <div style={{ flex: 1, height: 1, background: C.border }} />
            <span style={{ fontSize: 12, color: C.textDim }}>or</span>
            <div style={{ flex: 1, height: 1, background: C.border }} />
          </div>

          {/* Email / password */}
          <form onSubmit={handleEmailAuth}>
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: C.text, marginBottom: 6 }}>
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                placeholder="you@company.com"
                style={inputStyle}
              />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: C.text, marginBottom: 6 }}>
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={6}
                placeholder="••••••••"
                style={inputStyle}
              />
            </div>

            {error && (
              <div style={{
                padding: '10px 12px',
                background: C.redBg,
                border: `1px solid ${C.red}`,
                borderRadius: 8,
                color: C.red,
                fontSize: 13,
                marginBottom: 16,
              }}>
                {error}
              </div>
            )}

            {message && (
              <div style={{
                padding: '10px 12px',
                background: C.greenBg,
                border: `1px solid ${C.green}`,
                borderRadius: 8,
                color: C.green,
                fontSize: 13,
                marginBottom: 16,
              }}>
                {message}
              </div>
            )}

            <button type="submit" disabled={loading} style={btnPrimary}>
              {loading ? '…' : mode === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          {/* Toggle */}
          <p style={{ textAlign: 'center', margin: '18px 0 0', fontSize: 13, color: C.textMid }}>
            {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
            <button
              onClick={toggleMode}
              style={{
                background: 'none',
                border: 'none',
                color: C.blue,
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 600,
                padding: 0,
                fontFamily: C.sans,
              }}
            >
              {mode === 'signin' ? 'Sign up' : 'Sign in'}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
