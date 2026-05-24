'use client';

import { useState, useRef, useEffect } from 'react';
import { parseCsv, type CsvRow } from '@/lib/csv-parser';

const NAVY = '#0A1628';
const ACCENT = '#4A9EFF';
const SURFACE = 'rgba(255,255,255,0.06)';
const BORDER = 'rgba(255,255,255,0.12)';

// ---------------------------------------------------------------------------
// Google API type declarations (gapi + Picker)
// ---------------------------------------------------------------------------
interface DocsViewInstance {
  setMimeTypes(types: string): DocsViewInstance;
}

interface PickerInstance {
  setVisible(v: boolean): void;
}

interface PickerBuilderInstance {
  addView(view: DocsViewInstance): PickerBuilderInstance;
  setOAuthToken(token: string): PickerBuilderInstance;
  setDeveloperKey(key: string): PickerBuilderInstance;
  setCallback(cb: (data: PickerCallbackData) => void): PickerBuilderInstance;
  build(): PickerInstance;
}

interface PickerCallbackData {
  action: string;
  docs?: Array<{ id: string; name: string }>;
}

declare global {
  interface Window {
    gapi: {
      load(api: string, cb: () => void): void;
    };
    google: {
      picker: {
        PickerBuilder: new () => PickerBuilderInstance;
        DocsView: new () => DocsViewInstance;
        Action: { PICKED: string; CANCEL: string };
      };
    };
  }
}

// Must be registered as an authorised redirect URI in Google Cloud Console.
const GOOGLE_REDIRECT_URI = 'https://clyintel-app.vercel.app/api/auth/google/callback';

// ---------------------------------------------------------------------------

type Step = 'select' | 'preview' | 'success';

