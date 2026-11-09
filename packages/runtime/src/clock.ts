// 仮想時計(timewebと同じ方式)。Date、performance.now、requestAnimationFrame、setTimeout、setInterval を差し替え、
// ランタイムが時刻を進めたときだけ待機中のコールバックを実行する。最初に読み込むこと。
// 差し替え前の本物は real に保持する(生存通知、プレビューの描画ペース、時刻の補間に使う)。

type Timer = { id: number; due: number; cb: Function; args: unknown[]; interval: number | null; seq: number };

const g = globalThis as any;

export const real = {
  setTimeout: g.setTimeout.bind(g) as typeof setTimeout,
  clearTimeout: g.clearTimeout.bind(g) as typeof clearTimeout,
  setInterval: g.setInterval.bind(g) as typeof setInterval,
  clearInterval: g.clearInterval.bind(g) as typeof clearInterval,
  requestAnimationFrame: g.requestAnimationFrame.bind(g) as typeof requestAnimationFrame,
  cancelAnimationFrame: g.cancelAnimationFrame.bind(g) as typeof cancelAnimationFrame,
  performanceNow: performance.now.bind(performance),
  timeOrigin: performance.timeOrigin,
  Date: g.Date as DateConstructor,
  /** 本物のUNIX時刻(ms、小数あり) */
  unixMs(): number {
    return performance.timeOrigin + real.performanceNow();
  },
};

const epoch = real.Date.now();
let vnow = 0;
let nextId = 1;
let seq = 0;
const timers = new Map<number, Timer>();
let rafs = new Map<number, FrameRequestCallback>();

/** 仮想時刻(ms) */
export function now(): number {
  return vnow;
}

function addTimer(cb: Function, ms: number | undefined, args: unknown[], interval: boolean): number {
  const id = nextId++;
  const d = Math.max(0, Number(ms) || 0);
  timers.set(id, { id, due: vnow + d, cb, args, interval: interval ? Math.max(1, d) : null, seq: seq++ });
  return id;
}

const virtual = {
  setTimeout: (cb: Function, ms?: number, ...args: unknown[]) => addTimer(cb, ms, args, false),
  setInterval: (cb: Function, ms?: number, ...args: unknown[]) => addTimer(cb, ms, args, true),
  clearTimeout: (id: number) => void timers.delete(id),
  clearInterval: (id: number) => void timers.delete(id),
  requestAnimationFrame: (cb: FrameRequestCallback) => {
    const id = nextId++;
    rafs.set(id, cb);
    return id;
  },
  cancelAnimationFrame: (id: number) => void rafs.delete(id),
};

class VirtualDate extends real.Date {
  constructor(...a: any[]) {
    if (a.length === 0) super(epoch + vnow);
    else super(...(a as []));
  }
  static now() {
    return epoch + vnow;
  }
}

let installed = false;
let suspended = 0;

function applyVirtual() {
  g.setTimeout = virtual.setTimeout;
  g.setInterval = virtual.setInterval;
  g.clearTimeout = virtual.clearTimeout;
  g.clearInterval = virtual.clearInterval;
  g.requestAnimationFrame = virtual.requestAnimationFrame;
  g.cancelAnimationFrame = virtual.cancelAnimationFrame;
  g.Date = VirtualDate;
  performance.now = () => vnow;
}

function applyReal() {
  g.setTimeout = real.setTimeout;
  g.setInterval = real.setInterval;
  g.clearTimeout = real.clearTimeout;
  g.clearInterval = real.clearInterval;
  g.requestAnimationFrame = real.requestAnimationFrame;
  g.cancelAnimationFrame = real.cancelAnimationFrame;
  g.Date = real.Date;
  performance.now = real.performanceNow;
}

export function install() {
  if (installed) return;
  installed = true;
  applyVirtual();
}

/**
 * ランタイム自身が使うライブラリ(Mediabunnyなど)を本物の時計で動かす。
 * フレームの合間(スケッチのコードが動いていないとき)にだけ使う。
 */
export async function withRealTimers<T>(fn: () => Promise<T>): Promise<T> {
  suspended++;
  applyReal();
  try {
    return await fn();
  } finally {
    suspended--;
    if (suspended === 0 && installed) applyVirtual();
  }
}

/** 仮想時刻を ms まで進め、その間に期限が来たタイマーを順に実行し、最後にrAFを1回実行する。 */
export function advanceTo(ms: number) {
  // 前へ戻すシーク(純粋スケッチ)では、タイマーは捨てずに時刻だけ戻す
  if (ms < vnow) {
    vnow = ms;
  }
  for (let guard = 0; guard < 100000; guard++) {
    let next: Timer | null = null;
    for (const t of timers.values()) {
      if (t.due <= ms && (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq))) next = t;
    }
    if (!next) break;
    vnow = Math.max(vnow, next.due);
    if (next.interval != null) {
      next.due += next.interval;
      next.seq = seq++;
    } else {
      timers.delete(next.id);
    }
    try {
      next.cb(...next.args);
    } catch (e) {
      reportError(e);
    }
  }
  vnow = ms;
  const cbs = rafs;
  rafs = new Map();
  for (const cb of cbs.values()) {
    try {
      cb(vnow);
    } catch (e) {
      reportError(e);
    }
  }
}

let errorSink: (e: unknown) => void = (e) => console.error(e);
export function onError(fn: (e: unknown) => void) {
  errorSink = fn;
}
function reportError(e: unknown) {
  errorSink(e);
}

install();
