import { useState, useEffect, useCallback } from 'react';

export type Theme = 'light' | 'dark';

function getSystemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getStoredPreference(): 'light' | 'dark' | 'system' {
  const stored = localStorage.getItem('theme-preference');
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system';
}

export function useTheme() {
  const [preference, setPreference] = useState<'light' | 'dark' | 'system'>(getStoredPreference);
  const [resolvedTheme, setResolvedTheme] = useState<Theme>(
    () => preference === 'system' ? getSystemTheme() : preference
  );

  useEffect(() => {
    const resolve = () => {
      const theme = preference === 'system' ? getSystemTheme() : preference;
      setResolvedTheme(theme);
      document.documentElement.setAttribute('data-theme', theme);
    };

    resolve();

    if (preference === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => resolve();
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
  }, [preference]);

  const cycleTheme = useCallback(() => {
    const next = preference === 'system' ? 'light' : preference === 'light' ? 'dark' : 'system';
    setPreference(next);
    localStorage.setItem('theme-preference', next);
  }, [preference]);

  return { theme: resolvedTheme, preference, cycleTheme };
}
