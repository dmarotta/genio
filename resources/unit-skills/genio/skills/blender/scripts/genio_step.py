"""Modeller steps inside one headless Blender. modeller.mjs runs this; agents do not.

The only argument after `--` is a plan JSON written by modeller.mjs:
  base      the snapshot to open first, or null (an empty scene)
  replay    step scripts to re-run first (rebuilding a pruned snapshot), each
              {script, lib} (or a bare script path)
  steps     one or more steps, run back to back in this session, each with
              out       staging folder for this step's files
              script    the step script, or null to only rebuild a snapshot (or check it)
              lib       the model's lib.py as this step runs with it, or null
              outputs   any of blend, glb, sheet, check (check: review a step without a script)
              step      id, n, name, model (for the receipt)
              previous  first step only: its parent's receipt parts for the text review's
                        changes ([] with no parent; null or absent: unknown, no Changes line)
              pairs     first step only: its parent's pair results (receipt checks.pairs, with
                        its checks.pierces as pierces), or null: the checks then examine every pair
              full      examine every pair whatever the parent's results (an export's check)
  checks    budget (triangles), size ([x, y, z] metres) and symmetry ('x', 'y'), all optional

Per step: step script, modifier-applied GLB, then <out>/landed.json (the
kernel publishes the step to the live view from it at once), then the compressed
.blend (so a step stopped later still has its snapshot), the checks and the text
review (genio_review.py) and the 2x2 Workbench review sheet with part labels (its
camera never reaches a snapshot). The checks and the sheet share one copy of the
shipped meshes, and the sheet renders that copy instead of evaluating live modifiers
again. A sheet that fails is a warning: the step stays published. Each step's receipt goes to <out>/receipt.json (atomically,
last) and stdout as one `@@GENIO_STEP` line. The first failure stops the run.

The checks are incremental: a pair of parts is examined only when one of them changed since
the parent step (by an exact hash of its shipped geometry); the others keep the parent's
results. Every FULL_EVERY-th step, an export's check (`full`), a changed model size or a
parent without results examine every pair.
Exit codes: 0 done, 3 a step script raised, 4 a replayed script raised.
"""
import ast
import contextlib
import hashlib
import io
import json
import math
import os
import sys
import time
import traceback
import warnings

import bpy
import numpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

import genio_bpy
import genio_parts as p
import genio_review

RAY_BUDGET = 200000
LABELS_SHOWN = 10
FULL_EVERY = 10  # steps between checks of every pair (incremental checks in between)
MODIFIER_WARN_MS = 2000  # loading and evaluating live modifiers above this: suggest p.freeze()


class StepError(Exception):
    def __init__(self, kind, message, trace, output=''):
        super().__init__(message)
        self.kind, self.trace, self.output = kind, trace, output


def caption_of(code):
    try:
        doc = ast.get_docstring(ast.parse(code))
    except SyntaxError:
        return None
    return doc.strip().splitlines()[0].strip() if doc and doc.strip() else None


def _trace(paths):
    frames = traceback.extract_tb(sys.exc_info()[2])
    # The agent's own lines first (its script and lib.py); the deepest frame shows where a helper refused.
    mine = [f for f in frames if f.filename in paths]
    keep = mine + [f for f in frames[-2:] if f not in mine]
    return [f'{os.path.basename(f.filename)}:{f.lineno}: {(f.line or "").strip()}' for f in keep]


def run_script(path, kind, api, lib=None):
    """Run a step script, after the model's lib.py when it has one: the lib's helpers are the script's globals."""
    code = open(path, encoding='utf-8-sig').read()  # Windows PowerShell 5.1 writes a BOM
    sources = ([(lib, open(lib, encoding='utf-8-sig').read())] if lib else []) + [(path, code)]
    env = {'__name__': '__genio_step__', '__file__': path, 'bpy': bpy, 'p': p}
    buf = io.StringIO()
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always')
        try:
            with contextlib.redirect_stdout(buf):
                for file, text in sources:
                    exec(compile(text, file, 'exec'), env)
        except (Exception, SystemExit) as e:  # noqa: BLE001 - the step's own error is the result
            sys.stdout.write(buf.getvalue())
            raise StepError(kind, f'{type(e).__name__}: {e}', _trace({path, lib}), buf.getvalue()[-4000:]) from None
    sys.stdout.write(buf.getvalue())
    for w in caught:
        where = f'{os.path.basename(w.filename)}:{w.lineno}'
        api.append(f'{w.category.__name__} at {where}: {w.message}')
    return code, buf.getvalue()[-4000:]


def _boxes_touch(a, b, tol):
    return all(a[0][i] <= b[1][i] + tol and b[0][i] <= a[1][i] + tol for i in range(3))


