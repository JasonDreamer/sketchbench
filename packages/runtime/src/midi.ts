// assets.midi() が返すMIDIデータと、イベント対応表・マーカー・BPMから作る時刻の関数。
// どれも作品時刻 t(秒)で引き、前のフレームの状態を持たない(純粋スケッチのまま使える)。

export interface Note { pitch: number; velocity: number; channel: number; track: number; start: number; end: number }
interface Cc { channel: number; controller: number; value: number; time: number }
interface MidiData {
  duration: number;
  notes: Note[];
  cc: Cc[];
  tempos: [number, number][];
  timeSignatures: [number, number, number][];
  markers: [number, string][];
  trackNames: string[];
}

export interface NoteFilter { note?: number | number[]; channel?: number; track?: number | string }
export interface ActiveNote extends Note { elapsed: number; progress: number }
export interface Envelope { attack?: number; decay?: number; sustain?: number; release?: number }

function lastLE(a: number[], x: number): number {
  let lo = 0, hi = a.length - 1, r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (a[m] <= x) { r = m; lo = m + 1; } else hi = m - 1;
  }
  return r;
}

export class MidiTrack {
  readonly duration: number;
  readonly notes: Note[];
  readonly tempos: [number, number][];
  readonly markers: [number, string][];
  private cc: Cc[];

  constructor(private d: MidiData, private offset: number) {
    this.duration = d.duration;
    this.notes = d.notes.map((n) => ({ ...n, start: n.start + offset, end: n.end + offset }));
    this.cc = d.cc.map((c) => ({ ...c, time: c.time + offset }));
    this.tempos = d.tempos.map(([t, b]) => [t + offset, b]);
    this.markers = d.markers.map(([t, s]) => [t + offset, s]);
  }

  /** フィルターに合うノート(開始順) */
  filter(f: NoteFilter = {}): Note[] {
    const notes = Array.isArray(f.note) ? f.note : f.note != null ? [f.note] : null;
    const track = typeof f.track === "string" ? this.d.trackNames.indexOf(f.track) : f.track;
    return this.notes.filter((n) => (!notes || notes.includes(n.pitch)) && (f.channel == null || n.channel === f.channel) && (track == null || n.track === track));
  }

  /** 時刻tに鳴っているノート */
  notesAt(t: number, f: NoteFilter = {}): ActiveNote[] {
    return this.filter(f)
      .filter((n) => n.start <= t && t < n.end)
      .map((n) => ({ ...n, elapsed: t - n.start, progress: (t - n.start) / Math.max(1e-9, n.end - n.start) }));
  }

  /** CCの値(0〜1)。直前の値を保つ。まだ送られていなければ init */
  ccAt(controller: number, t: number, opts: { channel?: number; init?: number } = {}): number {
    let v = opts.init ?? 0;
    for (const c of this.cc) {
      if (c.time > t) break;
      if (c.controller === controller && (opts.channel == null || c.channel === opts.channel)) v = c.value;
    }
    return v;
  }

  /** 直前のノートオンからの秒数(なければ Infinity) */
  since(f: NoteFilter, t: number): number {
    const starts = this.filter(f).map((n) => n.start);
    const i = lastLE(starts, t);
    return i < 0 ? Infinity : t - starts[i];
  }

  /**
   * ADSRのエンベロープ(0〜1、ベロシティを掛ける)。重なったノートは大きいほうを取る。
   * attack・decay・release は秒、sustain は0〜1。既定は打楽器向け(attack 0、decay 0.25、sustain 0)
   */
  envelope(f: NoteFilter, t: number, e: Envelope = {}): number {
    const { attack = 0, decay = 0.25, sustain = 0, release = 0.1 } = e;
    let best = 0;
    for (const n of this.filter(f)) {
      if (n.start > t) break;
      const x = t - n.start;
      let v: number;
      if (x < attack) v = x / attack;
      else if (x < attack + decay) v = 1 - (1 - sustain) * ((x - attack) / decay);
      else v = sustain;
      if (t >= n.end) {
        const r = t - n.end;
        const atEnd = n.end - n.start < attack ? (n.end - n.start) / attack : Math.max(sustain, n.end - n.start < attack + decay ? 1 - (1 - sustain) * ((n.end - n.start - attack) / decay) : sustain);
        v = release > 0 ? atEnd * Math.max(0, 1 - r / release) : 0;
      }
      best = Math.max(best, v * n.velocity);
    }
    return best;
  }
}

