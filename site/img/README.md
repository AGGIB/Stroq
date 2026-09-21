# site/img

## desk.avif, desk.webp — the hero desktop wallpaper

**Painting:** James McNeill Whistler (American, 1834–1903), *Nocturne: Blue and
Gold—Southampton Water*, 1872. Art Institute of Chicago, Stickney Fund,
accession 1900.52.

**Licence: public domain.** The Art Institute of Chicago reports
`is_public_domain: true` for artwork 56905
(`https://api.artic.edu/api/v1/artworks/56905`), and the artist died in 1903, so
the work is out of copyright worldwide under life + 70 years. The file used here
is the Google Art Project scan on Wikimedia Commons, also tagged public domain:

  https://commons.wikimedia.org/wiki/File:James_McNeill_Whistler_-_Nocturne-_Blue_and_Gold--Southampton_Water_-_Google_Art_Project.jpg

**How these files were made.** From the 3840×2540 Commons scan, with `sharp`:

```js
sharp(src)
  .extract({ left: 1007, top: 150, width: 2600, height: 1625 })
  .resize(1400, 875, { fit: 'cover' })
  .modulate({ brightness: 1.34, saturation: 1.34 })
  .linear(1.14, -2)
```

then `.avif({ quality: 44, effort: 7 })` and `.webp({ quality: 58, effort: 6 })`.

The crop puts the gold sail about a tenth of the way in from the left, which is
the band of the painting the editor window leaves uncovered. The brightening is
not a stylistic whim: the window on top of it is dark, and the desktop has to be
the lighter surface or the composition reads as a dark panel on a dark panel.

Quality was chosen by looking, not by habit — at 1:1 on the visible band, q38,
q44 and q50 are near indistinguishable, and q50 costs 88 KB against q44's 39 KB.

`sharp` is deliberately **not** a dependency of this repo: the asset is built
once, out of tree, and committed. Rebuilding needs only a scratch
`npm install sharp` and the snippet above.