def _crossing(a, b, tol, budget):
    """Edges of a that enter and leave b. Returns (depth, protrudes): the longest stretch inside
    b, and how far that edge sticks out of b on its shorter side (a post through a roof sticks
    out; a leg standing in a footing barely does)."""
    tree, best = b['tree'], (0.0, 0.0)
    pts, edges = a['pts'], a['edges']
    if not len(edges):
        return best
    # Only edges reaching into b's box (+ tol) can cross it: picked at once, in edge order.
    pa, pb = pts[edges[:, 0]], pts[edges[:, 1]]
    lo, hi = numpy.array(b['box'][0]) - tol, numpy.array(b['box'][1]) + tol
    near = numpy.all((numpy.maximum(pa, pb) >= lo) & (numpy.minimum(pa, pb) <= hi), axis=1)
    for i, j in edges[near].tolist():
        if budget[0] <= 0:
            break
        start, end = Vector(pts[i]), Vector(pts[j])
        length = (end - start).length
        if length < 3 * tol:
            continue
        d = (end - start) / length
        hits, origin, left = [], start, length
        while left > tol and len(hits) < 6:
            budget[0] -= 1
            loc, normal, _, _ = tree.ray_cast(origin, d, left)
            if loc is None:
                break
            t = (loc - start).length
            # Grazing hits come from edges lying in a face of b: parts resting on each other.
            if abs(d.dot(normal)) > 0.05 and (not hits or t - hits[-1] > tol):
                hits.append(t)
            origin, left = loc + d * tol, length - t - tol
        inside = [t for t in hits if tol < t < length - tol]
        # Hits pair up as in/out; an edge can cross several pieces of b (array copies).
        for k in range(0, len(inside) - 1, 2):
            depth = inside[k + 1] - inside[k]
            if depth > best[0]:
                best = (depth, min(inside[k], length - inside[k + 1]))
    return best


class _Part(dict):
    """A part record whose costly fields ('tree', 'pts', 'edges') are built on first use, from arrays
    copied while the mesh existed: an incremental check needs them only near a changed part."""

    def __init__(self, fields, lazy):
        super().__init__(fields)
        self._lazy = lazy

    def __missing__(self, key):
        if key not in self._lazy:
            raise KeyError(key)
        self[key] = value = self._lazy.pop(key)()
        return value


def _polygons(loops, totals):
    flat, ends = loops.tolist(), numpy.cumsum(totals).tolist()
    return [flat[s:e] for s, e in zip([0] + ends[:-1], ends)]


def _pulled(pts, normals, matrix, shrink):
    normals = normals.reshape(-1, 3) @ numpy.array(matrix.to_3x3().inverted().transposed()).T
    normals /= numpy.maximum(numpy.linalg.norm(normals, axis=1), 1e-12)[:, None]
    return pts - normals * shrink


def _parts(meshes, shrink, open_names=()):
    """Per part: a BVH of its surface, and its edges pulled `shrink` metres inwards along the
    vertex normals. Rays run along the pulled-in edges, so parts that merely rest on each other
    (coplanar faces) do not count as crossing. The text review also uses the world vertices,
    triangles and whether the part is closed; 'hash' is an exact digest of the shipped geometry in
    place (vertices, triangles, edges), which tells the incremental checks what changed."""
    out = []
    for ob, mesh in meshes.items():
        if not len(mesh.polygons):
            continue
        pts = p.world_vertices(ob, mesh)
        normals = numpy.empty(len(mesh.vertices) * 3, dtype=numpy.float64)
        mesh.vertices.foreach_get('normal', normals)
        loops = genio_bpy._ints(mesh.loops, 'vertex_index', len(mesh.loops))
        totals = genio_bpy._ints(mesh.polygons, 'loop_total', len(mesh.polygons))
        edges = genio_bpy._ints(mesh.edges, 'vertices', len(mesh.edges), 2)
        mesh.calc_loop_triangles()
        tris = genio_bpy._ints(mesh.loop_triangles, 'vertices', len(mesh.loop_triangles), 3)
        digest = hashlib.blake2b(digest_size=8)
        for a in (pts, tris, edges):
            digest.update(numpy.ascontiguousarray(a).tobytes())
        out.append(_Part({'name': ob.name, 'ob': ob, 'world': pts, 'tris': tris, 'closed': ob.name not in open_names,
                          'box': (pts.min(axis=0).tolist(), pts.max(axis=0).tolist()), 'hash': digest.hexdigest()}, {
            'pts': lambda pts=pts, normals=normals, matrix=ob.matrix_world.copy(): _pulled(pts, normals, matrix, shrink),
            'edges': lambda edges=edges: edges,
            'tree': lambda pts=pts, loops=loops, totals=totals: BVHTree.FromPolygons(pts.tolist(), _polygons(loops, totals), epsilon=0.0)}))
    return out


