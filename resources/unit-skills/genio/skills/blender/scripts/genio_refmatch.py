"""Reference matching by numbers: the player's orthographic references, tagged front, side or top in
references.json, against the model's silhouette from the same view, as text review items.
genio_step.py calls match() in the step's own Blender run, on the shipped meshes; agents never import it.

Per reference:
  shape     the image's alpha when it has one, else every pixel unlike the colour round its border,
            cropped to the shape
  scale     the reference's `span` (metres across the shape, left to right), else the brief's size
            (init --size) on the view's longer stated axis, give or take 4 % for the best overlap,
            else the model's own size, give or take 15 % (proportions only: scaled to fit)
  turn      as given or mirrored (a top view also upside down), whichever overlaps more
  place     slid onto the model's silhouette where they overlap most, then moved by the parts' median
            misfit, so one misplaced part does not drag the others
The model renders once per view as a part-ID buffer (Workbench, flat, one exact colour per part, no
anti-aliasing), in the sheet's views: front from -Y (+X right), side from +X (+Y right), top from +Z
(+Y up). Then the items:
  overlap   the silhouettes' intersection over union
  parts     each part forming the outline is fitted to the reference by moving its box edges, its own
            silhouette stretched with them, while that improves the match: too wide or narrow (per cent
            and metres), too high, low, far forward or back, or one edge short of or past the reference
  missing   reference shape that no fitted part covers: its size and place in the model's metres
  extra     parts mostly where the reference has nothing
An overlay (grey both, red reference only, blue model only), one cell per view, goes to match.png
beside the sheet. Everything is information, never a gate.
"""
import contextlib
import os
import time

import bpy
import numpy
from mathutils import Matrix, Vector

import genio_bpy
import genio_parts as p
import genio_review

RES = 512  # px across a view's part-ID buffer
MARGIN = 1.2  # the model's frame in a view, of its size
BLOCK = 8  # px per block of the missing-shape search
MIN_BLOCKS = 3  # blocks in a missing shape
MISSING_SHOWN = 3  # missing shapes per view, the largest
EXTRA = 0.6  # of a part's visible pixels outside the reference: not in it
MIN_PART_PX = 30  # a part this small in a view is not judged there
FIT_PARTS = 16  # parts fitted per view, the largest first
OWN_PX = 3  # outline pixels a part needs on a side to judge that side
EDGE_PX = 2  # the least edge move reported, in px ...
EDGE_SHARE = 0.01  # ... and of the model's size in the view
SIZE_SHARE = 0.03  # the least size change reported, of the part's own size
FIT_CAP = 0.2  # of the model's size in the view: how far an edge may move
TURN_GAIN = 0.02  # a mirrored or turned image must overlap this much more than the image as given
SCALES = (0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15)  # tried without a size
BRIEF_SCALES = (0.96, 0.98, 1.0, 1.02, 1.04)  # tried on the brief's size: within its Size line's 5 %
ROUNDS = 3  # placements by the parts' median misfit
OVERLAP_TOL = 2  # points the overlap moves before the line says it again
IMAGE_MAX = 1024  # px: larger references are scaled down first
VIEWS = {  # view: (camera direction, image up, world axis along image x, along image y), as on the sheet
    'front': ((0, -1, 0), (0, 0, 1), 0, 2),
    'side': ((1, 0, 0), (0, 0, 1), 1, 2),
    'top': ((0, 0, 1), (0, 1, 0), 0, 1),
}
AXIS = 'xyz'
BIG, SMALL = ('wide', 'long', 'tall'), ('narrow', 'short', 'short')
EDGES = (('-x side', '+x side'), ('front', 'back'), ('bottom', 'top'))  # per world axis: low edge, high edge
TOO_LOW = ('too far to -x', 'too far forward', 'too low')  # a part sitting towards the low end of an axis
TOO_HIGH = ('too far to +x', 'too far back', 'too high')


def camera_basis(direction, up):
    back = Vector(direction).normalized()
    right = (-back).cross(Vector(up)).normalized()
    return right, back.cross(right), back


