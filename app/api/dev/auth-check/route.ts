import { randomBytes } from "node:crypto";

export const runtime = "nodejs";

export function GET(request: Request): Response {
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };
  const notFound = () => new Response(null, { status: 404, headers });
  if (process.env.NODE_ENV !== "development" || process.env.APP_ENV !== "development") return notFound();
  try {
    const origin = process.env.APP_ORIGIN ?? "";
    if (!/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/.test(origin)) return notFound();
    const configured = new URL(origin);
    const requested = new URL(request.url);
    if (requested.origin !== configured.origin || requested.username || requested.password ||
        request.headers.get("host") !== configured.host) return notFound();
  } catch {
    return notFound();
  }
  const nonce = randomBytes(24).toString("base64");
  headers["Content-Security-Policy"] += `; script-src 'nonce-${nonce}'; connect-src 'self'`;
  return new Response(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Development sign-in check</title>
<body>
<h1>Development sign-in check</h1>
<button id="sign-in" type="button">Sign in with Google</button>
<button id="refresh" type="button">Refresh session</button>
<p id="status" role="status"></p>
<p id="user"></p>
<p id="verification" hidden>Confirm this is your intended Google account; owner access is not granted automatically.</p>
<p id="owner" role="status"></p>
<script nonce="${nonce}">
const signIn = document.getElementById('sign-in');
const refresh = document.getElementById('refresh');
const status = document.getElementById('status');
const user = document.getElementById('user');
const verification = document.getElementById('verification');
const owner = document.getElementById('owner');
const options = { credentials: 'same-origin', cache: 'no-store', redirect: 'error' };
async function readSession() {
  refresh.disabled = true;
  user.textContent = '';
  owner.textContent = '';
  verification.hidden = true;
  status.textContent = 'Checking session…';
  try {
    const response = await fetch('/api/auth/get-session', options);
    if (!response.ok) throw new Error();
    const session = await response.json();
    if (session === null) { status.textContent = 'Not signed in.'; return; }
    if (typeof session?.user?.id !== 'string' || !session.user.id) throw new Error();
    user.textContent = 'User ID: ' + session.user.id;
    verification.hidden = false;
    status.textContent = 'Authenticated.';
    const access = await fetch('/api/v1/me', options);
    if (access.ok) owner.textContent = 'Authorized owner access.';
    else if (access.status === 403) owner.textContent = 'Owner binding required.';
    else throw new Error();
  } catch {
    status.textContent = 'Unable to verify session or owner access.';
  } finally {
    refresh.disabled = false;
  }
}
signIn.addEventListener('click', async () => {
  signIn.disabled = true;
  status.textContent = 'Starting sign-in…';
  try {
    const callbackURL = location.origin + '/api/dev/auth-check';
    const response = await fetch('/api/auth/sign-in/social', {
      ...options, method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'google', callbackURL, newUserCallbackURL: callbackURL,
        errorCallbackURL: callbackURL, disableRedirect: true })
    });
    if (!response.ok) throw new Error();
    const result = await response.json();
    if (typeof result?.url !== 'string') throw new Error();
    const target = new URL(result.url);
    if (target.protocol !== 'https:' || target.host !== 'accounts.google.com' ||
        target.username || target.password) throw new Error();
    location.assign(target.href);
  } catch {
    status.textContent = 'Unable to start sign-in.';
    signIn.disabled = false;
  }
});
refresh.addEventListener('click', readSession);
void readSession();
</script>
</body>
</html>`, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
}
