// レンダラー: スケッチの g(描画コンテキスト)と canvas を用意する。
// canvas2d / webgl / p5 / shader(ISF)。three・html・hydra は後のフェーズ。

import { advanceTo, now } from "./clock.js";

export interface Renderer {
  kind: string;
  canvas: HTMLCanvasElement;
  g: any;
  /** 1フレーム描く。drawはスケッチのdraw(gを使う) */
  frame(draw: () => unknown): Promise<void>;
  dispose(): void;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export async function createRenderer(kind: string, w: number, h: number, host: HTMLElement): Promise<Renderer> {
  switch (kind) {
    case "canvas2d": {
      const canvas = makeCanvas(w, h);
      const g = canvas.getContext("2d", { alpha: true })!;
      return { kind, canvas, g, async frame(draw) { await draw(); }, dispose() {} };
    }
    case "webgl": {
      const canvas = makeCanvas(w, h);
      const g = canvas.getContext("webgl2", { preserveDrawingBuffer: true, premultipliedAlpha: true, antialias: true })!;
      return {
        kind, canvas, g,
        async frame(draw) { await draw(); },
        dispose() { g.getExtension("WEBGL_lose_context")?.loseContext(); },
      };
    }
    case "p5":
      return createP5(w, h, host);
    default:
      throw new Error(`未対応のrenderer: ${kind}(フェーズ1は canvas2d・webgl・p5・shader)`);
  }
}

/** p5はインスタンスモードで作り、noLoop() と redraw() で1フレームずつ駆動する。 */
async function createP5(w: number, h: number, host: HTMLElement): Promise<Renderer> {
  const mod: any = await import("p5");
  const P5 = mod.default ?? mod;
  const holder = document.createElement("div");
  holder.style.display = "none";
  host.appendChild(holder);
  let current: (() => unknown) | null = null;
  let ready = false;
  const inst = new P5((p: any) => {
    p.setup = () => {
      p.pixelDensity(1);
      p.createCanvas(w, h);
      p.noLoop();
      ready = true;
    };
    p.draw = () => current?.();
  }, holder);
  // p5の初期化は仮想時計のrAFやタイマーを使うことがあるので、時刻を止めたまま流す
  for (let i = 0; i < 500 && !ready; i++) {
    advanceTo(now());
    await new Promise((r) => queueMicrotask(() => r(null)));
    if (!ready) await Promise.resolve();
  }
  if (!ready) throw new Error("p5の setup が終わらない");
  const canvas: HTMLCanvasElement = inst.canvas ?? holder.querySelector("canvas");
  return {
    kind: "p5", canvas, g: inst,
    async frame(draw) {
      let err: unknown = null;
      current = () => {
        try {
          return draw();
        } catch (e) {
          err = e;
        }
      };
      await inst.redraw();
      current = null;
      if (err) throw err;
    },
    dispose() {
      inst.remove();
      holder.remove();
    },
  };
}

// ---------------------------------------------------------------- ISF(シェーダーモード)

export interface IsfInput { name: string; type: string; default?: any; min?: any; max?: any }

/** isfクレートが出したメタデータの入力を、名前と型だけの形にそろえる。 */
export function isfInputs(meta: any): IsfInput[] {
  const raw: any[] = meta?.inputs ?? meta?.INPUTS ?? [];
  return raw.map((i) => {
    const name = i.NAME ?? i.name;
    const type = String(i.TYPE ?? i.type ?? i.ty ?? "float").toLowerCase();
    const inner = typeof i.ty === "object" ? Object.values(i.ty)[0] as any : i;
    return { name, type: typeof i.ty === "object" ? Object.keys(i.ty)[0].toLowerCase() : type, default: inner?.DEFAULT ?? inner?.default, min: inner?.MIN ?? inner?.min, max: inner?.MAX ?? inner?.max };
  });
}

const GLSL_TYPE: Record<string, string> = { float: "float", bool: "bool", event: "bool", long: "int", color: "vec4", point2d: "vec2" };

export function createIsf(source: string, meta: any, w: number, h: number): Renderer & { setUniforms(v: Record<string, any>, time: number, delta: number, frame: number): void } {
  const canvas = makeCanvas(w, h);
  const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, premultipliedAlpha: false })!;
  const inputs = isfInputs(meta);
  const unsupported = inputs.filter((i) => !GLSL_TYPE[i.type]).map((i) => `${i.name}(${i.type})`);
  if (unsupported.length) throw new Error(`この入力型はフェーズ1では未対応: ${unsupported.join(", ")}`);
  if ((meta?.passes ?? meta?.PASSES ?? []).length > 1) throw new Error("複数パスのISFはフェーズ1では未対応");
  const body = source.replace(/^\s*\/\*[\s\S]*?\*\//, "");
  const frag = `#version 300 es
precision highp float;
precision highp int;
uniform float TIME;
uniform float TIMEDELTA;
uniform int FRAMEINDEX;
uniform int PASSINDEX;
uniform vec2 RENDERSIZE;
uniform vec4 DATE;
${inputs.map((i) => `uniform ${GLSL_TYPE[i.type]} ${i.name};`).join("\n")}
in vec2 isf_FragNormCoord;
out vec4 sb_FragColor;
#define gl_FragColor sb_FragColor
#define texture2D texture
${body}`;
  const vert = `#version 300 es
out vec2 isf_FragNormCoord;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  isf_FragNormCoord = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("GLSLのコンパイルエラー:\n" + gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vert));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("GLSLのリンクエラー:\n" + gl.getProgramInfoLog(prog));
  const loc = (n: string) => gl.getUniformLocation(prog, n);
  return {
    kind: "shader", canvas, g: gl,
    setUniforms(values, time, delta, frame) {
      gl.useProgram(prog);
      gl.uniform1f(loc("TIME"), time);
      gl.uniform1f(loc("TIMEDELTA"), delta);
      gl.uniform1i(loc("FRAMEINDEX"), frame);
      gl.uniform1i(loc("PASSINDEX"), 0);
      gl.uniform2f(loc("RENDERSIZE"), w, h);
      for (const i of inputs) {
        const v = values[i.name] ?? i.default;
        const l = loc(i.name);
        if (l == null || v == null) continue;
        switch (i.type) {
          case "float": gl.uniform1f(l, Number(v)); break;
          case "long": gl.uniform1i(l, Number(v) | 0); break;
          case "bool": case "event": gl.uniform1i(l, v ? 1 : 0); break;
          case "point2d": gl.uniform2f(l, v[0], v[1]); break;
          case "color": {
            const c = typeof v === "string" ? hexToRgba(v) : v;
            gl.uniform4f(l, c[0], c[1], c[2], c[3] ?? 1);
            break;
          }
        }
      }
    },
    async frame(draw) {
      await draw(); // uniformを設定する
      gl.viewport(0, 0, w, h);
      gl.useProgram(prog);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() { gl.getExtension("WEBGL_lose_context")?.loseContext(); },
  };
}

export function hexToRgba(hex: string): number[] {
  const m = hex.replace("#", "");
  const n = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const v = [0, 2, 4, 6].map((i) => (i < n.length ? parseInt(n.slice(i, i + 2), 16) / 255 : 1));
  return v;
}
