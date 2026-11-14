// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
// Hidden window: grabs the screen, scales it down, turns it into JPEGs and hands them to the main process.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cheap fingerprint of a JPEG, so an unchanged screen is not sent again and again. */
function fingerprint(u8) {
  let h = 2166136261 >>> 0;
  const step = Math.max(1, (u8.length / 4096) | 0);
  for (let i = 0; i < u8.length; i += step) h = Math.imul(h ^ u8[i], 16777619) >>> 0;
  return h ^ u8.length;
}

window.cap.onStart(async (o) => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: o.sourceId, maxFrameRate: o.fps } },
    });
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    const interval = 1000 / o.fps;
    let lastPrint = 0, lastSent = 0;
    for (;;) {
      const t0 = performance.now();
      const vw = video.videoWidth, vh = video.videoHeight;
      if (vw && vh) {
        const k = Math.min(1, o.maxDim / Math.max(vw, vh));
        const w = Math.round(vw * k), h = Math.round(vh * k);
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        ctx.drawImage(video, 0, 0, w, h);
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', o.quality));
        if (blob) {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const fp = fingerprint(bytes);
          if (fp !== lastPrint || t0 - lastSent > 1000) { // identical picture: only a keep-alive once a second
            const sent = await window.cap.frame(bytes, w, h);
            if (sent) { lastPrint = fp; lastSent = t0; } else await sleep(80); // the connection is busy: ease off
          }
        }
      }
      await sleep(Math.max(0, interval - (performance.now() - t0)));
    }
  } catch (e) {
    window.cap.failed((e && e.message) || e);
  }
});