@contextlib.contextmanager
def scene_kept(scene, objects):
    """The ID renders' settings, camera, object colours and render visibility, undone on exit."""
    shading, render = scene.display.shading, scene.render
    keys = [(shading, k) for k in ('light', 'color_type', 'show_cavity', 'show_object_outline', 'show_shadows', 'show_specular_highlight', 'show_xray', 'show_backface_culling')]
    keys += [(scene.display, 'render_aa'), (scene.view_settings, 'view_transform'), (scene.view_settings, 'look'), (scene.view_settings, 'exposure'), (scene.view_settings, 'gamma'),
             (render, 'engine'), (render, 'resolution_x'), (render, 'resolution_y'), (render, 'resolution_percentage'), (render, 'film_transparent'), (render, 'filepath'),
             (render, 'dither_intensity'), (render.image_settings, 'file_format'), (render.image_settings, 'color_mode'), (render.image_settings, 'color_depth'), (scene, 'camera'), (scene, 'world')]
    saved = [(o, k, getattr(o, k)) for o, k in keys]
    world = scene.world
    sky = tuple(world.color) if world else None
    colours = [(o, tuple(o.color)) for o in objects]
    hidden = [(o, o.hide_render) for o in scene.objects]
    made = []
    try:
        yield made
    finally:
        for o, k, v in saved:
            with contextlib.suppress(AttributeError, TypeError, ValueError, ReferenceError):
                setattr(o, k, v)
        if world is not None:
            world.color = sky
        for o, c in colours:
            with contextlib.suppress(ReferenceError):
                o.color = c
        for o, h in hidden:
            with contextlib.suppress(ReferenceError):
                o.hide_render = h
        for block in made:
            with contextlib.suppress(ReferenceError, RuntimeError):
                if isinstance(block, bpy.types.Object):
                    data = block.data
                    bpy.data.objects.remove(block)
                    bpy.data.cameras.remove(data)
                elif isinstance(block, bpy.types.World):
                    bpy.data.worlds.remove(block)


def _setup(scene, objects, made):
    scene.render.engine = 'BLENDER_WORKBENCH'
    sh = scene.display.shading
    sh.light, sh.color_type = 'FLAT', 'OBJECT'
    sh.show_cavity = sh.show_object_outline = sh.show_shadows = sh.show_specular_highlight = sh.show_xray = sh.show_backface_culling = False
    scene.display.render_aa = 'OFF'
    scene.view_settings.view_transform = 'Raw'  # ids must reach the PNG unchanged
    scene.view_settings.look = 'None'
    scene.view_settings.exposure, scene.view_settings.gamma = 0.0, 1.0
    if scene.world is None:
        scene.world = bpy.data.worlds.new('Genio reference match')
        made.append(scene.world)
    scene.world.color = (0, 0, 0)
    r = scene.render
    r.resolution_x = r.resolution_y = RES
    r.resolution_percentage, r.film_transparent, r.dither_intensity = 100, False, 0.0
    r.image_settings.file_format, r.image_settings.color_mode, r.image_settings.color_depth = 'PNG', 'RGB', '16'
    cam = bpy.data.objects.new('Genio match camera', bpy.data.cameras.new('Genio match camera'))
    made.append(cam)
    scene.collection.objects.link(cam)
    cam.data.type = 'ORTHO'
    scene.camera = cam
    shipped = set(objects)
    for ob in scene.objects:
        ob.hide_render = ob not in shipped
    for i, ob in enumerate(objects):
        # 6 bits per channel keeps ids exact through the PNG
        ob.color = (((i + 1) & 63) * 4 / 255, (((i + 1) >> 6) & 63) * 4 / 255, 0.5, 1)


def _pixels(path, size=None, raw=False):
    """An image's RGBA rows, top first, scaled down to IMAGE_MAX (or `size`) px on its longer side first;
    `raw` reads the stored values (the ID buffers: the Raw view writes them without the sRGB curve)."""
    img = bpy.data.images.load(path, check_existing=False)
    try:
        if raw:
            img.colorspace_settings.name = 'Non-Color'
        w, h = img.size
        if not w or not h:
            raise ValueError('the image is empty or unreadable')
        most = size or IMAGE_MAX
        if max(w, h) > most:
            img.scale(max(1, round(w * most / max(w, h))), max(1, round(h * most / max(w, h))))
            w, h = img.size
        px = numpy.empty(w * h * 4, dtype=numpy.float32)
        img.pixels.foreach_get(px)
    finally:
        bpy.data.images.remove(img)
    return px.reshape(h, w, 4)[::-1]


