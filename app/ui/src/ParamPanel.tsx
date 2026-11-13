// パラメータパネル。レイヤーごとに、合成の設定と、スケッチのparams宣言から作った入力欄をTweakpaneで出し、キーフレームを打つ。
// 値の正は project.json(Rustコア)なので、ここは操作を送るだけ。表示は現在フレームで評価した値。
// paramsと合成の値のキーはレイヤーのフレームで持つ(作品のフレームとは開始・オフセット・速度の分ずれる)。
import { createEffect, on, onCleanup, onMount } from "solid-js";
import { Pane } from "tweakpane";
import { evaluate, isKeyed } from "../../../packages/runtime/src/keyframes";
import { layerFrame, propOf, type LayerLike, type ProjectLike } from "./timeline-model";

type KeyMsg = { key: string; code: string; shift: boolean; ctrl: boolean; alt?: boolean };
export type ParamApi = { key(k: KeyMsg): boolean };

type Row = {
  layer: string;
  /** 表示名とTweakpaneのキー */
  name: string;
  type: string;
  obj: Record<string, unknown>;
  binding: any;
  /** キーを打てるなら、その対象(params か合成の値) */
  target: { param: string } | { property: string } | null;
  /** project.json の今の値(キーつきのまま) */
  entry(): unknown;
  /** 宣言の既定値 */
  fallback: unknown;
  /** キーがないときに値そのものを変える操作 */
  set(value: unknown): Record<string, unknown>;
  keyBtn: HTMLButtonElement | null;
};

/** キーフレームを打てる型(数値・vec2・色は補間、ほかは次のキーまで保持) */
const SUPPORTED = new Set(["float", "int", "bool", "color", "vec2", "rgba", "enum", "text"]);
const BLENDS = { 通常: "normal", 加算: "add", 乗算: "multiply", スクリーン: "screen", 差分: "difference" };
const MATTE_MODES = { アルファ: "alpha", "アルファ反転": "alphaInverted", 輝度: "luma", 輝度反転: "lumaInverted" };

