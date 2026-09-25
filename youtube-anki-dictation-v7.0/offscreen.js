let stream = null;
let audioContext = null;
let source = null;
let workletNode = null;
let silentGain = null;
let ring = [];
let totalSamples = 0;
let maxSamples = 0;
let sampleRate = 48000;
let absoluteSamplesWritten = 0;
let timelineMarkers = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;
  (async () => {
    if (message.type === 'OFFSCREEN_START') return await start(message.streamId, message.maxSeconds || 60);
    if (message.type === 'OFFSCREEN_CAPTURE') return capture(message.seconds || 8);
    if (message.type === 'OFFSCREEN_CAPTURE_RANGE') {
      return captureRange(message.startAgoSeconds, message.endAgoSeconds);
    }
    if (message.type === 'OFFSCREEN_TIMELINE_SYNC') {
      return syncTimeline(message);
    }
    if (message.type === 'OFFSCREEN_CAPTURE_VIDEO_RANGE') {
      return captureVideoRange(message.startVideoTime, message.endVideoTime);
    }
    if (message.type === 'OFFSCREEN_STOP') return await stop();
    return { ok: false, error: 'Unknown offscreen message' };
  })().then(sendResponse).catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;
});

async function start(streamId, maxSeconds) {
  await stopAudioOnly();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  audioContext = new AudioContext();
  await audioContext.resume();
  sampleRate = audioContext.sampleRate;
  maxSamples = Math.floor(sampleRate * Math.max(15, Math.min(90, Number(maxSeconds) || 60)));
  ring = [];
  totalSamples = 0;
  absoluteSamplesWritten = 0;
  timelineMarkers = [];

  source = audioContext.createMediaStreamSource(stream);
  source.connect(audioContext.destination);

  await audioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-worklet.js'));
  workletNode = new AudioWorkletNode(audioContext, 'anki-ring-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1]
  });
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;

  workletNode.port.onmessage = (event) => {
    const data = event.data;
    const copy = data instanceof Float32Array ? data : new Float32Array(data);
    if (!copy.length) return;
    ring.push(copy);
    totalSamples += copy.length;
    absoluteSamplesWritten += copy.length;
    while (totalSamples > maxSamples && ring.length > 1) {
      const removed = ring.shift();
      totalSamples -= removed.length;
    }
    trimTimelineMarkers();
  };

  source.connect(workletNode);
  workletNode.connect(silentGain);
  silentGain.connect(audioContext.destination);
  return { ok: true, sampleRate };
}

function syncTimeline(message) {
  if (!audioContext) return { ok: false, error: '録音が開始されていません' };
  let currentTime = Number(message.currentTime);
  const playbackRate = Math.max(0.05, Number(message.playbackRate || 1));
  const paused = !!message.paused;
  const sentAtMs = Number(message.sentAtMs);
  const receivedAtMs = Date.now();
  if (!Number.isFinite(currentTime)) return { ok: false, error: '動画時刻が不正です' };

  // content -> background -> offscreen の通信遅延だけ再生時刻を前進させる。
  // 極端な遅延は補正せず、誤ったシーク判定を避ける。
  if (!paused && Number.isFinite(sentAtMs)) {
    const latency = Math.max(0, Math.min(0.75, (receivedAtMs - sentAtMs) / 1000));
    currentTime += latency * playbackRate;
  }

  const marker = {
    sampleIndex: absoluteSamplesWritten,
    videoTime: Math.max(0, currentTime),
    playbackRate,
    paused,
    receivedAtMs
  };
  const last = timelineMarkers[timelineMarkers.length - 1];
  if (!last || marker.sampleIndex !== last.sampleIndex || Math.abs(marker.videoTime - last.videoTime) > 0.001 || marker.paused !== last.paused) {
    timelineMarkers.push(marker);
  }
  trimTimelineMarkers();
  return { ok: true, markerCount: timelineMarkers.length };
}

function ringStartAbsoluteSample() {
  return absoluteSamplesWritten - totalSamples;
}

