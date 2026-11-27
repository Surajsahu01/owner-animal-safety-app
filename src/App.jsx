import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API, api, getToken, setToken } from './api.js';

const LEVELS = {
  ANIMAL_NEAR_ROAD: { text: 'NEAR ROAD', cls: 'warn' },
  ANIMAL_ON_ROAD_EMERGENCY: { text: 'ON ROAD', cls: 'danger' },
  ANIMAL_LEFT: { text: 'LEFT ROAD', cls: 'ok' },
};

const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

const urlB64ToUint8 = (b64) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

const hasGps = (a) => a && a.lat != null && a.lng != null && Number.isFinite(Number(a.lat)) && Number.isFinite(Number(a.lng));

// Pole GPS position with an optional embedded OpenStreetMap view.
function Location({ a }) {
  const [open, setOpen] = useState(false);
  if (!hasGps(a)) return <p className="muted">📍 {a.poleId}: GPS location not available yet.</p>;
  const lat = Number(a.lat), lng = Number(a.lng), d = 0.004;
  const link = a.mapLink || `https://www.google.com/maps?q=${lat},${lng}`;
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${lng - d},${lat - d},${lng + d},${lat + d}&layer=mapnik&marker=${lat},${lng}`;
  return (
    <div className="loc">
      <p>📍 <b>{a.poleId}</b> · GPS {lat.toFixed(5)}, {lng.toFixed(5)}</p>
      <div className="row">
        <button onClick={() => setOpen(!open)}>{open ? 'Hide map' : 'Show map'}</button>
        <a className="btn" href={link} target="_blank" rel="noreferrer">Open in Maps</a>
      </div>
      {open && <iframe className="map" title={`Map of ${a.poleId}`} src={src} loading="lazy" />}
    </div>
  );
}

// ---- Voice alerts (browser speech synthesis) ----
const voiceSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

const SPEECH = {
  en: {
    lang: 'en-IN',
    who: (label, id) => (label ? `${label}, belt ${id}` : `Belt ${id}`),
    test: 'Voice alerts are on.',
    ANIMAL_NEAR_ROAD: (w, p) => `Warning. ${w} is near the road at ${p}.`,
    ANIMAL_ON_ROAD_EMERGENCY: (w, p) => `Emergency! ${w} is on the road at ${p}. Please act now.`,
    ANIMAL_LEFT: (w, p) => `${w} has left the road at ${p}.`,
  },
  hi: {
    lang: 'hi-IN',
    who: (label, id) => (label ? `${label}, बेल्ट ${id}` : `बेल्ट ${id}`),
    test: 'वॉइस अलर्ट चालू हैं।',
    ANIMAL_NEAR_ROAD: (w, p) => `चेतावनी। ${w} सड़क के पास ${p} पर है।`,
    ANIMAL_ON_ROAD_EMERGENCY: (w, p) => `आपातकाल! ${w} सड़क पर ${p} पर है। कृपया तुरंत कार्रवाई करें।`,
    ANIMAL_LEFT: (w, p) => `${w} ${p} पर सड़क से हट गया है।`,
  },
};

const findVoice = (code) => {
  if (!voiceSupported) return null;
  const voices = window.speechSynthesis.getVoices();
  return voices.find((v) => v.lang.replace('_', '-').toLowerCase() === code.toLowerCase()) ||
    voices.find((v) => v.lang.toLowerCase().startsWith(code.slice(0, 2).toLowerCase())) || null;
};

// Use the chosen language only if this device has a voice for it; otherwise fall back to English.
const pickLang = (lang) => (lang !== 'en' && !findVoice(SPEECH[lang].lang) ? 'en' : lang);

function stopSpeech() { if (voiceSupported) window.speechSynthesis.cancel(); }

function speak(text, lang, times = 1) {
  if (!voiceSupported) return;
  const synth = window.speechSynthesis;
  const cfg = SPEECH[lang] || SPEECH.en;
  synth.cancel();
  for (let i = 0; i < times; i++) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = cfg.lang; u.rate = 0.95; u.volume = 1;
    const v = findVoice(cfg.lang); if (v) u.voice = v;
    synth.speak(u);
  }
}

function announce(p, animals, lang) {
  const L = pickLang(lang);
  const cfg = SPEECH[L];
  const make = cfg[p.level];
  if (!make) return;
  const animal = animals.find((a) => a.beltId === p.beltId);
  speak(make(cfg.who(animal?.label, p.beltId), p.poleId), L, p.level === 'ANIMAL_ON_ROAD_EMERGENCY' ? 2 : 1);
}

const loadPref = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const savePref = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

function Auth({ onDone }) {
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ name: '', login: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const body = mode === 'login' ? { login: f.login, password: f.password } : f;
      const res = await api(`/${mode}`, { method: 'POST', body });
      setToken(res.token); onDone(res.owner);
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  }

  return (
    <main className="wrap narrow">
      <h1>🐄 Animal Owner Alerts</h1>
      <p className="muted">Get notified when your animal is near or on the road.</p>
      <form className="card" onSubmit={submit}>
        <h2>{mode === 'login' ? 'Log in' : 'Create account'}</h2>
        {mode === 'register' && <input placeholder="Your name" value={f.name} onChange={set('name')} required />}
        <input placeholder="Email or phone number" autoComplete="username" value={f.login} onChange={set('login')} required />
        <input placeholder="Password (8+ characters)" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} type="password" value={f.password} onChange={set('password')} required minLength={8} />
        {err && <p className="error">{err}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Register'}</button>
        <button type="button" className="link" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(''); }}>
          {mode === 'login' ? 'New here? Create an account' : 'Already registered? Log in'}
        </button>
      </form>
    </main>
  );
}

function Home({ owner, onLogout }) {
  const [animals, setAnimals] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [live, setLive] = useState(false);
  const [banner, setBanner] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ beltId: '', label: '', species: '' });
  const [push, setPush] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const [, tick] = useState(0);
  const swReg = useRef(null);

  const [voiceOn, setVoiceOn] = useState(loadPref('voiceOn', '0') === '1');
  const [voiceLang, setVoiceLang] = useState(loadPref('voiceLang', 'en'));
  const [voiceReady, setVoiceReady] = useState(false);
  const [, setVoicesTick] = useState(0);
  const voiceRef = useRef({ on: voiceOn, lang: voiceLang });
  const animalsRef = useRef(animals);
  voiceRef.current = { on: voiceOn, lang: voiceLang };
  animalsRef.current = animals;

  // Browsers only allow speech after the user has interacted with the page once.
  useEffect(() => {
    if (!voiceSupported) return undefined;
    const synth = window.speechSynthesis;
    const prime = () => { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; synth.speak(u); setVoiceReady(true); };
    const refresh = () => setVoicesTick((n) => n + 1);
    window.addEventListener('pointerdown', prime, { once: true });
    synth.addEventListener?.('voiceschanged', refresh);
    return () => { window.removeEventListener('pointerdown', prime); synth.removeEventListener?.('voiceschanged', refresh); };
  }, []);

  function toggleVoice(on) {
    setVoiceOn(on); savePref('voiceOn', on ? '1' : '0');
    if (on) speak(SPEECH[pickLang(voiceLang)].test, pickLang(voiceLang)); else stopSpeech();
  }
  function changeLang(l) {
    setVoiceLang(l); savePref('voiceLang', l);
    speak(SPEECH[pickLang(l)].test, pickLang(l));
  }

  const load = useCallback(async () => {
    try {
      const [a, l] = await Promise.all([api('/animals'), api('/alerts?limit=50')]);
      setAnimals(a); setAlerts(l); setError('');
    } catch (e) { if (e.code === 'expired') onLogout(); else setError(e.message); }
  }, [onLogout]);

  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').then((r) => { swReg.current = r; }).catch(() => {});
    const socket = io(API, { auth: { token: getToken() }, transports: ['websocket', 'polling'] });
    socket.on('connect', () => setLive(true));
    socket.on('disconnect', () => setLive(false));
    socket.on('owner-alert', (p) => {
      setBanner(p); loadRef.current();
      if (voiceRef.current.on) announce(p, animalsRef.current, voiceRef.current.lang);
    });
    const poll = setInterval(() => loadRef.current(), 30000);
    const clock = setInterval(() => tick((n) => n + 1), 20000);
    return () => { socket.close(); clearInterval(poll); clearInterval(clock); };
  }, []);

  async function enablePush() {
    setError('');
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser does not support push notifications.');
      const perm = await Notification.requestPermission(); setPush(perm);
      if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them in browser settings.');
      const { key } = await api('/vapid-key');
      if (!key) throw new Error('Push is not configured on the server (VAPID keys missing).');
      const reg = swReg.current || (await navigator.serviceWorker.ready);
      const sub = (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) }));
      await api('/push-subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    } catch (e) { setError(e.message); }
  }

  async function addAnimal(e) {
    e.preventDefault(); setError('');
    try {
      await api('/animals', { method: 'POST', body: { beltId: Number(form.beltId), label: form.label, species: form.species } });
      setForm({ beltId: '', label: '', species: '' }); load();
    } catch (x) { setError(x.message); }
  }

  async function removeAnimal(beltId) {
    if (!window.confirm(`Remove belt #${beltId} from your account? You will stop receiving its alerts.`)) return;
    try { await api(`/animals/${beltId}`, { method: 'DELETE' }); load(); } catch (x) { setError(x.message); }
  }

  const lv = (l) => LEVELS[l] || { text: l, cls: 'warn' };

  return (
    <main className="wrap">
      <header className="top">
        <div><h1>🐄 My Animals</h1><p className="muted">{owner.name} · {owner.login}</p></div>
        <div className="right">
          <span className={`tag ${live ? 'ok' : ''}`}>{live ? 'LIVE' : 'OFFLINE'}</span>
          <button onClick={() => { setToken(''); onLogout(); }}>Log out</button>
        </div>
      </header>

      {banner && (
        <section className={`banner ${lv(banner.level).cls}`} role="alert">
          <div><strong>{banner.title}</strong><p>{banner.body}</p>
            <Location a={banner} /></div>
          <button onClick={() => { setBanner(null); stopSpeech(); }}>✕</button>
        </section>
      )}
      {error && <p className="error">{error}</p>}

      {voiceSupported && (
        <section className="card">
          <div className="top">
            <h2>🔊 Voice alerts</h2>
            <label className="switch">
              <input type="checkbox" checked={voiceOn} onChange={(e) => toggleVoice(e.target.checked)} /> {voiceOn ? 'On' : 'Off'}
            </label>
          </div>
          <div className="row">
            <select value={voiceLang} onChange={(e) => changeLang(e.target.value)}>
              <option value="en">English</option>
              <option value="hi">हिन्दी (Hindi)</option>
            </select>
            <button onClick={() => speak(SPEECH[pickLang(voiceLang)].test, pickLang(voiceLang))}>Test voice</button>
          </div>
          <p className="muted">The alert is read aloud when it arrives while this page is open. Keep the volume up.</p>
          {voiceLang === 'hi' && pickLang('hi') === 'en' && <p className="error">No Hindi voice is installed on this device, so English will be used.</p>}
          {voiceOn && !voiceReady && <p className="muted">Tap anywhere on the page once to activate voice.</p>}
        </section>
      )}

      {/* {push !== 'granted' && push !== 'unsupported' && (
        <section className="card">
          <h2>Phone notifications</h2>
          <p className="muted">Turn on notifications to be alerted even when this app is closed.</p>
          <button className="primary" onClick={enablePush}>{push === 'denied' ? 'Retry (allow in browser settings)' : 'Enable notifications'}</button>
        </section>
      )} */}
      {/* {push === 'granted' && <p className="muted">🔔 Notifications enabled on this device. <button className="link" onClick={enablePush}>Re-register</button></p>} */}

      <section className="card">
        <h2>Register an animal belt</h2>
        <form className="row" onSubmit={addAnimal}>
          <input type="number" min="1" max="255" placeholder="Belt ID (1-255)" value={form.beltId} onChange={(e) => setForm({ ...form, beltId: e.target.value })} required />
          <input placeholder="Name (e.g. Gauri)" value={form.label} maxLength={40} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          <input placeholder="Type (cow, goat…)" value={form.species} maxLength={30} onChange={(e) => setForm({ ...form, species: e.target.value })} />
          <button className="primary">Add</button>
        </form>
      </section>

      <section>
        <h2>Your animals</h2>
        {!animals.length && <p className="muted">No animals registered yet. Enter the belt ID printed on the animal's belt above.</p>}
        <div className="grid">
          {animals.map((a) => {
            const last = a.lastAlert;
            return (
              <article className="card" key={a.beltId}>
                <header className="top">
                  <h3>{a.label || 'Animal'} <small>· belt #{a.beltId}</small></h3>
                  {last && <span className={`pill ${lv(last.level).cls}`}>{lv(last.level).text}</span>}
                </header>
                {a.species && <p className="muted">{a.species}</p>}
                {last ? (
                  <>
                    <p>Last detected near <b>{last.poleId}</b> · {ago(last.time)}</p>
                    <Location a={last} />
                  </>
                ) : <p className="muted">Not detected by any pole yet.</p>}
                <button className="link danger-text" onClick={() => removeAnimal(a.beltId)}>Remove</button>
              </article>
            );
          })}
        </div>
      </section>

      <section>
        <h2>Recent alerts</h2>
        {!alerts.length && <p className="muted">No alerts yet.</p>}
        <ul className="list">
          {alerts.map((a) => (
            <li key={a.id}>
              <span className={`pill ${lv(a.level).cls}`}>{lv(a.level).text}</span>
              <span>Belt #{a.animalId} · {a.poleId}</span>
              <small>{hasGps(a) ? `${Number(a.lat).toFixed(5)}, ${Number(a.lng).toFixed(5)} · ` : ''}{ago(a.time)}{a.mapLink && <> · <a href={a.mapLink} target="_blank" rel="noreferrer">Map</a></>}</small>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

export default function App() {
  const [owner, setOwner] = useState(null);
  const [checking, setChecking] = useState(!!getToken());

  useEffect(() => {
    if (!getToken()) return;
    api('/me').then(setOwner).catch(() => setToken('')).finally(() => setChecking(false));
  }, []);

  if (checking) return <main className="wrap narrow"><p className="muted">Loading…</p></main>;
  return owner ? <Home owner={owner} onLogout={() => setOwner(null)} /> : <Auth onDone={setOwner} />;
}
