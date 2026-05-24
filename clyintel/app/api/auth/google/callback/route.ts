import { NextResponse } from 'next/server';

// Google's implicit grant redirect sends the access token in the URL *hash*
// (e.g. #access_token=...&token_type=Bearer&...).  The hash is never sent to
// the server, so this route returns a minimal HTML page whose inline script
// reads the hash client-side and posts the token back to the opener window,
// then closes the popup.
export async function GET() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Connecting to Google…</title>
  <style>
    body {
      margin: 0;
      font-family: system-ui, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100dvh;
      background: #0A1628;
      color: rgba(255,255,255,0.6);
      font-size: 14px;
    }
  </style>
</head>
<body>
  <p>Connecting…</p>
  <script>
    (function () {
      var hash = window.location.hash.slice(1);
      var params = new URLSearchParams(hash);
      var token = params.get('access_token');
      var error = params.get('error');

      if (window.opener) {
        window.opener.postMessage(
          token
            ? { type: 'GOOGLE_OAUTH_TOKEN', access_token: token }
            : { type: 'GOOGLE_OAUTH_ERROR', error: error || 'unknown_error' },
          window.location.origin
        );
      }

      window.close();
    })();
  </script>
</body>
</html>`;

  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
