// 開発中の動作確認: UI WebViewのページの中でJSを評価する(Chrome DevTools Protocol)。
// アプリを SB_DEBUG_PORT=<番号> で起動しておく。実際のマウスやキーを送らないので、ほかのウィンドウに入力が漏れない。
// 使い方: node tools/ui-cdp.mjs <番号> "<式>"   (式はPromiseでもよい。結果をJSONで表示する)
const [port, expr] = process.argv.slice(2);
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === "page" && /tauri\.localhost|index\.html/.test(t.url)) ?? list.find((t) => t.type === "page");
if (!page) throw new Error("UIのページが見つからない");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const res = await new Promise((resolve) => {
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id === 1) resolve(d.result);
  };
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
});
ws.close();
if (res.exceptionDetails) {
  console.error(res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails));
  process.exit(1);
}
console.log(JSON.stringify(res.result.value, null, 1));
