// assets.audio() が返す、解析済みの音声。値はすべて作品時刻 t(秒)で引く。
// 解析はRustコアが読み込み時に一度だけ行い、.cache/ に保存したもの(シークや書き出しで値がずれない)。

interface Analysis {
  duration: number;
  rate: number;
  rms: number[];
  low: number[];
  mid: number[];
  high: number[];
  onsets: number[];
  beats: number[];
  downbeats: number[];
  bpm: number | null;
  beatModel: string | null;
  waveMin: number[];
  waveMax: number[];
}

export interface BeatInfo {
  /** 何拍目か(0から)。最初の拍より前は -1 */
  index: number;
  /** 拍の中の進み具合(0〜1) */
  phase: number;
  /** 直前の拍からの経過秒 */
  since: number;
  /** 何小節目か(0から)。小節頭がない場合は -1 */
  bar: number;
  /** 小節の中で何拍目か(0から) */
  beatInBar: number;
  /** 直前の拍が小節頭か */
  downbeat: boolean;
}

/** 昇順の配列で、x以下の最後の要素の位置(なければ -1) */
function lastLE(a: number[], x: number): number {
  let lo = 0, hi = a.length - 1, r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (a[m] <= x) {
      r = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return r;
}

export class AudioTrack {
  readonly duration: number;
  readonly bpm: number | null;
  /** ビート・小節頭・オンセットの時刻(作品時刻、秒) */
  readonly beats: number[];
  readonly downbeats: number[];
  readonly onsets: number[];
  readonly beatModel: string | null;

  constructor(private a: Analysis, private offset: number) {
    this.duration = a.duration;
    this.bpm = a.bpm;
    this.beats = a.beats.map((b) => b + offset);
    this.downbeats = a.downbeats.map((b) => b + offset);
    this.onsets = a.onsets.map((b) => b + offset);
    this.beatModel = a.beatModel;
  }

  private sample(v: number[], t: number): number {
    const x = (t - this.offset) * this.a.rate;
    if (x < 0 || x >= v.length - 1) return 0;
    const i = Math.floor(x);
    return v[i] + (v[i + 1] - v[i]) * (x - i);
  }

  /** 音量(0〜1) */
  rms(t: number): number {
    return this.sample(this.a.rms, t);
  }

  /** 帯域のエネルギー(0〜1)。low: 〜200Hz、mid: 200〜2000Hz、high: 2000Hz〜 */
  band(name: "low" | "mid" | "high", t: number): number {
    return this.sample(this.a[name], t);
  }

  /** 波形の最小値と最大値(-1〜1) */
  wave(t: number): [number, number] {
    return [this.sample(this.a.waveMin, t), this.sample(this.a.waveMax, t)];
  }

  beat(t: number): BeatInfo {
    const i = lastLE(this.beats, t);
    if (i < 0) return { index: -1, phase: 0, since: Infinity, bar: -1, beatInBar: 0, downbeat: false };
    const b = this.beats[i];
    const next = this.beats[i + 1] ?? b + (this.bpm ? 60 / this.bpm : 0.5);
    const d = lastLE(this.downbeats, t + 1e-6);
    const db = d >= 0 ? this.downbeats[d] : -1;
    const beatInBar = d >= 0 ? i - lastLE(this.beats, db + 1e-6) : i;
    return { index: i, phase: Math.min(1, (t - b) / (next - b)), since: t - b, bar: d, beatInBar, downbeat: d >= 0 && Math.abs(db - b) < 1e-3 };
  }

  /** 直前のビートから指数的に減衰する値(ビートの瞬間に1)。decay は秒 */
  pulse(t: number, decay = 0.15): number {
    const i = lastLE(this.beats, t);
    return i < 0 ? 0 : Math.exp(-(t - this.beats[i]) / decay);
  }

  /** 直前のオンセットから指数的に減衰する値 */
  onset(t: number, decay = 0.1): number {
    const i = lastLE(this.onsets, t);
    return i < 0 ? 0 : Math.exp(-(t - this.onsets[i]) / decay);
  }
}

export async function loadAudio(work: string, rel: string, offsetSec: number): Promise<AudioTrack> {
  const r = await fetch(`/work/${encodeURIComponent(work)}/analysis/assets/${rel}`);
  if (!r.ok) throw new Error(`assets/${rel} を解析できない: ${await r.text()}`);
  return new AudioTrack(await r.json(), offsetSec);
}