export default function ImportPage() {
  const [step, setStep] = useState<Step>('select');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [importedCount, setImportedCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const gapiReadyRef = useRef(false);

  useEffect(() => {
    function loadScript(src: string, onReady: () => void) {
      const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
      if (existing) {
        // Tag exists: if already loaded fire immediately, otherwise wait for the load event.
        if (existing.dataset.loaded === 'true') {
          onReady();
        } else {
          existing.addEventListener('load', onReady, { once: true });
        }
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.defer = true;
      s.addEventListener('load', () => {
        s.dataset.loaded = 'true';
        onReady();
      }, { once: true });
      document.head.appendChild(s);
    }

    loadScript('https://apis.google.com/js/api.js', () => {
      gapiReadyRef.current = true;
    });
  }, []);

  function applyParsedCsv(text: string, name: string) {
    const parsed = parseCsv(text);
    if (parsed.headers.length === 0) {
      setError('Could not parse CSV — no headers found.');
      return;
    }
    setHeaders(parsed.headers);
    setRows(parsed.rows);
    setFileName(name);
    setError('');
    setStep('preview');
  }

  function handleLocalFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => applyParsedCsv(ev.target?.result as string, file.name);
    reader.readAsText(file);
  }

  async function downloadDriveFile(fileId: string, token: string, name: string) {
    try {
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) throw new Error(`Drive API error: ${res.status}`);
      const text = await res.text();
      applyParsedCsv(text, name);
    } catch {
      setError('Failed to download file from Google Drive.');
    }
  }

  function showPicker(token: string) {
    window.gapi.load('picker', () => {
      const view = new window.google.picker.DocsView().setMimeTypes(
        'text/csv,text/plain'
      );

      const pickerBuilder = new window.google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setCallback((data: PickerCallbackData) => {
          if (
            data.action === window.google.picker.Action.PICKED &&
            data.docs?.[0]
          ) {
            const doc = data.docs[0];
            downloadDriveFile(doc.id, token, doc.name);
          }
        });

      const apiKey = process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
      if (apiKey) pickerBuilder.setDeveloperKey(apiKey);

      pickerBuilder.build().setVisible(true);
    });
  }

  function openDrivePicker() {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId) {
      setError('NEXT_PUBLIC_GOOGLE_CLIENT_ID is not configured.');
      return;
    }
    if (!gapiReadyRef.current || !window.gapi) {
      setError('Google API is still loading — please try again.');
      return;
    }

    // Build the OAuth 2.0 implicit grant URL and open it in a popup so the
    // user always sees the account-selection / consent screen.
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: GOOGLE_REDIRECT_URI,
      response_type: 'token',
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      prompt: 'consent select_account',
      include_granted_scopes: 'true',
    });
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    const width = 500;
    const height = 620;
    const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - height) / 2);

    const popup = window.open(
      authUrl,
      'google-oauth',
      `width=${width},height=${height},left=${left},top=${top},scrollbars=yes,resizable=yes`
    );

    if (!popup) {
      setError('Popup was blocked. Please allow popups for this site and try again.');
      return;
    }

    function handleMessage(event: MessageEvent) {
      // Only accept messages from our own origin (posted by the callback page).
      if (event.origin !== window.location.origin) return;
      const msg = event.data as { type?: string; access_token?: string; error?: string };
      if (msg.type === 'GOOGLE_OAUTH_TOKEN' && msg.access_token) {
        cleanup();
        showPicker(msg.access_token);
      } else if (msg.type === 'GOOGLE_OAUTH_ERROR') {
        cleanup();
        setError(`Google authorization failed: ${msg.error ?? 'unknown error'}`);
      }
    }

    function cleanup() {
      window.removeEventListener('message', handleMessage);
      clearInterval(closedPoll);
    }

    // Detect if the user closes the popup without completing the OAuth flow.
    const closedPoll = setInterval(() => {
      if (popup.closed) cleanup();
    }, 500);

    window.addEventListener('message', handleMessage);
  }

  async function handleConfirmImport() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/import-invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, rows }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Import failed');
      }
      const data = await res.json();
      setImportedCount(data.count ?? rows.length);
      setStep('success');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setLoading(false);
    }
  }

  function handleReset() {
    setStep('select');
    setHeaders([]);
    setRows([]);
    setFileName('');
    setError('');
    setImportedCount(0);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  const previewRows = rows.slice(0, 8);
  const remaining = rows.length - previewRows.length;

  // -------------------------------------------------------------------------
  // Shared styles
  // -------------------------------------------------------------------------
  const btnBase: React.CSSProperties = {
    border: 'none',
    borderRadius: 10,
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  };

  // -------------------------------------------------------------------------
  // Render: success
  // -------------------------------------------------------------------------
  if (step === 'success') {
    return (
      <div style={pageWrap}>
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: '50%',
            background: 'rgba(34,197,94,0.15)',
            border: '2px solid #22C55E',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 28,
            fontSize: 32,
          }}
        >
          ✓
        </div>
        <h1
          style={{
            color: '#fff',
            fontSize: 26,
            fontWeight: 700,
            margin: '0 0 12px',
            letterSpacing: '-0.5px',
          }}
        >
          Import complete
        </h1>
        <p style={{ color: 'rgba(255,255,255,0.55)', fontSize: 15, margin: '0 0 32px' }}>
          {importedCount} {importedCount === 1 ? 'row' : 'rows'} imported from{' '}
          <span style={{ color: ACCENT }}>{fileName}</span>
        </p>
        <button
          onClick={handleReset}
          style={{
            ...btnBase,
            padding: '12px 28px',
            background: SURFACE,
            color: '#fff',
            border: `1px solid ${BORDER}`,
          }}
        >
          Import another file
        </button>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: preview
  // -------------------------------------------------------------------------
  if (step === 'preview') {
    return (
      <div style={{ minHeight: '100dvh', background: NAVY, padding: '2rem 1.25rem' }}>
        <div style={{ maxWidth: 860, margin: '0 auto' }}>
          <div style={{ marginBottom: 24 }}>
            <p
              style={{
                color: ACCENT,
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 2,
                textTransform: 'uppercase',
                margin: '0 0 8px',
              }}
            >
              Preview
            </p>
            <h1
              style={{
                color: '#fff',
                fontSize: 22,
                fontWeight: 700,
                margin: '0 0 6px',
                letterSpacing: '-0.5px',
              }}
            >
              {fileName}
            </h1>
            <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: 13, margin: 0 }}>
              {rows.length} {rows.length === 1 ? 'row' : 'rows'} detected
              {remaining > 0 ? ` — showing first 8` : ''}
            </p>
          </div>

          {/* Table */}
          <div
            style={{
              overflowX: 'auto',
              borderRadius: 12,
              border: `1px solid ${BORDER}`,
              marginBottom: 24,
            }}
          >
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 13,
                color: '#fff',
              }}
            >
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.05)' }}>
                  {headers.map(h => (
                    <th
                      key={h}
                      style={{
                        padding: '10px 14px',
                        textAlign: 'left',
                        fontWeight: 600,
                        color: 'rgba(255,255,255,0.55)',
                        whiteSpace: 'nowrap',
                        borderBottom: `1px solid ${BORDER}`,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row, i) => (
                  <tr
                    key={i}
                    style={{
                      background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                    }}
                  >
                    {headers.map(h => (
                      <td
                        key={h}
                        style={{
                          padding: '9px 14px',
                          color: 'rgba(255,255,255,0.8)',
                          borderBottom:
                            i < previewRows.length - 1 ? `1px solid ${BORDER}` : 'none',
                          whiteSpace: 'nowrap',
                          maxWidth: 200,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {row[h]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {remaining > 0 && (
            <p
              style={{
                color: 'rgba(255,255,255,0.35)',
                fontSize: 12,
                margin: '-12px 0 24px',
                textAlign: 'center',
              }}
            >
              + {remaining} more {remaining === 1 ? 'row' : 'rows'} not shown
            </p>
          )}

          {error && (
            <p
              style={{
                color: '#F87171',
                fontSize: 13,
                margin: '0 0 16px',
                textAlign: 'center',
              }}
            >
              {error}
            </p>
          )}

          <div style={{ display: 'flex', gap: 12 }}>
            <button
              onClick={handleReset}
              style={{
                ...btnBase,
                flex: 1,
                padding: '14px',
                background: 'transparent',
                color: 'rgba(255,255,255,0.5)',
                border: `1px solid ${BORDER}`,
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmImport}
              disabled={loading}
              style={{
                ...btnBase,
                flex: 2,
                padding: '14px',
                background: loading ? 'rgba(74,158,255,0.4)' : ACCENT,
                color: '#fff',
                cursor: loading ? 'not-allowed' : 'pointer',
              }}
            >
              {loading
                ? 'Importing…'
                : `Import ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: select source
  // -------------------------------------------------------------------------
  return (
    <div style={pageWrap}>
      <div style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <p
            style={{
              color: ACCENT,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 2,
              textTransform: 'uppercase',
              margin: '0 0 10px',
            }}
          >
            Import
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
            Import Invoices
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 14, margin: 0 }}>
            Upload a CSV file from your computer or Google Drive.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Local file */}
          <button
            onClick={() => fileInputRef.current?.click()}
            style={{
              ...btnBase,
              padding: '20px 24px',
              background: SURFACE,
              border: `1px solid ${BORDER}`,
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 28 }}>📂</span>
            <span>
              <span style={{ display: 'block', fontSize: 15, fontWeight: 600 }}>
                Upload from computer
              </span>
              <span
                style={{
                  display: 'block',
                  fontSize: 12,
                  color: 'rgba(255,255,255,0.45)',
                  marginTop: 3,
                  fontWeight: 400,
                }}
              >
                Select a .csv file from your local disk
              </span>
            </span>
          </button>

          {/* Google Drive */}
          <button
            onClick={openDrivePicker}
            style={{
              ...btnBase,
              padding: '20px 24px',
              background: SURFACE,
              border: `1px solid ${BORDER}`,
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 28 }}>☁️</span>
            <span>
              <span style={{ display: 'block', fontSize: 15, fontWeight: 600 }}>
                Import from Google Drive
              </span>
              <span
                style={{
                  display: 'block',
                  fontSize: 12,
                  color: 'rgba(255,255,255,0.45)',
                  marginTop: 3,
                  fontWeight: 400,
                }}
              >
                Browse and select a CSV from your Drive
              </span>
            </span>
          </button>
        </div>

        {error && (
          <p
            style={{
              color: '#F87171',
              fontSize: 13,
              marginTop: 16,
              textAlign: 'center',
            }}
          >
            {error}
          </p>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={handleLocalFile}
          style={{ display: 'none' }}
        />
      </div>
    </div>
  );
}

const pageWrap: React.CSSProperties = {
  minHeight: '100dvh',
  background: NAVY,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '2rem 1.25rem',
  textAlign: 'center',
};
