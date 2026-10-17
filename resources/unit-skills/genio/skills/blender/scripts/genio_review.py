"""The Modeller's text review: a few short lines after every step, so the agent reads its defects
as words instead of finding them in the sheet. genio_step.py calls review(); agents never import it.

Each line appears only when it has something to say, in this order:
  Changes       parts added, moved, changed and removed since the previous step, by name
  Floating      parts touching nothing that leads down to the ground
  Deep overlap  a part through another and out again (the pass-through check), or sunk deep into it
  Z-fighting    same-facing faces of two parts in one plane, overlapping
  Symmetry      L/R twins missing or off; with a declared axis, parts without a mirror twin and
                centre parts off centre
It works on the shipped geometry from the same Blender run, renders nothing, is deterministic and
is information only, never a gate.
"""
import numpy
from mathutils import Vector

NAMES_SHOWN = 6  # names per change kind
ITEMS_SHOWN = 3  # items per defect line
SAMPLES = 1500  # surface points per part for contact tests
DEEP_SHARE = 1 / 3  # of the smaller part's volume inside the other
DEEP = 0.03  # of the model's size: how thick the overlap must be every way (the pass-through check's depth)
PLANE = 2e-4  # of the model's size: faces closer than this to one plane can z-fight
GRID = 8  # points per axis when measuring an overlap's volume


def _list(names, shown=NAMES_SHOWN):
    return ', '.join(names[:shown]) + (f' and {len(names) - shown} more' if len(names) > shown else '')


def _items(items):
    return '; '.join(items[:ITEMS_SHOWN]) + (f'; and {len(items) - ITEMS_SHOWN} more' if len(items) > ITEMS_SHOWN else '')


def _m(v):
    return f'{v:.2f}'.rstrip('0').rstrip('.') if abs(v) >= 0.005 else '0'


def part_table(parts):
    """What the next step compares with: triangles and world box per part name (the receipt's parts)."""
    return {x['name']: {'triangles': len(x['tris']), 'box': [[round(float(v), 4) for v in x['box'][k]] for k in (0, 1)]} for x in parts}


def changes(table, previous, tol):
    """`Changes: ...` against the previous step's part table ({} for the first step).
    Returns (line, names added/moved/changed)."""
    added = [n for n in table if n not in previous]
    removed = [n for n in previous if n not in table]
    moved, changed = [], []
    for n in table:
        if n not in previous:
            continue
        a, b = previous[n], table[n]
        if 'box' not in a:
            if a.get('triangles') != b['triangles']:
                changed.append(n)
            continue
        lo0, hi0, lo1, hi1 = (numpy.array(v) for v in (*a['box'], *b['box']))
        if numpy.abs((hi0 - lo0) - (hi1 - lo1)).max() > tol or a.get('triangles') != b['triangles']:
            changed.append(n)
        elif numpy.abs((lo0 + hi0) - (lo1 + hi1)).max() / 2 > tol:
            moved.append(n)
    kinds = [(added, 'added'), (moved, 'moved'), (changed, 'changed'), (removed, 'removed')]
    said = [f'{len(names)} {word} ({_list(sorted(names))})' for names, word in kinds if names]
    return 'Changes: ' + (', '.join(said) if said else 'none'), added + moved + changed


def _boxes_near(a, b, tol):
    return all(a[0][i] <= b[1][i] + tol and b[0][i] <= a[1][i] + tol for i in range(3))


def _in_box(pts, box, tol):
    lo, hi = numpy.array(box[0]) - tol, numpy.array(box[1]) + tol
    return pts[numpy.all((pts >= lo) & (pts <= hi), axis=1)]


