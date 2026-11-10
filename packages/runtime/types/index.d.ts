// @sketchbench/runtime の型定義(フェーズ1)。AGENTS.md と合わせてAIが読む前提で、全体をこのファイルに収める。

import type p5 from "p5";

/** params と tracks のフィールドの型 */
export type ParamType = "float" | "int" | "bool" | "color" | "vec2" | "enum" | "text" | "file" | "curve" | "list<text>";

export type ParamDecl =
  | { type: "float" | "int"; default: number; min?: number; max?: number; step?: number }
  | { type: "bool"; default: boolean }
  | { type: "color"; default: string }
  | { type: "vec2"; default: [number, number] }
  | { type: "enum"; default: string; options: readonly string[] }
  | { type: "text" | "file"; default: string }
  | { type: "curve"; default: Array<[number, number]> }
  | { type: "list<text>"; default: string[] };

type ParamValue<D> = D extends { type: "float" | "int" } ? number
  : D extends { type: "bool" } ? boolean
  : D extends { type: "vec2" } ? [number, number]
  : D extends { type: "curve" } ? Array<[number, number]>
  : D extends { type: "list<text>" } ? string[]
  : string;

export type Params<P extends Record<string, ParamDecl>> = { [K in keyof P]: ParamValue<P[K]> };

/**
 * pure: 時刻tの関数(任意の時刻へ即シークでき、順不同に描いても同じ結果)
 * stateful: simulateやフィードバックで状態を持つ(フェーズ4)
 * sequential: 仮想時計で動かす既存コード。宣言がない場合はこれ
 */
export type Mode = "pure" | "stateful" | "sequential";

export interface RendererMap {
  canvas2d: CanvasRenderingContext2D;
  webgl: WebGL2RenderingContext;
  p5: p5;
  shader: WebGL2RenderingContext;
}
export type RendererKind = keyof RendererMap;

/** シード固定の乱数。Math.random と crypto.getRandomValues も同じ乱数に差し替えてある */
export interface Rand {
  (): number;
  range(min: number, max: number): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
  /** 値ノイズ(-1〜1)。同じ引数なら常に同じ値 */
  noise(x: number, y?: number, z?: number): number;
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

/** 解析済みの音声。値はすべて作品時刻 t(秒)で引く(project.json の audio の offset を反映済み) */
export interface AudioTrack {
  readonly duration: number;
  readonly bpm: number | null;
  /** ビート・小節頭・オンセットの時刻(作品時刻、秒)。ビートは Beat This! で推定 */
  readonly beats: readonly number[];
  readonly downbeats: readonly number[];
  readonly onsets: readonly number[];
  /** 音量(0〜1) */
  rms(t: number): number;
  /** 帯域のエネルギー(0〜1)。low: 〜200Hz、mid: 200〜2000Hz、high: 2000Hz〜 */
  band(name: "low" | "mid" | "high", t: number): number;
  /** 波形の最小値と最大値(-1〜1) */
  wave(t: number): [number, number];
  beat(t: number): BeatInfo;
  /** 直前のビートから指数的に減衰する値(ビートの瞬間に1)。decay は秒 */
  pulse(t: number, decay?: number): number;
  /** 直前のオンセットから指数的に減衰する値 */
  onset(t: number, decay?: number): number;
}

/** 作品フォルダの assets/ を読む */
export interface Assets {
  /** 解析済みの音声(wav、mp3、flac など) */
  audio(path: string): Promise<AudioTrack>;
  url(path: string): string;
  image(path: string): Promise<HTMLImageElement>;
  text(path: string): Promise<string>;
  json<T = unknown>(path: string): Promise<T>;
  font(family: string, path: string): Promise<FontFace>;
}

export interface SetupContext<R extends RendererKind, P extends Record<string, ParamDecl>> {
  width: number;
  height: number;
  p: Params<P>;
  assets: Assets;
  g: RendererMap[R];
  canvas: HTMLCanvasElement;
}

export interface DrawContext<R extends RendererKind, P extends Record<string, ParamDecl>> {
  /** 選んだrendererのコンテキスト(Canvas2D、WebGL2、p5インスタンス) */
  g: RendererMap[R];
  /** 秒(レイヤー時刻)。書き出し時も同じ値 */
  t: number;
  /** フレーム番号 */
  frame: number;
  width: number;
  height: number;
  /** params宣言から作った値(project.json の値で上書きされる) */
  p: Params<P>;
  /** このフレーム用に「シードとフレーム番号」で初期化した乱数 */
  rand: Rand;
  canvas: HTMLCanvasElement;
}

export interface SketchDef<R extends RendererKind, P extends Record<string, ParamDecl>, S> {
  mode?: Mode;
  renderer?: R;
  params?: P;
  /** 読み込み時とコード変更時に1回。戻り値は draw の第2引数に渡る */
  setup?(ctx: SetupContext<R, P>): S | Promise<S>;
  /** フレームごと。p5では g が p5 インスタンス(noLoopとredrawで駆動される) */
  draw(ctx: DrawContext<R, P>, state: S): void | Promise<void>;
  /** ホットリロード前と終了時。イベントやGPU資源を解放する */
  dispose?(state: S): void;
}

export function defineSketch<R extends RendererKind = "canvas2d", P extends Record<string, ParamDecl> = {}, S = undefined>(
  def: SketchDef<R, P, S>,
): SketchDef<R, P, S>;

export const rand: Rand;
