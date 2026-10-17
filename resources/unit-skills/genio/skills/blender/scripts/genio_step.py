"""Modeller steps inside one headless Blender. modeller.mjs runs this; agents do not.

The only argument after `--` is a plan JSON written by modeller.mjs:
  replay    step scripts to re-run first (rebuilding a pruned snapshot)
  steps     one or more steps, run back to back in this session, each with
              out      staging folder for this step's files
              script   the step script, or null to only rebuild a snapshot
              outputs  any of blend, glb, sheet
              step     id, n, name, model (for the receipt)
  checks    budget (triangles) and size ([x, y, z] metres), both optional

Per step: step script, modifier-applied GLB, then <out>/landed.json (the
kernel publishes the step to the live view from it at once), then checks,
compressed .blend and the 2x2 Workbench review sheet (its camera never reaches
a snapshot). A sheet that fails is a warning: the step stays published. Each
step's receipt goes to <out>/receipt.json (atomically, last) and stdout as one
`@@GENIO_STEP` line. The first failure stops the run.
Exit codes: 0 done, 3 a step script raised, 4 a replayed script raised.
"""
import ast
import contextlib
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

RAY_BUDGET = 200000
PIERCE_PAIRS_SHOWN = 8


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


def _trace(path):
    frames = traceback.extract_tb(sys.exc_info()[2])
    # The agent's own lines first; the deepest frame shows where a helper refused.
    mine = [f for f in frames if f.filename == path]
    keep = mine + [f for f in frames[-2:] if f not in mine]
    return [f'{os.path.basename(f.filename)}:{f.lineno}: {(f.line or "").strip()}' for f in keep]


def run_script(path, kind, api):
    code = open(path, encoding='utf-8-sig').read()  # Windows PowerShell 5.1 writes a BOM
    env = {'__name__': '__genio_step__', '__file__': path, 'bpy': bpy, 'p': p}
    buf = io.StringIO()
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always')
        try:
            with contextlib.redirect_stdout(buf):
                exec(compile(code, path, 'exec'), env)
        except (Exception, SystemExit) as e:  # noqa: BLE001 - the step's own error is the result
            sys.stdout.write(buf.getvalue())
            raise StepError(kind, f'{type(e).__name__}: {e}', _trace(path), buf.getvalue()[-4000:]) from None
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
    lo, hi = b['box']
    for i, j in a['edges']:
        if budget[0] <= 0:
            break
        pa, pb = a['pts'][i], a['pts'][j]
        if any(max(pa[k], pb[k]) < lo[k] - tol or min(pa[k], pb[k]) > hi[k] + tol for k in range(3)):
            continue
        start, end = Vector(pa), Vector(pb)
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


def _parts(meshes, shrink):
    """Per part: a BVH of its surface, and its edges pulled `shrink` metres inwards along the
    vertex normals. Rays run along the pulled-in edges, so parts that merely rest on each other
    (coplanar faces) do not count as crossing."""
    out = []
    for ob, mesh in meshes.items():
        if not len(mesh.polygons):
            continue
        pts = p.world_vertices(ob, mesh)
        normals = numpy.empty(len(mesh.vertices) * 3, dtype=numpy.float64)
        mesh.vertices.foreach_get('normal', normals)
        normals = normals.reshape(-1, 3) @ numpy.array(ob.matrix_world.to_3x3().inverted().transposed()).T
        normals /= numpy.maximum(numpy.linalg.norm(normals, axis=1), 1e-12)[:, None]
        polys = [tuple(pl.vertices) for pl in mesh.polygons]
        out.append({'name': ob.name, 'pts': (pts - normals * shrink).tolist(), 'edges': [tuple(e.vertices) for e in mesh.edges],
                    'tree': BVHTree.FromPolygons(pts.tolist(), polys, epsilon=0.0),
                    'box': (pts.min(axis=0).tolist(), pts.max(axis=0).tolist())})
    return out


