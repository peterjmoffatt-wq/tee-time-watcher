// Shared auth helpers used by both login.html and index.html.

async function checkAuth() {
  const res = await fetch('/api/auth/me');
  if (!res.ok) return null;
  return res.json();
}

async function requireAuthOrRedirect() {
  const me = await checkAuth();
  if (!me || !me.ok) {
    window.location.href = '/login.html';
    return null;
  }
  return me;
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
}
