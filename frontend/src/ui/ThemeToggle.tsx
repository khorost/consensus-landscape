import React from 'react';

interface ThemeToggleProps {
  preference: 'light' | 'dark' | 'system';
  onToggle: () => void;
}

const ICONS: Record<string, string> = {
  light: '☀',
  dark: '☾',
  system: '◐',
};

const LABELS: Record<string, string> = {
  light: 'Светлая тема',
  dark: 'Тёмная тема',
  system: 'Системная тема',
};

export const ThemeToggle: React.FC<ThemeToggleProps> = ({ preference, onToggle }) => {
  return (
    <button
      className="btn btn-icon theme-toggle"
      onClick={onToggle}
      title={LABELS[preference]}
      aria-label={LABELS[preference]}
    >
      {ICONS[preference]}
    </button>
  );
};
