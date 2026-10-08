# WebTranslatePlace icons

The shared icon source is `wtp.svg` in the project root. All browser variants use
PNG exports at 16, 32, 48 and 128 pixels for the toolbar and extension manager.

Regenerate them with ImageMagick from the repository root:

```bash
for size in 16 32 48 128; do
  magick -background none -density 384 wtp.svg -resize "${size}x${size}" "src/icons/icon${size}.png"
done
```

Then run `python3 scripts/build.py` to update all browser packages.
