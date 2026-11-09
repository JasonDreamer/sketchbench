// スケッチWebViewの共通部分。生存通知、結果の返送、共有メモリの受け取り。
(() => {
  const SB = 'http://sb.localhost';
  const L = new URLSearchParams(location.search).get('l') || '?';
  window.SBL = L;
  // 仮想時計に置き換える前の本物を保持する(設計書のとおり)
  window.__sb_real = {
    setTimeout: window.setTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    now: performance.now.bind(performance),
    dateNow: Date.now,
    raf: window.requestAnimationFrame.bind(window),
  };
  const post = (p, b) => fetch(SB + p, { method: 'POST', body: b });
  window.__run = async (id, fn) => {
    let r;
    try { r = { ok: true, v: await fn() }; } catch (e) { r = { ok: false, err: String((e && e.stack) || e) }; }
    await post('/done?id=' + id, JSON.stringify(r));
  };
  __sb_real.setInterval(() => { post('/hb?l=' + L, '').catch(() => {}); }, 500);
  if (window.chrome && chrome.webview) {
    chrome.webview.addEventListener('sharedbufferreceived', (e) => {
      window.__sharedBuf = e.getBuffer();
      window.__sharedMeta = e.additionalData;
    });
  }
  post('/hello?l=' + L, navigator.userAgent);
})();
