/** 字幕時間軸波形：跨工作區切換時重用已解碼峰值，避免重複 readFile + decode */
const MAX_ENTRIES = 4;

const cache = new Map<string, Float32Array>();
/** LRU 鍵序（最前者最舊） */
const lruKeys: string[] = [];

const inflight = new Map<string, Promise<Float32Array>>();

function touchKey(key: string) {
  const i = lruKeys.indexOf(key);
  if (i >= 0) lruKeys.splice(i, 1);
  lruKeys.push(key);
}

function evictIfNeeded() {
  while (lruKeys.length > MAX_ENTRIES) {
    const drop = lruKeys.shift();
    if (drop) cache.delete(drop);
  }
}

export function waveformPeaksCacheKey(
  mediaPath: string | null | undefined,
  mediaSrc: string | null | undefined,
  barCount: number,
): string | null {
  const p = mediaPath?.trim();
  if (p) return `${barCount}\0path:${p}`;
  const s = mediaSrc?.trim();
  if (s) return `${barCount}\0src:${s}`;
  return null;
}

export function getCachedWaveformPeaks(key: string): Float32Array | undefined {
  const peaks = cache.get(key);
  if (peaks) touchKey(key);
  return peaks;
}

export function setCachedWaveformPeaks(key: string, peaks: Float32Array) {
  cache.set(key, peaks);
  touchKey(key);
  evictIfNeeded();
}

export function getOrComputeWaveformPeaks(
  key: string,
  compute: () => Promise<Float32Array>,
): Promise<Float32Array> {
  const hit = cache.get(key);
  if (hit) {
    touchKey(key);
    return Promise.resolve(hit);
  }
  let p = inflight.get(key);
  if (!p) {
    p = compute()
      .then((peaks) => {
        inflight.delete(key);
        setCachedWaveformPeaks(key, peaks);
        return peaks;
      })
      .catch((e) => {
        inflight.delete(key);
        throw e;
      });
    inflight.set(key, p);
  }
  return p;
}
