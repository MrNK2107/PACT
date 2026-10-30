// Offline recorder for the sim3d demo scenes: steps the page's virtual clock one frame at a time
// (?offline, src/app/offline.ts) and pipes a screenshot of every frame into ffmpeg.
//   node rec.mjs <scene> <out.mp4> [fps=30] [maxSeconds=240]
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const [scene, out, fpsArg, maxArg] = process.argv.slice(2);
if (!scene || !out) {
  console.error('usage: node rec.mjs <scene> <out.mp4> [fps] [maxSeconds]');
  process.exit(2);
}
const fps = Number(fpsArg ?? 30);
const maxFrames = Number(maxArg ?? 240) * fps;
const W = Number(process.env.REC_W ?? 1920), H = Number(process.env.REC_H ?? 1080);
const BASE = process.env.PACT_URL ?? 'http://localhost:5173';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader=false'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(`${BASE}/?demo=${scene}&once&offline${process.env.PACT_QUERY ?? ""}`);
// the demo redirects to the scene's own URL first
await page.waitForFunction((s) => window.__demoScene === s && window.pactRender, scene, { timeout: 60000 });
const gpu = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const i = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return i ? gl.getParameter(i.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log(`scene ${scene}: renderer ${gpu}`);

const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
  '-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '18', '-pix_fmt', 'yuv420p', out], { stdio: ['pipe', 'inherit', 'inherit'] });
const cdp = await page.context().newCDPSession(page);
let frames = 0, skipped = 0;
const t0 = Date.now();
while (frames < maxFrames) {
  const r = await page.evaluate((dt) => window.pactRender.step(dt), 1 / fps);
  if (r.busy) { skipped++; continue; }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 93 });
  if (!ff.stdin.write(Buffer.from(shot.data, 'base64'))) await new Promise((res) => ff.stdin.once('drain', res));
  frames++;
  if (frames % (fps * 10) === 0) console.log(`  ${frames / fps}s of video, sim t=${(await page.evaluate(() => window.pact.time())).toFixed(0)}, ${((Date.now() - t0) / 1000).toFixed(0)}s wall`);
  if (await page.evaluate(() => window.__demoDone)) break;
}
ff.stdin.end();
await new Promise((res) => ff.on('close', res));
const counts = await page.evaluate(() => ({ t: window.pact.time(), ...window.pact.counts(), hash: window.pact.hash() }));
console.log(`scene ${scene}: ${frames} frames (${(frames / fps).toFixed(1)} s), ${skipped} busy steps, ${((Date.now() - t0) / 1000).toFixed(0)} s wall`, JSON.stringify(counts));
await browser.close();