function trimTimelineMarkers() {
  if (!timelineMarkers.length) return;
  const floor = ringStartAbsoluteSample() - Math.round(sampleRate * 2);
  let keepFrom = 0;
  while (keepFrom + 1 < timelineMarkers.length && timelineMarkers[keepFrom + 1].sampleIndex < floor) keepFrom++;
  if (keepFrom > 0) timelineMarkers = timelineMarkers.slice(keepFrom);
  if (timelineMarkers.length > 1200) timelineMarkers = timelineMarkers.slice(-1200);
}

function splitTimelineRuns() {
  const markers = timelineMarkers.filter(m => Number.isFinite(m.sampleIndex) && Number.isFinite(m.videoTime));
  if (markers.length < 2) return [];
  const runs = [];
  let current = [markers[0]];
  for (let i = 1; i < markers.length; i++) {
    const a = markers[i - 1];
    const b = markers[i];
    const ds = (b.sampleIndex - a.sampleIndex) / Math.max(1, sampleRate);
    const dv = b.videoTime - a.videoTime;
    let discontinuity = ds <= 0;
    if (!discontinuity) {
      // 逆方向はシーク。前方向でも実時間に対して速すぎる増分はシークとみなす。
      if (dv < -0.08) discontinuity = true;
      else if (dv > 0.12 && dv / ds > 5.5) discontinuity = true;
    }
    if (discontinuity) {
      if (current.length >= 2) runs.push(current);
      current = [b];
    } else {
      current.push(b);
    }
  }
  if (current.length >= 2) runs.push(current);
  return runs;
}

function mapVideoTimeInRun(run, target) {
  // 後ろから探すことで、同じrun内でも最も新しい通常再生セグメントを使う。
  for (let i = run.length - 2; i >= 0; i--) {
    const a = run[i];
    const b = run[i + 1];
    const dsSamples = b.sampleIndex - a.sampleIndex;
    if (dsSamples <= 0) continue;
    const ds = dsSamples / Math.max(1, sampleRate);
    const dv = b.videoTime - a.videoTime;
    if (dv <= 0.002) continue; // pause/silence plateau
    const ratio = dv / ds;
    if (ratio < 0.08 || ratio > 5.5) continue;
    const lo = Math.min(a.videoTime, b.videoTime) - 0.015;
    const hi = Math.max(a.videoTime, b.videoTime) + 0.015;
    if (target < lo || target > hi) continue;
    const frac = Math.max(0, Math.min(1, (target - a.videoTime) / dv));
    return a.sampleIndex + frac * dsSamples;
  }
  return null;
}

function captureVideoRange(startVideoTime, endVideoTime) {
  if (!audioContext || !ring.length) return { ok: false, error: '録音バッファがまだありません' };
  let startVideo = Number(startVideoTime);
  let endVideo = Number(endVideoTime);
  if (!Number.isFinite(startVideo) || !Number.isFinite(endVideo)) {
    return { ok: false, error: '動画タイムコードが不正です' };
  }
  startVideo = Math.max(0, startVideo);
  endVideo = Math.max(0, endVideo);
  if (endVideo < startVideo) [startVideo, endVideo] = [endVideo, startVideo];
  if (endVideo - startVideo < 0.08) endVideo = startVideo + 0.08;

  const runs = splitTimelineRuns();
  let mapped = null;
  // シークや巻き戻しで同じ時刻を複数回再生していても、開始と終了を同じ連続再生runから取る。
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    const startSample = mapVideoTimeInRun(run, startVideo);
    const endSample = mapVideoTimeInRun(run, endVideo);
    if (Number.isFinite(startSample) && Number.isFinite(endSample) && endSample > startSample) {
      mapped = { startSample, endSample, runIndex: i };
      break;
    }
  }
  if (!mapped) {
    return {
      ok: false,
      error: '指定した動画タイムコードの連続再生区間が録音バッファにありません。選択箇所を一度再生してから保存してください',
      markerCount: timelineMarkers.length,
      runCount: runs.length
    };
  }

  const ringStart = ringStartAbsoluteSample();
  const startAbs = Math.round(mapped.startSample);
  const endAbs = Math.round(mapped.endSample);
  if (startAbs < ringStart || endAbs > absoluteSamplesWritten) {
    return {
      ok: false,
      error: '指定した動画区間の音声が録音バッファ外です。選択箇所を再生し直してから保存してください',
      availableSeconds: totalSamples / sampleRate
    };
  }
  const all = flattenRing();
  const start = Math.max(0, startAbs - ringStart);
  const end = Math.min(all.length, endAbs - ringStart);
  if (end <= start) return { ok: false, error: '動画タイムコードから音声範囲を作れませんでした' };
  const pcm = all.slice(start, end);
  const result = encodeResult(pcm, false);
  result.videoStart = startVideo;
  result.videoEnd = endVideo;
  result.timelineMapped = true;
  result.markerCount = timelineMarkers.length;
  result.runIndex = mapped.runIndex;
  return result;
}

