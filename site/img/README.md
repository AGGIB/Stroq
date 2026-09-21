# site/img

## desk.avif, desk.webp — the hero desktop wallpaper

**Authored here.** A Sequoia-style desktop: a deep diagonal gradient with four
blurred light ribbons drifting across it.

**Why not an actual macOS wallpaper.** Apple's desktop pictures are copyrighted
files. Shipping one from this site would be redistributing Apple's artwork
without a licence, so this is an original image built to read the same way.
Nothing here is derived from an Apple asset.

**How to rebuild it.** The image is a single SVG, rasterised. No dependency is
needed to read it; `sharp` (or any SVG rasteriser) turns it into the AVIF and
WebP that ship:

```js
const W = 1400, H = 875;
const D = {
  a: 'M-150,760 C250,560 520,880 900,600 C1180,395 1330,470 1560,300',
  b: 'M-150,620 C220,430 560,720 930,450 C1210,245 1340,330 1560,170',
  c: 'M-150,880 C300,700 600,980 980,720 C1250,535 1380,600 1560,450',
  d: 'M-150,470 C260,300 600,560 960,300 C1220,115 1360,190 1560,40',
};
const base = ['#081029', '#131746', '#2a1550', '#4b163c'];
const bands = [
  { d: D.a, c: '#3f74ff', w: 130, o: 0.62 },
  { d: D.b, c: '#2fd3ff', w: 92,  o: 0.46 },
  { d: D.c, c: '#cc46e8', w: 150, o: 0.54 },
  { d: D.d, c: '#ff7ab0', w: 78,  o: 0.30 },
];
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0.1" y1="0" x2="0.8" y2="1">
      ${base.map((c, i) => `<stop offset="${(i / (base.length - 1)).toFixed(2)}" stop-color="${c}"/>`).join('')}
    </linearGradient>
    <filter id="b" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="22"/>
    </filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <g filter="url(#b)" style="mix-blend-mode:screen">
    ${bands.map(b => `<path d="${b.d}" fill="none" stroke="${b.c}" stroke-width="${b.w}" stroke-linecap="round" opacity="${b.o}"/>`).join('')}
  </g>
</svg>`;
// sharp(Buffer.from(svg)).avif({ quality: 58, effort: 7 }).toFile('desk.avif')
// sharp(Buffer.from(svg)).webp({ quality: 82, effort: 6 }).toFile('desk.webp')
```

The ribbons are **stroked curves, not filled slabs**: a stroke keeps a readable
edge through the blur, which is what makes the shapes read as ribbons instead of
as a smear. An earlier attempt with filled paths and a 72–120px blur dissolved
into flat horizontal bands.

A synthetic gradient compresses far better than a photograph: 5.8 KB of AVIF
against the 39 KB the previous painted wallpaper cost.

The stage adds a grain overlay in CSS, which also keeps a smooth gradient of
this size from banding in 8-bit.
