// Letter Rescue — original cast, drawn in SVG so it scales crisply and needs no image files.
//   Tap  — a teal glove-bot who lives on the LEFT hand side of the keyboard.
//   Tock — an orange glove-bot who lives on the RIGHT hand side.
//   Glitch — a fizzy purple static cloud who scrambles letters and words. Mischievous, never scary.
//   Letter buddies — each rescued letter is a little round character in its finger's colour.

export function Tap({ size = 120, talking = false, wave = false }: { size?: number; talking?: boolean; wave?: boolean }) {
  return <GloveBot size={size} body="#14b8a6" dark="#0f766e" talking={talking} wave={wave} />;
}
export function Tock({ size = 120, talking = false, wave = false }: { size?: number; talking?: boolean; wave?: boolean }) {
  return <GloveBot size={size} body="#fb923c" dark="#c2410c" talking={talking} wave={wave} flip />;
}

function GloveBot({ size, body, dark, talking, wave, flip }: { size: number; body: string; dark: string; talking: boolean; wave: boolean; flip?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" class={'bot' + (wave ? ' wave' : '') + (talking ? ' talking' : '')} style={flip ? { transform: 'scaleX(-1)' } : {}}>
      {/* fingers */}
      {[18, 36, 54, 72].map((x, i) => (
        <rect x={x} y={[22, 12, 10, 18][i]} width="16" height="46" rx="8" fill={body} stroke={dark} stroke-width="3" class={i === 1 && wave ? 'bot-finger' : ''} />
      ))}
      {/* thumb */}
      <rect x="86" y="52" width="16" height="34" rx="8" fill={body} stroke={dark} stroke-width="3" transform="rotate(-35 94 69)" />
      {/* palm / face */}
      <rect x="14" y="44" width="78" height="62" rx="26" fill={body} stroke={dark} stroke-width="3" />
      <ellipse cx="40" cy="70" rx="9" ry="11" fill="#fff" /><ellipse cx="66" cy="70" rx="9" ry="11" fill="#fff" />
      <circle cx="42" cy="72" r="5" fill="#111827" /><circle cx="68" cy="72" r="5" fill="#111827" />
      <circle cx="44" cy="70" r="1.6" fill="#fff" /><circle cx="70" cy="70" r="1.6" fill="#fff" />
      {talking
        ? <ellipse cx="53" cy="92" rx="8" ry="5" fill={dark} class="bot-mouth" />
        : <path d="M44 90 Q53 97 62 90" stroke={dark} stroke-width="3.5" fill="none" stroke-linecap="round" />}
      <circle cx="30" cy="86" r="4" fill="#fda4af" opacity=".7" /><circle cx="76" cy="86" r="4" fill="#fda4af" opacity=".7" />
      {/* antenna light */}
      <line x1="53" y1="44" x2="53" y2="36" stroke={dark} stroke-width="3" /><circle cx="53" cy="34" r="4" fill="#fde047" />
    </svg>
  );
}

export function Glitch({ size = 120, mood = 'sly' }: { size?: number; mood?: 'sly' | 'oops' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" class="glitch">
      <defs>
        <radialGradient id="gl" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#c084fc" /><stop offset="1" stop-color="#6d28d9" /></radialGradient>
      </defs>
      <path d="M20 70 Q8 52 26 42 Q26 20 50 22 Q62 6 80 20 Q104 18 102 44 Q118 56 104 74 Q108 96 84 96 Q70 110 52 98 Q28 104 26 86 Q10 82 20 70Z" fill="url(#gl)" stroke="#4c1d95" stroke-width="3" />
      {/* static sparks */}
      <path d="M14 40 l6 4 -5 3 7 4" stroke="#facc15" stroke-width="2.5" fill="none" class="spark" />
      <path d="M104 30 l-6 5 6 2 -6 5" stroke="#facc15" stroke-width="2.5" fill="none" class="spark s2" />
      {/* zigzag eyes */}
      <path d="M38 56 l6 -6 6 6" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" />
      <path d="M66 56 l6 -6 6 6" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" />
      {mood === 'sly'
        ? <path d="M42 76 Q58 70 76 78" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" />
        : <ellipse cx="58" cy="78" rx="7" ry="8" fill="#1e1b4b" />}
    </svg>
  );
}

/** A letter buddy: round body in its finger colour with the letter on its tummy. Trapped = inside Glitch's bubble. */
export function LetterBuddy({ letter, color, size = 90, trapped = false, happy = true }: { letter: string; color: string; size?: number; trapped?: boolean; happy?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" class={'buddy' + (trapped ? ' trapped' : '')}>
      <circle cx="50" cy="56" r="34" fill={color} stroke="rgba(0,0,0,.25)" stroke-width="3" />
      <circle cx="38" cy="44" r="5" fill="#111827" /><circle cx="62" cy="44" r="5" fill="#111827" />
      <circle cx="39.5" cy="42.5" r="1.5" fill="#fff" /><circle cx="63.5" cy="42.5" r="1.5" fill="#fff" />
      {happy ? <path d="M40 56 Q50 64 60 56" stroke="#111827" stroke-width="3" fill="none" stroke-linecap="round" />
             : <path d="M42 60 Q50 54 58 60" stroke="#111827" stroke-width="3" fill="none" stroke-linecap="round" />}
      <text x="50" y="84" text-anchor="middle" font-family="Consolas, monospace" font-weight="900" font-size={letter.length > 1 ? 18 : 24} fill="#111827">{letter}</text>
      {trapped && <>
        <circle cx="50" cy="52" r="46" fill="rgba(192,132,252,.18)" stroke="#c084fc" stroke-width="3" stroke-dasharray="6 4" class="bubble" />
        <path d="M18 30 l4 3 -3 2 5 3" stroke="#facc15" stroke-width="2" fill="none" />
      </>}
    </svg>
  );
}

/** Island blob for the world map. */
export function Island({ color, width = 260, children }: { color: string; width?: number; children?: any }) {
  return (
    <div class="island" style={{ width: width + 'px' }}>
      <svg viewBox="0 0 260 120" class="island-shape" preserveAspectRatio="none">
        <path d="M10 70 Q20 30 70 30 Q100 6 150 20 Q210 10 240 44 Q262 70 236 92 Q200 116 130 108 Q60 116 26 98 Q2 88 10 70Z" fill={color} opacity=".22" />
        <path d="M22 72 Q30 42 74 40 Q104 20 150 32 Q204 24 228 50 Q246 70 226 86 Q196 104 130 98 Q66 104 36 90 Q18 84 22 72Z" fill={color} opacity=".35" />
      </svg>
      <div class="island-content">{children}</div>
    </div>
  );
}