function capture(seconds) {
  if (!audioContext || !ring.length) return { ok: false, error: '録音バッファがまだありません' };
  const wanted = Math.max(1, Math.floor(sampleRate * Math.max(1, Number(seconds) || 8)));
  const all = flattenRing();
  const start = Math.max(0, all.length - wanted);
  const pcm = all.slice(start);
  return encodeResult(pcm, start === 0 && all.length < wanted);
}

function captureRange(startAgoSeconds, endAgoSeconds) {
  if (!audioContext || !ring.length) return { ok: false, error: '録音バッファがまだありません' };
  let startAgo = Number(startAgoSeconds);
  let endAgo = Number(endAgoSeconds);
  if (!Number.isFinite(startAgo) || !Number.isFinite(endAgo)) {
    return { ok: false, error: '音声範囲の時刻が不正です' };
  }
  startAgo = Math.max(0, startAgo);
  endAgo = Math.max(0, endAgo);
  if (startAgo < endAgo) [startAgo, endAgo] = [endAgo, startAgo];
  if (startAgo - endAgo < 0.08) startAgo = endAgo + 0.08;

  const all = flattenRing();
  const requestedStart = all.length - Math.round(startAgo * sampleRate);
  const requestedEnd = all.length - Math.round(endAgo * sampleRate);
  const start = Math.max(0, Math.min(all.length, requestedStart));
  const end = Math.max(start, Math.min(all.length, requestedEnd));
  if (end <= start) return { ok: false, error: '指定した音声範囲が録音バッファ外です' };

  const pcm = all.slice(start, end);
  const clippedStart = requestedStart < 0;
  const clippedEnd = requestedEnd > all.length;
  const result = encodeResult(pcm, clippedStart || clippedEnd);
  result.requestedStartAgo = startAgo;
  result.requestedEndAgo = endAgo;
  result.availableSeconds = all.length / sampleRate;
  result.clippedStart = clippedStart;
  result.clippedEnd = clippedEnd;
  return result;
}

function flattenRing() {
  const all = new Float32Array(totalSamples);
  let offset = 0;
  for (const chunk of ring) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return all;
}

function encodeResult(pcm, clipped = false) {
  const wav = encodeWav16Mono(pcm, sampleRate);
  return {
    ok: true,
    data: uint8ToBase64(new Uint8Array(wav)),
    sampleRate,
    seconds: pcm.length / sampleRate,
    clipped
  };
}

async function stopAudioOnly() {
  try { if (workletNode) workletNode.port.onmessage = null; } catch {}
  try { source?.disconnect(); } catch {}
  try { workletNode?.disconnect(); } catch {}
  try { silentGain?.disconnect(); } catch {}
  try { stream?.getTracks().forEach(t => t.stop()); } catch {}
  try { if (audioContext && audioContext.state !== 'closed') await audioContext.close(); } catch {}
  stream = null;
  audioContext = null;
  source = null;
  workletNode = null;
  silentGain = null;
  ring = [];
  totalSamples = 0;
  absoluteSamplesWritten = 0;
  timelineMarkers = [];
}

async function stop() {
  await stopAudioOnly();
  return { ok: true };
}

function encodeWav16Mono(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let p = 44;
  for (let i = 0; i < samples.length; i++, p += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