def _samples(part):
    """Surface points of a part: its vertices and triangle centres, at most SAMPLES, evenly strided."""
    if 'samples' not in part:
        pts = numpy.vstack([part['world'], part['world'][part['tris']].mean(axis=1)]) if len(part['tris']) else part['world']
        part['samples'] = pts[::max(1, len(pts) // SAMPLES + (len(pts) % SAMPLES > 0))]
    return part['samples']


def _inside(part, pts):
    """Which points are inside a closed part: the nearest surface faces away from them."""
    tree, out = part['tree'], numpy.zeros(len(pts), dtype=bool)
    for i, q in enumerate(pts):
        q = Vector(q)
        loc, normal, _, _ = tree.find_nearest(q)
        out[i] = loc is not None and (q - loc).dot(normal) < 0
    return out


def _gap(a, b, limit):
    """The distance from a's surface to b's, up to `limit` (None beyond it)."""
    best = None
    for q in _in_box(_samples(a), b['box'], limit):
        loc, _, _, d = b['tree'].find_nearest(Vector(q), limit if best is None else best)
        if loc is not None and (best is None or d < best):
            best = d
    return best


def _touch(a, b, tol):
    if a['tree'].overlap(b['tree']):
        return True
    if _gap(a, b, tol) is not None or _gap(b, a, tol) is not None:
        return True
    # One part wholly inside the other touches it too.
    for x, y in ((a, b), (b, a)):
        if y['closed'] and all(y['box'][0][i] <= x['box'][0][i] and x['box'][1][i] <= y['box'][1][i] for i in range(3)) \
                and _inside(y, x['world'][:1])[0]:
            return True
    return False


def contacts(parts, tol):
    """Which parts touch: {index: set of indices}."""
    adj = {i: set() for i in range(len(parts))}
    for i in range(len(parts)):
        for j in range(i + 1, len(parts)):
            if _boxes_near(parts[i]['box'], parts[j]['box'], tol) and _touch(parts[i], parts[j], tol):
                adj[i].add(j)
                adj[j].add(i)
    return adj


def floating(parts, adj, ground_z, tol):
    """`Floating: ...`: groups of parts with no chain of contacts down to a part on the ground (the
    model's lowest point), each with its gap to the nearest other part. Returns (items, names)."""
    seen = {i for i, x in enumerate(parts) if x['box'][0][2] <= ground_z + tol}
    stack = list(seen)
    while stack:
        for j in adj[stack.pop()] - seen:
            seen.add(j)
            stack.append(j)
    items, names, done = [], [], set(seen)
    for i in sorted(range(len(parts)), key=lambda k: parts[k]['name']):
        if i in done:
            continue
        group, stack = {i}, [i]
        while stack:
            for j in adj[stack.pop()] - group:
                group.add(j)
                stack.append(j)
        done |= group
        members = sorted(parts[k]['name'] for k in group)
        near = None
        for k in group:
            others = [o for o in range(len(parts)) if o not in group]
            others.sort(key=lambda o: _box_gap(parts[k]['box'], parts[o]['box']))
            for o in others[:3]:
                d = _gap(parts[k], parts[o], 1e9)
                if d is not None and (near is None or d < near[0]):
                    near = (d, parts[o]['name'])
        where = f' ({_m(near[0])} m from {near[1]})' if near else ''
        items.append(' + '.join(members[:3]) + (f' + {len(members) - 3} more' if len(members) > 3 else '') + where)
        names += members
    return items, names


def _box_gap(a, b):
    return float(numpy.linalg.norm([max(0.0, a[0][i] - b[1][i], b[0][i] - a[1][i]) for i in range(3)]))


def _volume(part):
    w, t = part['world'], part['tris']
    if not len(t):
        return 0.0
    a, b, c = w[t[:, 0]], w[t[:, 1]], w[t[:, 2]]
    return abs(float(numpy.einsum('ij,ij->i', a, numpy.cross(b, c)).sum()) / 6)


def deep_overlaps(parts, adj, pierced, size):
    """`Deep overlap: ...`: the pass-through check's notable pairs (deep in and out again), plus
    closed parts sunk with a third or more of the smaller one's volume inside the other, by an
    overlap at least 3 % of the model thick every way. Joints, crossings, thin slabs laid into
    each other and posts standing in a socket stay quiet. Returns (items, names)."""
    items, names, said = [], [], set()
    for f in pierced:
        x, y = sorted((f['a'], f['b']))
        items.append(f"{x} / {y} ({_m(f['depth'])} m inside, {_m(f['protrudes'])} m out)")
        said.add(frozenset((f['a'], f['b'])))
        names += [f['a'], f['b']]
    sunk = []
    for i in sorted(adj):
        for j in sorted(adj[i]):
            a, b = parts[i], parts[j]
            if j < i or frozenset((a['name'], b['name'])) in said or not (a['closed'] and b['closed']):
                continue
            va, vb = _volume(a), _volume(b)
            small, other = (a, b) if va <= vb else (b, a)
            vs = min(va, vb)
            lo = numpy.maximum(a['box'][0], b['box'][0])
            hi = numpy.minimum(a['box'][1], b['box'][1])
            if vs <= 0 or numpy.any(hi - lo < DEEP * size) or numpy.prod(hi - lo) < DEEP_SHARE * vs:
                continue
            ticks = [lo[k] + (numpy.arange(GRID) + 0.5) * (hi[k] - lo[k]) / GRID for k in range(3)]
            grid = numpy.stack(numpy.meshgrid(*ticks, indexing='ij'), -1).reshape(-1, 3)
            grid = grid[_inside(small, grid)]
            grid = grid[_inside(other, grid)] if len(grid) else grid
            if not len(grid) or numpy.any(grid.max(axis=0) - grid.min(axis=0) + (hi - lo) / GRID < DEEP * size):
                continue
            share = len(grid) * numpy.prod(hi - lo) / GRID ** 3 / vs
            if share >= DEEP_SHARE:
                text = f"{small['name']} hidden inside {other['name']}" if share >= 0.97 else \
                    f"{small['name']} / {other['name']} ({round(min(share, 1) * 100)} % of {small['name']} inside)"
                sunk.append((-share, text, small['name'], other['name']))
    for _, text, x, y in sorted(sunk):
        items.append(text)
        names += [x, y]
    return items, names


# Barycentric points spread over a triangle's interior: centres of its 16 sub-triangles at level 4.
_BARY = numpy.array([((i + 1 / 3) / 4, (j + 1 / 3) / 4) for i in range(4) for j in range(4 - i)]
                    + [((i + 2 / 3) / 4, (j + 2 / 3) / 4) for i in range(3) for j in range(3 - i)])


def _covered(pts, tris):
    """Which points lie inside any of the triangles (all in about one plane)."""
    v0, e1, e2 = tris[:, 0], tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]
    d = pts[None] - v0[:, None]
    d11, d12, d22 = (e1 * e1).sum(1), (e1 * e2).sum(1), (e2 * e2).sum(1)
    den = d11 * d22 - d12 * d12
    keep = den > 1e-18
    if not keep.any():
        return numpy.zeros(len(pts), dtype=bool)
    d, e1, e2, d11, d12, d22, den = d[keep], e1[keep], e2[keep], d11[keep], d12[keep], d22[keep], den[keep]
    p1, p2 = (d * e1[:, None]).sum(2), (d * e2[:, None]).sum(2)
    u = (d22[:, None] * p1 - d12[:, None] * p2) / den[:, None]
    v = (d11[:, None] * p2 - d12[:, None] * p1) / den[:, None]
    return ((u >= -1e-6) & (v >= -1e-6) & (u + v <= 1 + 1e-6)).any(axis=0)


def _faces(part, box, tol):
    """The part's triangles that reach into a box: corners (m, 3, 3), unit normals and plane offsets."""
    tri = part['world'][part['tris']]
    if not len(tri):
        return tri, None, None
    lo, hi = numpy.array(box[0]) - tol, numpy.array(box[1]) + tol
    tri = tri[numpy.all((tri.max(axis=1) >= lo) & (tri.min(axis=1) <= hi), axis=1)]
    n = numpy.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    area = numpy.linalg.norm(n, axis=1)
    tri, n, area = tri[area > 1e-12], n[area > 1e-12], area[area > 1e-12]
    n = n / area[:, None]
    return tri, n, numpy.einsum('ij,ij->i', n, tri[:, 0])


def _shared_area(ta, na, da, tb, nb, db, tol):
    """Area of a's triangles covered by same-facing triangles of b in the same plane, its centre and
    the mean area of a's triangles that were sampled (the smaller, the finer the estimate)."""
    area, centre, tested = 0.0, numpy.zeros(3), []
    for start in range(0, len(ta), 256):
        same = (na[start:start + 256] @ nb.T > 0.999) & (numpy.abs(da[start:start + 256, None] - db[None]) < tol)
        for k in numpy.nonzero(same.any(axis=1))[0]:
            t = ta[start + k]
            pts = t[0] + _BARY[:, :1] * (t[1] - t[0]) + _BARY[:, 1:] * (t[2] - t[0])
            hit = _covered(pts, tb[same[k]])
            tested.append(numpy.linalg.norm(numpy.cross(t[1] - t[0], t[2] - t[0])) / 2)
            if hit.any():
                a = tested[-1] * hit.mean()
                area += a
                centre += pts[hit].mean(axis=0) * a
    return area, (centre / area if area else centre), (sum(tested) / len(tested) if tested else 0.0)


def z_fighting(parts, tol, size):
    """`Z-fighting: ...`: same-facing faces of two parts in one plane (normals within 2.6 degrees,
    planes closer than 0.02 % of the model) that overlap by more than a small patch. Faces that
    meet back to back (a box resting on another) face opposite ways and stay quiet. Returns (items, names)."""
    least, plane = max(1e-6, (0.01 * size) ** 2), max(1e-4, PLANE * size)
    found = []
    for i in range(len(parts)):
        for j in range(i + 1, len(parts)):
            a, b = parts[i], parts[j]
            if not _boxes_near(a['box'], b['box'], tol):
                continue
            box = (numpy.maximum(a['box'][0], b['box'][0]), numpy.minimum(a['box'][1], b['box'][1]))
            ta, na, da = _faces(a, box, plane)
            tb, nb, db = _faces(b, box, plane)
            if not len(ta) or not len(tb):
                continue
            # Sampled from the side with the smaller triangles, unless only the other side saw it.
            ab = _shared_area(ta, na, da, tb, nb, db, plane)
            ba = _shared_area(tb, nb, db, ta, na, da, plane)
            fine, coarse = (ab, ba) if ab[2] <= ba[2] else (ba, ab)
            area, centre, _ = fine if fine[0] > 0 else coarse
            if area > least:
                found.append((-area, *sorted((a['name'], b['name'])), area, centre))
    found.sort(key=lambda f: (f[0], f[1], f[2]))
    items = [f"{x} / {y} ({area:.2g} m² at {', '.join(_m(v) for v in c)})" for _, x, y, area, c in found]
    return items, [n for f in found for n in f[1:3]]


def _frame_box(part, frame):
    pts = part['world'] if frame is None else part['world'] @ frame[:3, :3].T + frame[:3, 3]
    return pts.min(axis=0), pts.max(axis=0)


def _mirror_box(box, k):
    lo, hi = box[0].copy(), box[1].copy()
    lo[k], hi[k] = -box[1][k], -box[0][k]
    return lo, hi


def symmetry(parts, axis, size, tol, other_side):
    """`Symmetry: ...`: an L/R part whose twin is missing, or not its mirror across x = 0 (across
    their parent's x = 0 when they share one); with a declared axis ('x' or 'y'), also parts on one
    side with no mirror twin and parts across the centre whose box is off centre. Returns (items, names)."""
    tol = max(2 * tol, 0.01 * size)
    by_name = {x['name']: x for x in parts}
    items, names, paired = [], [], set()
    for x in sorted(parts, key=lambda q: q['name']):
        twin_name = other_side(x['name'])
        if not twin_name:
            continue
        paired.add(x['name'])
        twin = by_name.get(twin_name)
        if twin is None:
            items.append(f"{x['name']} has no {twin_name}")
            names.append(x['name'])
            continue
        if x['name'] > twin_name:
            continue
        parent = x['ob'].parent
        frame = numpy.array(parent.matrix_world.inverted()) if parent is not None and twin['ob'].parent == parent else None
        lo, hi = _mirror_box(_frame_box(x, frame), 0)
        tlo, thi = _frame_box(twin, frame)
        off = float(max(numpy.abs(lo - tlo).max(), numpy.abs(hi - thi).max()))
        if off > tol:
            items.append(f"{twin_name} is {_m(off)} m off the mirror of {x['name']}")
            names += [x['name'], twin_name]
    if axis in ('x', 'y'):
        k = 'xy'.index(axis)
        boxes = {x['name']: (numpy.array(x['box'][0]), numpy.array(x['box'][1])) for x in parts}
        lonely, skew = [], []
        for x in sorted(parts, key=lambda q: q['name']):
            if x['name'] in paired:
                continue
            lo, hi = boxes[x['name']]
            if lo[k] < -tol and hi[k] > tol:
                c = (lo[k] + hi[k]) / 2
                if abs(c) > tol:
                    skew.append(f"{x['name']} {_m(abs(c))} m off centre")
                    names.append(x['name'])
            elif max(abs(lo[k]), abs(hi[k])) > tol:
                mlo, mhi = _mirror_box((lo, hi), k)
                if not any(n != x['name'] and max(numpy.abs(mlo - b[0]).max(), numpy.abs(mhi - b[1]).max()) <= tol for n, b in boxes.items()):
                    lonely.append(x['name'])
                    names.append(x['name'])
        if lonely:
            items.append(f'no mirror twin in {axis}: {_list(lonely, 4)}')
        items += skew
    return items, names


def review(parts, *, previous, size, tol, ground_z, pierced, axis, other_side):
    """The step's text review. `parts` are genio_step._parts records (name, ob, world vertices,
    triangles, BVH tree, box, closed); `pierced` the pass-through check's notable pairs; `previous`
    the previous step's part table ({} for the first step; None when unknown: no Changes line). Returns (lines, the parts worth a label on the sheet as
    (name, flagged by a defect line), this step's part table)."""
    table = part_table(parts)
    line, changed = changes(table, previous, tol) if previous is not None else (None, [])
    lines, flagged = [line] if line else [], []
    adj = contacts(parts, tol)
    for title, (items, names) in (('Floating', floating(parts, adj, ground_z, tol)),
                                  ('Deep overlap', deep_overlaps(parts, adj, pierced, size)),
                                  ('Z-fighting', z_fighting(parts, tol, size)),
                                  ('Symmetry', symmetry(parts, axis, size, tol, other_side))):
        if items:
            lines.append(f'{title}: {_items(items)}')
            flagged += [n for k, n in enumerate(names) if n not in flagged and n not in names[:k]]
    return lines, [(n, True) for n in flagged] + [(n, False) for n in changed if n not in flagged], table