def pierces(parts, tol):
    """Pairs where an edge of one part goes in and out of another, deepest first. Crossing
    timbers and joints are often intended; a post sticking through a roof is the kind of bug
    this catches."""
    budget, found = [RAY_BUDGET], []
    for x in range(len(parts)):
        for y in range(x + 1, len(parts)):
            a, b = parts[x], parts[y]
            if not _boxes_touch(a['box'], b['box'], tol) or not a['tree'].overlap(b['tree']):
                continue
            depth, protrudes = max(_crossing(a, b, tol, budget), _crossing(b, a, tol, budget))
            if depth > tol:
                found.append({'a': a['name'], 'b': b['name'], 'depth': round(depth, 4), 'protrudes': round(protrudes, 4)})
    found.sort(key=lambda f: -f['depth'])
    return found, budget[0] <= 0


def notable_pierces(found, size):
    """The pairs worth a warning: deep (3% of the model) and sticking out (1%). Shallow joints,
    X-bracing and parts standing in a socket stay in the data only."""
    return [f for f in found if f['depth'] >= 0.03 * size and f['protrudes'] >= 0.01 * size]


def _names(items):
    return ', '.join(items[:6]) + (f' and {len(items) - 6} more' if len(items) > 6 else '')


def inspect_model(checks):
    """Advisory checks on the shipped (evaluated) meshes, built on genio_bpy.validate(), plus the
    Modeller's own: budget, ground, centring, size and parts passing through each other. Nothing
    here blocks a step."""
    objects = p.export_objects()
    warn, out = [], {}
    try:
        report = genio_bpy.validate()
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
    with p.evaluated(objects) as shipped:
        found, truncated = pierces(_parts(shipped, 2 * tol), tol)
    out['pierces'] = found
    out['pierce_check_truncated'] = truncated
    notable = notable_pierces(found, size)
    if notable:
        pairs = '; '.join(f"{f['a']} / {f['b']} ({f['depth']:.2f} m inside, {f['protrudes']:.2f} m out)" for f in notable[:PIERCE_PAIRS_SHOWN])
        more = f' and {len(notable) - PIERCE_PAIRS_SHOWN} more' if len(notable) > PIERCE_PAIRS_SHOWN else ''
        warn.append(f'Parts passing through each other: {pairs}{more}. Intended crossings are fine; look for parts poking out on the sheet. All contacts: checks.pierces.')
    if truncated:
        warn.append('The pass-through check stopped early on this many parts; its list is incomplete.')
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
AXES = [  # (world axis, colour, 5x7 glyph) for the marker in each sheet cell
    ((1, 0, 0), (0.93, 0.27, 0.27), ('10001', '10001', '01010', '00100', '01010', '10001', '10001')),
    ((0, 1, 0), (0.30, 0.82, 0.22), ('10001', '10001', '01010', '00100', '00100', '00100', '00100')),
    ((0, 0, 1), (0.33, 0.55, 1.00), ('11111', '00001', '00010', '00100', '01000', '10000', '11111')),
]


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
    for axis, colour, glyph in AXES:
        dx, dy = Vector(axis).dot(right), Vector(axis).dot(up)
        if math.hypot(dx, dy) < 0.3:
            continue
        for k in range(61):
            _fill(img, ox + dx * k / 2 - 1, oy + dy * k / 2 - 1, 3, 3, colour)
        gx, gy = ox + dx * 44 - 5, oy + dy * 44 + 7  # the letter's top-left; 2 px per glyph pixel
        for row, bits in enumerate(glyph):
            for col, bit in enumerate(bits):
                if bit == '1':
                    _fill(img, gx + 2 * col, gy - 2 * row - 2, 2, 2, colour)


