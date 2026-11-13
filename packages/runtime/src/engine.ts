// レイヤーの読み込み・setup・描画と、出力canvasへの合成(合成は compositor.ts のWebGL2)。
// コード変更時は dispose() してから新しいコードで setup() する。新しいコードが失敗したら直前の正常なコードで描き続ける。

import { advanceTo } from "./clock.js";
import { errorText, log, post, work } from "./bridge.js";
import { rand, seed } from "./rand.js";
import { createIsf, createRenderer, type Renderer } from "./renderers.js";
import { loadAudio } from "./audio.js";
import { makeTracks } from "./tracks.js";
import { evaluate } from "./keyframes.js";
import { Compositor } from "./compositor.js";
import { bindTime, LayerClock, placement, TIME_ARGS, type LayerSettings } from "./layer.js";
import { beatsFn, clearMidiCache, Events, fetchMidi, loadMidi, makeMarkers, MidiTrack, sectionFn, type MarkerInfo } from "./midi.js";

export interface ProjectInfo {
  width: number;
  height: number;
  fps: [number, number];
  duration: number;
  seed?: number;
  audio?: { asset: string; offset?: number }[];
  eventMap?: Record<string, any>;
  ccMap?: Record<string, CcMapEntry>;
  markers?: any[];
  bpm?: number;
  beatOffset?: number;
  layers?: LayerSettings[];
}

/** project.json の ccMap: { "レイヤー.param": { cc, channel?, min?, max?, source? } } */
interface CcMapEntry { cc: number; channel?: number; min?: number; max?: number; source?: string }

interface LayerInfo {
  id: string;
  sketch: string;
  kind: "ts" | "isf" | "missing";
  url?: string;
  params: Record<string, any>;
  tracks?: Record<string, any>;
}

interface Loaded {
  url: string;
  def: any;
  renderer: Renderer;
  state: unknown;
  /** project.json の値(キーフレームつきのまま)。描画のたびに評価する */
  params: Record<string, any>;
  /** params の型(補間のしかたを決める) */
  types: Record<string, string>;
  tracks: Record<string, any>;
  failedAt: number;
  /** レイヤー時刻と作品時刻の対応(setupで作った関数もこれを見る) */
  clock: LayerClock;
  settings: LayerSettings;
  /** 内部解像度の倍率(変わったら作り直す) */
  resolution: number;
}

export class Engine {
  project!: ProjectInfo;
  output: HTMLCanvasElement;
  comp: Compositor | null = null;
  layers = new Map<string, Loaded>();
  order: string[] = [];
  host: HTMLElement;
  lastFrame = -1;
  rev = 0;
  events = new Events(new Map());
  markers: MarkerInfo[] = [];
  section = sectionFn([]);
  beats = beatsFn(undefined, undefined, 30);
  /** CC割り当て。プレビュー中はライブの値(live)、なければ録音ファイル(source)の値を使う */
  ccMap: { layer: string; param: string; e: CcMapEntry; track: MidiTrack | null }[] = [];
  /** ライブのCCの値("channel:cc" → 0〜1)。プレビューのときだけ入る */
  liveCc = new Map<string, number>();

  constructor(host: HTMLElement) {
    this.host = host;
    this.output = document.createElement("canvas");
    host.appendChild(this.output);
  }

  get fps(): number {
    return this.project.fps[0] / Math.max(1, this.project.fps[1]);
  }