def pierces(parts, tol, test=None, known=()):
    """Pairs where an edge of one part goes in and out of another, deepest first. Crossing
    timbers and joints are often intended; a post sticking through a roof is the kind of bug
    this catches. Only pairs `test(name, name)` accepts are examined (all without it); `known`
    adds the others' results as stored."""
    budget, order = [RAY_BUDGET], {x['name']: i for i, x in enumerate(parts)}
    found = [{**f, 'a': f['b'], 'b': f['a']} if order[f['a']] > order[f['b']] else dict(f) for f in known]
    for x in range(len(parts)):
        for y in range(x + 1, len(parts)):
            a, b = parts[x], parts[y]
            if test is not None and not test(a['name'], b['name']):
                continue
            if not _boxes_touch(a['box'], b['box'], tol) or not a['tree'].overlap(b['tree']):
                continue
            depth, protrudes = max(_crossing(a, b, tol, budget), _crossing(b, a, tol, budget))
            if depth > tol:
                found.append({'a': a['name'], 'b': b['name'], 'depth': round(depth, 4), 'protrudes': round(protrudes, 4)})
    found.sort(key=lambda f: (-f['depth'], order[f['a']], order[f['b']]))
    return found, budget[0] <= 0


def notable_pierces(found, size):
    """The pairs worth a warning: deep (3% of the model) and sticking out (1%). Shallow joints,
    X-bracing and parts standing in a socket stay in the data only."""
    return [f for f in found if f['depth'] >= 0.03 * size and f['protrudes'] >= 0.01 * size]


def _names(items):
    return ', '.join(items[:6]) + (f' and {len(items) - 6} more' if len(items) > 6 else '')


def inspect_model(checks, previous=None, known=None, full=False, shipped=None):
    """Advisory checks on the shipped (evaluated) meshes, built on genio_bpy.validate(), plus the
    Modeller's own: budget, ground, centring, size and parts passing through each other, then the
    text review against the `previous` step's part table. Nothing here blocks a step. `known` is the
    previous step's pair results (see the module notes; None or `full`: every pair is examined);
    `shipped` an open p.evaluated() of the parts, reused. out['pairs'] is this step's, to store, and
    out['known'] what the next step of the same run gets as its `known`."""
    objects = p.export_objects()
    with contextlib.nullcontext(shipped) if shipped is not None else p.evaluated(objects) as shipped:
        return _inspect(checks, previous, known, full, objects, shipped)


