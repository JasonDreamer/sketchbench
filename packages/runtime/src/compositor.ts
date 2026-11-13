// レイヤーの合成(WebGL2)。各レイヤーのcanvasをテクスチャにして、変形・不透明度・ブレンドモード・トラックマットをかけて重ねる。
// 途中の結果はプリマルチプライドアルファで持ち、使えれば半精度浮動小数(RGBA16F)のテクスチャに溜める。
// フレームバッファの中は「行0が画面の上」として扱う(canvasから上げたテクスチャと同じ向き)。画面へ出すときだけ上下を返す。

export type Blend = "normal" | "add" | "multiply" | "screen" | "difference";
export type MatteMode = "alpha" | "alphaInverted" | "luma" | "lumaInverted";

const BLEND_ID: Record<Blend, number> = { normal: 0, add: 1, multiply: 2, screen: 3, difference: 4 };
const MATTE_ID: Record<MatteMode, number> = { alpha: 1, alphaInverted: 2, luma: 3, lumaInverted: 4 };

/** 出力のピクセル座標(上が0)からレイヤーのUV(0〜1)への変換。列優先の3x3 */
export type InvTransform = Float32Array;

export interface Placed {
  source: TexImageSource;
  inv: InvTransform;
  opacity: number;
}

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// レイヤー1枚を重ねる。uMode: 0 合成、1 置くだけ(マット用)
const FS_LAYER = `#version 300 es
precision highp float;
uniform sampler2D uDst;
uniform sampler2D uSrc;
uniform sampler2D uMatteTex;
uniform mat3 uInv;
uniform float uOpacity;
uniform int uBlend;
uniform int uMatte;
uniform int uMode;
out vec4 o;
void main() {
  vec2 P = gl_FragCoord.xy;
  vec2 uv = (uInv * vec3(P, 1.0)).xy;
  vec4 s = (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec4(0.0) : texture(uSrc, uv);
  s *= uOpacity;
  if (uMode == 1) { o = s; return; }
  if (uMatte > 0) {
    vec4 m = texelFetch(uMatteTex, ivec2(P), 0);
    float k = uMatte <= 2 ? m.a : clamp(dot(m.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    if (uMatte == 2 || uMatte == 4) k = 1.0 - k;
    s *= k;
  }
  vec4 d = texelFetch(uDst, ivec2(P), 0);
  if (uBlend == 1) { o = vec4(s.rgb + d.rgb, min(1.0, s.a + d.a)); return; }
  vec3 cs = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
  vec3 cb = d.a > 0.0 ? d.rgb / d.a : vec3(0.0);
  vec3 B = uBlend == 2 ? cs * cb : uBlend == 3 ? cs + cb - cs * cb : uBlend == 4 ? abs(cs - cb) : cs;
  o = vec4(s.rgb * (1.0 - d.a) + d.rgb * (1.0 - s.a) + s.a * d.a * B, s.a + d.a * (1.0 - s.a));
}`;

// 溜めた結果を画面へ(上下を返す)。uRead=1 のときはアルファで割って8bitの読み出し用にする
const FS_OUT = `#version 300 es
precision highp float;
uniform sampler2D uAcc;
uniform int uRead;
uniform vec2 uSize;
out vec4 o;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  if (uRead == 0) P.y = int(uSize.y) - 1 - P.y;
  vec4 c = texelFetch(uAcc, P, 0);
  c = clamp(c, 0.0, 1.0);
  if (uRead == 1) o = c.a > 0.0 ? vec4(c.rgb / c.a, c.a) : vec4(0.0);
  else o = c;
}`;

function compile(gl: WebGL2RenderingContext, fs: string): WebGLProgram {
  const prog = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`合成シェーダー: ${gl.getShaderInfoLog(s)}`);
    gl.attachShader(prog, s);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`合成シェーダー: ${gl.getProgramInfoLog(prog)}`);
  return prog;
}

type Target = { tex: WebGLTexture; fb: WebGLFramebuffer };

export class Compositor {
  readonly gl: WebGL2RenderingContext;
  /** 途中の結果を半精度浮動小数で持てるか */
  readonly float: boolean;
  private layerProg: WebGLProgram;
  private outProg: WebGLProgram;
  private acc: [Target, Target];
  private matte: Target;
  private read: Target;
  private src: WebGLTexture;
  private cur = 0;
  private u: Record<string, WebGLUniformLocation | null> = {};