  /** project.json と各スケッチを読み直す。変わったレイヤーだけ作り直す。 */
  async load(): Promise<boolean> {
    const res = await (await fetch(`/api/project?work=${encodeURIComponent(work)}`)).json();
    if (!res.ok) {
      log("error", `project.json を読めない: ${res.error}`);
      return false;
    }
    const p = res.project as ProjectInfo;
    const sizeChanged = !this.project || p.width !== this.project.width || p.height !== this.project.height;
    this.project = p;
    if (sizeChanged) {
      // WebGLのコンテキストは大きさごとに作り直す(canvasごと替える)
      this.comp?.dispose();
      const c = document.createElement("canvas");
      this.host.replaceChild(c, this.output);
      this.output = c;
      this.comp = new Compositor(c, p.width, p.height);
      for (const id of [...this.layers.keys()]) this.drop(id);
    }
    // イベント対応表・マーカー・BPM(作品時刻で引く関数)
    clearMidiCache();
    try {
      this.events = await Events.load(work, p.eventMap);
    } catch (e) {
      log("error", `eventMap を読めない: ${errorText(e)}`);
    }
    this.markers = makeMarkers(p.markers, this.fps, p.duration);
    this.section = sectionFn(this.markers);
    this.beats = beatsFn(p.bpm, p.beatOffset, this.fps);
    this.ccMap = [];
    for (const [key, e] of Object.entries(p.ccMap ?? {})) {
      const [layer, param] = key.split(".");
      let track: MidiTrack | null = null;
      if (e.source) {
        try {
          track = new MidiTrack(await fetchMidi(work, e.source.replace(/^\.\//, "")), 0);
        } catch (err) {
          log("error", `ccMap の ${key}: ${errorText(err)}`);
        }
      }
      this.ccMap.push({ layer, param, e, track });
    }
    const infos = res.layers as LayerInfo[];
    this.order = infos.map((l) => l.id);
    for (const id of [...this.layers.keys()]) if (!this.order.includes(id)) this.drop(id);
    let ok = true;
    for (const info of infos) {
      const cur = this.layers.get(info.id);
      if (info.kind === "missing") {
        log("error", `レイヤー ${info.id}: ${info.sketch} に sketch.ts も shader.fs もない`);
        ok = false;
        continue;
      }
      const settings = this.settingsOf(info.id);
      if (cur && cur.url === info.url && cur.resolution === resolutionOf(settings)) {
        ({ entries: cur.params, types: cur.types } = resolveParams(cur.def, info.params));
        cur.settings = settings;
        cur.clock.set(settings, this.fps, p.duration);
        cur.tracks = this.bindTracks(makeTracks(cur.def.tracks, info.tracks, this.fps), cur.clock);
        continue;
      }
      ok = (await this.loadLayer(info, cur)) && ok;
    }
    this.lastFrame = -1;
    return ok;
  }

  private settingsOf(id: string): LayerSettings {
    return this.project.layers?.find((l) => l.id === id) ?? { id };
  }

  private bindTracks(tracks: Record<string, any>, clock: LayerClock) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(tracks)) out[k] = bindTime(v, TIME_ARGS.track, clock.toWork);
    return out;
  }

  /** 合成結果をRGBA8(アルファで割った値、上の行から)で読む */
  readPixels(into?: Uint8Array) {
    return this.comp!.readPixels(into);
  }

  private drop(id: string) {
    const l = this.layers.get(id);
    if (!l) return;
    try {
      l.def.dispose?.(l.state);
    } catch (e) {
      log("warn", `dispose で例外: ${errorText(e)}`);
    }
    l.renderer.dispose();
    this.layers.delete(id);
  }

  private async loadLayer(info: LayerInfo, prev: Loaded | undefined): Promise<boolean> {
    const settings = this.settingsOf(info.id);
    const res = resolutionOf(settings);
    const w = Math.max(1, Math.round(this.project.width * res)), h = Math.max(1, Math.round(this.project.height * res));
    const clock = new LayerClock(this.fps);
    clock.set(settings, this.fps, this.project.duration);
    try {
      let def: any;
      let renderer: Renderer;
      if (info.kind === "isf") {
        const r = await fetch(info.url!);
        const body = await r.json();
        if (!r.ok || !body.ok) throw diagError(body);
        const isf = createIsf(body.source, body.meta, w, h);
        def = { mode: "pure", renderer: "shader", isf: body.meta, draw: ({ t, frame, p }: any) => isf.setUniforms(p, t, 1 / this.fps, frame) };
        renderer = isf;
      } else {
        // 変換エラーは診断のJSONで返ってくるので、importの前に確かめる
        const r = await fetch(info.url!);
        if (r.status === 422) throw diagError(await r.json());
        if (!r.ok) throw new Error(`${info.url}: ${r.status}`);
        const mod = await import(info.url!);
        def = mod.default;
        if (!def || typeof def.draw !== "function") throw new Error(`${info.sketch}: default export に defineSketch({ draw }) がない`);
        const kind = def.renderer ?? "canvas2d";
        // rendererの種類が同じならcanvasとコンテキストを使い回す
        const reuse = prev && prev.renderer.kind === kind && kind !== "p5" && prev.renderer.canvas.width === w && prev.renderer.canvas.height === h;
        renderer = reuse ? prev!.renderer : await createRenderer(kind, w, h, this.host);
      }
      const { entries: params, types } = resolveParams(def, info.params);
      let state: unknown;
      try {
        state = def.setup ? await def.setup({ width: w, height: h, p: evalParams(params, types, 0), assets: assetsApi(this.project, clock), g: renderer.g, canvas: renderer.canvas }) : undefined;
      } catch (e) {
        if (!prev || prev.renderer !== renderer) renderer.dispose();
        throw e;
      }
      // 新しいコードのsetupが通ってから古いほうを片付ける
      if (prev) {
        try {
          prev.def.dispose?.(prev.state);
        } catch (e) {
          log("warn", `dispose で例外: ${errorText(e)}`);
        }
        if (prev.renderer !== renderer) prev.renderer.dispose();
      }
      this.layers.set(info.id, { url: info.url!, def, renderer, state, params, types, tracks: this.bindTracks(makeTracks(def.tracks, info.tracks, this.fps), clock), failedAt: -1, clock, settings, resolution: res });
      post(`/declare?work=${encodeURIComponent(work)}&sketch=${encodeURIComponent(info.sketch)}`, JSON.stringify({
        mode: def.mode ?? "sequential", renderer: def.renderer ?? (info.kind === "isf" ? "shader" : "canvas2d"), params: declaredParams(def), tracks: def.tracks ?? null,
      })).catch(() => {});
      log("info", `${info.sketch} を読み込んだ`);
      return true;
    } catch (e) {
      const detail = e instanceof DiagnosticError ? e.message : errorText(e);
      log("error", `${info.sketch} を読み込めない。直前の正常なコードで描き続ける。\n${detail}`, { sketch: info.sketch });
      return false;
    }
  }

  /** CC割り当てを反映した params */
  private paramsAt(layer: string, base: Record<string, any>, t: number): Record<string, any> {
    const maps = this.ccMap.filter((m) => m.layer === layer);
    if (maps.length === 0) return base;
    const out = { ...base };
    for (const m of maps) {
      const live = this.liveCc.get(`${m.e.channel ?? "*"}:${m.e.cc}`) ?? this.liveCc.get(`*:${m.e.cc}`);
      const v = live ?? (m.track ? m.track.ccAt(m.e.cc, t, { channel: m.e.channel, init: NaN }) : NaN);
      if (Number.isFinite(v)) out[m.param] = (m.e.min ?? 0) + v * ((m.e.max ?? 1) - (m.e.min ?? 0));
    }
    return out;
  }

  /**
   * 1フレーム描いて合成する。先に全レイヤーのスケッチを下から順に描き(inputs.layer は自分より下のレイヤーだけ引ける)、
   * そのあとで変形・不透明度・ブレンド・マットをかけて重ねる
   */
  async render(frame: number) {
    const tw = frame / this.fps;
    advanceTo(tw * 1000);
    const { width, height } = this.project;
    const drawn = new Map<string, HTMLCanvasElement>();
    for (const id of this.order) {
      const l = this.layers.get(id);
      if (!l || !l.clock.active(frame)) continue;
      const lf = l.clock.layerFrame(frame);
      const lframe = Math.floor(lf + 1e-9);
      const t = lf / this.fps;
      seed(this.project.seed ?? 0, lframe);
      const p = this.paramsAt(id, evalParams(l.params, l.types, lf), tw);
      const toWork = l.clock.toWork;
      const inputs = {
        layer: (name: string): HTMLCanvasElement | null => {
          const c = drawn.get(name);
          if (!c && !this.warned.has(`${id}>${name}`)) {
            this.warned.add(`${id}>${name}`);
            log("warn", `レイヤー ${id}: inputs.layer("${name}") を引けない(自分より下にあり、今のフレームで出ているレイヤーだけ引ける)`);
          }
          return c ?? null;
        },
      };
      const ctx = {
        g: l.renderer.g, t, frame: lframe, width: l.renderer.canvas.width, height: l.renderer.canvas.height, p, rand, canvas: l.renderer.canvas,
        events: bindTime(this.events, TIME_ARGS.events, toWork), section: (name: string, x: number) => this.section(name, toWork(x)), beats: (x: number) => this.beats(toWork(x)),
        markers: this.markers, tracks: l.tracks, inputs,
      };
      try {
        await l.renderer.frame(() => l.def.draw(ctx, l.state));
        l.failedAt = -1;
      } catch (e) {
        if (l.failedAt < 0) log("error", `draw で例外(frame ${frame}): ${errorText(e)}`);
        l.failedAt = frame;
      }
      drawn.set(id, l.renderer.canvas);
    }
    const comp = this.comp!;
    comp.begin();
    const matteSources = new Set(this.order.map((id) => this.layers.get(id)?.settings.matte?.layer).filter(Boolean) as string[]);
    const place = (id: string) => {
      const l = this.layers.get(id)!;
      return { source: drawn.get(id)!, ...placement(l.settings, l.clock.layerFrame(frame), width, height) };
    };
    for (const id of this.order) {
      const l = this.layers.get(id);
      if (!l || !drawn.has(id) || l.settings.visible === false || matteSources.has(id)) continue;
      const m = l.settings.matte;
      const matte = m ? { placed: drawn.has(m.layer) && this.layers.has(m.layer) ? place(m.layer) : null, mode: m.mode ?? "alpha" } : undefined;
      comp.layer(place(id), l.settings.blend ?? "normal", matte);
    }
    comp.finish();
    this.lastFrame = frame;
  }

  private warned = new Set<string>();
}

/** 変換エラー。スタックは要らないので message だけを持つ */
class DiagnosticError extends Error {}

function diagError(body: any): Error {
  const d = (body?.diagnostics ?? []).map((x: any) => x.message).join("\n");
  return new DiagnosticError(d || "変換に失敗");
}

/** params宣言の既定値に、project.json の値({ value } か値そのもの)を重ねる。 */
const ISF_TYPES: Record<string, string> = { float: "float", long: "int", bool: "bool", event: "bool", point2d: "vec2", color: "rgba" };

/** params宣言の既定値に project.json の値(キーフレームつきのまま)を重ね、型の表と一緒に返す */
function resolveParams(def: any, overrides: Record<string, any>): { entries: Record<string, any>; types: Record<string, string> } {
  const entries: Record<string, any> = {};
  const types: Record<string, string> = {};
  for (const [k, v] of Object.entries<any>(def?.params ?? {})) {
    entries[k] = v?.default;
    types[k] = v?.type ?? "float";
  }
  if (def?.isf) {
    for (const i of def.isf.INPUTS ?? def.isf.inputs ?? []) {
      const name = i.NAME ?? i.name;
      if (!name) continue;
      if (entries[name] === undefined) entries[name] = i.DEFAULT ?? i.default;
      types[name] = ISF_TYPES[String(i.TYPE ?? i.type ?? "float").toLowerCase()] ?? "float";
    }
  }
  for (const [k, v] of Object.entries<any>(overrides ?? {})) entries[k] = v;
  return { entries, types };
}

/** UIとスキーマに渡すparams宣言。ISFの入力も同じ形(type・default・min・max)にそろえる */
function declaredParams(def: any): Record<string, any> | null {
  const out: Record<string, any> = { ...(def?.params ?? {}) };
  for (const i of def?.isf?.INPUTS ?? def?.isf?.inputs ?? []) {
    const name = i.NAME ?? i.name;
    if (!name || out[name]) continue;
    const type = ISF_TYPES[String(i.TYPE ?? i.type ?? "float").toLowerCase()];
    if (!type) continue; // image などはparamsにしない
    out[name] = { type, default: i.DEFAULT ?? i.default, min: i.MIN ?? i.min, max: i.MAX ?? i.max };
  }
  return Object.keys(out).length ? out : null;
}

/** フレーム(レイヤー時刻)での params の値 */
function evalParams(entries: Record<string, any>, types: Record<string, string>, frame: number): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(entries)) out[k] = evaluate(types[k] ?? "float", v, frame);
  return out;
}

