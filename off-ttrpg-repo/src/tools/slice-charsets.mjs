// CharSet slicer — one-time conversion of RM2k charset sheets (288×256,
// eight 72×128 characters of 3×4 × 24×32 frames) into individual sprite
// sheets for the NPC hot folder (assets/sprites/npcs/), with the sheet's
// keyed background color converted to real transparency (sampled at 0,0).
// Empty slots are skipped. Frame row order (up/right/down/left) matches the
// engine's convention as-is.
//
// Dev tool: needs the server running on :8420 and Playwright.
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const SRC = fileURLToPath(new URL('../../assets/level creation/CharSet/', import.meta.url));
const OUT = fileURLToPath(new URL('../../assets/sprites/npcs/', import.meta.url));

mkdirSync(OUT, { recursive: true });
const sheets = readdirSync(SRC).filter(f => /\.png$/i.test(f));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
await page.goto('http://localhost:8420/');

let written = 0;
for (const sheet of sheets) {
  const slots = await page.evaluate(async file => {
    const img = new Image();
    img.src = `/assets/level creation/CharSet/${encodeURIComponent(file)}`;
    await img.decode();
    const full = document.createElement('canvas');
    full.width = img.width; full.height = img.height;
    const fx = full.getContext('2d');
    fx.drawImage(img, 0, 0);
    const key = fx.getImageData(0, 0, 1, 1).data;
    const out = [];
    for (let slot = 0; slot < 8; slot++) {
      const sx = (slot % 4) * 72, sy = Math.floor(slot / 4) * 128;
      const c = document.createElement('canvas');
      c.width = 72; c.height = 128;
      const x = c.getContext('2d');
      x.drawImage(img, sx, sy, 72, 128, 0, 0, 72, 128);
      const idat = x.getImageData(0, 0, 72, 128);
      const d = idat.data;
      let opaque = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] === key[0] && d[i + 1] === key[1] && d[i + 2] === key[2]) d[i + 3] = 0;
        else if (d[i + 3] > 0) opaque++;
      }
      if (opaque < 40) { out.push(null); continue; }   // empty slot
      x.putImageData(idat, 0, 0);
      out.push(c.toDataURL());
    }
    return out;
  }, sheet);
  const base = sheet.replace(/\.png$/i, '');
  slots.forEach((url, i) => {
    if (!url) return;
    writeFileSync(path.join(OUT, `${base}-${i + 1}.png`), Buffer.from(url.split(',')[1], 'base64'));
    written++;
  });
  console.log(`${sheet}: ${slots.filter(Boolean).length} characters`);
}
console.log(`wrote ${written} NPC sprites to assets/sprites/npcs/`);
await browser.close();
