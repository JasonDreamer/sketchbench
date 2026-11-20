// ワークスペース(エリアの配置を丸ごと切り替えるタブ)。配置は作品ごとに UI の localStorage に持ち、
// 「初期設定として保存」で新しく開く作品の既定にもできる(Blenderのスタートアップファイルに当たる)。
// 配置は sliced-areas の形式(各エリアの矩形を0〜1で持つ。top: 1 が上端)。

import type { AreasLayout } from "sliced-areas";

/** エディタの種類(エリアの左上のメニューで切り替える) */
export type EditorTag = "preview" | "timeline" | "graph" | "params" | "code" | "console" | "history" | "assets" | "export";

export const EDITOR_NAMES: Record<EditorTag, string> = {
  preview: "プレビュー",
  timeline: "タイムライン",
  graph: "グラフエディタ",
  params: "パラメータ",
  code: "コード",
  console: "コンソール",
  history: "履歴",
  assets: "アセット",
  export: "書き出し",
};

export interface Workspace {
  name: string;
  layout: AreasLayout;
}

export interface WorkspaceSet {
  active: number;
  list: Workspace[];
}

const a = (tag: EditorTag, left: number, right: number, top: number, bottom: number) => ({ tag, rect: { left, right, top, bottom } });

/** 設計書の「初期ワークスペース」 */
export function builtinWorkspaces(): WorkspaceSet {
  return {
    active: 2,
    list: [
      { name: "アイデア", layout: { areas: [a("preview", 0, 0.7, 1, 0), a("history", 0.7, 1, 1, 0.4), a("console", 0.7, 1, 0.4, 0)] } },
      { name: "コード", layout: { areas: [a("code", 0, 0.5, 1, 0), a("preview", 0.5, 1, 1, 0.45), a("console", 0.5, 0.75, 0.45, 0), a("params", 0.75, 1, 0.45, 0)] } },
      { name: "タイミング", layout: { areas: [a("preview", 0, 0.72, 1, 0.42), a("params", 0.72, 1, 1, 0.42), a("timeline", 0, 0.62, 0.42, 0), a("graph", 0.62, 1, 0.42, 0)] } },
      { name: "素材", layout: { areas: [a("assets", 0, 0.3, 1, 0), a("preview", 0.3, 1, 1, 0.4), a("timeline", 0.3, 1, 0.4, 0)] } },
      { name: "書き出し", layout: { areas: [a("preview", 0, 0.6, 1, 0), a("export", 0.6, 1, 1, 0)] } },
    ],
  };
}

const key = (work: string | null) => `workspaces:${work ?? ""}`;

function read(k: string): WorkspaceSet | null {
  try {
    const v = JSON.parse(localStorage.getItem(k) ?? "null");
    return v && Array.isArray(v.list) && v.list.length ? v : null;
  } catch {
    return null;
  }
}

/** 作品のワークスペース。なければ「初期設定」、それもなければ組み込みのもの */
export function loadWorkspaces(work: string | null): WorkspaceSet {
  return read(key(work)) ?? read("workspaces:default") ?? builtinWorkspaces();
}

export function saveWorkspaces(work: string | null, ws: WorkspaceSet) {
  try {
    localStorage.setItem(key(work), JSON.stringify(ws));
  } catch {}
}

/** 今の配置を、新しく開く作品の既定にする */
export function saveAsDefault(ws: WorkspaceSet) {
  try {
    localStorage.setItem("workspaces:default", JSON.stringify(ws));
  } catch {}
}