def render_ids(objects, view, centre, span, path):
    """The view's part-ID buffer: (RES, RES) ints, rows top first, -1 for the background, else an index
    into `objects`. The scene must be set up (_setup) inside scene_kept()."""
    scene = bpy.context.scene
    cam = scene.camera
    direction, up, _, _ = VIEWS[view]
    right, upv, back = camera_basis(direction, up)
    cam.data.ortho_scale = span
    cam.data.clip_start, cam.data.clip_end = span * 1e-3, span * 10
    cam.location = Vector(centre) + back * span * 3
    cam.rotation_euler = Matrix((right, upv, back)).transposed().to_euler()
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    try:
        px = _pixels(path, RES, raw=True)
    finally:
        with contextlib.suppress(OSError):
            os.remove(path)
    ids = numpy.rint(px[..., 0] * 255 / 4).astype(numpy.int64) + (numpy.rint(px[..., 1] * 255 / 4).astype(numpy.int64) << 6) - 1
    ids[(px[..., 2] < 0.25) | (ids >= len(objects))] = -1
    return ids


def _frame(objects):
    """The shipped parts' world box (min, max), from their vertices (shipped meshes swapped in)."""
    pts = [p.world_vertices(o, o.data) for o in objects if len(o.data.vertices)]
    if not pts:
        return None
    pts = numpy.vstack(pts)
    return pts.min(axis=0), pts.max(axis=0)


def shape_of(path):
    """The reference's shape (bool rows, top first) cropped to it: the alpha when the image has one,
    else every pixel unlike the colour round its border."""
    px = _pixels(path)
    alpha = px[..., 3]
    if alpha.min() < 0.5 < alpha.max():
        shape = alpha > 0.5
    else:
        rgb = px[..., :3]
        bg = numpy.median(numpy.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]]), axis=0)
        shape = numpy.abs(rgb - bg).max(axis=2) > 0.25
    ys, xs = numpy.nonzero(shape)
    if not len(ys):
        raise ValueError('no shape in it (a silhouette or render on a plain background is needed)')
    return shape[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def _resample(shape, h, w):
    rows = ((numpy.arange(h) + 0.5) * shape.shape[0] / h).astype(numpy.intp)
    cols = ((numpy.arange(w) + 0.5) * shape.shape[1] / w).astype(numpy.intp)
    return shape[rows[:, None], cols]


def _half(mask):
    h, w = mask.shape[0] // 2 * 2, mask.shape[1] // 2 * 2
    return mask[:h, :w].reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3), dtype=numpy.float32)


