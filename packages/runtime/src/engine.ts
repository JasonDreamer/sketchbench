// レイヤーの読み込み・setup・描画と、出力canvasへの合成(合成は compositor.ts のWebGL2)。
// コード変更時は dispose() してから新しいコードで setup() する。新しいコードが失敗したら直前の正常なコードで描き続ける。

import { advanceTo } from "./clock.js";
import { errorText, log, post, work } from "./bridge.js";
import { rand, seed } from "./rand.js";
import { createIsf, createRenderer, type Renderer } from "./renderers.js";
import { loadAudio } from "./audio.js";
import { makeTracks } from "./tracks.js";
import { evaluate } from "./keyframes.js";
import { Compositor, type AlphaMode } from "./compositor.js";
import { FrameCache, hashText } from "./cache.js";
import { loadGlyphFont } from "./text.js";
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
  /** 読み込むたびに増える番号(キャッシュのキーに入れる) */
  gen: number;
  /** 描いてみて分かったこと: tracks の all() を使う、inputs.layer を使う(キャッシュのしかたが変わる) */
  flags: { allTracks: boolean; usesInputs: boolean };
  /** tracks の中身全体のハッシュ(all() を使うスケッチのキー) */
  tracksHash: string;
  /** 読み込みに使った情報(逐次スケッチを先頭からやり直すときに使う) */
  info: LayerInfo;
  /** project.json の params のハッシュ(保存点とキャッシュのキー) */
  paramsHash: string;
  /** stateful: setup が返した最初の状態の複製と、保存点 */
  sim: SimState | null;
  /** sequential: 最後に描いたレイヤーのフレーム(-1 はまだ描いていない) */
  seqFrame: number;
}

/** stateful の保存点。frame は状態がどのフレームまで進んだか(-1 は setup の直後) */
interface SimState {
  key: string;
  frame: number;
  saves: Map<number, unknown>;
  /** 保存点1つのおおよそのバイト数と、保存する間隔(フレーム) */
  bytes: number;
  interval: number;
}

/** 保存点の既定の間隔(秒)と、スケッチごとのメモリの上限 */
const SAVE_EVERY_SEC = 2;
const SAVE_BUDGET = 256 * 1024 * 1024;

export class Engine {
  project!: ProjectInfo;
  output: HTMLCanvasElement;
  comp: Compositor | null = null;
  /** 書き出しで出力の大きさを変えるとき(16:9 と 9:16 など)。project.json の width・height の代わりに使う */
  sizeOverride: { width: number; height: number } | null = null;
  /** プレビューキャッシュ(プレビューのときだけ。書き出しでは null) */
  cache: FrameCache | null = null;
  private cacheBudget = 0;
  /** ほかのレイヤーの inputs.layer で引かれるレイヤー(毎回描く) */
  private inputSources = new Set<string>();
  /** キャッシュから出したレイヤーを inputs.layer で引かれたので、描き直しが要る */
  needsRedraw = false;
  private gen = 0;
  /** 作品全体の設定(イベント・マーカー・BPM・音声・シード・大きさ)のハッシュ。変わったらキャッシュを全部捨てる */
  private globalKey = "";
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

  /** プレビューキャッシュを使う(バイト数の上限) */
  enableCache(budget: number) {
    this.cacheBudget = budget;
    if (this.comp) this.cache = new FrameCache(this.comp.gl, budget);
  }

