import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeTelegramJoinToken, getTelegramLaunch, loadTelegramProfile, safeAvatarUrl } from './telegram';

afterEach(() => vi.unstubAllGlobals());
const token = 'eyJhbGciOiJIUzI1NiJ9.eyJyb29tX2lkIjo0Mn0.signature';
const start = `join_${btoa(token).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

describe('Telegram launch', () => {
  it('decodes an ASCII JWT without trusting its claims', () => {
    expect(decodeTelegramJoinToken(start)).toBe(token);
  });
  it.each(['', token, 'room_abc', 'join_%%%', 'join_a', 'join_YQ==', `join_${btoa('../room')}`, `join_${btoa('a.b.c/other')}`, `join_${btoa('é.b.c')}`, 'join_YS5iLmN'])('rejects unsafe or noncanonical start parameter %s', (value) => {
    expect(decodeTelegramJoinToken(value)).toBeNull();
  });
  it('reads only raw init data and start param, not unsafe profile fields', () => {
    vi.stubGlobal('Telegram', { WebApp: { initData: 'signed-data', initDataUnsafe: { start_param: start, user: { username: 'untrusted', photo_url: 'https://evil.test' } } } });
    expect(getTelegramLaunch({ search: '', hash: '' })).toMatchObject({ initData: 'signed-data', startParam: start });
  });
  it('supports query and hash start fallbacks without an SDK', () => {
    expect(getTelegramLaunch({ search: `?tgWebAppStartParam=${start}`, hash: '' }).startParam).toBe(start);
    expect(getTelegramLaunch({ search: '', hash: `#tgWebAppStartParam=${start}` }).startParam).toBe(start);
    expect(getTelegramLaunch({ search: '', hash: '' }).initData).toBe('');
  });
  it('uses raw launch data while the external SDK loads, without trusting user fields', () => {
    vi.stubGlobal('Telegram', undefined);
    const raw = new URLSearchParams({ start_param: start, user: '{"username":"untrusted"}', hash: 'signed' }).toString();
    const launch = getTelegramLaunch({ search: '', hash: `#tgWebAppData=${encodeURIComponent(raw)}` });
    expect(launch.initData).toBe(raw);
    expect(launch.startParam).toBe(start);
  });
});

describe('verified Telegram profile', () => {
  it('posts raw init data to the profile endpoint and returns a verified profile', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ username: '@alex', avatar_url: 'https://images.test/avatar' })));
    await expect(loadTelegramProfile('signed-data', 'https://api.test/', fetcher)).resolves.toEqual({ username: 'alex', avatarUrl: 'https://images.test/avatar' });
    expect(fetcher).toHaveBeenCalledWith('https://api.test/api/telegram/profile', expect.objectContaining({ method: 'POST', body: JSON.stringify({ init_data: 'signed-data' }) }));
  });
  it('never requests a profile without init data', async () => {
    const fetcher = vi.fn();
    await expect(loadTelegramProfile('', '', fetcher)).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('allows verified profiles without names or photos', async () => {
    await expect(loadTelegramProfile('signed', '', vi.fn().mockResolvedValue(new Response(JSON.stringify({ username: null, avatar_url: null }))))).resolves.toEqual({ username: null, avatarUrl: undefined });
  });
  it.each([401, 500])('falls back on status %s', async (status) => {
    await expect(loadTelegramProfile('untrusted', '', vi.fn().mockResolvedValue(new Response(null, { status })))).resolves.toBeNull();
  });
  it.each(['not json', JSON.stringify({ username: 123, avatar_url: null }), JSON.stringify({ username: 'Alex' })])('rejects malformed profile %s', async (body) => {
    await expect(loadTelegramProfile('signed', '', vi.fn().mockResolvedValue(new Response(body)))).resolves.toBeNull();
  });
  it('falls back on unavailable networking', async () => {
    await expect(loadTelegramProfile('signed', '', vi.fn().mockRejectedValue(new Error('offline')))).resolves.toBeNull();
  });
  it.each(['http://images.test/a', 'https://user:pass@images.test/a', 'javascript:alert(1)', 'https://api.telegram.org/file/botSECRET/photo', null])('rejects unsafe/public bot photo URLs %s', (url) => {
    expect(safeAvatarUrl(url)).toBeUndefined();
  });
});
