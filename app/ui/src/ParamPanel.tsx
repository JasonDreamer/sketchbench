// パラメータパネル。スケッチのparams宣言からTweakpaneの入力欄を作り、キーフレームを打つ。
// 値の正は project.json(Rustコア)なので、ここは操作を送るだけ。表示は現在フレームで評価した値。
import { createEffect, on, onCleanup, onMount } from "solid-js";
import { Pane } from "tweakpane";
import { evaluate, isKeyed } from "../../../packages/runtime/src/keyframes";
import type { ProjectLike } from "./timeline-model";

type KeyMsg = { key: string; code: string; shift: boolean; ctrl: boolean; alt?: boolean };
export type ParamApi = { key(k: KeyMsg): boolean };

type Row = {
  layer: string;
  name: string;
  type: string;
  obj: Record<string, unknown>;
  binding: any;
  keyBtn: HTMLButtonElement;
};

/** キーフレームを打てる型(それ以外の型はキーを打っても次のキーまで値を保つ) */
const SUPPORTED = new Set(["float", "int", "bool", "color", "vec2", "rgba", "enum", "text"]);

const toUi = (type: string, v: unknown): unknown => {
  if (type === "vec2") {
    const a = Array.isArray(v) ? v : [0, 0];
    return { x: Number(a[0] ?? 0), y: Number(a[1] ?? 0) };
  }
  if (type === "rgba") {
    const a = Array.isArray(v) ? v : [0, 0, 0, 1];
    return { r: Number(a[0] ?? 0), g: Number(a[1] ?? 0), b: Number(a[2] ?? 0), a: Number(a[3] ?? 1) };
  }
  if (type === "bool") return !!v;
  if (type === "float" || type === "int") return Number(v ?? 0);
  return v ?? "";
};

const fromUi = (type: string, v: any): unknown => {
  if (type === "vec2") return [v.x, v.y];
  if (type === "rgba") return [v.r, v.g, v.b, v.a];
  if (type === "int") return Math.round(v);
  return v;
};