  constructor(readonly canvas: HTMLCanvasElement, readonly width: number, readonly height: number) {
    canvas.width = width;
    canvas.height = height;
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error("WebGL2 を使えない");
    this.gl = gl;
    this.float = !!gl.getExtension("EXT_color_buffer_float");
    this.layerProg = compile(gl, FS_LAYER);
    this.outProg = compile(gl, FS_OUT);
    for (const n of ["uDst", "uSrc", "uMatteTex", "uInv", "uOpacity", "uBlend", "uMatte", "uMode"]) this.u[n] = gl.getUniformLocation(this.layerProg, n);
    for (const n of ["uAcc", "uRead", "uSize"]) this.u[`out.${n}`] = gl.getUniformLocation(this.outProg, n);
    this.acc = [this.target(this.float), this.target(this.float)];
    this.matte = this.target(this.float);
    this.read = this.target(false);
    this.src = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    this.params(gl.LINEAR);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
  }

  private params(filter: number) {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private target(float: boolean): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, float ? gl.RGBA16F : gl.RGBA8, this.width, this.height);
    this.params(gl.NEAREST);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb };
  }

  private clear(t: Target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private upload(source: TexImageSource) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  /** 透明で始める */
  begin() {
    this.cur = 0;
    this.clear(this.acc[0]);
  }

  /** 1枚重ねる。matte を渡すと、そのレイヤーを置いた結果のアルファか輝度で切り抜く(null は何もないマット) */
  layer(l: Placed, blend: Blend, matte?: { placed: Placed | null; mode: MatteMode }) {
    const gl = this.gl;
    gl.useProgram(this.layerProg);
    gl.uniform1i(this.u.uDst, 0);
    gl.uniform1i(this.u.uSrc, 1);
    gl.uniform1i(this.u.uMatteTex, 2);
    gl.uniform1i(this.u.uMatte, 0);
    if (matte) {
      // マットのレイヤーを出力の座標に置いておく(マットが今いなければ空のまま)
      this.clear(this.matte);
      if (matte.placed) {
        // 書き込み先(マット)をサンプラーに結んだままにしない(フィードバックループになる)
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.acc[this.cur].tex);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.read.tex);
        this.upload(matte.placed.source);
        gl.uniformMatrix3fv(this.u.uInv, false, matte.placed.inv);
        gl.uniform1f(this.u.uOpacity, matte.placed.opacity);
        gl.uniform1i(this.u.uMode, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.uniform1i(this.u.uMatte, MATTE_ID[matte.mode] ?? 1);
    }
    const from = this.acc[this.cur], to = this.acc[1 - this.cur];
    this.upload(l.source);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from.tex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.matte.tex);
    gl.uniformMatrix3fv(this.u.uInv, false, l.inv);
    gl.uniform1f(this.u.uOpacity, l.opacity);
    gl.uniform1i(this.u.uBlend, BLEND_ID[blend] ?? 0);
    gl.uniform1i(this.u.uMode, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, to.fb);
    gl.viewport(0, 0, this.width, this.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.cur = 1 - this.cur;
  }

  /** 画面(canvas)へ出す */
  finish() {
    const gl = this.gl;
    gl.useProgram(this.outProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.acc[this.cur].tex);
    gl.uniform1i(this.u["out.uAcc"], 0);
    gl.uniform1i(this.u["out.uRead"], 0);
    gl.uniform2f(this.u["out.uSize"], this.width, this.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** 合成結果をRGBA8(アルファで割った値、上の行から)で読む */
  readPixels(into?: Uint8Array): Uint8Array {
    const gl = this.gl;
    const out = into ?? new Uint8Array(this.width * this.height * 4);
    gl.useProgram(this.outProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.acc[this.cur].tex);
    gl.uniform1i(this.u["out.uAcc"], 0);
    gl.uniform1i(this.u["out.uRead"], 1);
    gl.uniform2f(this.u["out.uSize"], this.width, this.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.read.fb);
    gl.viewport(0, 0, this.width, this.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  dispose() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/**
 * 変形(位置・スケール・回転・アンカー)の逆変換。出力のピクセル P = position + R·S·(L − anchor)。
 * L はレイヤーの座標(出力と同じ大きさで測る。内部解像度は関係ない)。rotation は度で、時計回りが正
 */
export function inverseTransform(w: number, h: number, position: [number, number], scale: [number, number], rotation: number, anchor: [number, number]): InvTransform {
  const r = (rotation * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const nz = (v: number) => (Math.abs(v) < 1e-6 ? (v < 0 ? -1e-6 : 1e-6) : v);
  const sx = nz(scale[0]), sy = nz(scale[1]);
  // A = S⁻¹·R⁻¹
  const a00 = c / sx, a01 = s / sx, a10 = -s / sy, a11 = c / sy;
  const [px, py] = position, [ax, ay] = anchor;
  return new Float32Array([
    a00 / w, a10 / h, 0,
    a01 / w, a11 / h, 0,
    (ax - a00 * px - a01 * py) / w, (ay - a10 * px - a11 * py) / h, 1,
  ]);
}
