// フェーズ0の計測関数。UI WebViewとスケッチWebViewの両方で読み込み、window.T から呼ぶ。
(() => {
  const SB = 'http://sb.localhost';
  const W4 = 3840, H4 = 2160;
  const real = window.__sb_real || { setTimeout: setTimeout.bind(window), now: performance.now.bind(performance), raf: requestAnimationFrame.bind(window) };
  const now = () => real.now();
  const sleep = (ms) => new Promise((r) => real.setTimeout(r, ms));
  const raf = () => new Promise((r) => real.raf(r));
  const r2 = (x) => Math.round(x * 100) / 100;
  const stat = (v) => {
    if (!v.length) return null;
    const s = [...v].sort((a, b) => a - b);
    return { n: s.length, median: r2(s[s.length >> 1]), min: r2(s[0]), max: r2(s[s.length - 1]) };
  };
  const hash = (u8) => { let h = 2166136261; for (let i = 0; i < u8.length; i += 7) { h ^= u8[i]; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };

  const T = {};

  // ---------------------------------------------------------------- 9. 環境・GPU
  T.env = async () => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const out = {
      ua: navigator.userAgent,
      webglRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      webglVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      visibility: document.visibilityState,
      dpr: devicePixelRatio,
      hardwareConcurrency: navigator.hardwareConcurrency,
    };
    if (navigator.userAgentData) {
      const v = await navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'platformVersion']);
      out.fullVersionList = v.fullVersionList; out.platformVersion = v.platformVersion;
    }
    out.webgpu = {};
    if (navigator.gpu) {
      for (const pp of ['high-performance', 'low-power']) {
        try {
          const a = await navigator.gpu.requestAdapter({ powerPreference: pp });
          out.webgpu[pp] = a ? { vendor: a.info?.vendor, architecture: a.info?.architecture, device: a.info?.device, description: a.info?.description } : 'no adapter';
        } catch (e) { out.webgpu[pp] = 'error ' + e.message; }
      }
    } else out.webgpu = 'navigator.gpu なし';
    return out;
  };

  // 1080pのWebGLを一定時間描いてGPUメモリを確保させる
  T.spin = async ({ ms }) => {
    const c = document.createElement('canvas'); c.width = 1920; c.height = 1080;
    const gl = c.getContext('webgl2');
    const end = now() + ms; let n = 0;
    while (now() < end) { gl.clearColor(n % 2, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); n++; await raf(); }
    return n;
  };

  // ---------------------------------------------------------------- 7. GPU共有
  T.texCopy = async () => {
    const src = document.createElement('canvas'); src.width = W4; src.height = H4;
    const sg = src.getContext('webgl2', { preserveDrawingBuffer: true });
    const dst = document.createElement('canvas'); dst.width = W4; dst.height = H4;
    const gl = dst.getContext('webgl2');
    gl.getExtension('EXT_color_buffer_float'); gl.getExtension('EXT_color_buffer_half_float');
    const out = {};
    for (const [name, ifmt, type] of [['RGBA8', gl.RGBA8, gl.UNSIGNED_BYTE], ['RGBA16F', gl.RGBA16F, gl.HALF_FLOAT]]) {
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      const t0 = now();
      gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, gl.RGBA, type, src);
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const fbOk = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      const px = type === gl.UNSIGNED_BYTE ? new Uint8Array(4) : new Float32Array(4);
      const rtype = type === gl.UNSIGNED_BYTE ? gl.UNSIGNED_BYTE : gl.FLOAT;
      if (fbOk) gl.readPixels(0, 0, 1, 1, gl.RGBA, rtype, px);
      const first = now() - t0;
      const times = [];
      let correct = 0;
      for (let i = 0; i < 20; i++) {
        const v = (i * 13) % 256;
        sg.clearColor(v / 255, 0.5, 0.25, 1); sg.clear(sg.COLOR_BUFFER_BIT);
        const t1 = now();
        gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, gl.RGBA, type, src);
        if (fbOk) gl.readPixels(0, 0, 1, 1, gl.RGBA, rtype, px);
        else gl.finish();
        times.push(now() - t1);
        const got = type === gl.UNSIGNED_BYTE ? px[0] : Math.round(px[0] * 255);
        if (Math.abs(got - v) <= 1) correct++;
      }
      out[name] = { firstMs: r2(first), ms: stat(times), correct: `${correct}/20`, readbackOk: fbOk };
      gl.deleteFramebuffer(fb); gl.deleteTexture(tex);
    }
    return out;
  };

  T.readPixels4k = async () => {
    const c = document.createElement('canvas'); c.width = W4; c.height = H4;
    const gl = c.getContext('webgl2', { preserveDrawingBuffer: true });
    const buf = new Uint8Array(W4 * H4 * 4);
    const sync = [];
    for (let i = 0; i < 10; i++) {
      gl.clearColor(i / 10, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      const t0 = now(); gl.readPixels(0, 0, W4, H4, gl.RGBA, gl.UNSIGNED_BYTE, buf); sync.push(now() - t0);
    }
    // PBOで非同期に読む
    const pbo = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, buf.byteLength, gl.STREAM_READ);
    const async_ = [];
    for (let i = 0; i < 10; i++) {
      gl.clearColor(i / 10, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      const t0 = now();
      gl.readPixels(0, 0, W4, H4, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
      while (gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) await sleep(0);
      gl.deleteSync(fence);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, buf);
      async_.push(now() - t0);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return { syncMs: stat(sync), pboFenceMs: stat(async_) };
  };

  T.glContextsMain = async () => {
    const ctxs = []; let lost = 0;
    for (let i = 0; i < 32; i++) {
      const c = document.createElement('canvas');
      c.addEventListener('webglcontextlost', () => lost++);
      const gl = c.getContext('webgl2');
      if (!gl) break;
      gl.clear(gl.COLOR_BUFFER_BIT);
      ctxs.push(gl);
    }
    await sleep(800);
    const alive = ctxs.filter((g) => !g.isContextLost()).length;
    ctxs.forEach((g) => g.getExtension('WEBGL_lose_context')?.loseContext());
    return { created: ctxs.length, alive, lostEvents: lost };
  };

  T.glContextsWorker = () => new Promise((res) => {
    const src = `onmessage = async () => {
      const ctxs = []; let err = null;
      for (let i = 0; i < 32; i++) {
        try { const gl = new OffscreenCanvas(16, 16).getContext('webgl2'); if (!gl) break; gl.clear(gl.COLOR_BUFFER_BIT); ctxs.push(gl); }
        catch (e) { err = e.message; break; }
      }
      setTimeout(() => postMessage({ created: ctxs.length, alive: ctxs.filter(g => !g.isContextLost()).length, err }), 800);
    };`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = (e) => { w.terminate(); res(e.data); };
    w.onerror = (e) => { w.terminate(); res({ error: e.message }); };
    w.postMessage(0);
  });

  // ---------------------------------------------------------------- 3. フレーム転送
  T.transfer = async ({ n, port, token }) => {
    const N = W4 * H4 * 4;
    const src = new Uint8Array(N);
    for (let i = 0; i < N; i += 4096) src[i] = (i >> 12) & 255;
    let expect = 0; for (let i = 0; i < N; i += 1 << 20) expect += src[i];
    const want = `${N} ${expect}`;
    const bench = async (fn) => {
      const times = []; let bad = 0; let err = null;
      for (let i = 0; i < n; i++) {
        const t0 = now();
        try { const r = await fn(); if (r !== want) bad++; } catch (e) { err = String(e); break; }
        times.push(now() - t0);
      }
      return { ms: stat(times.slice(1)), firstMs: r2(times[0] ?? -1), mismatched: bad, error: err };
    };
    const out = { bytes: N };
    out.customSchemePost = await bench(async () => (await fetch(SB + '/frame', { method: 'POST', body: src })).text());
    out.localhostHttp = await bench(async () => (await fetch(`http://127.0.0.1:${port}/frame`, { method: 'POST', body: src, headers: { 'x-token': token } })).text());
    // 共有メモリ: Rustが渡したバッファに書き、短い通知を送る。Rust側は受けたフレームを別バッファに写す
    for (let i = 0; i < 30 && !window.__sharedBuf; i++) await sleep(100);
    if (window.__sharedBuf) {
      const view = new Uint8Array(window.__sharedBuf);
      out.sharedBufferMeta = window.__sharedMeta;
      out.sharedBuffer = await bench(async () => { view.set(src); return (await fetch(SB + '/sbuf', { method: 'POST', body: '' })).text(); });
      const set = []; for (let i = 0; i < 10; i++) { const t0 = now(); view.set(src); set.push(now() - t0); }
      out.sharedBufferWriteOnlyMs = stat(set);
      const notify = []; for (let i = 0; i < 10; i++) { const t0 = now(); await fetch(SB + '/hb?l=probe', { method: 'POST', body: '' }); notify.push(now() - t0); }
      out.smallNotifyRoundtripMs = stat(notify);
      // readPixelsで共有メモリへ直接書けるか
      try {
        const c = document.createElement('canvas'); c.width = W4; c.height = H4;
        const gl = c.getContext('webgl2', { preserveDrawingBuffer: true });
        gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        const t = [];
        for (let i = 0; i < 5; i++) { const t0 = now(); gl.readPixels(0, 0, W4, H4, gl.RGBA, gl.UNSIGNED_BYTE, view); t.push(now() - t0); }
        out.readPixelsIntoSharedBuffer = { ms: stat(t), firstPixel: [...view.subarray(0, 4)], glError: gl.getError() };
      } catch (e) { out.readPixelsIntoSharedBuffer = 'error ' + e.message; }
      try { chrome.webview.releaseBuffer(window.__sharedBuf); out.releaseBuffer = 'ok'; } catch (e) { out.releaseBuffer = 'error ' + e.message; }
      window.__sharedBuf = null;
    } else out.sharedBuffer = 'sharedbufferreceived が来なかった';
    return out;
  };

  // ---------------------------------------------------------------- 5. WebCodecs
  const CODECS = {
    'H.264 High L5.2': 'avc1.640034',
    'H.265 Main L5.1': 'hvc1.1.6.L153.B0',
    'AV1 Main L5.1': 'av01.0.13M.08',
    'VP9 P0 L5.1': 'vp09.00.51.08',
  };
  T.codecSupport = async () => {
    const out = {};
    for (const [name, codec] of Object.entries(CODECS)) {
      for (const [res, w, h] of [['1080p', 1920, 1080], ['4K', W4, H4]]) {
        for (const hw of ['prefer-hardware', 'prefer-software']) {
          try {
            const r = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, framerate: 30, bitrate: res === '4K' ? 40e6 : 12e6, hardwareAcceleration: hw });
            out[`${name} ${res} ${hw}`] = r.supported;
          } catch (e) { out[`${name} ${res} ${hw}`] = 'error ' + e.message; }
        }
      }
    }
    return out;
  };

  T.encodeSpeed = async () => {
    const out = {};
    const c = document.createElement('canvas'); c.width = W4; c.height = H4;
    const g = c.getContext('2d');
    for (const [name, codec] of Object.entries(CODECS)) {
      const cfg = { codec, width: W4, height: H4, framerate: 30, bitrate: 40e6, hardwareAcceleration: 'prefer-hardware' };
      const sup = await VideoEncoder.isConfigSupported(cfg).catch(() => ({ supported: false }));
      if (!sup.supported) { out[name] = 'unsupported'; continue; }
      let bytes = 0, chunks = 0, err = null;
      const enc = new VideoEncoder({ output: (ch) => { bytes += ch.byteLength; chunks++; }, error: (e) => { err = e.message; } });
      enc.configure(cfg);
      const N = 60;
      const t0 = now();
      for (let i = 0; i < N; i++) {
        g.fillStyle = `hsl(${i * 6},70%,50%)`; g.fillRect(0, 0, W4, H4);
        g.fillStyle = '#fff'; g.font = '200px sans-serif'; g.fillText('frame ' + i, 200 + i * 20, 1000);
        const f = new VideoFrame(c, { timestamp: Math.round(i * 1e6 / 30) });
        enc.encode(f, { keyFrame: i % 30 === 0 }); f.close();
        while (enc.encodeQueueSize > 4) await sleep(1);
      }
      try { await enc.flush(); } catch (e) { err = err || e.message; }
      const dt = now() - t0;
      enc.close();
      out[name] = { frames: N, ms: Math.round(dt), fps: r2(N / dt * 1000), chunks, MB: r2(bytes / 1e6), error: err };
    }
    return out;
  };

  // RGBの色票をエンコードし、デコードしたYUV値から変換係数とレンジを判定する
  const PATCHES = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0], [128, 128, 128], [200, 100, 50]];
  const expectYUV = (rgb, mat, full) => {
    const [kr, kb] = mat === '601' ? [0.299, 0.114] : [0.2126, 0.0722];
    const [R, G, B] = rgb.map((x) => x / 255);
    const Y = kr * R + (1 - kr - kb) * G + kb * B;
    const Cb = (B - Y) / (2 * (1 - kb)), Cr = (R - Y) / (2 * (1 - kr));
    return full ? [255 * Y, 128 + 255 * Cb, 128 + 255 * Cr].map((v) => Math.min(255, Math.max(0, v))) : [16 + 219 * Y, 128 + 224 * Cb, 128 + 224 * Cr];
  };

  // avcCからSPSを取り出してVUIの色情報を読む
  const parseAvcC = (desc) => {
    const b = new Uint8Array(desc instanceof ArrayBuffer ? desc : desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength));
    const nsps = b[5] & 0x1f; if (!nsps) return null;
    const len = (b[6] << 8) | b[7];
    return parseSPS(b.subarray(8, 8 + len));
  };
  const parseSPS = (nal) => {
    const rb = []; // エミュレーション防止バイトを除く
    for (let i = 1; i < nal.length; i++) { if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue; rb.push(nal[i]); }
    let pos = 0;
    const u = (n) => { let v = 0; for (let i = 0; i < n; i++) { v = (v << 1) | ((rb[pos >> 3] >> (7 - (pos & 7))) & 1); pos++; } return v; };
    const ue = () => { let z = 0; while (u(1) === 0) z++; return (1 << z) - 1 + u(z); };
    const se = () => { const k = ue(); return k & 1 ? (k + 1) / 2 : -k / 2; };
    const profile = u(8); u(8); const level = u(8); ue();
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      const cf = ue(); if (cf === 3) u(1); ue(); ue(); u(1);
      if (u(1)) { for (let i = 0; i < (cf !== 3 ? 8 : 12); i++) if (u(1)) { const sz = i < 6 ? 16 : 64; let last = 8, next = 8; for (let j = 0; j < sz; j++) { if (next) next = (last + se() + 256) % 256; last = next || last; } } }
    }
    ue(); const poc = ue();
    if (poc === 0) ue(); else if (poc === 1) { u(1); se(); se(); const n = ue(); for (let i = 0; i < n; i++) se(); }
    ue(); u(1); ue(); ue(); const fmo = u(1); if (!fmo) u(1); u(1);
    if (u(1)) { ue(); ue(); ue(); ue(); }
    const out = { profile, level, vui: false };
    if (u(1)) {
      out.vui = true;
      if (u(1)) { const ar = u(8); if (ar === 255) { u(16); u(16); } }
      if (u(1)) u(1);
      out.videoSignalTypePresent = !!u(1);
      if (out.videoSignalTypePresent) {
        out.videoFormat = u(3); out.fullRange = !!u(1);
        if (u(1)) { out.colourPrimaries = u(8); out.transfer = u(8); out.matrix = u(8); }
      }
    }
    return out;
  };

  const encodeDecode = async (codec, frame) => {
    let meta = null, chunk = null, err = null;
    const enc = new VideoEncoder({ output: (ch, m) => { chunk = chunk || ch; if (m?.decoderConfig) meta = m.decoderConfig; }, error: (e) => { err = e.message; } });
    enc.configure({ codec, width: frame.codedWidth, height: frame.codedHeight, bitrate: 30e6, framerate: 30, hardwareAcceleration: 'prefer-hardware' });
    enc.encode(frame, { keyFrame: true });
    await enc.flush(); enc.close();
    if (!chunk || !meta) return { err: err || 'no output' };
    let decoded = null;
    const dec = new VideoDecoder({ output: (f) => { decoded = decoded || f; }, error: (e) => { err = e.message; } });
    dec.configure(meta);
    dec.decode(chunk); await dec.flush(); dec.close();
    if (!decoded) return { err: err || 'no decoded frame', meta };
    const fmt = decoded.format;
    const buf = new Uint8Array(decoded.allocationSize());
    const layout = await decoded.copyTo(buf);
    const W = decoded.codedWidth, H = decoded.codedHeight;
    const sample = (x, y) => {
      const Y = buf[layout[0].offset + y * layout[0].stride + x];
      if (fmt === 'NV12') { const o = layout[1].offset + (y >> 1) * layout[1].stride + (x >> 1) * 2; return [Y, buf[o], buf[o + 1]]; }
      if (fmt === 'I420') { return [Y, buf[layout[1].offset + (y >> 1) * layout[1].stride + (x >> 1)], buf[layout[2].offset + (y >> 1) * layout[2].stride + (x >> 1)]]; }
      return null;
    };
    const values = PATCHES.map((_, i) => sample(Math.floor((i + 0.5) * W / PATCHES.length), H >> 1));
    const decodedColorSpace = decoded.colorSpace?.toJSON?.() ?? null;
    decoded.close();
    const sps = codec.startsWith('avc1') && meta.description ? parseAvcC(meta.description) : null;
    return { format: fmt, values, decoderConfigColorSpace: meta.colorSpace ?? null, decodedColorSpace, sps, err };
  };

  T.yuvCheck = async () => {
    const W = 1920, H = 1080;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    PATCHES.forEach((p, i) => { g.fillStyle = `rgb(${p})`; g.fillRect(Math.floor(i * W / PATCHES.length), 0, Math.ceil(W / PATCHES.length), H); });
    const judge = (values) => {
      if (!values || values.some((v) => !v)) return null;
      const cand = {};
      for (const mat of ['601', '709']) for (const full of [false, true]) {
        let e = 0; PATCHES.forEach((p, i) => { const x = expectYUV(p, mat, full); for (let k = 0; k < 3; k++) e += Math.abs(x[k] - values[i][k]); });
        cand[`BT.${mat} ${full ? 'full' : 'limited'}`] = r2(e / (PATCHES.length * 3));
      }
      const best = Object.entries(cand).sort((a, b) => a[1] - b[1])[0][0];
      return { meanAbsErrorPerCandidate: cand, best };
    };
    const out = { patchesRGB: PATCHES };
    for (const [name, codec] of [['H.264', 'avc1.640028'], ['H.265', 'hvc1.1.6.L120.B0'], ['AV1', 'av01.0.08M.08']]) {
      const sup = await VideoEncoder.isConfigSupported({ codec, width: W, height: H, bitrate: 30e6, hardwareAcceleration: 'prefer-hardware' }).catch(() => ({ supported: false }));
      if (!sup.supported) { out[name] = 'unsupported'; continue; }
      // (a) canvasのRGBをそのまま渡す(エンコーダーが変換する)
      const f1 = new VideoFrame(c, { timestamp: 0 });
      const rgbInputColorSpace = f1.colorSpace?.toJSON?.();
      const a = await encodeDecode(codec, f1); f1.close();
      a.judge = judge(a.values); a.inputColorSpace = rgbInputColorSpace;
      // (b) 自前でBT.709リミテッドのNV12に変換し、colorSpaceを明示して渡す
      const rgba = g.getImageData(0, 0, W, H).data;
      const nv = new Uint8Array(W * H * 3 / 2);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4; const [Y, U, V] = expectYUV([rgba[o], rgba[o + 1], rgba[o + 2]], '709', false);
        nv[y * W + x] = Math.round(Y);
        if (!(x & 1) && !(y & 1)) { const co = W * H + (y >> 1) * W + x; nv[co] = Math.round(U); nv[co + 1] = Math.round(V); }
      }
      const f2 = new VideoFrame(nv, { format: 'NV12', codedWidth: W, codedHeight: H, timestamp: 0, colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } });
      const b = await encodeDecode(codec, f2); f2.close();
      b.judge = judge(b.values);
      out[name] = { rgbInput: a, nv12Bt709LimitedInput: b };
    }
    return out;
  };

  // ---------------------------------------------------------------- 4. HTMLレンダラー
  T.hic = async () => {
    const c0 = document.createElement('canvas');
    const ctx0 = c0.getContext('2d');
    const gl0 = document.createElement('canvas').getContext('webgl2');
    const out = {
      drawElementImage: typeof ctx0.drawElementImage === 'function',
      texElementSubImage2D: typeof gl0?.texElementSubImage2D === 'function',
      texElementImage2D_old: typeof gl0?.texElementImage2D === 'function',
      updateElementGeometry: typeof c0.updateElementGeometry === 'function',
      requestPaint: typeof c0.requestPaint === 'function',
      onpaintProp: 'onpaint' in c0,
    };
    if (!out.drawElementImage) return out;
    const work = document.getElementById('work') || document.body;
    const W = 1920, H = 1080;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    c.style.cssText = `width:${W}px;height:${H}px`;
    c.setAttribute('content', 'drawable'); c.setAttribute('layoutsubtree', '');
    const el = document.createElement('div'); el.setAttribute('drawable', '');
    el.style.cssText = 'width:1920px;height:1080px;font:120px serif;color:#c00;background:linear-gradient(90deg,rgba(0,0,255,0.5),transparent)';
    el.textContent = 'HTML-in-Canvas テスト';
    c.appendChild(el); work.appendChild(c);
    let paintEvents = 0; c.addEventListener('paint', () => paintEvents++);
    await raf(); await raf();
    const ctx = c.getContext('2d');
    const times = []; let err = null; let ret;
    for (let i = 0; i < 10; i++) {
      try {
        ctx.clearRect(0, 0, W, H);
        const t0 = now(); ret = ctx.drawElementImage(el, 0, 0); ctx.getImageData(0, 0, 1, 1); times.push(now() - t0);
      } catch (e) { err = e.message; break; }
      await raf();
    }
    out.drawReturn = ret === undefined ? 'undefined' : String(ret);
    out.drawErr = err; out.paintEvents = paintEvents;
    if (!err) {
      const d = ctx.getImageData(0, 0, W, H).data;
      let painted = 0, semi = 0;
      for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) painted++; if (d[i] > 0 && d[i] < 255) semi++; }
      out.paintedPixels = painted; out.semiTransparentPixels = semi; out.drawMs1080p = stat(times);
    }
    c.remove();
    return out;
  };

  const loadImg = (url) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image load failed')); i.src = url; });
  const toDataURL = async (url) => { const b = await (await fetch(url)).blob(); return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); }); };

  T.foreignObject = async () => {
    const W = 1920, H = 1080;
    const red = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); g.fillStyle = '#f00'; g.fillRect(0, 0, 64, 64); return c.toDataURL('image/png'); })();
    const fontData = await toDataURL(SB + '/sysfont?name=impact.ttf').catch(() => null);
    const svg = (body, style = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${W}px;height:${H}px"><style>${style}</style>${body}</div></foreignObject></svg>`;
    // html-to-imageと同じdata URL方式を既定にし、blob URLとの違いも記録する
    let mode = 'data';
    const render = async (s) => {
      const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
      const t0 = now();
      const url = mode === 'blob' ? URL.createObjectURL(new Blob([s], { type: 'image/svg+xml' })) : 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
      const img = await loadImg(url); g.drawImage(img, 0, 0); if (mode === 'blob') URL.revokeObjectURL(url);
      let data = null, tainted = false;
      try { data = g.getImageData(0, 0, W, H).data; } catch (e) { tainted = e.name; }
      return { ms: now() - t0, data, tainted };
    };
    const px = (d, x, y) => { const o = (y * W + x) * 4; return [d[o], d[o + 1], d[o + 2], d[o + 3]]; };
    const out = {};
    const text = '<div style="font:140px TF, monospace;color:#000">WWWiii 文字</div>';
    mode = 'blob';
    out.taintedBlobUrl = (await render(svg(text.replace('TF, ', '')))).tainted;
    mode = 'data';
    const base = await render(svg(text.replace('TF, ', '')));
    out.taintedDataUrl = base.tainted;
    // foreignObjectを含まないSVGはtaintしないか(切り分け用)
    {
      const c = document.createElement('canvas'); c.width = 100; c.height = 100; const g = c.getContext('2d');
      const img = await loadImg('data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>'));
      g.drawImage(img, 0, 0);
      try { g.getImageData(0, 0, 1, 1); out.taintedPlainSvg = false; } catch (e) { out.taintedPlainSvg = e.name; }
    }
    // 外部画像(同一オリジンのURL)とdata URL
    const ext = await render(svg(`<img src="${SB}/s/red.png" width="64" height="64"/>`));
    out.externalImageInSvg = ext.data ? (px(ext.data, 32, 32)[0] > 200 && px(ext.data, 32, 32)[3] > 0 ? 'drawn' : 'not drawn') : ext.tainted;
    const emb = await render(svg(`<img src="${red}" width="64" height="64"/>`));
    out.dataUrlImageInSvg = emb.data ? (px(emb.data, 32, 32)[0] > 200 ? 'drawn' : 'not drawn') : emb.tainted;
    // Webフォント: 文書側で読み込んだだけのもの / SVG内でdata URL指定
    if (fontData) {
      const ff = new FontFace('TF', `url(${SB}/sysfont?name=impact.ttf)`); await ff.load(); document.fonts.add(ff);
      const docOnly = await render(svg(text));
      out.documentFontUsedInSvg = docOnly.data && base.data ? hash(docOnly.data) !== hash(base.data) : null;
      const inl = await render(svg(text, `@font-face{font-family:TF;src:url(${fontData})}`));
      out.inlineDataUrlFontUsedInSvg = inl.data && base.data ? hash(inl.data) !== hash(base.data) : null;
      const ext2 = await render(svg(text, `@font-face{font-family:TF;src:url(${SB}/sysfont?name=impact.ttf)}`));
      out.externalUrlFontUsedInSvg = ext2.data && base.data ? hash(ext2.data) !== hash(base.data) : null;
      document.fonts.delete(ff);
    } else out.font = 'font fetch failed';
    // 同じ入力を5回描いて一致するか(1080p)
    const rich = svg(`<div style="width:1600px;height:800px;margin:100px;border-radius:40px;background:linear-gradient(45deg,#f80,#08f);box-shadow:0 0 60px #000;font:80px serif;color:#fff;padding:40px">foreignObject 再現性 <b>bold</b> <i>italic</i></div><img src="${red}" width="64" height="64"/>`);
    const hs = []; const ms = [];
    for (let i = 0; i < 5; i++) { const r = await render(rich); hs.push(r.data ? hash(r.data) : r.tainted); ms.push(r.ms); }
    out.repeatHashesIdentical = hs.every((h) => h === hs[0]);
    out.render1080pMs = stat(ms);
    return out;
  };

  // 仮想時計(timeweb方式の最小版)の下でCSSアニメーションが止まるか
  T.cssClock = async () => {
    const orig = { now: performance.now, dnow: Date.now, raf: window.requestAnimationFrame };
    let vt = 0;
    performance.now = () => vt; Date.now = () => 1.7e12 + vt;
    window.requestAnimationFrame = (cb) => real.setTimeout(() => cb(vt), 16);
    const out = {};
    const host = document.getElementById('work') || document.body;
    try {
      const mk = (css) => { const e = document.createElement('div'); e.style.cssText = 'width:10px;height:10px;' + css; host.appendChild(e); return e; };
      const x = (e) => new DOMMatrix(getComputedStyle(e).transform).m41;
      // CSSトランジション
      const t = mk('transition:transform 1s linear'); t.getBoundingClientRect(); t.style.transform = 'translateX(100px)';
      // CSSアニメーション
      const st = document.createElement('style'); st.textContent = '@keyframes sbmove { from { transform: translateX(0) } to { transform: translateX(100px) } }'; document.head.appendChild(st);
      const a = mk('animation: sbmove 1s linear forwards');
      // Web Animations
      const w = mk(''); w.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(100px)' }], { duration: 1000, fill: 'forwards' });
      await new Promise((r) => real.setTimeout(r, 400)); // 実時間だけ進め、仮想時刻は0のまま
      out.afterRealTime400ms_virtualTimeFrozen = { transition: r2(x(t)), cssAnimation: r2(x(a)), webAnimation: r2(x(w)), expectedIfFollowingVirtualClock: 0 };
      const anims = document.getAnimations();
      out.getAnimationsCount = anims.length;
      anims.forEach((an) => { an.pause(); an.currentTime = 500; });
      await new Promise((r) => real.setTimeout(r, 50));
      out.afterPauseAndCurrentTime500 = { transition: r2(x(t)), cssAnimation: r2(x(a)), webAnimation: r2(x(w)), expected: 50 };
      anims.forEach((an) => { an.currentTime = 250; });
      out.afterSeekBackTo250 = { transition: r2(x(t)), cssAnimation: r2(x(a)), webAnimation: r2(x(w)), expected: 25 };
      [t, a, w, st].forEach((e) => e.remove());
    } finally {
      performance.now = orig.now; Date.now = orig.dnow; window.requestAnimationFrame = orig.raf;
    }
    return out;
  };

  // 取り込み試験用に、文字とグラデーションの多いDOMを全面に置く
  T.busyPage = () => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;z-index:5;background:linear-gradient(135deg,#123,#c84);color:#fff;font:28px serif;overflow:hidden;padding:20px';
    d.innerHTML = Array.from({ length: 40 }, (_, i) => `<span style="color:hsl(${i * 9},80%,70%)">行${i} HTML取り込み試験 The quick brown fox ${i * 37}</span>`).join('<br>');
    document.body.appendChild(d);
    return true;
  };

  // ---------------------------------------------------------------- 1. 非表示ウィンドウでの描画
  const glFrameTester = (gl) => {
    const px = new Uint8Array(4);
    let k = 0, ok = 0, bad = 0;
    return {
      step() {
        const v = k % 256; k++;
        gl.clearColor(v / 255, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        if (Math.abs(px[0] - v) <= 1) ok++; else bad++;
      },
      result() { return { frames: k, ok, bad }; },
    };
  };

  T.render = async ({ ms }) => {
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
    const gl = c.getContext('webgl2', { preserveDrawingBuffer: true });
    const out = { visibility: document.visibilityState, hidden: document.hidden };
    // 生存通知と同じsetInterval(500ms)の間隔
    const gaps = []; let last = now();
    const iv = real.setInterval(() => { const n = now(); gaps.push(n - last); last = n; }, 500);
    const run = async (name, schedule) => {
      const t = glFrameTester(gl); const end = now() + ms;
      await new Promise((done) => {
        const tick = () => { if (now() >= end) return done(); t.step(); schedule(tick); };
        schedule(tick);
        real.setTimeout(done, ms + 3000); // スケジューラが止まった場合の打ち切り
      });
      out[name] = { ...t.result(), fps: r2(t.result().frames / ms * 1000) };
    };
    await run('raf', (f) => real.raf(f));
    await run('setTimeout0', (f) => real.setTimeout(f, 0));
    const mc = new MessageChannel(); let pending = null; mc.port1.onmessage = () => { const f = pending; pending = null; f && f(); };
    await run('messageChannel', (f) => { pending = f; mc.port2.postMessage(0); });
    // WorkerとOffscreenCanvas
    out.worker = await new Promise((res) => {
      const src = `onmessage = (e) => {
        const ms = e.data; const gl = new OffscreenCanvas(1280, 720).getContext('webgl2');
        const px = new Uint8Array(4); let k = 0, ok = 0, bad = 0; const end = performance.now() + ms;
        const tick = () => { if (performance.now() >= end) { postMessage({ frames: k, ok, bad, fps: Math.round(k / ms * 100000) / 100 }); return; }
          const v = k % 256; k++; gl.clearColor(v / 255, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          if (Math.abs(px[0] - v) <= 1) ok++; else bad++; setTimeout(tick, 0); };
        tick(); };`;
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      const to = real.setTimeout(() => { w.terminate(); res('timeout'); }, ms + 5000);
      w.onmessage = (e) => { clearTimeout(to); w.terminate(); res(e.data); };
      w.onerror = (e) => { clearTimeout(to); w.terminate(); res('error ' + e.message); };
      w.postMessage(ms);
    });
    clearInterval(iv);
    out.setInterval500GapMs = stat(gaps);
    out.visibilityAfter = document.visibilityState;
    return out;
  };

  // 長時間の非表示での間引き(setIntervalと連鎖setTimeout)
  T.timerGaps = async ({ ms }) => {
    const iv = []; const ch = []; let li = now(), lc = now();
    const h = real.setInterval(() => { const n = now(); iv.push(n - li); li = n; }, 500);
    let stop = false;
    const chain = () => { if (stop) return; real.setTimeout(() => { const n = now(); ch.push(n - lc); lc = n; chain(); }, 500); };
    chain();
    const t0 = now();
    // 途中経過は分ごとの最大値として残す
    const perMinute = [];
    while (now() - t0 < ms) {
      await new Promise((r) => real.setTimeout(r, 1000));
      const m = Math.floor((now() - t0) / 60000);
      perMinute[m] = Math.max(perMinute[m] || 0, iv.length ? iv[iv.length - 1] : 0, ch.length ? ch[ch.length - 1] : 0);
    }
    stop = true; clearInterval(h);
    return { visibility: document.visibilityState, setInterval500: stat(iv), chainedSetTimeout500: stat(ch), maxGapPerMinuteMs: perMinute.map((x) => Math.round(x || 0)) };
  };

  // ---------------------------------------------------------------- 7. シェーダーの無限ループ
  T.gpuHang = async () => {
    const c = document.createElement('canvas'); c.width = W4; c.height = H4;
    const gl = c.getContext('webgl2');
    const ev = { lost: 0, restored: 0 };
    const t0 = now();
    c.addEventListener('webglcontextlost', (e) => { e.preventDefault(); ev.lost++; ev.lostAtMs = r2(now() - t0); });
    c.addEventListener('webglcontextrestored', () => { ev.restored++; ev.restoredAtMs = r2(now() - t0); });
    const vs = `#version 300 es\nvoid main(){ vec2 p = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 4.0 - 1.0; gl_Position = vec4(p, 0, 1); }`;
    const fs = `#version 300 es\nprecision highp float; uniform float u; out vec4 o;\nvoid main(){ float x = 0.0; for (int i = 0; i >= 0; i++) { x += sin(float(i) * u + gl_FragCoord.x); if (x > 1e30) break; } o = vec4(x, 0, 0, 1); }`;
    const sh = (t, s) => { const h = gl.createShader(t); gl.shaderSource(h, s); gl.compileShader(h); if (!gl.getShaderParameter(h, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(h)); return h; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return { linkError: gl.getProgramInfoLog(p) };
    gl.useProgram(p); gl.uniform1f(gl.getUniformLocation(p, 'u'), 0.001);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const readMs = r2(now() - t0);
    await sleep(8000);
    return { readPixelsReturnedMs: readMs, glError: gl.getError(), isContextLost: gl.isContextLost(), ...ev };
  };

  window.T = T;
})();