def _inspect(checks, previous, known, full, objects, shipped):
    warn, out = [], {}
    try:
        report = genio_bpy._validate(shipped, True)
    except ValueError:  # no mesh vertices in Export
        out['stats'] = {'triangles': 0, 'vertices': 0, 'objects': 0, 'parts': []}
        warn.append('The Export collection has no meshes yet: nothing ships.')
        return out, warn
    meshes = report['meshes']
    stats = out['stats'] = {
        'triangles': report['triangles'], 'vertices': report['vertices'], 'objects': report['mesh_count'],
        'parts': [{k: m[k] for k in ('name', 'triangles', 'vertices', 'base_triangles')} for m in meshes],
        'min': report['bounds']['min'], 'max': report['bounds']['max'], 'dimensions': report['dimensions']}
    lo, hi, dims = Vector(stats['min']), Vector(stats['max']), Vector(stats['dimensions'])
    size = max(dims) or 1.0
    tol = max(1e-4, 1e-3 * size)
    budget = checks.get('budget')
    out['budget'] = {'triangles': stats['triangles'], 'limit': budget, 'over': bool(budget and stats['triangles'] > budget)}
    if out['budget']['over']:
        warn.append(f"{stats['triangles']} triangles is over the budget of {budget}.")
    ground_tol = max(0.005, 0.002 * dims.z)
    out['ground'] = {'min_z': round(lo.z, 4), 'ok': abs(lo.z) <= ground_tol}
    if not out['ground']['ok']:
        where = 'floats above' if lo.z > 0 else 'sinks below'
        warn.append(f'The model {where} the ground: its lowest point is z = {lo.z:.3f} m (p.ground() fixes it).')
    mid = (lo + hi) / 2
    centre_tol = max(0.01, 0.05 * max(dims.x, dims.y))
    out['centre'] = {'x': round(mid.x, 4), 'y': round(mid.y, 4), 'ok': abs(mid.x) <= centre_tol and abs(mid.y) <= centre_tol}
    if not out['centre']['ok']:
        warn.append(f'The footprint is off centre by ({mid.x:.2f}, {mid.y:.2f}) m (p.center() fixes it).')
    out['size'] = {'dimensions': [round(v, 4) for v in dims], 'expected': checks.get('size')}
    if size < 0.01 or size > 2000:
        warn.append(f'The model is {size:.4g} m across: check units (1 Blender unit is 1 metre).')
    expected = checks.get('size')
    if expected:
        off = [i for i in range(3) if expected[i] and abs(dims[i] - expected[i]) > 0.25 * expected[i]]
        out['size']['ok'] = not off
        if off:
            axes = ', '.join(f"{'xyz'[i]} {dims[i]:.2f} m (expected {expected[i]:.2f})" for i in off)
            warn.append(f'Size differs from the expected size: {axes}.')
    open_parts = [{k: m[k] for k in ('name', 'non_manifold_edges', 'loose_vertices')} for m in meshes if m['non_manifold_edges'] or m['loose_vertices']]
    out['non_manifold'] = open_parts
    if open_parts:
        warn.append(f'{len(open_parts)} part(s) are open or non-manifold: {_names([x["name"] for x in open_parts])}. Fine for cards and planes; a problem for booleans and solid parts.')
    inward = [m['name'] for m in meshes if m['flipped_faces']]
    if inward:
        warn.append(f'Some faces point inwards on: {_names(inward)}.')
    kept = [m['name'] for m in meshes if m['unapplied_modifiers']]
    if kept:
        warn.append(f'Shape keys keep these parts from shipping their modifiers: {_names(kept)}.')
    parts = _parts(shipped, 2 * tol, {x['name'] for x in open_parts})
    # Incremental: pairs of unchanged parts keep the parent's results, valid while the model's size
    # (and so every tolerance) is the same.
    hashes, scale = {x['name']: x['hash'] for x in parts}, round(size, 6)
    usable = not full and known is not None and known.get('size') == scale and isinstance(known.get('hashes'), dict)
    changed = sorted(n for n, h in hashes.items() if known['hashes'].get(n) != h) if usable else None
    fresh = set(changed or ())
    test = (lambda a, b: a in fresh or b in fresh) if usable else None
    carry = (lambda a, b: a in hashes and b in hashes and a not in fresh and b not in fresh) if usable else (lambda a, b: False)
    known = known if usable else {}
    found, truncated = pierces(parts, tol, test, [f for f in known.get('pierces', []) if carry(f['a'], f['b'])])
    stopped = known.get('stopped', {})
    truncated_carried = truncated or bool(stopped.get('pierces'))
    out['pierces'] = found
    out['pierce_check_truncated'] = truncated_carried
    # The text review: deep pass-throughs are its "Deep overlap" line, never a warning as well.
    carried = {k: [x for x in known.get(k, []) if carry(x[0], x[1])] for k in ('contacts', 'sunk', 'z_fighting')}
    out['review'], out['labels'], out['part_table'], pairs, z_stopped = genio_review.review(
        parts, previous=previous, size=size, tol=tol, ground_z=lo.z, pierced=notable_pierces(found, size),
        axis=checks.get('symmetry'), other_side=p._other_side, test=test, known=carried)
    z_stopped = z_stopped or bool(stopped.get('z_fighting'))
    out['z_fighting_check_truncated'] = z_stopped
    out['pairs'] = {'full': not usable, 'changed': changed, 'size': scale, 'hashes': hashes,
                    'stopped': {'pierces': truncated_carried, 'z_fighting': z_stopped}, **pairs}
    out['known'] = {**out['pairs'], 'pierces': found}
    # A label points at the part's surface nearest its box centre.
    labelled = {n for n, _ in out['labels'][:LABELS_SHOWN]}
    out['anchors'] = {x['name']: list(x['tree'].find_nearest((Vector(x['box'][0]) + Vector(x['box'][1])) / 2)[0]) for x in parts if x['name'] in labelled}
    if truncated_carried:
        warn.append('The pass-through check stopped early on this many parts; its list is incomplete.')
    if z_stopped:
        warn.append('The z-fighting check stopped early on this many faces; its list is incomplete.')
    flipped = [m['name'] for m in meshes if m['negative_determinant']]
    uneven = [o.name for o in objects if o.type == 'MESH' and any(m.type in ('BEVEL', 'SOLIDIFY') for m in o.modifiers)
              and max(o.scale) - min(o.scale) > 1e-4]
    if flipped:
        warn.append(f'Negative scale flips normals on: {_names(flipped)}.')
    if uneven:
        warn.append(f'Uneven object scale stretches bevels/solidify on: {_names(uneven)} (p.apply_scale(ob)).')
    shipped = set(objects)
    cutters = set(p.export_objects(p.CUTTERS))
    stray = [o.name for o in bpy.context.scene.objects if o not in shipped and o not in cutters]
    out['stray'] = stray
    if stray:
        warn.append(f'Not in Export, so they will not ship: {_names(stray)}.')
    dupes = [o.name for o in objects if p._SUFFIX.search(o.name)]
    if dupes:
        warn.append(f'Names with .001-style suffixes (a part was built twice?): {_names(dupes)}.')
    return out, warn


def save_blend(path):
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=path, copy=True, compress=True)


