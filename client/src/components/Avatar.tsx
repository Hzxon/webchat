// Muted, warm tones that sit with the palette in styles.css, for a sender's name in a chat.
const COLORS = ['#b4532a', '#3d6e8c', '#5d7a45', '#a0662a', '#2f7a6b', '#9b4848', '#5a6474', '#86702f', '#8a5468'];

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
      // The avatar itself takes one of the palette's four soft tones (layout.css), as the design draws people.
      className={`avatar tone-${seed % 4} ${square ? 'avatar-square' : ''}`}
      style={{ width: size, height: size, fontSize: size * 0.34 }}
    >
      {initials(name)}
      {online && <span className="avatar-online" aria-label="online" />}
    </span>
  );
}

export const nameColor = (seed: number) => COLORS[seed % COLORS.length];
