// Rebuild the candy I/ME PNGs using the original lettering and heart alpha.
// Uses installed Edge and Node only; no packages or network access required.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../public/embedded/heart-star/', import.meta.url);
const scope = {};
new Function('globalThis', readFileSync(new URL('candy-motifs.js', root), 'utf8'))(scope);
const patterns = scope.HeartStarCandy.register();
const keys = ['blue-cocoa', 'strawberry-milk', 'lemon-soda', 'grape-checker', 'peach-heart', 'cream-pink-dot', 'strawberry-star', 'grape-dot', 'peach-sorbet', 'daisy'];
const original = 'data:image/png;base64,' + readFileSync(new URL('assets/ime-brown-polka.png', root)).toString('base64');
const profile = mkdtempSync(join(tmpdir(), 'pic-candy-generate-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
let socket, next = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 20000);
  pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
  socket.send(JSON.stringify({ id, method, params }));
});
try {
  let port;
  for (let i = 0; i < 200; i++) {
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]; break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  if (!port) throw Error('Edge did not start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data), p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); }
  });
  for (const key of keys) {
    const expression = `(${async (original, pattern) => {
      const load = async src => { const image = new Image(); image.src = src; await image.decode(); return image; };
      const [image, texture] = await Promise.all([load(original), load(pattern)]);
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
      const source = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const left = Math.floor(canvas.width / 4 * .4) * 4, bottom = Math.floor(canvas.height / 4 * .52) * 4;
      let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0;
      for (let y = 0; y < bottom; y++) for (let x = left; x < canvas.width; x++) if (source.data[(y * canvas.width + x) * 4 + 3]) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Extend the vector paint past its silhouette; the original alpha defines the final heart.
      // This covers small differences between the two heart outlines without a colored fringe.
      const svg = decodeURIComponent(pattern.slice(pattern.indexOf(',') + 1));
      const paintSvg = svg.replace(/<g fill="url\(#texture\)">[\s\S]*<\/g><\/svg>$/, '<rect width="1000" height="950" fill="url(#texture)"/></svg>');
      const paint = await load('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(paintSvg));
      ctx.drawImage(paint, minX, minY, maxX - minX + 1, maxY - minY + 1);
      const colors = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let y = 0; y < bottom; y++) for (let x = left; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (source.data[i + 3]) for (let c = 0; c < 3; c++) source.data[i + c] = colors[i + c];
      }
      ctx.putImageData(source, 0, 0);
      return canvas.toDataURL('image/png');
    }})(${JSON.stringify(original)},${JSON.stringify((patterns[`candy-${key}-heart-20`] || patterns[`candy-${key}-heart-30`]).src)})`;
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    const path = new URL(`assets/ime-candy-${key}.png`, root);
    writeFileSync(path, Buffer.from(result.result.value.split(',')[1], 'base64'));
    console.log('Generated ' + fileURLToPath(path));
  }
} finally {
  socket?.close(); browser.kill();
}