function resolutionOf(s: LayerSettings): number {
  const r = Number(s.resolution ?? 1);
  return Number.isFinite(r) ? Math.max(0.1, Math.min(1, r)) : 1;
}

/** setupに渡す assets。音声とMIDIはレイヤー時刻で引けるように包む */
function assetsApi(project: ProjectInfo, clock: LayerClock) {
  const url = (rel: string) => `/work/${encodeURIComponent(work)}/files/assets/${rel}`;
  return {
    url,
    async image(rel: string) {
      const img = new Image();
      img.src = url(rel);
      await img.decode();
      return img;
    },
    async text(rel: string) {
      return (await fetch(url(rel))).text();
    },
    async json(rel: string) {
      return (await fetch(url(rel))).json();
    },
    /** 解析済みの音声。project.json の audio に同じファイルがあれば、その offset を作品時刻に反映する */
    async audio(rel: string) {
      const entry = (project.audio ?? []).find((a) => a.asset.replace(/^\.\//, "") === `assets/${rel}`);
      const offsetSec = entry ? (entry.offset ?? 0) * project.fps[1] / project.fps[0] : 0;
      return bindTime(await loadAudio(work, rel, offsetSec), TIME_ARGS.audio, clock.toWork);
    },
    /** MIDIファイル。offset は秒(作品時刻でのファイルの先頭) */
    async midi(rel: string, opts: { offset?: number } = {}) {
      return bindTime(await loadMidi(work, rel, opts.offset ?? 0), TIME_ARGS.midi, clock.toWork);
    },
    async font(family: string, rel: string) {
      const f = new FontFace(family, `url(${url(rel)})`);
      await f.load();
      document.fonts.add(f);
      await document.fonts.ready;
      return f;
    },
  };
}
