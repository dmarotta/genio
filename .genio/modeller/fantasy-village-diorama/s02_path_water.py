"""Laying a winding dirt path, a little stream and a pond"""
import math
dirt = p.material('Dirt', '#b08a5a', rough=0.95)
water = p.material('Water', '#4d9ccf', rough=0.15)
bank = p.material('Bank', '#8a6a44', rough=0.95)
ground = p.collection('Ground')
TOP = 0.195


def ribbon(prefix, pts, width, z, mat, thick=0.012, segs=8):
    # boxes between points, discs at joints: a cheap, clean winding strip
    for i, (x, y) in enumerate(pts):
        p.cylinder(f'{prefix}_j{i:02d}', width / 2, thick, loc=(x, y, z), mat=mat, segments=segs, col=ground)
        if i + 1 < len(pts):
            nx, ny = pts[i + 1]
            length = math.hypot(nx - x, ny - y)
            ang = math.atan2(ny - y, nx - x)
            p.box(f'{prefix}_s{i:02d}', (length, width, thick), loc=((x + nx) / 2, (y + ny) / 2, z),
                  rot=(0, 0, ang), mat=mat, col=ground)


# main path: front edge up to the little square, on to the tavern
ribbon('path_main', [(-0.02, -0.87), (0.06, -0.7), (-0.06, -0.45), (0.0, -0.2), (0.0, 0.0),
                      (-0.1, 0.22), (-0.12, 0.36)], 0.13, TOP + 0.004, dirt)
# little square round the well
p.cylinder('path_square', 0.2, 0.012, loc=(0.0, -0.02, TOP + 0.005), mat=dirt, segments=10, col=ground)
# branch west to the windmill
ribbon('path_west', [(-0.12, 0.05), (-0.35, 0.12), (-0.5, 0.28)], 0.1, TOP + 0.003, dirt)
# branch east over the stream to the far cottages
# (it stops at the banks; the bridge spans the gap)
ribbon('path_east', [(0.14, 0.04), (0.37, 0.12)], 0.1, TOP + 0.003, dirt)
ribbon('path_far', [(0.6, 0.15), (0.76, 0.1)], 0.1, TOP + 0.003, dirt)

# stream from a spring near the back edge down to the pond
STREAM = [(0.36, 0.78), (0.5, 0.62), (0.56, 0.42), (0.48, 0.14), (0.5, -0.12), (0.46, -0.3)]
ribbon('stream_bank', STREAM, 0.15, TOP + 0.002, bank, thick=0.01)
ribbon('stream', STREAM, 0.1, TOP + 0.006, water, thick=0.01)
# pond
p.cylinder('pond_bank', 0.26, 0.01, loc=(0.42, -0.42, TOP + 0.002), mat=bank, segments=12, col=ground)
p.cylinder('pond', 0.22, 0.012, loc=(0.42, -0.42, TOP + 0.006), mat=water, segments=12, col=ground)
