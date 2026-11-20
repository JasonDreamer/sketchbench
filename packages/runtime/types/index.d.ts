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
 * stateful: simulate で状態を1フレームずつ進める(粒子・物理・前フレームの結果を使う表現)。
 *   アプリが一定フレームごとに状態を複製して保存点にし、シークでは直前の保存点から計算し直す
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
  /** MIDIファイル(.mid)。offset は秒(作品時刻でのファイルの先頭) */
  midi(path: string, opts?: { offset?: number }): Promise<MidiTrack>;
  url(path: string): string;
  image(path: string): Promise<HTMLImageElement>;
  text(path: string): Promise<string>;
  json<T = unknown>(path: string): Promise<T>;
  /** CSSのフォントとして読み込む(fillText や text.layoutVertical で family の名前で使う) */
  font(family: string, path: string): Promise<FontFace>;
  /** フォントファイル(.ttf・.otf)の輪郭と点列を取る */
  glyphs(path: string): Promise<GlyphFont>;
}

/** 文字モジュールが置いた1文字(x, y は文字の中心) */
export interface PlacedChar {
  ch: string;
  x: number;
  y: number;
  size: number;
  /** 縦書きで90度回して置く */
  rotate: boolean;
  /** 元の文字列での位置 */
  index: number;
  /** 何行目(縦書きでは右から何列目) */
  line: number;
}

export interface TextLayoutOptions {
  /** 縦書き: 1列目の中心のxと上端のy。横書き: 左端のxと1行目の中心のy */
  x: number;
  y: number;
  size: number;
  /** assets.font で読み込んだ名前 */
  family: string;
  weight?: string;
  /** 文字の間隔と行の間隔(文字の大きさに対する割合。行の既定 0.6) */
  letterSpacing?: number;
  lineGap?: number;
  /** 1行の最大の長さ(px)。超えたら折り返す */
  maxLength?: number;
}