VIEWS = [  # (file, direction from the model's centre, image up, perspective); sheet order: TL, TR, BL, BR
    ('view', (1.0, -1.25, 0.75), (0.0, 0.0, 1.0), True),
    ('front', (0.0, -1.0, 0.0), (0.0, 0.0, 1.0), False),  # +X right
    ('side', (1.0, 0.0, 0.0), (0.0, 0.0, 1.0), False),  # from +X: +Y right, the front on the left
    ('top', (0.0, 0.0, 1.0), (0.0, 1.0, 0.0), False),  # plan view: +X right, +Y up, the front at the bottom
]
# A 5x7 font for the sheet's letters and part labels: seven rows per glyph, top first, one hex
# byte each with the leftmost pixel as bit 4. Lowercase is drawn as uppercase.
FONT = {ch: bytes.fromhex(rows) for ch, rows in {
    'A': '0e11111f111111', 'B': '1e11111e11111e', 'C': '0e11101010110e', 'D': '1e11111111111e', 'E': '1f10101e10101f',
    'F': '1f10101e101010', 'G': '0e111017111f0f', 'H': '1111111f111111', 'I': '0e04040404040e', 'J': '0702020202120c',
    'K': '11121418141211', 'L': '1010101010101f', 'M': '111b1515111111', 'N': '11111915131111', 'O': '0e11111111110e',
    'P': '1e11111e101010', 'Q': '0e11111115120d', 'R': '1e11111e141211', 'S': '0f10100e01011e', 'T': '1f040404040404',
    'U': '1111111111110e', 'V': '11111111110a04', 'W': '1111111515150a', 'X': '11110a040a1111', 'Y': '11110a04040404',
    'Z': '1f01020408101f', '0': '0e11131519110e', '1': '040c040404040e', '2': '0e11010204081f', '3': '1f02040201110e',
    '4': '02060a121f0202', '5': '1f101e0101110e', '6': '0608101e11110e', '7': '1f010204080808', '8': '0e11110e11110e',
    '9': '0e11110f01020c', ' ': '00000000000000', '.': '00000000000c0c', '-': '0000001f000000', '_': '0000000000001f',
    '(': '02040808080402', ')': '08040202020408', '/': '00010204081000', '?': '0e110102040004',
}.items()}
AXES = [  # (world axis, colour, letter) for the marker in each sheet cell
    ((1, 0, 0), (0.93, 0.27, 0.27), 'X'),
    ((0, 1, 0), (0.30, 0.82, 0.22), 'Y'),
    ((0, 0, 1), (0.33, 0.55, 1.00), 'Z'),
]
LABEL_TEXT, LABEL_FLAGGED, LABEL_LINE, LABEL_BOX = (0.95, 0.95, 0.95), (1.0, 0.55, 0.35), (1.0, 0.85, 0.25), (0.06, 0.06, 0.07)


def camera_basis(direction, up):
    """(right, up, back) of a camera looking at the model from `direction`, with `up` as image up.
    Explicit, because a camera looking straight down has no up of its own (the top view came out
    rotated 180 degrees)."""
    back = Vector(direction).normalized()
    right = (-back).cross(Vector(up)).normalized()
    return right, back.cross(right), back


def _fill(img, x, y, w, h, colour):
    """A w x h block of pixels from (x, y), clipped to the image."""
    x, y = int(round(x)), int(round(y))
    img[max(0, y):max(0, y + h), max(0, x):max(0, x + w), :3] = colour


def draw_axes(img, right, up):
    """The world axes as seen in this view, in the cell's lower-left corner: a coloured line per
    axis that lies in the image (an axis pointing at the camera is left out) and its letter.
    `img` rows run bottom-up, as Blender stores pixels."""
    ox = oy = 48
    for axis, colour, letter in AXES:
        dx, dy = Vector(axis).dot(right), Vector(axis).dot(up)
        if math.hypot(dx, dy) < 0.3:
            continue
        for k in range(61):
            _fill(img, ox + dx * k / 2 - 1, oy + dy * k / 2 - 1, 3, 3, colour)
        draw_text(img, ox + dx * 44 - 5, oy + dy * 44 - 7, letter, colour)


def draw_text(img, x, y, text, colour, scale=2):
    """`text` in the 5x7 font from its lower-left corner (x, y), `scale` px per font pixel."""
    for i, ch in enumerate(text.upper()):
        for row, bits in enumerate(FONT.get(ch, FONT['?'])):
            for col in range(5):
                if bits >> (4 - col) & 1:
                    _fill(img, x + (6 * i + col) * scale, y + (6 - row) * scale, scale, scale, colour)


def short_name(name, most=12):
    """A part's name for its label: long leading words cut to four letters (`Roof shingle 12` is
    `ROOF SHIN 12`), so numbered and L/R parts stay apart; then cut to `most` characters."""
    words = name.split()
    while len(' '.join(words)) > most and any(len(w) > 4 for w in words[:-1]):
        k = max(range(len(words) - 1), key=lambda i: len(words[i]))
        words[k] = words[k][:4]
    text = ' '.join(words).upper()
    return text if len(text) <= most else text[:most - 1] + '.'


