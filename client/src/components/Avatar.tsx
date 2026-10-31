const COLORS = ['#e17055', '#0984e3', '#6c5ce7', '#00a884', '#d6336c', '#e8a317', '#1098ad', '#7950f2', '#c2255c'];

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[words.length - 1]![0]! : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

export function Avatar({ name, seed, size = 44, online }: { name: string; seed: number; size?: number; online?: boolean }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: COLORS[seed % COLORS.length] }}>
      {initials(name)}
      {online && <span className="avatar-online" aria-label="online" />}
    </span>
  );
}

export const nameColor = (seed: number) => COLORS[seed % COLORS.length];
