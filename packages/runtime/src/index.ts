// @sketchbench/runtime の公開API。スケッチは defineSketch の戻り値を default export する。
// 型は types/index.d.ts が正。ここは実行時の実体だけを持つ。

export function defineSketch<T>(def: T): T {
  return def;
}

export { rand } from "./rand.js";
export * as text from "./text.js";