def draw_labels(img, labels, project):
    """Part labels on one sheet cell: each part's short name in a dark box on the background next to
    the model, never over it, with a leader line to a dot on the part. Parts flagged by the text
    review are orange, the step's other changes white; a part with no free spot nearby is left out.
    `labels` is [(name, world point on the part, flagged)], `project` maps a point to (x, y) pixels."""
    size = img.shape[0]
    bg = img[size - 1, size - 1, :3]
    busy = (numpy.abs(img[..., :3] - bg).max(axis=2) > 0.03).astype(numpy.int32)
    busy[:130, :130] = 1  # the axis marker
    table = numpy.zeros((size + 1, size + 1), dtype=numpy.int32)
    table[1:, 1:] = busy.cumsum(0).cumsum(1)
    placed, boxes = [], []

    def free(x, y, w, h):
        if x < 2 or y < 2 or x + w > size - 2 or y + h > size - 2:
            return False
        if any(x < bx + bw + 4 and bx < x + w + 4 and y < by + bh + 4 and by < y + h + 4 for bx, by, bw, bh in boxes):
            return False
        return table[y + h, x + w] - table[y, x + w] - table[y + h, x] + table[y, x] == 0

    def spots(ax, ay, w, h):
        for r in range(28, size, 14):
            for k in range(16):
                yield int(ax + r * math.cos(k * math.pi / 8) - w / 2), int(ay + r * math.sin(k * math.pi / 8) - h / 2)

    for name, point, flagged in labels:
        ax, ay = project(point)
        if not (0 <= ax < size and 0 <= ay < size):
            continue
        text = short_name(name)
        w, h = 12 * len(text) + 4, 20
        spot = next((xy for xy in spots(ax, ay, w, h) if free(*xy, w, h)), None)
        if spot is None:
            continue
        boxes.append((*spot, w, h))
        placed.append((ax, ay, spot, w, h, text, LABEL_FLAGGED if flagged else LABEL_TEXT))
    for ax, ay, (x, y), w, h, _, _ in placed:  # leaders first, under every box
        tx, ty = min(max(ax, x), x + w), min(max(ay, y), y + h)
        n = int(math.hypot(tx - ax, ty - ay)) + 1
        for k in range(n + 1):
            _fill(img, ax + (tx - ax) * k / n - 1, ay + (ty - ay) * k / n - 1, 2, 2, LABEL_LINE)
        _fill(img, ax - 3, ay - 3, 7, 7, LABEL_BOX)
        _fill(img, ax - 2, ay - 2, 5, 5, LABEL_LINE)
    for _, _, (x, y), w, h, text, colour in placed:
        _fill(img, x, y, w, h, LABEL_BOX)
        draw_text(img, x + 3, y + 3, text, colour)