const cache = new Map<string, Promise<MidiData>>();
export function fetchMidi(work: string, relFromWork: string): Promise<MidiData> {
  if (!cache.has(relFromWork)) {
    cache.set(relFromWork, fetch(`/work/${encodeURIComponent(work)}/midi/${relFromWork}`).then(async (r) => {
      if (!r.ok) throw new Error(`${relFromWork} を読めない: ${await r.text()}`);
      return r.json();
    }));
  }
  return cache.get(relFromWork)!;
}

export function clearMidiCache() {
  cache.clear();
}

export async function loadMidi(work: string, rel: string, offsetSec = 0): Promise<MidiTrack> {
  return new MidiTrack(await fetchMidi(work, `assets/${rel}`), offsetSec);
}

// ---------------------------------------------------------------- イベント対応表・マーカー・BPM

export interface EventHit { time: number; index: number; velocity: number }

/** project.json の eventMap: { 名前: { midi: "assets/x.mid", note?, channel?, track? } | { times: [秒...] } } */
export class Events {
  constructor(private map: Map<string, EventHit[]>) {}

  static async load(work: string, eventMap: Record<string, any> | undefined): Promise<Events> {
    const m = new Map<string, EventHit[]>();
    for (const [name, src] of Object.entries(eventMap ?? {})) {
      let hits: EventHit[] = [];
      if (Array.isArray(src?.times)) {
        hits = (src.times as number[]).slice().sort((a, b) => a - b).map((time, index) => ({ time, index, velocity: 1 }));
      } else if (typeof src?.midi === "string") {
        const tr = new MidiTrack(await fetchMidi(work, src.midi.replace(/^\.\//, "")), Number(src.offset ?? 0));
        hits = tr.filter({ note: src.note, channel: src.channel, track: src.track }).map((n, index) => ({ time: n.start, index, velocity: n.velocity }));
      }
      m.set(name, hits);
    }
    return new Events(m);
  }

  private hits(name: string): EventHit[] {
    const h = this.map.get(name);
    if (!h) throw new Error(`eventMap に ${name} がない`);
    return h;
  }

  /** 直前の発生からの秒数(なければ Infinity) */
  since(name: string, t: number): number {
    const l = this.last(name, t);
    return l ? t - l.time : Infinity;
  }

  /** 時刻t以前で最後の発生 */
  last(name: string, t: number): EventHit | null {
    const h = this.hits(name);
    const i = lastLE(h.map((x) => x.time), t);
    return i < 0 ? null : h[i];
  }

  /** 時刻t以前の発生回数 */
  count(name: string, t: number): number {
    return (this.last(name, t)?.index ?? -1) + 1;
  }

  /** [from, to) に発生した一覧 */
  between(name: string, from: number, to: number): EventHit[] {
    return this.hits(name).filter((x) => x.time >= from && x.time < to);
  }

  names(): string[] {
    return [...this.map.keys()];
  }
}

export interface MarkerInfo { name: string; start: number; end: number }

/** project.json の markers: [{ name, start, end? }](フレーム)。end がなければ次のマーカーか尺の終わりまで */
export function makeMarkers(markers: any[] | undefined, fps: number, durationFrames: number): MarkerInfo[] {
  const ms = (markers ?? []).filter((m) => m && typeof m.name === "string").slice().sort((a, b) => a.start - b.start);
  return ms.map((m, i) => ({
    name: m.name,
    start: m.start / fps,
    end: (m.end ?? ms[i + 1]?.start ?? durationFrames) / fps,
  }));
}

/** 区間内の進み具合(0〜1)。区間の外では -1 */
export function sectionFn(markers: MarkerInfo[]) {
  return (name: string, t: number): number => {
    const m = markers.find((x) => x.name === name && x.start <= t && t < x.end);
    return m ? (t - m.start) / (m.end - m.start) : -1;
  };
}

/** 拍単位の時刻。project.json の bpm と beatOffset(拍0の時刻、フレーム)から */
export function beatsFn(bpm: number | undefined, beatOffsetFrames: number | undefined, fps: number) {
  return (t: number): number => (bpm ? ((t - (beatOffsetFrames ?? 0) / fps) * bpm) / 60 : NaN);
}