def render_sheet(out_dir, size, stats):
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
        bases.append((right, up))
        if persp:
            cam.data.type, cam.data.lens = 'PERSP', 50
            distance = radius / math.sin(cam.data.angle / 2) * 1.05
        else:
            cam.data.type = 'ORTHO'
            cam.data.ortho_scale = max(max(spans[name]) * 1.15, 0.01)
            distance = radius * 4
        cam.location = centre + d * distance
        cam.rotation_euler = Matrix((right, up, d)).transposed().to_euler()
        scene.render.filepath = os.path.join(out_dir, f'{name}.png')
        bpy.ops.render.render(write_still=True)
        files.append(scene.render.filepath)
    full = size * 2
    sheet = numpy.zeros((full, full, 4), dtype=numpy.float32)
    corners = [(size, 0), (size, size), (0, 0), (0, size)]  # (row, col) of each cell's lower-left; rows run bottom-up
    for path, (row, col), (right, up) in zip(files, corners, bases):
        img = bpy.data.images.load(path)
        px = numpy.empty(size * size * 4, dtype=numpy.float32)
        img.pixels.foreach_get(px)
        cell = px.reshape(size, size, 4)
        draw_axes(cell, right, up)  # on the sheet only: view.png stays clean for the live view
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


def run_step(item, plan, replay, first, last):
    """One step of the plan on the scene as the previous one left it. Returns the exit code."""
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

    def finish(code):
        receipt['timings_ms'] = t
        write_receipt(out, receipt)
        return code

    try:
        if first:
            if not bpy.data.filepath:
                bpy.ops.wm.read_factory_settings(use_empty=True)
            p.collection(p.EXPORT)
            lap('setup')
            for path in replay:
                run_script(path, 'replay', [])
            lap('replay')
        if script:
            p.BAKES.clear()
            code, printed = run_script(script, 'error', receipt['api_warnings'])
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
    if script and 'glb' in outputs and has_meshes():
        # The web preset under genio_bpy's modifier rule: what the live view shows is what ships.
        with selection_kept():
            genio_bpy.export(os.path.join(out, 'model.glb'), target='web', fmt='glb')
        lap('export')
        # The player sees the step now; snapshot, checks and sheet follow and the receipt completes it.
        write_json(out, 'landed.json', {'ok': True, 'stage': 'glb', **item.get('step', {}), 'caption': receipt.get('caption'), 'timings_ms': dict(t)})
    warn = []
    if script:
        if not receipt.get('caption'):
            warn.append('Start the step script with a docstring: its first line is the caption the player sees.')
        checks, found = inspect_model(plan.get('checks') or {})
        warn += found
        stats = checks.pop('stats')
        receipt.update(triangles=stats['triangles'], vertices=stats['vertices'], objects=stats['objects'],
                       parts=stats['parts'], checks=checks)
        if stats['objects']:
            receipt['bounds'] = {'min': [round(v, 4) for v in stats['min']], 'max': [round(v, 4) for v in stats['max']],
                                 'dimensions': [round(v, 4) for v in stats['dimensions']]}
        lap('checks')
    blend = os.path.join(out, 'model.blend')
    if 'blend' in outputs:
        save_blend(blend)
        lap('save')
    if 'sheet' in outputs and receipt.get('objects', 0) > 0:
        try:
            render_sheet(out, plan.get('sheet_size', 512), stats)
        except Exception as e:  # noqa: BLE001 - the step is published already; the sheet is the agent's eyes only
            warn.append(f'The review sheet failed ({type(e).__name__}: {e}); the step is published without it.')
        lap('sheet')
        if not last:
            # The review camera and render settings must not reach the next step: reopen the snapshot.
            bpy.ops.wm.open_mainfile(filepath=blend)
            lap('reload')
    receipt['warnings'] = warn + receipt['api_warnings']
    receipt['ok'] = True
    return finish(0)


def main():
    plan = json.load(open(sys.argv[sys.argv.index('--') + 1], encoding='utf8'))
    steps = plan['steps']
    for i, item in enumerate(steps):
        code = run_step(item, plan, plan.get('replay', []), i == 0, i == len(steps) - 1)
        if code:
            sys.exit(code)


if __name__ == '__main__':
    main()
