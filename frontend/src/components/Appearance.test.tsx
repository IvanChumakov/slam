import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Appearance } from './Appearance';
import styles from '../styles.css?raw';

const contrast = (foreground: string, background: string) => {
  const luminance = (hex: string) => {
    const [red, green, blue] = hex.match(/../g)!.map((value) => parseInt(value, 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

describe('Appearance', () => {
  it('keeps small selected-channel text above 4.5:1 contrast for every accent and mode', () => {
    const pairs = [...styles.matchAll(/--accent:\s*#([\da-f]{6});\s*--accent-soft:\s*#([\da-f]{6});/g)];
    expect(pairs).toHaveLength(9);
    for (const [, foreground, background] of pairs) {
      expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(['clay', 'sage', 'slate'])('uses a truly black accessible palette with the %s accent', (accent) => {
    const base = styles.match(/:root\[data-theme="black"\]\s*\{([^}]+)\}/)?.[1];
    expect(base).toBeDefined();
    expect(base).toMatch(/color-scheme:\s*dark;/);
    const colors = Object.fromEntries([...base!.matchAll(/--([\w-]+):\s*#([\da-f]{6});/g)]
      .map(([, name, color]) => [name, color]));
    expect(colors.canvas).toBe('000000');
    expect(colors.panel).toBe('0d1014');
    expect(colors['panel-soft']).toBe('080b0f');
    if (accent !== 'clay') {
      const override = styles.match(new RegExp(`:root\\[data-theme="black"\\]\\[data-accent="${accent}"\\]\\s*\\{([^}]+)\\}`))?.[1];
      expect(override).toBeDefined();
      Object.assign(colors, Object.fromEntries([...override!.matchAll(/--([\w-]+):\s*#([\da-f]{6});/g)]
        .map(([, name, color]) => [name, color])));
    }
    for (const background of ['canvas', 'panel', 'panel-soft', 'accent-soft']) {
      expect(contrast(colors.text, colors[background])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.muted, colors[background])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.accent, colors[background])).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(colors.accent, colors['accent-soft'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors['on-accent'], colors.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.border, colors.panel)).toBeGreaterThanOrEqual(3);
    expect(contrast(colors.border, colors['panel-soft'])).toBeGreaterThanOrEqual(3);
    expect(styles).toMatch(/:focus-visible[^}]+outline:\s*3px solid var\(--accent\)/);
  });

  it('styles compact wrapping rosters without truncating names or changing voice-highlight timing', () => {
    const roster = styles.match(/\.channel-roster\s*\{([^}]+)\}/)?.[1];
    expect(roster).toBeDefined();
    expect(roster).toMatch(/list-style:\s*none/);
    expect(roster).toMatch(/margin:\s*4px 0 8px/);
    expect(roster).toMatch(/padding:\s*0 8px 0 16px/);
    expect(roster).toMatch(/display:\s*grid/);
    expect(roster).toMatch(/gap:\s*4px/);
    const member = styles.match(/\.channel-roster-member\s*\{([^}]+)\}/)?.[1];
    expect(member).toMatch(/display:\s*flex/);
    expect(member).toMatch(/min-width:\s*0/);
    expect(member).toMatch(/gap:\s*8px/);
    const avatar = styles.match(/\.channel-roster-avatar\s*\{([^}]+)\}/)?.[1];
    expect(avatar).toMatch(/width:\s*18px/);
    expect(avatar).toMatch(/height:\s*18px/);
    expect(avatar).toMatch(/flex-shrink:\s*0/);
    expect(avatar).toMatch(/border-radius:\s*50%/);
    const name = styles.match(/\.channel-roster-name\s*\{([^}]+)\}/)?.[1];
    expect(name).toMatch(/min-width:\s*0/);
    expect(name).toMatch(/overflow-wrap:\s*anywhere/);
    expect(name).not.toMatch(/nowrap|ellipsis|max-height/);
    expect(styles).toMatch(/\.channel-roster-you\s*\{[^}]+color:\s*var\(--muted\)/);
    expect(styles).toMatch(/\.channel-roster-stale\s*\{[^}]+color:\s*var\(--muted\)/);
    expect(styles).toMatch(/\.participant-speaking, \.participant-avatar-speaking\s*\{\s*transition-duration:\s*40ms;/);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none !important/);
  });
  let change: (event: { matches: boolean }) => void;
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false,
      addEventListener: vi.fn((_name, listener) => { change = listener; }),
      removeEventListener: vi.fn(),
    })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to System and follows OS changes', () => {
    render(<Appearance />);
    expect(screen.getByLabelText('Color mode')).toHaveValue('system');
    expect(document.documentElement.dataset.theme).toBe('light');
    act(() => change({ matches: true }));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('persists only versioned appearance choices and restores them', async () => {
    const view = render(<Appearance />);
    await userEvent.selectOptions(screen.getByLabelText('Color mode'), 'dark');
    await userEvent.selectOptions(screen.getByLabelText('Accent color'), 'sage');
    expect(JSON.parse(localStorage.getItem('slam.appearance.v1')!)).toEqual({ version: 1, mode: 'dark', accent: 'sage' });
    view.unmount();
    render(<Appearance />);
    expect(screen.getByLabelText('Color mode')).toHaveValue('dark');
    expect(screen.getByLabelText('Accent color')).toHaveValue('sage');
  });

  it('offers Black as the fourth mode and persists and restores it in version 1', async () => {
    const view = render(<Appearance />);
    expect([...screen.getByLabelText('Color mode').querySelectorAll('option')].map((option) => option.textContent))
      .toEqual(['System', 'Light', 'Dark', 'Black']);
    await userEvent.selectOptions(screen.getByLabelText('Color mode'), 'black');
    await userEvent.selectOptions(screen.getByLabelText('Accent color'), 'slate');
    expect(document.documentElement.dataset.theme).toBe('black');
    expect(JSON.parse(localStorage.getItem('slam.appearance.v1')!)).toEqual({ version: 1, mode: 'black', accent: 'slate' });
    view.unmount();
    render(<Appearance />);
    expect(screen.getByLabelText('Color mode')).toHaveValue('black');
    expect(screen.getByLabelText('Accent color')).toHaveValue('slate');
    expect(document.documentElement.dataset.theme).toBe('black');
  });

  it.each(['system', 'light', 'dark'])('restores existing version-1 %s preferences without changing the accent', (mode) => {
    localStorage.setItem('slam.appearance.v1', JSON.stringify({ version: 1, mode, accent: 'sage' }));
    render(<Appearance />);
    expect(screen.getByLabelText('Color mode')).toHaveValue(mode);
    expect(screen.getByLabelText('Accent color')).toHaveValue('sage');
    expect(document.documentElement.dataset.theme).toBe(mode === 'system' ? 'light' : mode);
  });

  it.each(['clay', 'sage', 'slate'])('never lets OS changes override saved Black with the %s accent', (accent) => {
    localStorage.setItem('slam.appearance.v1', JSON.stringify({ version: 1, mode: 'black', accent }));
    render(<Appearance />);
    expect(document.documentElement.dataset.theme).toBe('black');
    act(() => change({ matches: true }));
    expect(document.documentElement.dataset.theme).toBe('black');
    act(() => change({ matches: false }));
    expect(document.documentElement.dataset.theme).toBe('black');
    expect(document.documentElement.dataset.accent).toBe(accent);
  });

  it.each(['{', 'null', '{"version":1,"mode":"neon","accent":"sage"}',
    '{"version":2,"mode":"dark","accent":"sage"}', '{"version":1,"mode":"dark","accent":"neon"}'])('rejects malformed or unrecognized stored preferences: %s', (stored) => {
    localStorage.setItem('slam.appearance.v1', stored);
    render(<Appearance />);
    expect(screen.getByLabelText('Color mode')).toHaveValue('system');
    expect(screen.getByLabelText('Accent color')).toHaveValue('clay');
  });

  it('does not let OS changes override an explicit mode and removes the listener on unmount', async () => {
    const removeEventListener = vi.fn();
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false,
      addEventListener: vi.fn((_name, listener) => { change = listener; }), removeEventListener,
    })));
    const view = render(<Appearance />);
    await userEvent.selectOptions(screen.getByLabelText('Color mode'), 'light');
    act(() => change({ matches: true }));
    expect(document.documentElement.dataset.theme).toBe('light');
    view.unmount();
    expect(removeEventListener).toHaveBeenLastCalledWith('change', expect.any(Function));
  });

  it('remains usable when browser storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<Appearance />);
    await userEvent.selectOptions(screen.getByLabelText('Color mode'), 'light');
    expect(document.documentElement.dataset.theme).toBe('light');
    vi.restoreAllMocks();
  });
});
