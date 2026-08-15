# Build an 8th Wall image target from any photo, LOCALLY. No backend needed.
#
#   python make-target-local.py assets/box/lc-spiderman-lid.jpg lc-box
#
# Why this can exist: a "compiled" target from the MIXR backend is not a feature
# bundle, it is just a GRAYSCALE 480x640 PNG plus crop metadata. Verified by
# opening all three known-good targets:
#
#   mixr-demo     lum 480x640  crop 480x640 at (80,0) of 640x640   isRotated True
#   jox2-contact  lum 480x640  crop 480x640 at (0,86) of 480x812   isRotated False
#   jox2-brand    lum 480x640  crop 500x667 at (0,90) of 500x846   isRotated False
#
# Every luminance image is 480x640 regardless of the crop size, so the recipe is:
# take the largest centred 3:4 portrait crop, resize to 480x640, desaturate. The
# engine extracts ORB features from that PNG itself at load time.
#
# This follows the jox2 pattern exactly (portrait crop, isRotated False), which
# is the simpler and better understood of the two shapes.
#
# The backend version also returns a 0-5 tracking quality score, which this does
# not. Prefer compile-target.mjs when the service is up; this exists so a dead
# backend never blocks a phone test again.

import json, sys, time
from pathlib import Path
from PIL import Image, ImageOps

LUM_W, LUM_H = 480, 640
ASPECT = LUM_W / LUM_H            # 0.75, portrait 3:4

src_arg = sys.argv[1] if len(sys.argv) > 1 else 'assets/box/lc-spiderman-lid.jpg'
name    = sys.argv[2] if len(sys.argv) > 2 else 'lc-box'

root = Path(__file__).parent
src  = root / src_arg
if not src.exists():
    print(f'not found: {src}')
    print('Save the box photo there first, then re-run.')
    sys.exit(1)

im = Image.open(src)
im = ImageOps.exif_transpose(im)          # honour the phone's rotation tag
ow, oh = im.size

# largest centred 3:4 portrait crop
if ow / oh > ASPECT:                       # too wide, trim the sides
    cw = int(round(oh * ASPECT)); ch = oh
else:                                      # too tall, trim top and bottom
    cw = ow; ch = int(round(ow / ASPECT))
left = (ow - cw) // 2
top  = (oh - ch) // 2

crop = im.crop((left, top, left + cw, top + ch))
lum  = crop.convert('L').resize((LUM_W, LUM_H), Image.LANCZOS).convert('RGB')

out_dir = root / 'assets' / 'image-target'
out_dir.mkdir(parents=True, exist_ok=True)
lum_name = f'{name}_luminance.png'
lum.save(out_dir / lum_name, 'PNG', optimize=True)

now = int(time.time() * 1000)
target = {
    'imagePath': f'assets/image-target/{lum_name}',
    'metadata': None,
    'name': name,
    'type': 'PLANAR',
    'properties': {
        'left': left, 'top': top,
        'width': cw, 'height': ch,
        'isRotated': False,
        'originalWidth': ow, 'originalHeight': oh,
    },
    'resources': {
        'originalImage': f'{name}_original.png',
        'croppedImage': f'{name}_cropped.png',
        'thumbnailImage': f'{name}_thumbnail.png',
        'luminanceImage': lum_name,
    },
    'created': now, 'updated': now,
}
(out_dir / f'{name}.json').write_text(json.dumps(target, indent=2), encoding='utf-8')

# a rough feature-density read, so a hopeless target is obvious before the phone
import statistics
small = lum.convert('L').resize((120, 160))
px = list(small.tobytes())
edges = 0
for y in range(1, 159):
    for x in range(1, 119):
        i = y * 120 + x
        if abs(px[i] - px[i - 1]) > 18 or abs(px[i] - px[i - 120]) > 18:
            edges += 1
density = edges / (118 * 158) * 100

print(f'source     {ow}x{oh}')
print(f'crop       {cw}x{ch} at ({left},{top})')
print(f'wrote      assets/image-target/{name}.json + {lum_name}')
print(f'contrast   stdev {statistics.pstdev(px):.1f}')
print(f'edge density {density:.1f}%  ', end='')
print('good target' if density > 12 else ('usable' if density > 6 else 'WEAK, expect poor tracking'))