export function ParamPanel(props: {
  project: ProjectLike;
  decls: Record<string, any>;
  frame: () => number;
  edit: (op: Record<string, unknown>) => Promise<any>;
  status: (s: string) => void;
  api: (a: ParamApi) => void;
}) {
  let host!: HTMLDivElement;
  let pane: Pane | null = null;
  let rows: Row[] = [];
  let shape = "";
  let hovered: Row | null = null;
  let syncing = false;
  let dragging = false;
  let lastFrame = -1;

  const entry = (r: { layer: string; name: string }) =>
    (props.project.layers.find((l) => l.id === r.layer) as any)?.params?.[r.name];
  const declOf = (r: { layer: string; name: string }) => {
    const sketch = props.project.layers.find((l) => l.id === r.layer)?.sketch ?? "";
    return props.decls?.[sketch]?.params?.[r.name] ?? {};
  };
  const typeOf = (d: any) => (Array.isArray(d.options) ? "enum" : String(d.type ?? "float"));
  /** 現在フレームの値。project.json に無ければ宣言の既定値 */
  const valueAt = (r: Row, frame: number) => {
    const e = entry(r);
    const v = e === undefined ? declOf(r).default : evaluate(r.type === "enum" ? "text" : r.type, e, frame);
    return toUi(r.type, v);
  };
  const keysOf = (r: Row): any[] => {
    const e = entry(r);
    return isKeyed(e) ? ((e as any).keys ?? []) : [];
  };

  const setKey = (r: Row, value: unknown) =>
    props.edit({ op: "setKey", target: { layer: r.layer, param: r.name }, frame: props.frame(), value });
  const deleteKey = (r: Row) => props.edit({ op: "deleteKey", target: { layer: r.layer, param: r.name }, frame: props.frame() });

  /** 値を変えたとき: キーがあれば現在フレームにキーを打ち、なければ値そのものを変える(AEと同じ) */
  const commit = (r: Row, value: unknown) => {
    if (keysOf(r).length > 0) setKey(r, value);
    else props.edit({ op: "setParam", layer: r.layer, name: r.name, value });
  };

  const toggleKey = (r: Row) => {
    const f = props.frame();
    if (keysOf(r).some((k) => k.frame === f)) deleteKey(r);
    else setKey(r, fromUi(r.type, r.obj[r.name]));
  };

  const build = () => {
    pane?.dispose();
    rows = [];
    hovered = null;
    pane = new Pane({ container: host });
    for (const l of props.project.layers) {
      const params = Object.entries<any>(props.decls?.[l.sketch]?.params ?? {});
      if (params.length === 0) continue;
      const folder = pane.addFolder({ title: `${l.id}  ${l.sketch.replace(/^sketches\//, "")}` });
      for (const [name, d] of params) {
        const type = typeOf(d);
        if (!SUPPORTED.has(type)) continue;
        const obj: Record<string, unknown> = {};
        const r = { layer: l.id, name, type, obj } as Row;
        obj[name] = valueAt(r, props.frame());
        const opts: Record<string, unknown> = { label: name };
        if (type === "float" || type === "int") {
          if (d.min !== undefined) opts.min = d.min;
          if (d.max !== undefined) opts.max = d.max;
          if (type === "int") opts.step = 1;
          else if (d.step !== undefined) opts.step = d.step;
        } else if (type === "enum") {
          opts.options = Object.fromEntries((d.options as unknown[]).map((o) => [String(o), o]));
        } else if (type === "text") {
          opts.view = "text";
        } else if (type === "rgba") {
          opts.color = { type: "float" };
        } else if (type === "vec2") {
          const axis = { ...(d.min !== undefined ? { min: d.min } : {}), ...(d.max !== undefined ? { max: d.max } : {}) };
          opts.x = axis;
          opts.y = axis;
        }
        r.binding = folder.addBinding(obj, name, opts);
        r.binding.on("change", (ev: { last: boolean }) => {
          if (syncing || !ev.last) return;
          commit(r, fromUi(type, obj[name]));
        });
        const el: HTMLElement = r.binding.element;
        el.addEventListener("mouseenter", () => (hovered = r));
        el.addEventListener("mouseleave", () => hovered === r && (hovered = null));
        // ラベルの左にキーフレームの印(◆: このフレームにキー、◇: 別のフレームにキー)
        const btn = document.createElement("button");
        btn.className = "kf";
        btn.type = "button";
        btn.addEventListener("click", () => toggleKey(r));
        el.querySelector(".tp-lblv_l")?.prepend(btn);
        r.keyBtn = btn;
        rows.push(r);
      }
    }
    if (rows.length === 0) host.dataset.empty = "1";
    else delete host.dataset.empty;
    lastFrame = -1;
    sync();
  };

  /** 現在フレームの値とキーの印を入力欄に反映する(操作中の欄は触らない) */
  const sync = () => {
    const f = props.frame();
    syncing = true;
    for (const r of rows) {
      const keys = keysOf(r);
      const onKey = keys.some((k) => k.frame === f);
      r.keyBtn.dataset.state = onKey ? "on" : keys.length ? "keyed" : "none";
      r.keyBtn.title = onKey ? "このフレームのキーを消す(Alt+I)" : "このフレームにキーを打つ(I)";
      r.keyBtn.setAttribute("aria-label", `${r.layer}.${r.name}: ${r.keyBtn.title}`);
      const el: HTMLElement = r.binding.element;
      if (dragging || el.contains(document.activeElement)) continue;
      r.obj[r.name] = valueAt(r, f);
      r.binding.refresh();
    }
    syncing = false;
    lastFrame = f;
  };

  onMount(() => {
    const down = () => (dragging = true);
    const up = () => {
      dragging = false;
      lastFrame = -1;
    };
    host.addEventListener("pointerdown", down);
    addEventListener("pointerup", up);
    onCleanup(() => {
      removeEventListener("pointerup", up);
      pane?.dispose();
    });
    props.api({
      key(k) {
        if (!hovered || k.ctrl || (k.key !== "i" && k.key !== "I")) return false;
        if (k.alt) {
          if (keysOf(hovered).some((x) => x.frame === props.frame())) deleteKey(hovered);
          else props.status(`${hovered.layer}.${hovered.name} のこのフレームにキーはない`);
        } else setKey(hovered, fromUi(hovered.type, hovered.obj[hovered.name]));
        return true;
      },
    });
  });

  // レイヤーやparams宣言が変わったら作り直し、値だけの変更なら入れ直す
  createEffect(
    on(
      () => [props.project, props.decls] as const,
      () => {
        const next = JSON.stringify(props.project.layers.map((l) => [l.id, l.sketch, props.decls?.[l.sketch]?.params ?? null]));
        if (next !== shape) {
          shape = next;
          build();
        } else {
          lastFrame = -1;
          sync();
        }
      },
    ),
  );
  // フレームが変わったら評価し直す(キーのあるparamsの値が動く)
  createEffect(() => {
    const f = props.frame();
    if (f !== lastFrame && rows.length) sync();
  });

  return (
    <div class="params" ref={host}>
      <div class="hint params-empty">スケッチで params を宣言すると、ここに入力欄が出ます。</div>
    </div>
  );
}
