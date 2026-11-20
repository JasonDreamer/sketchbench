// opentype.js 2.0.0 は型を同梱しないので、使う関数だけを宣言する
declare module "opentype.js" {
  export function parse(buffer: ArrayBuffer, opt?: unknown): any;
}
