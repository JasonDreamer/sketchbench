// レイヤーの読み込み・setup・描画と、出力canvasへの合成。
// コード変更時は dispose() してから新しいコードで setup() する。新しいコードが失敗したら直前の正常なコードで描き続ける。

import { advanceTo } from "./clock.js";
import { errorText, log, post, work } from "./bridge.js";
import { rand, seed } from "./rand.js";
import { createIsf, createRenderer, type Renderer } from "./renderers.js";

export interface ProjectInfo {
  width: number;
  height: number;
  fps: [number, number];
  duration: number;
  seed?: number;
}

interface LayerInfo {
  id: string;
  sketch: string;
  kind: "ts" | "isf" | "missing";
  url?: string;
  params: Record<string, any>;
}

interface Loaded {
  url: string;
  def: any;
  renderer: Renderer;
  state: unknown;
  params: Record<string, any>;
  failedAt: number;
}

export class Engine {
  project!: ProjectInfo;
  output: HTMLCanvasElement;
  out2d: CanvasRenderingContext2D;
  layers = new Map<string, Loaded>();
  order: string[] = [];
  host: HTMLElement;
  lastFrame = -1;
  rev = 0;

  constructor(host: HTMLElement) {
    this.host = host;
    this.output = document.createElement("canvas");
    this.out2d = this.output.getContext("2d", { alpha: true })!;
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
      this.output.width = p.width;
      this.output.height = p.height;
      for (const id of [...this.layers.keys()]) this.drop(id);
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
      if (cur && cur.url === info.url) {
        cur.params = resolveParams(cur.def, info.params);
        continue;
      }
      ok = (await this.loadLayer(info, cur)) && ok;
    }
    this.lastFrame = -1;
    return ok;
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
    const { width: w, height: h } = this.project;
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
        renderer = prev && prev.renderer.kind === kind && kind !== "p5" ? prev.renderer : await createRenderer(kind, w, h, this.host);
      }
      const params = resolveParams(def, info.params);
      let state: unknown;
      try {
        state = def.setup ? await def.setup({ width: w, height: h, p: params, assets: assetsApi(), g: renderer.g, canvas: renderer.canvas }) : undefined;
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
      this.layers.set(info.id, { url: info.url!, def, renderer, state, params, failedAt: -1 });
      post(`/declare?work=${encodeURIComponent(work)}&sketch=${encodeURIComponent(info.sketch)}`, JSON.stringify({
        mode: def.mode ?? "sequential", renderer: def.renderer ?? (info.kind === "isf" ? "shader" : "canvas2d"), params: def.params ?? null, tracks: def.tracks ?? null,
      })).catch(() => {});
      log("info", `${info.sketch} を読み込んだ`);
      return true;
    } catch (e) {
      const detail = e instanceof DiagnosticError ? e.message : errorText(e);
      log("error", `${info.sketch} を読み込めない。直前の正常なコードで描き続ける。\n${detail}`, { sketch: info.sketch });
      return false;
    }
  }

  /** 1フレーム描いて出力canvasに合成する。 */
  async render(frame: number) {
    const t = frame / this.fps;
    advanceTo(t * 1000);
    const { width, height } = this.project;
    this.out2d.clearRect(0, 0, width, height);
    for (const id of this.order) {
      const l = this.layers.get(id);
      if (!l) continue;
      seed(this.project.seed ?? 0, frame);
      try {
        await l.renderer.frame(() => l.def.draw({ g: l.renderer.g, t, frame, width, height, p: l.params, rand, canvas: l.renderer.canvas }, l.state));
        l.failedAt = -1;
      } catch (e) {
        if (l.failedAt < 0) log("error", `draw で例外(frame ${frame}): ${errorText(e)}`);
        l.failedAt = frame;
      }
      this.out2d.drawImage(l.renderer.canvas, 0, 0, width, height);
    }
    this.lastFrame = frame;
  }
}

/** 変換エラー。スタックは要らないので message だけを持つ */
class DiagnosticError extends Error {}

function diagError(body: any): Error {
  const d = (body?.diagnostics ?? []).map((x: any) => x.message).join("\n");
  return new DiagnosticError(d || "変換に失敗");
}

/** params宣言の既定値に、project.json の値({ value } か値そのもの)を重ねる。 */
function resolveParams(def: any, overrides: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  const decl = def?.params ?? {};
  for (const [k, v] of Object.entries<any>(decl)) out[k] = v?.default;
  if (def?.isf) {
    for (const i of def.isf.INPUTS ?? def.isf.inputs ?? []) {
      const name = i.NAME ?? i.name;
      if (name && out[name] === undefined) out[name] = i.DEFAULT ?? i.default;
    }
  }
  for (const [k, v] of Object.entries<any>(overrides ?? {})) out[k] = v && typeof v === "object" && "value" in v ? v.value : v;
  return out;
}

/** フェーズ1のassetsは作品フォルダのファイルを読むだけ。音声・MIDIの解析はフェーズ2。 */
function assetsApi() {
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
    async font(family: string, rel: string) {
      const f = new FontFace(family, `url(${url(rel)})`);
      await f.load();
      document.fonts.add(f);
      await document.fonts.ready;
      return f;
    },
  };
}