def _fast(n):
    return -(-n // 32) * 32


def _offset(a, b):
    """Where b's top-left goes on a (row, column; may be negative) for the most overlap, and the overlap
    there: a linear cross-correlation by FFT, padded so nothing wraps."""
    (ha, wa), (hb, wb) = a.shape, b.shape
    s = (_fast(ha + hb), _fast(wa + wb))
    corr = numpy.fft.irfft2(numpy.fft.rfft2(a, s=s) * numpy.conj(numpy.fft.rfft2(b, s=s)), s=s)
    dy, dx = numpy.unravel_index(int(numpy.argmax(corr)), corr.shape)
    best = float(corr[dy, dx])
    return (dy - s[0] if dy > s[0] - hb else dy), (dx - s[1] if dx > s[1] - wb else dx), best


def _overlap(a, b, dy, dx):
    """Pixels of b placed at (dy, dx) on a that a has too."""
    ys, xs = max(0, dy), max(0, dx)
    ye, xe = min(a.shape[0], dy + b.shape[0]), min(a.shape[1], dx + b.shape[1])
    if ye <= ys or xe <= xs:
        return 0
    return int(numpy.count_nonzero(a[ys:ye, xs:xe] & b[ys - dy:ye - dy, xs - dx:xe - dx]))


def _turns(view):
    turns = [('', lambda s: s), ('mirrored', lambda s: s[:, ::-1])]
    return turns + ([('upside down', lambda s: s[::-1]), ('turned round', lambda s: s[::-1, ::-1])] if view == 'top' else [])


def place(model, shape, metres, mpp, view, scales=(1.0,)):
    """The reference resized to the view's pixels (`metres` per image pixel, times each of `scales`)
    and turned (_turns), with the size and turn that overlap the model most, and where it goes on the
    model's buffer: (pixels, row, column, how it was turned, scale)."""
    a2 = _half(model)
    n_model = int(model.sum())
    best = None
    for k in scales:
        h, w = max(2, round(shape.shape[0] * metres * k / mpp)), max(2, round(shape.shape[1] * metres * k / mpp))
        small = _resample(shape, h, w)
        n_ref = int(small.sum())
        for how, turn in _turns(view):
            ref = turn(small)
            dy, dx, inter = _offset(a2, _half(ref))
            iou = 4 * inter / max(1, n_model + n_ref - 4 * inter)
            gain = TURN_GAIN if how else 0.0
            if best is None or iou - gain > best[0]:
                best = (iou - gain, ref, 2 * dy, 2 * dx, how, k)
    _, ref, dy, dx, how, k = best
    # The half-size placement, refined at full size.
    score = {(y, x): _overlap(model, ref, y, x) for y in range(dy - 2, dy + 3) for x in range(dx - 2, dx + 3)}
    dy, dx = max(score, key=score.get)
    return ref, dy, dx, how, k


def _grid(ids, ref, dy, dx):
    """The model's buffer and the reference on one grid holding both: (ids, ref, row and column of the
    model's frame in it)."""
    (H, W), (h, w) = ids.shape, ref.shape
    top, left = min(0, dy), min(0, dx)
    bottom, right = max(H, dy + h), max(W, dx + w)
    g_ids = numpy.full((bottom - top, right - left), -1, dtype=ids.dtype)
    g_ids[-top:-top + H, -left:-left + W] = ids
    g_ref = numpy.zeros(g_ids.shape, dtype=bool)
    g_ref[dy - top:dy - top + h, dx - left:dx - left + w] = ref
    return g_ids, g_ref, -top, -left


def _sides(mask, model):
    """A part's outline pixels with nothing of the model beyond them: (above, below, left, right)."""
    bg = ~model
    above, below, left, right = (numpy.ones_like(bg) for _ in range(4))
    above[1:], below[:-1], left[:, 1:], right[:, :-1] = bg[:-1], bg[1:], bg[:, :-1], bg[:, 1:]
    return [int(numpy.count_nonzero(mask & beyond)) for beyond in (above, below, left, right)]


def fit(mask, model, ref, cap):
    """Moves of a part's box edges (top, bottom, left, right; px, + down or right) that make the
    silhouette, with the part's own stretched to the new box, match the reference best: edges one at a
    time, in steps of 8, 4, 2 and 1 px, while the mismatch falls. Each edge moves at most half the
    part's size or `cap` px; an edge stopped there gets None (the reference goes on: another shape).
    Also returns (the window searched as (top, bottom, left, right), the edges in it, the part's shape)
    for the fitted silhouette."""
    ys, xs = numpy.nonzero(mask)
    y0, y1, x0, x1 = int(ys.min()), int(ys.max()) + 1, int(xs.min()), int(xs.max()) + 1
    H, W = model.shape
    ly, lx = int(min(cap, max(6, (y1 - y0) // 2))), int(min(cap, max(6, (x1 - x0) // 2)))
    wy0, wy1, wx0, wx1 = max(0, y0 - ly), min(H, y1 + ly), max(0, x0 - lx), min(W, x1 + lx)
    shape = mask[y0:y1, x0:x1]
    others = (model & ~mask)[wy0:wy1, wx0:wx1]
    target = ref[wy0:wy1, wx0:wx1]
    base = others ^ target
    table = numpy.zeros((base.shape[0] + 1, base.shape[1] + 1), dtype=numpy.int64)
    table[1:, 1:] = base.cumsum(0).cumsum(1)
    total, (sh, sw) = int(table[-1, -1]), shape.shape

    def cost(e):
        a, b, c, d = e
        part = _resample(shape, b - a, d - c) if (b - a, d - c) != (sh, sw) else shape
        inside = int(table[b, d] - table[a, d] - table[b, c] + table[a, c])
        return total - inside + int(numpy.count_nonzero((others[a:b, c:d] | part) ^ target[a:b, c:d]))

    e0 = [y0 - wy0, y1 - wy0, x0 - wx0, x1 - wx0]
    lim, top = [ly, ly, lx, lx], [base.shape[0]] * 2 + [base.shape[1]] * 2
    e, best = list(e0), cost(e0)
    for step in (8, 4, 2, 1):
        moved = True
        while moved:
            moved = False
            for i in range(4):
                for s in (-step, step):
                    t = list(e)
                    t[i] += s
                    if abs(t[i] - e0[i]) > lim[i] or not 0 <= t[i] <= top[i] or t[1] - t[0] < 2 or t[3] - t[2] < 2:
                        continue
                    c = cost(t)
                    if c < best:
                        e, best, moved = t, c, True
    moves = [e[i] - e0[i] for i in range(4)]
    stopped = [abs(moves[i]) >= lim[i] or (moves[i] and e[i] in (0, top[i])) for i in range(4)]
    return [None if stopped[i] else moves[i] for i in range(4)], ((wy0, wy1, wx0, wx1), e, shape)


def _median(pairs):
    """The weighted median of (value, weight) pairs, or 0 with none."""
    pairs = sorted(pairs)
    total = sum(w for _, w in pairs)
    run = 0.0
    for v, w in pairs:
        run += w
        if run >= total / 2:
            return v
    return 0.0


class _View:
    """One reference on its view's buffer: the parts' fits and the items they make."""

    def __init__(self, ids, ref, names, mpp, view, centre, row, col):
        self.ids, self.ref, self.names, self.mpp, self.view = ids, ref, names, mpp, view
        self.model = ids >= 0
        self.centre, self.row, self.col = centre, row, col  # the model's frame centre, and the frame's place on the grid
        ys, xs = numpy.nonzero(self.model)
        across = max(numpy.ptp(xs), numpy.ptp(ys)) + 1
        self.extent = across * mpp
        self.cap = max(6, int(FIT_CAP * across))

    def world(self, r, c):
        """The model's metres (along the view's image x and y axes) at a grid pixel's corner."""
        _, _, ax, ay = VIEWS[self.view]
        u = (c - self.col - RES / 2) * self.mpp + self.centre[ax]
        v = (RES / 2 - (r - self.row)) * self.mpp + self.centre[ay]
        return u, v

    def judge(self):
        """The parts not in the reference, and each judged part's fit: {index: (moves, sides, fitted)}.
        The largest part is fitted first and each next one against the silhouette as fitted so far
        (`sil`, which only grows), so a small part does not take up what a big part's change explains."""
        counts = numpy.bincount(self.ids[self.model], minlength=len(self.names))
        outside = numpy.bincount(self.ids[self.model & ~self.ref], minlength=len(self.names))
        visible = [k for k in numpy.argsort(-counts, kind='stable') if counts[k] >= MIN_PART_PX]
        self.extra = [k for k in visible if outside[k] >= EXTRA * counts[k]]
        self.share = {k: outside[k] / counts[k] for k in self.extra}
        fits, sil = {}, self.model.copy()
        for k in [k for k in visible if k not in self.extra][:FIT_PARTS]:
            mask = self.ids == k
            moves, fitted = fit(mask, sil, self.ref, self.cap)
            (y0, y1, x0, x1), (a, b, c, d), shape = fitted
            sil[y0:y1, x0:x1][a:b, c:d] |= _resample(shape, b - a, d - c)
            fits[k] = (moves, _sides(mask, self.model), fitted)
        self.fits, self.sil = fits, sil
        return fits

    def misfit(self):
        """The parts' median shift (rows, columns), each part weighed by its outline, from the parts
        judged on both sides of an axis."""
        out = []
        for lo, hi in ((0, 1), (2, 3)):
            votes = [((m[lo] + m[hi]) / 2, s[lo] + s[hi]) for m, s, _ in self.fits.values()
                     if m[lo] is not None and m[hi] is not None and s[lo] >= OWN_PX and s[hi] >= OWN_PX]
            out.append(_median(votes))
        return out

    def items(self, size):
        out, mpp = [], self.mpp
        _, _, ax, ay = VIEWS[self.view]
        least = max(EDGE_PX * mpp, EDGE_SHARE * self.extent)
        for k, (m, s, (_, _, shape)) in self.fits.items():
            name = self.names[k]
            # per world axis: the low and the high edge's move in metres along it (+ towards +axis)
            for axis, lo, hi, extent in ((ay, -m[1] * mpp if m[1] is not None else None, -m[0] * mpp if m[0] is not None else None, shape.shape[0] * mpp),
                                         (ax, m[2] * mpp if m[2] is not None else None, m[3] * mpp if m[3] is not None else None, shape.shape[1] * mpp)):
                own = (s[1], s[0]) if axis == ay else (s[2], s[3])
                lo = lo if own[0] >= OWN_PX else None
                hi = hi if own[1] >= OWN_PX else None
                out += self._part(name, axis, lo, hi, extent, least, size)
        out += self._missing(size)
        for k in self.extra:
            out.append((float('inf'), genio_review._item(f'extra:{self.names[k]}', f'{self.names[k]} not in the reference ({round(100 * self.share[k])} % outside)',
                                                         (self.names[k],), (100 * self.share[k],), (10,))))
        out.sort(key=lambda x: -x[0])
        return [item for _, item in out]

    def _part(self, name, axis, lo, hi, extent, least, size):
        m, drift = genio_review._m, genio_review._drift
        item = genio_review._item
        if lo is not None and hi is not None:
            out, grow, shift = [], hi - lo, (lo + hi) / 2
            if abs(grow) >= max(least, SIZE_SHARE * extent):
                word = SMALL[axis] if grow > 0 else BIG[axis]
                text = f'{name} {round(100 * abs(grow) / extent)} % too {word} ({m(abs(grow))} m)'
                out.append((abs(grow), item(f'size:{name}:{AXIS[axis]}', text, (name,), (grow,), (drift(grow, size),))))
            if abs(shift) >= least:
                text = f'{name} {m(abs(shift))} m {TOO_LOW[axis] if shift > 0 else TOO_HIGH[axis]}'
                out.append((abs(shift), item(f'shift:{name}:{AXIS[axis]}', text, (name,), (shift,), (drift(shift, size),))))
            return out
        # One edge alone is noisier (a neighbour's change shows there too): twice the least move.
        for d, side, sign in ((lo, 0, -1), (hi, 1, 1)):
            if d is not None and abs(d) >= 2 * least:
                text = f"{name} {EDGES[axis][side]} {m(abs(d))} m {'short of' if d * sign > 0 else 'past'} the reference"
                return [(abs(d), item(f'edge:{name}:{AXIS[axis]}:{side}', text, (name,), (d,), (drift(d, size),)))]
        return []

    def _missing(self, size):
        """Reference shape no part covers, as built or fitted: blocks more than half missing, joined
        4-connected."""
        missing = self.ref & ~self.sil
        h, w = missing.shape[0] // BLOCK, missing.shape[1] // BLOCK
        grid = missing[:h * BLOCK, :w * BLOCK].reshape(h, BLOCK, w, BLOCK).mean(axis=(1, 3)) > 0.5
        seen, found = numpy.zeros_like(grid), []
        _, _, ax, ay = VIEWS[self.view]
        m, drift = genio_review._m, genio_review._drift
        for y0, x0 in zip(*numpy.nonzero(grid)):
            if seen[y0, x0]:
                continue
            stack, cells = [(y0, x0)], []
            seen[y0, x0] = True
            while stack:
                y, x = stack.pop()
                cells.append((y, x))
                for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                    if 0 <= ny < h and 0 <= nx < w and grid[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            if len(cells) < MIN_BLOCKS:
                continue
            cy, cx = numpy.array(cells).T
            r0, r1, c0, c1 = cy.min() * BLOCK, (cy.max() + 1) * BLOCK, cx.min() * BLOCK, (cx.max() + 1) * BLOCK
            ys, xs = numpy.nonzero(missing[r0:r1, c0:c1])
            r0, r1, c0, c1 = r0 + ys.min(), r0 + ys.max() + 1, c0 + xs.min(), c0 + xs.max() + 1
            (u0, v1), (u1, v0) = self.world(r0, c0), self.world(r1, c1)
            nums = (u1 - u0, v1 - v0, (u0 + u1) / 2, (v0 + v1) / 2)
            q = max(0.1 * size, 1e-6)
            text = f'missing {m(nums[0])} x {m(nums[1])} m at {AXIS[ax]} {m(u0)}..{m(u1)}, {AXIS[ay]} {m(v0)}..{m(v1)}'
            key = f'missing:{round(nums[2] / q)},{round(nums[3] / q)}'
            found.append((max(nums[0], nums[1]), genio_review._item(key, text, (), nums, tuple(drift(v, size) for v in nums))))
        found.sort(key=lambda x: -x[0])
        return found[:MISSING_SHOWN]

    def overlay(self):
        """grey both, red reference only, blue model only, on a dark ground; square, RES px."""
        mo, re = self.model, self.ref
        rgb = numpy.full(mo.shape + (3,), 0.16, dtype=numpy.float32)
        rgb[mo & re] = 0.6
        rgb[mo & ~re] = (0.2, 0.4, 1.0)
        rgb[re & ~mo] = (1.0, 0.25, 0.2)
        ys, xs = numpy.nonzero(mo | re)
        half = int(max(numpy.ptp(ys), numpy.ptp(xs)) * 0.54) + 2
        cy, cx = (ys.min() + ys.max()) // 2, (xs.min() + xs.max()) // 2
        rgb = numpy.pad(rgb, ((half, half), (half, half), (0, 0)), constant_values=0.16)[cy:cy + 2 * half, cx:cx + 2 * half]
        rows = ((numpy.arange(RES) + 0.5) * rgb.shape[0] / RES).astype(numpy.intp)
        return rgb[rows[:, None], rows]


def _save(path, cells):
    sheet = numpy.concatenate(cells, axis=1)
    rgba = numpy.ones(sheet.shape[:2] + (4,), dtype=numpy.float32)
    rgba[..., :3] = sheet
    img = bpy.data.images.new('Genio reference match', sheet.shape[1], sheet.shape[0], alpha=False)
    try:
        img.pixels.foreach_set(rgba[::-1].ravel())
        img.filepath_raw, img.file_format = path, 'PNG'
        img.save()
    finally:
        bpy.data.images.remove(img)


def metres_per_pixel(ref, shape, view, size):
    """Metres per pixel of the cropped shape: its `span`, else the brief's size on the view's longer
    stated axis; None when neither says (proportions only)."""
    if ref.get('span'):
        return float(ref['span']) / shape.shape[1]
    _, _, ax, ay = VIEWS[view]
    tu, tv = (size[ax], size[ay]) if size else (0, 0)
    if tu and tu >= tv:
        return tu / shape.shape[1]
    if tv:
        return tv / shape.shape[0]
    return None


def match(refs, checks, objects, out_dir):
    """Review lines for the tagged references: {'lines': [(title, items)] in genio_review's item form,
    'overlay': out_dir/match.png or None, 'warnings': [...], 'clock': ms per part of the work}. `refs`
    are the plan's ({path, view, title, span}); `objects` the shipped mesh objects with their shipped
    meshes swapped in (genio_bpy.modifiers_baked). The scene is as it was afterwards."""
    clock, mark = {}, [time.perf_counter()]

    def lap(key):
        now = time.perf_counter()
        clock[key] = round(clock.get(key, 0) + (now - mark[0]) * 1000, 1)
        mark[0] = now

    out = {'lines': [], 'overlay': None, 'warnings': [], 'clock': clock}
    box = _frame(objects)
    if box is None:
        return out
    lo, hi = box
    centre, dims = (lo + hi) / 2, hi - lo
    size = float(max(dims)) or 1.0
    expected = checks.get('size')
    scene = bpy.context.scene
    buffers, cells = {}, []
    with scene_kept(scene, objects) as made:
        _setup(scene, objects, made)
        lap('setup')
        for ref in refs:
            view = ref['view']
            try:
                shape = shape_of(ref['path'])
            except Exception as e:  # noqa: BLE001 - one unreadable reference says so and the others go on
                out['warnings'].append(f"The reference {ref.get('file', os.path.basename(ref['path']))} could not be matched: {e}.")
                continue
            lap('images')
            _, _, ax, ay = VIEWS[view]
            span = max(dims[ax], dims[ay], 1e-3) * MARGIN
            mpp = span / RES
            if view not in buffers:
                buffers[view] = render_ids(objects, view, centre, span, os.path.join(out_dir, f'.ids_{view}.png'))
                lap('render')
            ids = buffers[view]
            model = ids >= 0
            if not model.any():
                continue
            metres = metres_per_pixel(ref, shape, view, expected)
            scaled = metres is None
            if scaled:
                ys, xs = numpy.nonzero(model)
                metres = max((numpy.ptp(xs) + 1) / shape.shape[1], (numpy.ptp(ys) + 1) / shape.shape[0]) * mpp
            # A span is exact; the brief's size is a round number, and without either only proportions count.
            scales = SCALES if scaled else (1.0,) if ref.get('span') else BRIEF_SCALES
            img, dy, dx, how, _ = place(model, shape, metres, mpp, view, scales)
            for _ in range(ROUNDS):
                g_ids, g_ref, row, col = _grid(ids, img, dy, dx)
                v = _View(g_ids, g_ref, [o.name for o in objects], mpp, view, centre, row, col)
                v.judge()
                sy, sx = (round(x) for x in v.misfit())
                if not sy and not sx:
                    break
                dy, dx = dy - sy, dx - sx
            lap('fit')
            inter, union = int(numpy.count_nonzero(v.model & v.ref)), int(numpy.count_nonzero(v.model | v.ref))
            pct = 100 * inter / max(1, union)
            notes = ([f'image {how}'] if how else []) + (['scaled to fit'] if scaled else [])
            said = f'{round(pct)} % overlap' + (f" ({', '.join(notes)})" if notes else '')
            items = [genio_review._item('overlap', said, (), (pct,), (OVERLAP_TOL,))] + v.items(size)
            out['lines'].append((ref['title'], items))
            cells.append(v.overlay())
            lap('items')
    if cells:
        out['overlay'] = os.path.join(out_dir, 'match.png')
        _save(out['overlay'], cells)
        lap('overlay')
    return out


def render_reference(path, view, span=None, objects=None):
    """A black-on-white silhouette PNG of the shipped parts from a view, RES px square, framed on the
    model's centre `span` metres across (default: its size in the view times MARGIN); returns the span.
    For tests: a reference with a known answer."""
    objects = [o for o in (objects or p.export_objects()) if o.type == 'MESH']
    with p.evaluated(objects) as shipped:
        with genio_bpy.modifiers_baked(objects, shipped=shipped):
            lo, hi = _frame(objects)
            centre, dims = (lo + hi) / 2, hi - lo
            _, _, ax, ay = VIEWS[view]
            span = span or max(dims[ax], dims[ay]) * MARGIN
            scene = bpy.context.scene
            with scene_kept(scene, objects) as made:
                _setup(scene, objects, made)
                ids = render_ids(objects, view, centre, span, path + '.ids.png')
    rgb = numpy.where((ids >= 0)[..., None], 0.0, 1.0).astype(numpy.float32).repeat(3, axis=2)
    _save(path, [rgb])
    return span
