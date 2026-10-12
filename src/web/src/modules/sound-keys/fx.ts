// Letter Rescue — sound, voice and little bursts of joy. No files besides the phoneme clips; effects are synthesized.
import type { ModuleSettings } from '../../core/types';
import { contentUrl } from '../../core/content-url';
import { SOUNDS } from './content';

export function opts(s: ModuleSettings) {
  const o = s.options ?? {};
  return {
    calm: (o.calm ?? 'off') === 'on',
    sound: (o.sound ?? 'on') === 'on',
    rate: (o.voice ?? 'slow') === 'slow' ? 0.85 : 1,
    hintMs: (o.hint ?? '5') === 'never' ? Infinity : Number(o.hint ?? '5') * 1000,
  };
}
export type Opts = ReturnType<typeof opts>;

const clipCache = new Map<string, HTMLAudioElement>();
/** The phoneme clip for a sound unit ("f" → /f/). */
export function playSound(id: string, o: Opts): Promise<void> {
  if (!o.sound) return Promise.resolve();
  const file = SOUNDS[id]?.audio ?? id;
  let a = clipCache.get(file);
  if (!a) { a = new Audio(contentUrl(`sounds/phonemes/${file}.mp3`)); a.preload = 'auto'; clipCache.set(file, a); }
  a.currentTime = 0;
  return new Promise((res) => { a!.onended = () => res(); a!.play().catch(() => res()); setTimeout(res, 1400); });
}

let voice: SpeechSynthesisVoice | undefined;
function pickVoice() {
  if (typeof speechSynthesis === 'undefined') return;
  const vs = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
  // Prefer natural/online voices (Windows "Natural" voices, Google), then any US English.
  voice = vs.find((v) => /natural|neural|online/i.test(v.name) && v.lang === 'en-US') ?? vs.find((v) => /aria|jenny|guy|zira|google us/i.test(v.name)) ?? vs.find((v) => v.lang === 'en-US') ?? vs[0];
}
if (typeof speechSynthesis !== 'undefined') { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

export function speak(text: string, o: Opts, opt: { rate?: number; pitch?: number } = {}): Promise<void> {
  if (!o.sound || typeof speechSynthesis === 'undefined' || !text) return Promise.resolve();
  return new Promise((res) => {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = opt.rate ?? o.rate; u.pitch = opt.pitch ?? 1; u.lang = 'en-US';
      if (voice) u.voice = voice;
      u.onend = () => res(); u.onerror = () => res();
      speechSynthesis.speak(u);
      setTimeout(res, 800 + text.length * 90);
    } catch { res(); }
  });
}
export function hush() { try { speechSynthesis.cancel(); } catch { /* none */ } }

let actx: AudioContext | null = null;
type Sfx = 'pop' | 'chime' | 'charge' | 'free' | 'plank' | 'gem' | 'zap' | 'hit' | 'win' | 'star' | 'soft' | 'whoosh' | 'type';
/** Small synthesized effects. Quiet and never harsh: there is no "wrong" buzzer anywhere. */
export function sfx(kind: Sfx, o: Opts, n = 0) {
  if (!o.sound) return;
  try {
    actx ??= new AudioContext();
    if (actx.state === 'suspended') actx.resume();
    const t = actx.currentTime;
    const note = (freq: number, at: number, dur: number, type: OscillatorType = 'sine', to?: number, vol = 0.07) => {
      const osc = actx!.createOscillator(); const g = actx!.createGain();
      osc.type = type; osc.frequency.setValueAtTime(freq, t + at);
      if (to) osc.frequency.exponentialRampToValueAtTime(to, t + at + dur);
      g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(vol, t + at + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      osc.connect(g).connect(actx!.destination); osc.start(t + at); osc.stop(t + at + dur + 0.03);
    };
    const scale = [523, 587, 659, 784, 880, 988, 1047, 1175];
    switch (kind) {
      case 'type': note(1400, 0, 0.03, 'square', undefined, 0.015); break;
      case 'pop': note(720, 0, 0.12, 'triangle', 200); note(1500, 0, 0.05, 'square', 600, 0.02); break;
      case 'charge': note(260 + n * 90, 0, 0.2, 'triangle', 300 + n * 110); break;
      case 'plank': note(330 + n * 40, 0, 0.09, 'triangle', undefined, 0.06); note(160, 0, 0.06, 'square', 90, 0.02); break;
      case 'gem': note(scale[n % scale.length] * 2, 0, 0.25, 'sine'); note(scale[(n + 2) % scale.length] * 2, 0.06, 0.25, 'sine', undefined, 0.04); break;
      case 'zap': note(900, 0, 0.18, 'sawtooth', 120, 0.03); break;
      case 'hit': note(200, 0, 0.18, 'square', 70, 0.04); note(1200, 0.02, 0.08, 'triangle', 400, 0.03); break;
      case 'chime': note(660, 0, 0.25); note(990, 0.1, 0.3); break;
      case 'soft': note(440, 0, 0.12, 'sine', undefined, 0.03); break;
      case 'whoosh': note(200, 0, 0.35, 'triangle', 900, 0.03); break;
      case 'star': note(scale[Math.min(7, 3 + n * 2)], 0, 0.4, 'triangle', undefined, 0.07); note(scale[Math.min(7, 4 + n * 2)] * 2, 0.08, 0.35, 'sine', undefined, 0.04); break;
      case 'free': [523, 659, 784, 1047].forEach((f, i) => note(f, i * 0.11, 0.3, 'triangle')); break;
      case 'win': [523, 659, 784, 659, 784, 1047].forEach((f, i) => note(f, i * 0.12, i === 5 ? 0.6 : 0.2, 'triangle')); break;
    }
  } catch { /* audio unavailable */ }
}

/** A short burst of confetti from a point (or the middle of the screen). Skipped in calm mode. */
export function confetti(o: Opts, from?: { x: number; y: number }, count = 36) {
  if (o.calm || typeof document === 'undefined') return;
  const x = from?.x ?? window.innerWidth / 2, y = from?.y ?? window.innerHeight / 3;
  const colors = ['#fde047', '#22d3ee', '#f472b6', '#a3e635', '#fb923c', '#a78bfa'];
  for (let i = 0; i < count; i++) {
    const p = document.createElement('i');
    p.className = 'lr-confetti';
    const ang = Math.random() * Math.PI * 2, dist = 80 + Math.random() * 220;
    p.style.left = x + 'px'; p.style.top = y + 'px';
    p.style.background = colors[i % colors.length];
    p.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
    p.style.setProperty('--dy', Math.sin(ang) * dist + 140 + 'px');
    p.style.setProperty('--r', Math.random() * 720 - 360 + 'deg');
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 1300);
  }
}

/** Centre of an element, for aiming confetti. */
export function centerOf(el: Element | null | undefined) {
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
