import type { ReactNode } from 'react';
import type { UserDTO } from '../../../shared/types';

const DAY = 24 * 3600_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export const formatTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Short time for the chat list: a time today, "Yesterday", a weekday this week, else a date. */
export function formatListTime(ts: number): string {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY);
  if (days === 0) return formatTime(ts);
  if (days === 1) return 'Yesterday';
  if (days < 7) return new Date(ts).toLocaleDateString([], { weekday: 'long' });
  return new Date(ts).toLocaleDateString();
}

export function dayLabel(ts: number): string {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(ts).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function presenceText(user: UserDTO | undefined): string {
  if (!user) return '';
  if (user.online) return 'online';
  if (!user.lastSeen) return 'offline';
  const days = Math.round((startOfDay(Date.now()) - startOfDay(user.lastSeen)) / DAY);
  const time = formatTime(user.lastSeen);
  const minutes = Math.floor((Date.now() - user.lastSeen) / 60_000);
  if (minutes < 60) return `active ${Math.max(minutes, 1)} min ago`;
  if (days === 0) return `last seen today at ${time}`;
  if (days === 1) return `last seen yesterday at ${time}`;
  return `last seen ${new Date(user.lastSeen).toLocaleDateString()}`;
}

const URL_PATTERN = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g;

/** Turns http(s) links in plain text into anchors. Everything else stays text, so no HTML is injected. */
export function linkify(text: string): ReactNode[] {
  return text.split(URL_PATTERN).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  );
}
