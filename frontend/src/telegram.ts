export type TelegramWebApp = {
  initData?: string;
  initDataUnsafe?: { start_param?: string };
  ready?: () => void;
  expand?: () => void;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export type TelegramProfile = { username: string | null; avatarUrl?: string };

export function safeAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hostname === 'api.telegram.org') return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function decodeTelegramJoinToken(startParam: string): string | null {
  if (!/^join_[A-Za-z0-9_-]+$/.test(startParam)) return null;
  const encoded = startParam.slice(5);
  try {
    const token = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    // Check canonical encoding and path safety, not JWT authenticity (server-owned).
    if (btoa(token).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== encoded ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
    return token;
  } catch {
    return null;
  }
}

export function getTelegramLaunch(location: Pick<Location, 'search' | 'hash'>) {
  const webApp = window.Telegram?.WebApp;
  const search = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#\??/, ''));
  const initData = (typeof webApp?.initData === 'string' && webApp.initData) ||
    hash.get('tgWebAppData') || search.get('tgWebAppData') || '';
  const sdkStartParam = webApp?.initDataUnsafe?.start_param;
  const startParam = (typeof sdkStartParam === 'string' && sdkStartParam) ||
    new URLSearchParams(initData).get('start_param') ||
    search.get('tgWebAppStartParam') || hash.get('tgWebAppStartParam') || '';
  return { webApp, initData, startParam };
}

export async function loadTelegramProfile(
  initData: string,
  apiUrl = '',
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TelegramProfile | null> {
  if (!initData) return null;
  try {
    const response = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/api/telegram/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ init_data: initData }),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const { username, avatar_url: avatarUrl } = body as Record<string, unknown>;
    if ((username !== null && typeof username !== 'string') || (avatarUrl !== null && typeof avatarUrl !== 'string')) return null;
    return { username: typeof username === 'string' ? username.replace(/^@/, '').slice(0, 32) : null, avatarUrl: safeAvatarUrl(avatarUrl) };
  } catch {
    return null;
  }
}
