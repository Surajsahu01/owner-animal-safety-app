export const API = (import.meta.env.VITE_API_URL || `${location.protocol}//${location.hostname}:3000`).replace(/\/+$/, '');

const KEY = 'ownerToken';
export const getToken = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
export const setToken = (t) => { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch { /* ignore */ } };

const ERRORS = {
  invalid_credentials: 'Wrong email/phone or password.',
  account_already_registered: 'This email or phone number is already registered. Please log in.',
  belt_already_registered: 'This belt ID is already registered to an owner.',
  invalid_belt_id: 'Belt ID must be a number from 1 to 255.',
};

const FIELD_HINTS = {
  name: 'Enter your name (at least 2 letters).',
  login: 'Enter a valid email address or a phone number (10-15 digits).',
  password: 'Password must be at least 8 characters.',
};

export async function api(path, { method = 'GET', body } = {}) {
  const token = getToken();
  let r;
  try {
    r = await fetch(`${API}/api/owner${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`Cannot reach the server at ${API}.`);
  }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && token) { setToken(''); const e = new Error('Session expired. Please log in again.'); e.code = 'expired'; throw e; }
  if (data.error === 'invalid_owner_payload') throw new Error((data.fields || []).map((x) => FIELD_HINTS[x]).filter(Boolean).join(' '));
  if (!r.ok) throw new Error(ERRORS[data.error] || data.error || `Server returned ${r.status}`);
  return data;
}