const toUi = (type: string, v: unknown): unknown => {
  if (type === "vec2") {
    const a = Array.isArray(v) ? v : typeof v === "number" ? [v, v] : [0, 0];
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

  const layerOf = (id: string): LayerLike | undefined => props.project.layers.find((l) => l.id === id);
  /** そのレイヤーのフレーム(キーの位置)。小数は丸める */
  const lframe = (r: { layer: string }) => {
    const l = layerOf(r.layer);
    return l ? Math.round(layerFrame(l, props.frame())) : props.frame();
  };
  const evalType = (r: Row) => (r.type === "enum" ? "text" : r.type);
  const valueAt = (r: Row) => {
    const e = r.entry();
    const v = e === undefined ? r.fallback : evaluate(evalType(r), e, lframe(r));
    return toUi(r.type, v === undefined ? r.fallback : v);
  };
  const keysOf = (r: Row): any[] => {
    const e = r.entry();
    return r.target && isKeyed(e) ? ((e as any).keys ?? []) : [];
  };
  const keyTarget = (r: Row) => ({ layer: r.layer, ...r.target });
  const setKey = (r: Row, value: unknown) => props.edit({ op: "setKey", target: keyTarget(r), frame: lframe(r), value });
  const deleteKey = (r: Row) => props.edit({ op: "deleteKey", target: keyTarget(r), frame: lframe(r) });

  /** 値を変えたとき: キーがあれば現在フレームにキーを打ち、なければ値そのものを変える(AEと同じ) */
  const commit = (r: Row, value: unknown) => {
    if (keysOf(r).length > 0) setKey(r, value);
    else props.edit(r.set(value));
  };
  const toggleKey = (r: Row) => {
    if (keysOf(r).some((k) => k.frame === lframe(r))) deleteKey(r);
    else setKey(r, fromUi(r.type, r.obj[r.name]));
  };

  const add = (folder: any, r: Omit<Row, "obj" | "binding" | "keyBtn">, opts: Record<string, unknown>) => {
    const obj: Record<string, unknown> = {};
    const row = { ...r, obj, binding: null, keyBtn: null } as Row;
    obj[r.name] = valueAt(row);
    row.binding = folder.addBinding(obj, r.name, opts);
    row.binding.on("change", (ev: { last: boolean }) => {
      if (syncing || !ev.last) return;
      commit(row, fromUi(row.type, obj[r.name]));
    });
    const el: HTMLElement = row.binding.element;
    if (r.target) {
      el.addEventListener("mouseenter", () => (hovered = row));
      el.addEventListener("mouseleave", () => hovered === row && (hovered = null));
      // ラベルの左にキーフレームの印(◆: このフレームにキー、◇: 別のフレームにキー)
      const btn = document.createElement("button");
      btn.className = "kf";
      btn.type = "button";
      btn.addEventListener("click", () => toggleKey(row));
      el.querySelector(".tp-lblv_l")?.prepend(btn);
      row.keyBtn = btn;
    }
    rows.push(row);
  };

  /** 合成の設定の欄 */
  const layerRows = (folder: any, l: LayerLike) => {
    const W = props.project.width ?? 1920, H = props.project.height ?? 1080;
    const id = l.id;
    const upd = (key: string, value: unknown) => ({ op: "updateLayer", layer: id, set: { [key]: value } });
    const updTransform = (key: string) => (value: unknown) => ({ op: "updateLayer", layer: id, set: { transform: { ...(layerOf(id)?.transform ?? {}), [key]: value } } });
    const f = folder.addFolder({ title: "レイヤー", expanded: false });
    add(f, { layer: id, name: "ブレンド", type: "enum", target: null, entry: () => layerOf(id)?.blend, fallback: "normal", set: (v) => upd("blend", v) }, { options: BLENDS });
    add(f, { layer: id, name: "不透明度", type: "float", target: { property: "opacity" }, entry: () => layerOf(id)?.opacity, fallback: 1, set: (v) => upd("opacity", v) }, { min: 0, max: 1, step: 0.01 });
    add(f, { layer: id, name: "位置", type: "vec2", target: { property: "transform.position" }, entry: () => propOf(layerOf(id)!, "transform.position"), fallback: [W / 2, H / 2], set: updTransform("position") }, {});
    // scale は数値(縦横同じ)で持っていれば数値の欄、[x, y] なら2つの欄
    const sc = propOf(l, "transform.scale");
    const scRaw = isKeyed(sc) ? (sc as any).value : sc;
    add(f, { layer: id, name: "スケール", type: Array.isArray(scRaw) ? "vec2" : "float", target: { property: "transform.scale" }, entry: () => propOf(layerOf(id)!, "transform.scale"), fallback: 1, set: updTransform("scale") }, { step: 0.01 });
    add(f, { layer: id, name: "回転", type: "float", target: { property: "transform.rotation" }, entry: () => propOf(layerOf(id)!, "transform.rotation"), fallback: 0, set: updTransform("rotation") }, { step: 0.1 });
    add(f, { layer: id, name: "アンカー", type: "vec2", target: { property: "transform.anchor" }, entry: () => propOf(layerOf(id)!, "transform.anchor"), fallback: [W / 2, H / 2], set: updTransform("anchor") }, {});
    add(f, { layer: id, name: "オフセット", type: "int", target: null, entry: () => layerOf(id)?.offset, fallback: 0, set: (v) => upd("offset", v) }, { step: 1 });
    add(f, { layer: id, name: "速度", type: "float", target: null, entry: () => layerOf(id)?.speed, fallback: 1, set: (v) => upd("speed", v || 1) }, { step: 0.01 });
    add(f, { layer: id, name: "内部解像度", type: "float", target: null, entry: () => layerOf(id)?.resolution, fallback: 1, set: (v) => upd("resolution", v) }, { min: 0.1, max: 1, step: 0.05 });
    add(f, { layer: id, name: "表示", type: "bool", target: null, entry: () => layerOf(id)?.visible, fallback: true, set: (v) => upd("visible", v ? null : false) }, {});
    // マット: 「なし」か、ほかのレイヤーと種類
    const others = Object.fromEntries([["なし", ""], ...props.project.layers.filter((x) => x.id !== id).map((x) => [x.id, x.id])]);
    add(f, { layer: id, name: "マット", type: "enum", target: null, entry: () => layerOf(id)?.matte?.layer ?? "", fallback: "", set: (v) => upd("matte", v ? { layer: v, mode: layerOf(id)?.matte?.mode ?? "alpha" } : null) }, { options: others });
    add(f, { layer: id, name: "マットの種類", type: "enum", target: null, entry: () => layerOf(id)?.matte?.mode ?? "alpha", fallback: "alpha", set: (v) => upd("matte", layerOf(id)?.matte ? { ...layerOf(id)!.matte!, mode: v } : null) }, { options: MATTE_MODES });
    // 重ね順と削除
    const n = props.project.layers.length;
    const i = props.project.layers.findIndex((x) => x.id === id);
    f.addButton({ title: "ひとつ上へ" }).on("click", () => i < n - 1 && props.edit({ op: "moveLayer", layer: id, to: i + 1 }));
    f.addButton({ title: "ひとつ下へ" }).on("click", () => i > 0 && props.edit({ op: "moveLayer", layer: id, to: i - 1 }));
    f.addButton({ title: "レイヤーを削除" }).on("click", () => confirm(`${id} を削除しますか(Ctrl+Zで戻せます)`) && props.edit({ op: "deleteLayer", layer: id }));
  };

  const build = () => {
    pane?.dispose();
    rows = [];
    hovered = null;
    pane = new Pane({ container: host });
    // 上のレイヤー(layers の後ろ)から並べる
    for (const l of [...props.project.layers].reverse()) {
      const folder = pane.addFolder({ title: `${l.id}  ${l.sketch.replace(/^sketches\//, "")}` });
      layerRows(folder, l);
      for (const [name, d] of Object.entries<any>(props.decls?.[l.sketch]?.params ?? {})) {
        const type = Array.isArray(d.options) ? "enum" : String(d.type ?? "float");
        if (!SUPPORTED.has(type)) continue;
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
        const id = l.id;
        add(folder, {
          layer: id, name, type, target: { param: name },
          entry: () => (layerOf(id)?.params as any)?.[name], fallback: d.default,
          set: (value) => ({ op: "setParam", layer: id, name, value }),
        }, opts);
      }
    }
    if (props.project.layers.length === 0) host.dataset.empty = "1";
    else delete host.dataset.empty;
    lastFrame = -1;
    sync();
  };

  /** 現在フレームの値とキーの印を入力欄に反映する(操作中の欄は触らない) */
  const sync = () => {
    syncing = true;
    for (const r of rows) {
      if (r.keyBtn) {
        const keys = keysOf(r);
        const onKey = keys.some((k) => k.frame === lframe(r));
        r.keyBtn.dataset.state = onKey ? "on" : keys.length ? "keyed" : "none";
        r.keyBtn.title = onKey ? "このフレームのキーを消す(Alt+I)" : "このフレームにキーを打つ(I)";
        r.keyBtn.setAttribute("aria-label", `${r.layer} ${r.name}: ${r.keyBtn.title}`);
      }
      const el: HTMLElement = r.binding.element;
      if (dragging || el.contains(document.activeElement)) continue;
      r.obj[r.name] = valueAt(r);
      r.binding.refresh();
    }
    syncing = false;
    lastFrame = props.frame();
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
        if (!hovered || !hovered.target || k.ctrl || (k.key !== "i" && k.key !== "I")) return false;
        if (k.alt) {
          if (keysOf(hovered).some((x) => x.frame === lframe(hovered!))) deleteKey(hovered);
          else props.status(`${hovered.layer} ${hovered.name} のこのフレームにキーはない`);
        } else setKey(hovered, fromUi(hovered.type, hovered.obj[hovered.name]));
        return true;
      },
    });
  });

  // レイヤーの構成やparams宣言が変わったら作り直し、値だけの変更なら入れ直す
  createEffect(
    on(
      () => [props.project, props.decls] as const,
      () => {
        const next = JSON.stringify([
          props.project.layers.map((l) => {
            const sc = propOf(l, "transform.scale");
            return [l.id, l.sketch, props.decls?.[l.sketch]?.params ?? null, Array.isArray(isKeyed(sc) ? (sc as any).value : sc)];
          }),
        ]);
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
  // フレームが変わったら評価し直す(キーのある値が動く)
  createEffect(() => {
    const f = props.frame();
    if (f !== lastFrame && rows.length) sync();
  });

  return (
    <div class="params" ref={host}>
      <div class="hint params-empty">レイヤーがありません。</div>
    </div>
  );
}
