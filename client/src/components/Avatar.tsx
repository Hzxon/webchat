const COLORS = ['#e17055', '#0984e3', '#6c5ce7', '#00a884', '#d6336c', '#e8a317', '#1098ad', '#7950f2', '#c2255c'];

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[words.length - 1]![0]! : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

interface AvatarProps {
  name: string;
  seed: number;
  size?: number;
  online?: boolean;
  /** Rounded square instead of a circle: projects, so they never look like a person. */
  square?: boolean;
}

export function Avatar({ name, seed, size = 44, online, square }: AvatarProps) {
  return (
    <span
      className={`avatar ${square ? 'avatar-square' : ''}`}
      style={{ width: size, height: size, fontSize: size * 0.38, background: COLORS[seed % COLORS.length] }}
    >
      {initials(name)}
      {online && <span className="avatar-online" aria-label="online" />}
    </span>
  );
}

export const nameColor = (seed: number) => COLORS[seed % COLORS.length];