export interface PathCommand {
  type: "M" | "L" | "Q" | "C" | "Z";
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

export interface GlyphFont {
  width(text: string, size: number): number;
  /** 文字列の輪郭。x, y はベースラインの左端 */
  path(text: string, x: number, y: number, size: number): { commands: PathCommand[]; path2d: Path2D };
  /** 1文字ずつの輪郭と送り幅 */
  glyphs(text: string, x: number, y: number, size: number): { ch: string; x: number; width: number; commands: PathCommand[]; path2d: Path2D }[];
  /** 輪郭に沿って spacing(px)ごとに置いた点。輪郭ごとの配列 */
  points(text: string, x: number, y: number, size: number, spacing?: number): { x: number; y: number }[][];
}

/** 文字モジュール(縦書き・ルビ・モーラ)。描くのは Canvas2D(p5 では g.drawingContext を渡す) */
export const text: {
  layoutVertical(g: CanvasRenderingContext2D, text: string, o: TextLayoutOptions): PlacedChar[];
  layoutHorizontal(g: CanvasRenderingContext2D, text: string, o: TextLayoutOptions): PlacedChar[];
  /** 置いた文字を描く(色などは先に g に設定しておく) */
  drawPlaced(g: CanvasRenderingContext2D, items: PlacedChar[], o: { family: string; weight?: string }): void;
  /** 青空文庫の記法「｜親文字《るび》」「漢字《るび》」を読む */
  parseRuby(s: string): { base: string; ruby?: string }[];
  /** ルビつきの配置。ルビは親文字の上(縦書きでは右)の中央に置く */
  layoutRuby(g: CanvasRenderingContext2D, segs: { base: string; ruby?: string }[] | string, o: TextLayoutOptions & { vertical?: boolean; rubySize?: number }): { base: PlacedChar[]; ruby: PlacedChar[] };
  /** 仮名をモーラに分ける(「きょう」→ ["きょ", "う"]) */
  moras(s: string): string[];
};

export interface SetupContext<R extends RendererKind, P extends Record<string, ParamDecl>> {
  width: number;
  height: number;
  p: Params<P>;
  assets: Assets;
  g: RendererMap[R];
  canvas: HTMLCanvasElement;
}

/** tracks 宣言のフィールドの型(params と同じ型名) */
export interface TrackDecl {
  fields: Record<string, Exclude<ParamType, "curve">>;
  /** 終了後もこの秒数だけ at() に含める */
  tail?: number;
}

type FieldValue<T> = T extends "float" | "int" ? number : T extends "bool" ? boolean : T extends "vec2" ? [number, number] : T extends "list<text>" ? string[] : string;

export interface ActiveClip<V> {
  id: string;
  /** フィールドの値 */
  value: V;
  /** クリップ開始からの経過(秒) */
  elapsed: number;
  /** クリップ内の進み具合(0〜1。終了後は1) */
  progress: number;
  /** 開始時刻順の通し番号(0から) */
  index: number;
  /** 終了後の経過(秒)。終了前は0 */
  after: number;
  start: number;
  end: number;
}

export interface ClipTrack<V> {
  /** 時刻tに有効なクリップ(開始時刻順、同時なら作成順)。tail の秒数だけ終了後も返す */
  at(t: number): ActiveClip<V>[];
  all(): ActiveClip<V>[];
}

export type Tracks<T extends Record<string, TrackDecl>> = { [K in keyof T]: ClipTrack<{ [F in keyof T[K]["fields"]]: FieldValue<T[K]["fields"][F]> }> };

/** project.json の eventMap で名前を付けたイベント(MIDIのノートや時刻の一覧) */
export interface Events {
  /** 直前の発生からの秒数(なければ Infinity) */
  since(name: string, t: number): number;
  /** 時刻t以前で最後の発生 */
  last(name: string, t: number): { time: number; index: number; velocity: number } | null;
  /** 時刻t以前の発生回数 */
  count(name: string, t: number): number;
  /** [from, to) に発生した一覧 */
  between(name: string, from: number, to: number): { time: number; index: number; velocity: number }[];
  names(): string[];
}

export interface MidiNote { pitch: number; velocity: number; channel: number; track: number; start: number; end: number }
export interface NoteFilter { note?: number | number[]; channel?: number; track?: number | string }

/** 秒に直したMIDIファイル。値はすべて作品時刻 t(秒)で引く */
export interface MidiTrack {
  readonly duration: number;
  readonly notes: readonly MidiNote[];
  /** [時刻, BPM] */
  readonly tempos: readonly [number, number][];
  filter(f?: NoteFilter): MidiNote[];
  /** 時刻tに鳴っているノート */
  notesAt(t: number, f?: NoteFilter): (MidiNote & { elapsed: number; progress: number })[];
  /** CCの値(0〜1)。直前の値を保つ */
  ccAt(controller: number, t: number, opts?: { channel?: number; init?: number }): number;
  /** 直前のノートオンからの秒数 */
  since(f: NoteFilter, t: number): number;
  /** ADSRのエンベロープ(0〜1、ベロシティを掛ける)。既定は attack 0、decay 0.25、sustain 0、release 0.1 */
  envelope(f: NoteFilter, t: number, e?: { attack?: number; decay?: number; sustain?: number; release?: number }): number;
}

export interface DrawContext<R extends RendererKind, P extends Record<string, ParamDecl>, T extends Record<string, TrackDecl> = {}> {
  /** 選んだrendererのコンテキスト(Canvas2D、WebGL2、p5インスタンス) */
  g: RendererMap[R];
  /** 秒(レイヤー時刻)。書き出し時も同じ値 */
  t: number;
  /** フレーム番号(レイヤー時刻) */
  frame: number;
  /** このレイヤーの描画の大きさ(内部解像度を反映した値) */
  width: number;
  height: number;
  /** params宣言から作った値(project.json の値で上書きされる) */
  p: Params<P>;
  /** このフレーム用に「シードとフレーム番号」で初期化した乱数 */
  rand: Rand;
  canvas: HTMLCanvasElement;
  /** tracks 宣言のクリップトラック */
  tracks: Tracks<T>;
  /** eventMap の名前付きイベント */
  events: Events;
  /** マーカーの区間内の進み具合(0〜1)。区間の外では -1 */
  section(name: string, t: number): number;
  /** 拍単位の時刻(project.json の bpm と beatOffset から)。bpm がなければ NaN */
  beats(t: number): number;
  /** マーカーの区間(作品時刻の秒) */
  markers: readonly { name: string; start: number; end: number }[];
  /** 他のレイヤーの描画結果。自分より下にあり、今のフレームで出ているレイヤーだけ引ける(それ以外は null) */
  inputs: { layer(id: string): HTMLCanvasElement | null };
}

/** simulate が受け取るもの(そのフレームのレイヤー時刻での値) */
export interface SimulateContext<P extends Record<string, ParamDecl>, T extends Record<string, TrackDecl> = {}> {
  /** これから進めるフレームの時刻(秒)と番号 */
  t: number;
  frame: number;
  /** 1フレームの秒数 */
  dt: number;
  width: number;
  height: number;
  p: Params<P>;
  /** シードとフレーム番号で初期化した乱数 */
  rand: Rand;
  tracks: Tracks<T>;
  events: Events;
  section(name: string, t: number): number;
  beats(t: number): number;
}

export interface SketchDef<R extends RendererKind, P extends Record<string, ParamDecl>, S, T extends Record<string, TrackDecl> = {}> {
  mode?: Mode;
  renderer?: R;
  params?: P;
  /** GUIで作るクリップトラック。tracks.名前.at(t) で引く */
  tracks?: T;
  /** 読み込み時とコード変更時に1回。戻り値は draw の第2引数に渡る */
  setup?(ctx: SetupContext<R, P>): S | Promise<S>;
  /**
   * mode "stateful" のとき、状態を1フレーム進める(フレーム0から順に1回ずつ呼ばれる)。
   * state を書き換えるか、新しい状態を返す。状態は複製できるデータ(オブジェクト・配列・型付き配列・Map・Set)にする
   */
  simulate?(state: S, ctx: SimulateContext<P, T>): S | void;
  /** フレームごと。p5では g が p5 インスタンス(noLoopとredrawで駆動される)。stateful では state を読むだけにする */
  draw(ctx: DrawContext<R, P, T>, state: S): void | Promise<void>;
  /** ホットリロード前と終了時。イベントやGPU資源を解放する */
  dispose?(state: S): void;
}

export function defineSketch<R extends RendererKind = "canvas2d", P extends Record<string, ParamDecl> = {}, S = undefined, T extends Record<string, TrackDecl> = {}>(
  def: SketchDef<R, P, S, T>,
): SketchDef<R, P, S, T>;

export const rand: Rand;
