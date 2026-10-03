export function RoomIcon({ name, off = false }: { name: 'mic' | 'audio' | 'camera' | 'screen' | 'leave' | 'channels'; off?: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {name === 'mic' ? <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></> : null}
      {name === 'audio' ? <><path d="M4 14v-3a8 8 0 0 1 16 0v3" /><rect x="3" y="12" width="4" height="8" rx="2" /><rect x="17" y="12" width="4" height="8" rx="2" /></> : null}
      {name === 'camera' ? <><rect x="3" y="6" width="12" height="12" rx="2" /><path d="m15 10 6-3v10l-6-3" /></> : null}
      {name === 'screen' ? <><rect x="3" y="3" width="18" height="14" rx="2" /><path d="M8 21h8M12 17v4m-3-11 3-3 3 3M12 7v6" /></> : null}
      {name === 'leave' ? <path d="M9 4H4v16h5m5-13 5 5-5 5M8 12h13" /> : null}
      {name === 'channels' ? <path d="M4 6h16M4 12h16M4 18h16" /> : null}
      {off ? <path d="m2 2 20 20" /> : null}
    </svg>
  );
}
