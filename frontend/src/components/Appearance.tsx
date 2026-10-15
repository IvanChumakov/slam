import { useEffect, useId, useState } from 'react';

type Preferences = { version: 1; mode: 'system' | 'light' | 'dark' | 'black'; accent: 'clay' | 'sage' | 'slate' };
const storageKey = 'slam.appearance.v1';

export function Appearance() {
  const id = useId();
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (value?.version === 1 && ['system', 'light', 'dark', 'black'].includes(value.mode) &&
        ['clay', 'sage', 'slate'].includes(value.accent)) {
        return { version: 1, mode: value.mode, accent: value.accent };
      }
    } catch { /* Storage can be unavailable in private or restricted browsers. */ }
    return { version: 1, mode: 'system', accent: 'clay' };
  });

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    function apply(matches: boolean) {
      document.documentElement.dataset.theme = preferences.mode === 'system'
        ? (matches ? 'dark' : 'light') : preferences.mode;
      document.documentElement.dataset.accent = preferences.accent;
    }
    apply(media?.matches ?? false);
    const change = (event: MediaQueryListEvent) => apply(event.matches);
    media?.addEventListener('change', change);
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)); }
    catch { /* Appearance still works for this session when persistence is blocked. */ }
    return () => media?.removeEventListener('change', change);
  }, [preferences]);

  return (
    <details className="appearance">
      <summary>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.4-3.4 1.5 1.5 0 0 1 1.1-2.6H18a3 3 0 0 0 3-3 9 9 0 0 0-9-9Z" />
          <circle cx="7.5" cy="10" r="1" /><circle cx="11" cy="6.5" r="1" /><circle cx="16" cy="8" r="1" />
        </svg>
        Theme &amp; colors
      </summary>
      <div className="appearance-options">
        <label htmlFor={`${id}-mode`}>Color mode</label>
        <select id={`${id}-mode`} value={preferences.mode}
          onChange={(event) => setPreferences({ ...preferences, mode: event.target.value as Preferences['mode'] })}>
          <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
          <option value="black">Black</option>
        </select>
        <label htmlFor={`${id}-accent`}>Accent color</label>
        <select id={`${id}-accent`} value={preferences.accent}
          onChange={(event) => setPreferences({ ...preferences, accent: event.target.value as Preferences['accent'] })}>
          <option value="clay">Clay</option><option value="sage">Sage</option><option value="slate">Slate</option>
        </select>
        <p>Saved only in this browser.</p>
      </div>
    </details>
  );
}
