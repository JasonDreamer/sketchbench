// Blender式のエリア(sliced-areas の Web Component)。各エリアの左上のメニューでエディタを切り替え、
// 角のドラッグで分割・結合、Ctrl+Space でカーソル下のエリアを最大化・復帰する。
// プレビューはUIの上に重なる別のネイティブ領域なので、境界や角をドラッグしている間は静止画で覆う。
// sliced-areas 2.1.1 は layout を2回目に代入すると止まることがあったので、配置を替えるときは要素ごと作り直す。
import { createEffect, For, onCleanup, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { registerSlicedAreasElement, type AreasLayout, type SlicedAreasElement } from "sliced-areas";
import "sliced-areas/styles.css";
import { EDITOR_NAMES, type EditorTag } from "./workspaces";

// 読み込むだけでは登録されないので、明示して登録する
registerSlicedAreasElement();

export interface AreasApi {
  /** カーソル下のエリアを最大化する(最大化中なら戻す) */
  toggleMaximize(): void;
  /** カーソル下のエリアのエディタ */
  hoveredTag(): EditorTag | null;
}

export function Areas(props: {
  layout: () => AreasLayout;
  onChange: (layout: AreasLayout) => void;
  editor: (tag: EditorTag) => JSX.Element;
  cover: (on: boolean) => void;
  api: (a: AreasApi) => void;
}) {
  let host!: HTMLDivElement;
  let el: SlicedAreasElement | null = null;
  let hovered: { id: string; tag: EditorTag } | null = null;
  let maximized = false;

  const resolver = (tag: string, areaId?: string) => {
    const t = (tag in EDITOR_NAMES ? tag : "preview") as EditorTag;
    const wrap = document.createElement("div");
    wrap.className = "area";
    wrap.dataset.editor = t;
    const head = document.createElement("div");
    head.className = "area-head";
    const body = document.createElement("div");
    body.className = "area-body";
    wrap.append(head, body);
    wrap.addEventListener("mouseenter", () => (hovered = { id: areaId ?? "", tag: t }));
    wrap.addEventListener("mouseleave", () => hovered?.id === areaId && (hovered = null));
    const target = el;
    const disposeHead = render(
      () => (
        <select aria-label="エディタの種類" onChange={(e) => areaId && target?.retag(areaId, e.currentTarget.value)}>
          <For each={Object.entries(EDITOR_NAMES)}>{([k, name]) => <option value={k} selected={k === t}>{name}</option>}</For>
        </select>
      ),
      head,
    );
    const disposeBody = render(() => props.editor(t), body);
    return {
      element: wrap,
      cleanup: () => {
        disposeHead();
        disposeBody();
      },
    };
  };

  const onLayout = (e: Event) => props.onChange((e as CustomEvent<{ layout: AreasLayout }>).detail.layout);
  // 境界(handle)や角(corner)を掴んだら、離すまでプレビューを覆う
  const onDown = (e: PointerEvent) => {
    const t = e.target as HTMLElement;
    if (!t.closest(".sliced-areas-handle, .sliced-areas-corner")) return;
    props.cover(true);
    addEventListener("pointerup", () => props.cover(false), { once: true });
  };

  const unmount = () => {
    if (!el) return;
    el.removeEventListener("sliced-areas:layoutchange", onLayout);
    el.removeEventListener("pointerdown", onDown, true);
    el.setResolver(null);
    el.remove();
    el = null;
  };

  const mount = (layout: AreasLayout) => {
    unmount();
    const e = document.createElement("sliced-areas") as SlicedAreasElement;
    el = e;
    host.appendChild(e);
    e.setResolver(resolver as any);
    e.layout = structuredClone(layout);
    e.addEventListener("sliced-areas:layoutchange", onLayout);
    e.addEventListener("pointerdown", onDown, true);
    maximized = false;
  };

  // ワークスペースを切り替えたら作り直す(自分の layoutchange では作り直さない)
  createEffect(() => mount(props.layout()));
  onCleanup(unmount);

  props.api({
    toggleMaximize() {
      if (!el) return;
      if (maximized) {
        el.restore();
        maximized = false;
      } else if (hovered?.id) {
        el.maximize(hovered.id);
        maximized = true;
      }
    },
    hoveredTag: () => hovered?.tag ?? null,
  });

  return <div class="areas" ref={host} />;
}
