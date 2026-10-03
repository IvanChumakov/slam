import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Appearance } from './Appearance';
import styles from '../styles.css?raw';

describe('Appearance', () => {
  it('keeps small selected-channel text above 4.5:1 contrast for every accent and mode', () => {
    const luminance = (hex: string) => {
      const [red, green, blue] = hex.match(/../g)!.map((value) => parseInt(value, 16) / 255)
        .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return red * 0.2126 + green * 0.7152 + blue * 0.0722;
    };
    const pairs = [...styles.matchAll(/--accent:\s*#([\da-f]{6});\s*--accent-soft:\s*#([\da-f]{6});/g)];
    expect(pairs).toHaveLength(6);
    for (const [, foreground, background] of pairs) {
      const first = luminance(foreground);
      const second = luminance(background);
      expect((Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
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