  /** project.json と各スケッチを読み直す。変わったレイヤーだけ作り直す。 */
  async load(): Promise<boolean> {
    const res = await (await fetch(`/api/project?work=${encodeURIComponent(work)}`)).json();
    if (!res.ok) {
      log("error", `project.json を読めない: ${res.error}`);
      return false;
    }
    const p = res.project as ProjectInfo;
    if (this.sizeOverride) {
      p.width = this.sizeOverride.width;
      p.height = this.sizeOverride.height;
    }
    const sizeChanged = !this.project || p.width !== this.project.width || p.height !== this.project.height;
    this.project = p;
    if (sizeChanged) {
      // WebGLのコンテキストは大きさごとに作り直す(canvasごと替える)
      this.comp?.dispose();
      const c = document.createElement("canvas");
      this.host.replaceChild(c, this.output);
      this.output = c;
      this.comp = new Compositor(c, p.width, p.height);
      // テクスチャはコンテキストごとに消えるので、キャッシュも作り直す
      this.cache = this.cacheBudget > 0 ? new FrameCache(this.comp.gl, this.cacheBudget) : null;
      for (const id of [...this.layers.keys()]) this.drop(id);
    }
    const global = hashText(JSON.stringify([p.width, p.height, p.fps, p.seed, p.eventMap, p.markers, p.bpm, p.beatOffset, p.audio]));
    if (global !== this.globalKey) {
      this.globalKey = global;
      this.cache?.clear();
    }
    // 合成の設定やparamsが変わると揃っていたフレームも揃わなくなるので、印だけ外す(テクスチャは残し、キーが合えば使う)
    this.cache?.markAllIncomplete();
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
        cur.tracks = this.bindTracks(makeTracks(cur.def.tracks, info.tracks, this.fps), cur.clock, cur.flags);
        cur.tracksHash = hashText(JSON.stringify(info.tracks ?? null));
        cur.paramsHash = hashText(JSON.stringify(info.params ?? null));
        cur.info = info;
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

  private bindTracks(tracks: Record<string, any>, clock: LayerClock, flags: { allTracks: boolean }) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(tracks)) {
      // all() を使うスケッチは、どのクリップを変えても全フレームが変わりうる
      out[k] = { at: (t: number) => v.at(clock.toWork(t)), all: () => ((flags.allTracks = true), v.all()) };
    }
    return out;
  }

  /** キャッシュのキーに入れる、時刻 t(レイヤー時刻の秒)に有効なクリップ */
  private clipsKey(l: Loaded, t: number): string {
    if (!l.def.tracks) return "";
    if (l.flags.allTracks) return l.tracksHash;
    return JSON.stringify(Object.keys(l.tracks).map((k) => l.tracks[k].at(t)));
  }

  private modeOf(l: Loaded): "pure" | "stateful" | "sequential" {
    const m = l.def.mode ?? "sequential";
    // 状態を複製できない stateful は、逐次と同じく先頭から描き直す
    if (m === "stateful" && !l.sim) return "sequential";
    return m;
  }

  /** stateful: 状態をレイヤーのフレーム F まで進める(直前の保存点か今の状態から、近いほうで) */
  private async advanceSim(l: Loaded, id: string, F: number) {
    const sim = l.sim!;
    const key = `${l.gen}|${l.paramsHash}|${l.tracksHash}|${this.globalKey}`;
    if (sim.key !== key) {
      // 入力が変わったら保存点を全部捨てて、setup 直後の状態からやり直す
      const first = sim.saves.get(-1);
      sim.saves = new Map([[-1, first]]);
      sim.key = key;
      sim.frame = Infinity;
    }
    let best = -1;
    for (const f of sim.saves.keys()) if (f <= F && f > best) best = f;
    if (sim.frame > F || best > sim.frame) {
      l.state = structuredClone(sim.saves.get(best));
      sim.frame = best;
    }
    const fps = this.fps;
    for (let f = sim.frame + 1; f <= F; f++) {
      const t = f / fps;
      const toWork = l.clock.toWork;
      seed(this.project.seed ?? 0, f);
      const p = this.paramsAt(id, evalParams(l.params, l.types, f), toWork(t));
      const ctx = {
        t, frame: f, dt: 1 / fps, width: l.renderer.canvas.width, height: l.renderer.canvas.height, p, rand, tracks: l.tracks,
        events: bindTime(this.events, TIME_ARGS.events, toWork), section: (name: string, x: number) => this.section(name, toWork(x)), beats: (x: number) => this.beats(toWork(x)),
      };
      const r = l.def.simulate?.(l.state, ctx);
      if (r !== undefined) l.state = r;
      sim.frame = f;
      if (f % sim.interval === 0 && !sim.saves.has(f)) this.save(l, f);
    }
  }

  private save(l: Loaded, f: number) {
    const sim = l.sim!;
    sim.saves.set(f, structuredClone(l.state));
    if (!sim.bytes) sim.bytes = sizeOf(l.state);
    // 上限を超えたら間隔を倍にして、間の保存点を捨てる
    while ((sim.saves.size - 1) * sim.bytes > SAVE_BUDGET && sim.interval < 1e6) {
      sim.interval *= 2;
      for (const k of [...sim.saves.keys()]) if (k >= 0 && k % sim.interval !== 0) sim.saves.delete(k);
    }
  }

  /** sequential: 先頭からやり直す(setup をもう一度呼び、canvas も作り直す) */
  private async restart(id: string) {
    const l = this.layers.get(id);
    if (!l) return;
    await this.loadLayer(l.info, l, true);
  }

  /** sequential: レイヤーのフレーム f を描く(追いつくための途中のフレーム。合成はしない) */
  private async drawSequential(l: Loaded, id: string, f: number) {
    const t = f / this.fps;
    const toWork = l.clock.toWork;
    advanceTo(toWork(t) * 1000);
    seed(this.project.seed ?? 0, f);
    const p = this.paramsAt(id, evalParams(l.params, l.types, f), toWork(t));
    const ctx = {
      g: l.renderer.g, t, frame: f, width: l.renderer.canvas.width, height: l.renderer.canvas.height, p, rand, canvas: l.renderer.canvas,
      events: bindTime(this.events, TIME_ARGS.events, toWork), section: (name: string, x: number) => this.section(name, toWork(x)), beats: (x: number) => this.beats(toWork(x)),
      markers: this.markers, tracks: l.tracks, inputs: { layer: () => null },
    };
    try {
      await l.renderer.frame(() => l.def.draw(ctx, l.state));
    } catch (e) {
      if (l.failedAt < 0) log("error", `draw で例外(frame ${f}): ${errorText(e)}`);
      l.failedAt = f;
    }
    l.seqFrame = f;
  }

  /** 先に描いておく(プレビューで止まっているとき)。全レイヤーが pure か stateful のときだけ。描けたら true */
  async prerender(frame: number): Promise<boolean> {
    if (!this.cache || this.order.some((id) => { const l = this.layers.get(id); return !l || this.modeOf(l) === "sequential"; })) return false;
    await this.compose(frame, frame, false);
    return true;
  }

  /** 合成結果を上の行から読む(compositor.ts の readPixels) */
  readPixels(into?: Uint8Array, opts?: { depth?: 8 | 16; alpha?: AlphaMode }) {
    return this.comp!.readPixels(into, opts);
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
    this.cache?.dropLayer(id);
    this.inputSources.delete(id);
  }

  /** fresh: canvas を使い回さず、ログも出さない(逐次スケッチを先頭からやり直すとき) */
  private async loadLayer(info: LayerInfo, prev: Loaded | undefined, fresh = false): Promise<boolean> {
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
        const reuse = !fresh && prev && prev.renderer.kind === kind && kind !== "p5" && prev.renderer.canvas.width === w && prev.renderer.canvas.height === h;
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
      const flags = { allTracks: false, usesInputs: false };
      // stateful: setup 直後の状態を保存点 -1 にする。複製できなければ逐次と同じ扱い
      let sim: SimState | null = null;
      if (def.mode === "stateful") {
        try {
          sim = { key: "", frame: -1, saves: new Map([[-1, structuredClone(state)]]), bytes: 0, interval: Math.max(1, Math.round(SAVE_EVERY_SEC * this.fps)) };
        } catch (e) {
          log("error", `${info.sketch}: stateful の状態を複製できない(関数やクラスのインスタンスを入れず、オブジェクト・配列・型付き配列で持つ)。先頭から描き直す扱いにする。${errorText(e)}`);
        }
        if (sim && typeof def.simulate !== "function") log("warn", `${info.sketch}: mode が stateful なのに simulate がない`);
      }
      this.layers.set(info.id, {
        url: info.url!, def, renderer, state, params, types, tracks: this.bindTracks(makeTracks(def.tracks, info.tracks, this.fps), clock, flags), failedAt: -1, clock, settings, resolution: res,
        gen: ++this.gen, flags, tracksHash: hashText(JSON.stringify(info.tracks ?? null)), info, paramsHash: hashText(JSON.stringify(info.params ?? null)), sim, seqFrame: -1,
      });
      this.cache?.dropLayer(info.id);
      this.inputSources.delete(info.id);
      post(`/declare?work=${encodeURIComponent(work)}&sketch=${encodeURIComponent(info.sketch)}`, JSON.stringify({
        mode: def.mode ?? "sequential", renderer: def.renderer ?? (info.kind === "isf" ? "shader" : "canvas2d"), params: declaredParams(def), tracks: def.tracks ?? null,
      })).catch(() => {});
      if (!fresh) log("info", `${info.sketch} を読み込んだ`);
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
  async render(frame: number, blur?: { samples: number; shutter: number }) {
    const comp = this.comp!;
    if (blur && blur.samples > 1 && this.allPure()) {
      // AEと同じくフレームを中心に、シャッターが開いている間を等間隔に描いて平均する
      comp.blurBegin();
      for (let i = 0; i < blur.samples; i++) {
        await this.compose(frame, frame + blur.shutter * ((i + 0.5) / blur.samples - 0.5));
        comp.blurAdd(1 / blur.samples);
      }
      comp.blurEnd();
    } else {
      await this.compose(frame, frame);
    }
    comp.finish();
    this.lastFrame = frame;
  }

  /** モーションブラーは時刻だけで決まるスケッチでしかかけられない */
  private allPure(): boolean {
    const bad = this.order.filter((id) => (this.layers.get(id)?.def.mode ?? "sequential") !== "pure");
    if (bad.length && !this.warned.has("blur")) {
      this.warned.add("blur");
      log("warn", `モーションブラーをかけない: ${bad.join("、")} が pure ではない(状態を持つスケッチは1フレームの中の時刻を描き分けられない)`);
    }
    return bad.length === 0;
  }

  /**
   * frame(整数)で出ているレイヤーを、時刻 sub(モーションブラーでは小数)で描いて重ねる。画面へはまだ出さない。
   * composite=false は先描き(キャッシュに入れるだけで重ねない)
   */
  private async compose(frame: number, sub: number, composite = true) {
    // 逐次スケッチは飛ばしたフレームを順に描いて追いつく。戻るときは先頭からやり直す(時計を進める前に済ませる)
    if (sub === frame) {
      for (const id of this.order) {
        let l = this.layers.get(id);
        if (!l || !l.clock.active(frame) || this.modeOf(l) !== "sequential") continue;
        const F = Math.floor(l.clock.layerFrame(frame) + 1e-9);
        if (F < l.seqFrame) {
          await this.restart(id);
          l = this.layers.get(id)!;
        }
        for (let f = Math.max(0, l.seqFrame + 1); f < F; f++) await this.drawSequential(l, id, f);
      }
    }
    const tw = sub / this.fps;
    advanceTo(tw * 1000);
    const { width, height } = this.project;
    const comp = this.comp!;
    const drawn = new Map<string, HTMLCanvasElement>();
    /** キャッシュから出したか、描いてキャッシュに入れたテクスチャ */
    const textures = new Map<string, WebGLTexture>();
    const hits = new Set<string>();
    let complete = true;
    for (const id of this.order) {
      const l = this.layers.get(id);
      if (!l || !l.clock.active(frame)) continue;
      const mode = this.modeOf(l);
      const cacheable = !!this.cache && sub === frame && mode !== "sequential" && !l.flags.usesInputs && !this.inputSources.has(id);
      const lf = l.clock.layerFrame(sub);
      // 乱数のシードとスケッチの frame はフレームの整数で(モーションブラーの中で粒がちらつかないように)
      const lframe = Math.floor(l.clock.layerFrame(frame) + 1e-9);
      const t = lf / this.fps;
      seed(this.project.seed ?? 0, lframe);
      const p = this.paramsAt(id, evalParams(l.params, l.types, lf), tw);
      let key = "";
      if (cacheable) {
        key = `${id}|${l.gen}|${lf}|${lframe}|${JSON.stringify(p)}|${this.clipsKey(l, t)}|${this.globalKey}`;
        // stateful は、それまでの入力全体(params とクリップ)でも結果が変わる
        if (mode === "stateful") key += `|${l.paramsHash}|${l.tracksHash}`;
        const tex = this.cache!.get(key);
        if (tex) {
          textures.set(id, tex);
          hits.add(id);
          continue;
        }
      }
      if (mode === "sequential" && lframe === l.seqFrame) {
        // 同じフレームを2度描くと状態が進んでしまうので、描いてあるcanvasをそのまま使う
        drawn.set(id, l.renderer.canvas);
        complete = false;
        continue;
      }
      if (mode === "stateful") await this.advanceSim(l, id, lframe);
      const toWork = l.clock.toWork;
      const inputs = {
        layer: (name: string): HTMLCanvasElement | null => {
          l.flags.usesInputs = true;
          if (hits.has(name)) {
            // キャッシュから出したレイヤーはcanvasが今のフレームではない。以後は毎回描き、このフレームは描き直す
            this.inputSources.add(name);
            this.needsRedraw = true;
            return this.layers.get(name)!.renderer.canvas;
          }
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
      if (mode === "sequential") l.seqFrame = lframe;
      drawn.set(id, l.renderer.canvas);
      if (cacheable && l.failedAt < 0 && !l.flags.usesInputs) {
        const c = l.renderer.canvas;
        const tex = comp.capture(c);
        this.cache!.put(key, { tex, bytes: c.width * c.height * 4, layer: id, frame });
        textures.set(id, tex);
      } else {
        complete = false;
      }
    }
    if (this.cache && complete && sub === frame && !this.cache.complete.has(frame)) {
      this.cache.complete.add(frame);
      this.cache.changed = true;
    }
    if (!composite) return;
    comp.begin();
    const matteSources = new Set(this.order.map((id) => this.layers.get(id)?.settings.matte?.layer).filter(Boolean) as string[]);
    const place = (id: string) => {
      const l = this.layers.get(id)!;
      return { source: textures.get(id) ?? drawn.get(id)!, ...placement(l.settings, l.clock.layerFrame(sub), width, height) };
    };
    const has = (id: string) => textures.has(id) || drawn.has(id);
    for (const id of this.order) {
      const l = this.layers.get(id);
      if (!l || !has(id) || l.settings.visible === false || matteSources.has(id)) continue;
      const m = l.settings.matte;
      const matte = m ? { placed: has(m.layer) && this.layers.has(m.layer) ? place(m.layer) : null, mode: m.mode ?? "alpha" } : undefined;
      comp.layer(place(id), l.settings.blend ?? "normal", matte);
    }
  }

  private warned = new Set<string>();
}

/** 状態のおおよそのバイト数(保存点のメモリの見積もり) */
function sizeOf(v: unknown, seen = new Set<unknown>()): number {
  if (v === null || v === undefined) return 8;
  if (typeof v === "number" || typeof v === "boolean") return 8;
  if (typeof v === "string") return v.length * 2;
  if (typeof v !== "object" || seen.has(v)) return 8;
  seen.add(v);
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (v instanceof ArrayBuffer) return v.byteLength;
  let n = 16;
  if (v instanceof Map) for (const [k, x] of v) n += sizeOf(k, seen) + sizeOf(x, seen);
  else if (v instanceof Set) for (const x of v) n += sizeOf(x, seen);
  else for (const x of Object.values(v)) n += sizeOf(x, seen) + 8;
  return n;
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
    /** フォントファイルの輪郭と点列(文字モジュールの GlyphFont) */
    async glyphs(rel: string) {
      return loadGlyphFont(url(rel));
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