def render_sheet(out_dir, size, stats, labels=()):
    scene = bpy.context.scene
    lo, hi = Vector(stats['min']), Vector(stats['max'])
    centre, dims = (lo + hi) / 2, hi - lo
    radius = max(dims.length / 2, 0.05)
    shipped = set(p.export_objects())
    for ob in scene.objects:
        ob.hide_render = ob not in shipped
    scene.render.engine = 'BLENDER_WORKBENCH'
    shading = scene.display.shading
    # Baked parts show their textures (Workbench draws each material's active image node);
    # parts without one keep their material colour.
    textured = any(s.material and s.material.node_tree and any(n.type == 'TEX_IMAGE' and n.image for n in s.material.node_tree.nodes)
                   for o in shipped if o.type == 'MESH' for s in o.material_slots)
    shading.light, shading.color_type = 'STUDIO', 'TEXTURE' if textured else 'MATERIAL'
    shading.show_cavity, shading.cavity_type = True, 'WORLD'
    shading.show_object_outline = True
    scene.display.render_aa = '8'
    if scene.world is None:
        scene.world = bpy.data.worlds.new('Genio review')
    scene.world.color = (0.30, 0.31, 0.34)
    scene.render.film_transparent = False
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    cam = bpy.data.objects.new('Genio review camera', bpy.data.cameras.new('Genio review camera'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.clip_start, cam.data.clip_end = max(radius * 0.001, 1e-4), radius * 40
    spans = {'view': None, 'front': (dims.x, dims.z), 'side': (dims.y, dims.z), 'top': (dims.x, dims.y)}
    files, bases = [], []
    for name, direction, up, persp in VIEWS:
        right, up, d = camera_basis(direction, up)
        if persp:
            cam.data.type, cam.data.lens = 'PERSP', 50
            distance = radius / math.sin(cam.data.angle / 2) * 1.05
            # Metres across the image at a point's depth (a square image: one angle both ways).
            width = (lambda tan, d: lambda rel: -rel.dot(d) * 2 * tan)(math.tan(cam.data.angle / 2), d)
        else:
            cam.data.type = 'ORTHO'
            cam.data.ortho_scale = max(max(spans[name]) * 1.15, 0.01)
            distance = radius * 4
            width = (lambda ortho: lambda rel: ortho)(cam.data.ortho_scale)
        eye = centre + d * distance

        def project(point, eye=eye, right=right, up=up, width=width):
            rel = Vector(point) - eye
            across = max(width(rel), 1e-9)
            return (rel.dot(right) / across + 0.5) * size, (rel.dot(up) / across + 0.5) * size

        bases.append((right, up, project))
        cam.location = eye
        cam.rotation_euler = Matrix((right, up, d)).transposed().to_euler()
        scene.render.filepath = os.path.join(out_dir, f'{name}.png')
        bpy.ops.render.render(write_still=True)
        files.append(scene.render.filepath)
    full = size * 2
    sheet = numpy.zeros((full, full, 4), dtype=numpy.float32)
    corners = [(size, 0), (size, size), (0, 0), (0, size)]  # (row, col) of each cell's lower-left; rows run bottom-up
    for path, (row, col), (right, up, project) in zip(files, corners, bases):
        img = bpy.data.images.load(path)
        px = numpy.empty(size * size * 4, dtype=numpy.float32)
        img.pixels.foreach_get(px)
        cell = px.reshape(size, size, 4)
        # On the sheet only: view.png stays clean for the live view.
        draw_labels(cell, labels, project)
        draw_axes(cell, right, up)
        sheet[row:row + size, col:col + size] = cell
        bpy.data.images.remove(img)
    sheet[size - 1:size + 1, :, :3] = 0.12
    sheet[:, size - 1:size + 1, :3] = 0.12
    sheet[..., 3] = 1.0
    img = bpy.data.images.new('Genio review sheet', full, full, alpha=False)
    img.pixels.foreach_set(sheet.ravel())
    img.filepath_raw = os.path.join(out_dir, 'sheet.png')
    img.file_format = 'PNG'
    img.save()
    for path in files[1:]:
        os.remove(path)
    return img.filepath_raw


def write_json(out, name, doc):
    # Atomic: modeller.mjs polls these files while Blender runs.
    path = os.path.join(out, name)
    with open(path + '.tmp', 'w', encoding='utf8') as f:
        json.dump(doc, f, indent=1)
    os.replace(path + '.tmp', path)


def write_receipt(out, receipt):
    write_json(out, 'receipt.json', receipt)
    print('@@GENIO_STEP ' + json.dumps({'id': receipt.get('id'), 'ok': receipt['ok'], 'kind': receipt.get('kind')}))
    sys.stdout.flush()


@contextlib.contextmanager
def selection_kept():
    """The exporter selects and unhides the shipped parts; the snapshot saved after it keeps the
    scene's own selection, active object and hidden parts."""
    layer = bpy.context.view_layer
    # A script that removed objects itself (bpy.data.objects.remove) leaves None slots until the
    # layer syncs; the export evaluates the scene anyway.
    layer.update()
    state = [(o, o.select_get(), o.hide_get()) for o in layer.objects]
    active = layer.objects.active
    try:
        yield
    finally:
        for o, selected, hidden in state:
            with contextlib.suppress(ReferenceError, RuntimeError):
                o.hide_set(hidden)
                o.select_set(selected)
        layer.objects.active = active


def has_meshes():
    return any(o.type == 'MESH' and len(o.data.vertices) for o in p.export_objects())


def run_step(item, plan, replay, first, last, previous, known=None):
    """One step of the plan on the scene as the previous one left it, reviewed against the `previous`
    step's part table and pair results (`known`). Returns the exit code, this step's part table and
    its pair results for the next step."""
    out, outputs, script = item['out'], set(item.get('outputs', [])), item.get('script')
    os.makedirs(out, exist_ok=True)
    t, mark = {}, time.perf_counter()
    receipt = {'schema': 'genio.modeller-step.v1', 'ok': False, **item.get('step', {}),
               'blender': '.'.join(map(str, bpy.app.version)), 'api_warnings': []}

    def lap(key):
        nonlocal mark
        now = time.perf_counter()
        t[key] = round((now - mark) * 1000, 1)
        mark = now

    table = pairs = None

    def finish(code):
        receipt['timings_ms'] = t
        write_receipt(out, receipt)
        return code, table, pairs

    try:
        if first:
            if plan.get('base'):
                # Opening the snapshot evaluates its live modifiers: timed apart, it is what every step pays for them.
                bpy.ops.wm.open_mainfile(filepath=plan['base'])
                lap('load')
            elif not bpy.data.filepath:
                bpy.ops.wm.read_factory_settings(use_empty=True)
            p.collection(p.EXPORT)
            lap('setup')
            for entry in replay:
                if isinstance(entry, str):
                    entry = {'script': entry}
                run_script(entry['script'], 'replay', [], entry.get('lib'))
            lap('replay')
        if script:
            p.BAKES.clear()
            code, printed = run_script(script, 'error', receipt['api_warnings'], item.get('lib'))
            receipt['caption'] = caption_of(code)
            receipt['output'] = printed
            if p.BAKES:
                receipt['bakes'] = list(p.BAKES)
        lap('script')
    except StepError as e:
        receipt.update(kind=e.kind, error=str(e), trace=e.trace, output=e.output)
        if script and e.kind == 'error':
            receipt['caption'] = caption_of(open(script, encoding='utf8').read())
        return finish(3 if e.kind == 'error' else 4)
    check = bool(script) or 'check' in outputs
    if check:
        # What the script added or changed is evaluated here, once (a script that removed objects
        # itself also leaves stale view layer slots until this sync).
        bpy.context.view_layer.update()
        lap('evaluate')
    if script and 'glb' in outputs and has_meshes():
        # The web preset under genio_bpy's modifier rule: what the live view shows is what ships.
        with selection_kept():
            genio_bpy.export(os.path.join(out, 'model.glb'), target='web', fmt='glb')
        lap('export')
        # The player sees the step now; snapshot, checks and sheet follow and the receipt completes it.
        write_json(out, 'landed.json', {'ok': True, 'stage': 'glb', **item.get('step', {}), 'caption': receipt.get('caption'), 'timings_ms': dict(t)})
    blend = os.path.join(out, 'model.blend')
    if 'blend' in outputs:
        # Before the checks and the sheet: a step stopped during them keeps its snapshot, so the next
        # step need not replay it.
        save_blend(blend)
        lap('save')
    warn, drawn = [], False
    if check:
        meshes = [o for o in p.export_objects() if o.type == 'MESH']
        with p.evaluated(meshes) as shipped:
            if script and not receipt.get('caption'):
                warn.append('Start the step script with a docstring: its first line is the caption the player sees.')
            number = item.get('step', {}).get('n') or 0
            full = bool(item.get('full')) or (number > 0 and number % FULL_EVERY == 0)
            checks, found = inspect_model(plan.get('checks') or {}, previous, known, full, shipped)
            warn += found
            stats = checks.pop('stats')
            labels, anchors, table = checks.pop('labels', []), checks.pop('anchors', {}), checks.pop('part_table', {})
            pairs = checks.pop('known', None)
            for part in stats['parts']:
                if part['name'] in table:
                    part['box'] = table[part['name']]['box']
            receipt.update(triangles=stats['triangles'], vertices=stats['vertices'], objects=stats['objects'],
                           parts=stats['parts'], review=checks.pop('review', []), checks=checks)
            if stats['objects']:
                receipt['bounds'] = {'min': [round(v, 4) for v in stats['min']], 'max': [round(v, 4) for v in stats['max']],
                                     'dimensions': [round(v, 4) for v in stats['dimensions']]}
            live = [o.name for o in meshes if genio_bpy._bakes_modifiers(o)]
            if live and t.get('load', 0) + t.get('evaluate', 0) >= MODIFIER_WARN_MS:
                tris = {x['name']: x['triangles'] for x in stats['parts']}
                live.sort(key=lambda name: -tris.get(name, 0))
                warn.append(f'Live modifiers on {_names(live)} cost seconds on every step, which loads and evaluates them again: p.freeze() each part once it is final.')
            lap('checks')
            if 'sheet' in outputs and receipt.get('objects', 0) > 0:
                drawn = True
                try:
                    # The shipped meshes swapped in: no render evaluates live modifiers again (24 s to 0.7 s at 423k).
                    with genio_bpy.modifiers_baked(meshes, shipped=shipped):
                        render_sheet(out, plan.get('sheet_size', 512), stats, [(n, anchors[n], bad) for n, bad in labels if n in anchors])
                except Exception as e:  # noqa: BLE001 - the step is published already; the sheet is the agent's eyes only
                    warn.append(f'The review sheet failed ({type(e).__name__}: {e}); the step is published without it.')
                lap('sheet')
    if drawn and not last:
        # The review camera and render settings must not reach the next step: reopen the snapshot.
        bpy.ops.wm.open_mainfile(filepath=blend)
        lap('reload')
    receipt['warnings'] = warn + receipt['api_warnings']
    receipt['ok'] = True
    return finish(0)


def main():
    plan = json.load(open(sys.argv[sys.argv.index('--') + 1], encoding='utf8'))
    steps = plan['steps']
    # The first step compares with its parent's receipt (None: no parent); each later one with the step before it.
    previous = None if not steps or steps[0].get('previous') is None else {x['name']: x for x in steps[0]['previous']}
    known = steps[0].get('pairs') if steps else None
    for i, item in enumerate(steps):
        code, table, pairs = run_step(item, plan, plan.get('replay', []), i == 0, i == len(steps) - 1, previous, known)
        previous = table if table is not None else previous
        known = pairs if pairs is not None else known
        if code:
            sys.exit(code)


if __name__ == '__main__':
    main()
