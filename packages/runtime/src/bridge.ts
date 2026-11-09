// Rustコアとの通信。スケッチ→Rustは専用URIスキームへのPOST、Rust→スケッチはTauriイベント。

import { real } from "./clock.js";

const q = new URLSearchParams(location.search);
export const label = q.get("l") ?? "?";
export const work = q.get("work") ?? "";
export const mode = (q.get("mode") ?? "preview") as "preview" | "export";
export const query = q;

let phase = "loading";

export function post(path: string, body: BodyInit = ""): Promise<Response> {
  return fetch(path, { method: "POST", body });
}

export function setPhase(p: "loading" | "setup" | "ready" | "error") {
  phase = p;
  post(`/state?l=${label}&phase=${p}`).catch(() => {});
}

export function log(level: "info" | "warn" | "error", message: string, extra: unknown = null) {
  post(`/log?l=${label}`, JSON.stringify({ level, message, extra })).catch(() => {});
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}\n${e.stack ?? ""}`;
  return String(e);
}

// 生存通知は差し替え前のsetIntervalで送る
real.setInterval(() => {
  post(`/hb?l=${label}&phase=${phase}`).catch(() => {});
}, 500);

addEventListener("error", (e) => log("error", errorText(e.error ?? e.message)));
addEventListener("unhandledrejection", (e) => log("error", errorText(e.reason)));

type Listener = (payload: any) => void;

/** Rustからのイベントを受ける(Tauriのイベント)。 */
export async function listen(event: string, fn: Listener): Promise<void> {
  const t = (window as any).__TAURI__;
  if (!t?.event?.listen) {
    log("error", "Tauriのイベントが使えない(withGlobalTauri とケイパビリティを確認)");
    return;
  }
  await t.event.listen(event, (e: { payload: unknown }) => fn(e.payload));
}
