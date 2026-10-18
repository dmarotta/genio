"""The Modeller's text review: a few short lines after every step, so the agent reads its defects
as words instead of finding them in the sheet. genio_step.py calls review(); agents never import it.

Each line appears only when it has something to say, in this order:
  Changes       parts added, moved, changed and removed since the previous step, by name
  Floating      parts touching nothing that leads down to the ground
  Deep overlap  a part through another and out again (the pass-through check), or sunk deep into it
  Z-fighting    same-facing faces of two parts in one plane, overlapping
  Symmetry      L/R twins missing or off; with a declared axis, parts without a mirror twin and
                centre parts off centre
  Size          an axis more than 5 % off the brief's size (init --size), in metres and per cent
  Triangles     past half the budget, or one part holding much of a dense model, by part
  Materials     parts without a material, and materials that look the same
  Bake          paint that ships only once baked, and parts without UVs where a bake needs them
It works on the shipped geometry from the same Blender run, renders nothing, is deterministic and
is information only, never a gate.

Known items: a defect line names each item (a pair, a part, a group) the first time it is printed,
and again only when its numbers change; while it stands as printed it is a count, `3 known`. `seen`
is what the parent step printed, by line and item; a review without it prints every item (the full
review, which the receipt keeps as well). Pairs marked with p.intended() never appear in the Deep
overlap and Z-fighting lines.

Incremental: with `test`, only pairs of parts it accepts (those with a changed part) are examined;
every other pair takes its result from `known`, the previous step's pairs (contacts, deep overlaps,
z-fighting), so the cost follows what changed rather than the model's size. The lines are the same
as a full review's.
"""
import contextlib
import time

import numpy
from mathutils import Vector

NAMES_SHOWN = 6  # names per change kind
ITEMS_SHOWN = 3  # items per defect line
SAMPLES = 1500  # surface points per part for contact tests
DEEP_SHARE = 1 / 3  # of the smaller part's volume inside the other
DEEP = 0.03  # of the model's size: how thick the overlap must be every way (the pass-through check's depth)
PLANE = 2e-4  # of the model's size: faces closer than this to one plane can z-fight
GRID = 8  # points per axis when measuring an overlap's volume
Z_BUDGET = 60_000_000  # z-fighting work per step: face pairs compared plus points tested against triangles
Z_CHUNK = 500_000  # face pairs compared at once
Z_TESTS = 20_000  # face pairs whose sample points are tested at once
KNOWN = 0.01  # of the model's size: how far a known item's lengths and places may drift and stay known
SIZE_OFF = 0.05  # of the brief's size per axis: the Size line
DENSE = 20_000  # triangles: a model this dense gets the Triangles line for one part holding much of it
DENSE_SHARE = 0.4  # of all triangles in one part
PART_SHARE = 0.2  # of all triangles: parts named in the Triangles line
AXES = (('wide', 0), ('long', 1), ('tall', 2))


def _list(names, shown=NAMES_SHOWN):
    return ', '.join(names[:shown]) + (f' and {len(names) - shown} more' if len(names) > shown else '')


def _items(items):
    return '; '.join(items[:ITEMS_SHOWN]) + (f'; and {len(items) - ITEMS_SHOWN} more' if len(items) > ITEMS_SHOWN else '')


def _m(v):
    return f'{v:.2f}'.rstrip('0').rstrip('.') if abs(v) >= 0.005 else '0'


def _item(key, text, names=(), nums=(), tols=()):
    """One thing a defect line says: `key` names it exactly (kind and parts), `nums` are its measures
    and `tols` how far each may move before it is news again."""
    return {'k': key, 't': text, 'names': list(names), 'v': [float(v) for v in nums], 'tol': [float(t) for t in tols]}


def _drift(v, size):
    """How far a length may move and stay the same item: 1 % of the model, or 5 % of the length."""
    return max(KNOWN * size, 0.05 * abs(v))


def _known(item, before):
    """Whether an item stands as it was printed: the same key, every measure within its tolerance."""
    return before is not None and len(before) == len(item['v']) and all(abs(a - b) <= t for a, b, t in zip(item['v'], before, item['tol']))


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


def contacts(parts, tol, test=None, known=()):
    """Which parts touch: {index: set of indices}. Only pairs `test(name, name)` accepts are examined
    (all without it); `known` adds pairs of indices already known to touch."""
    adj = {i: set() for i in range(len(parts))}
    for i, j in known:
        adj[i].add(j)
        adj[j].add(i)
    for i in range(len(parts)):
        for j in range(i + 1, len(parts)):
            if test is not None and not test(parts[i]['name'], parts[j]['name']):
                continue
            if _boxes_near(parts[i]['box'], parts[j]['box'], tol) and _touch(parts[i], parts[j], tol):
                adj[i].add(j)
                adj[j].add(i)
    return adj


def floating(parts, adj, ground_z, tol, size):
    """`Floating: ...`: groups of parts with no chain of contacts down to a part on the ground (the
    model's lowest point), each with its gap to the nearest other part. Returns the items."""
    seen = {i for i, x in enumerate(parts) if x['box'][0][2] <= ground_z + tol}
    stack = list(seen)
    while stack:
        for j in adj[stack.pop()] - seen:
            seen.add(j)
            stack.append(j)
    items, done = [], set(seen)
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
        text = ' + '.join(members[:3]) + (f' + {len(members) - 3} more' if len(members) > 3 else '') + where
        items.append(_item('|'.join(members), text, members, (near[0],) if near else (), (_drift(near[0], size),) if near else ()))
    return items


def _box_gap(a, b):
    return float(numpy.linalg.norm([max(0.0, a[0][i] - b[1][i], b[0][i] - a[1][i]) for i in range(3)]))


def _volume(part):
    w, t = part['world'], part['tris']
    if not len(t):
        return 0.0
    a, b, c = w[t[:, 0]], w[t[:, 1]], w[t[:, 2]]
    return abs(float(numpy.einsum('ij,ij->i', a, numpy.cross(b, c)).sum()) / 6)


def _sunk_item(a, b, share, va, vb):
    small, other = (a, b) if va <= vb else (b, a)
    text = f'{small} hidden inside {other}' if share >= 0.97 else f'{small} / {other} ({round(min(share, 1) * 100)} % of {small} inside)'
    return (-share, text, _item('sunk:' + '|'.join(sorted((a, b))), text, (small, other), (min(share, 1) * 100,), (5,)))


def deep_overlaps(parts, adj, pierced, size, test=None, known=()):
    """`Deep overlap: ...`: the pass-through check's notable pairs (deep in and out again), plus
    closed parts sunk with a third or more of the smaller one's volume inside the other, by an
    overlap at least 3 % of the model thick every way. Joints, crossings, thin slabs laid into
    each other and posts standing in a socket stay quiet. Only pairs `test` accepts are measured;
    `known` gives the others' sunk pairs as stored. Returns (items, the sunk pairs to store:
    [a, b, share, volume of a, volume of b], a first in part order)."""
    items, said = [], set()
    for f in pierced:
        x, y = sorted((f['a'], f['b']))
        items.append(_item(f'pierce:{x}|{y}', f"{x} / {y} ({_m(f['depth'])} m inside, {_m(f['protrudes'])} m out)", (x, y),
                           (f['depth'], f['protrudes']), (_drift(f['depth'], size), _drift(f['protrudes'], size))))
        said.add(frozenset((f['a'], f['b'])))
    sunk, store = [], []
    order = {x['name']: i for i, x in enumerate(parts)}
    for a, b, share, va, vb in known:
        if order[a] > order[b]:
            a, b, va, vb = b, a, vb, va
        if frozenset((a, b)) not in said:
            sunk.append(_sunk_item(a, b, share, va, vb))
            store.append([a, b, share, va, vb])
    for i in sorted(adj):
        for j in sorted(adj[i]):
            a, b = parts[i], parts[j]
            if j < i or frozenset((a['name'], b['name'])) in said or not (a['closed'] and b['closed']):
                continue
            if test is not None and not test(a['name'], b['name']):
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
            share = float(len(grid) * numpy.prod(hi - lo) / GRID ** 3 / vs)
            if share >= DEEP_SHARE:
                sunk.append(_sunk_item(a['name'], b['name'], share, va, vb))
                store.append([a['name'], b['name'], share, va, vb])
    items += [item for _, _, item in sorted(sunk, key=lambda s: s[:2])]
    return items, store


# Barycentric points spread over a triangle's interior: centres of its 16 sub-triangles at level 4.
_BARY = numpy.array([((i + 1 / 3) / 4, (j + 1 / 3) / 4) for i in range(4) for j in range(4 - i)]
                    + [((i + 2 / 3) / 4, (j + 2 / 3) / 4) for i in range(3) for j in range(3 - i)])


def _inside_tris(pts, tris):
    """For each triangle k, which of its points pts[k] (k, n, 3) lie inside it (all in about one
    plane): (k, n) booleans. Degenerate triangles contain nothing."""
    v0, e1, e2 = tris[:, 0], tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]
    d = pts - v0[:, None]
    d11, d12, d22 = (e1 * e1).sum(1), (e1 * e2).sum(1), (e2 * e2).sum(1)
    den = d11 * d22 - d12 * d12
    keep = den > 1e-18
    den = numpy.where(keep, den, 1.0)
    p1, p2 = (d * e1[:, None]).sum(2), (d * e2[:, None]).sum(2)
    u = (d22[:, None] * p1 - d12[:, None] * p2) / den[:, None]
    v = (d11[:, None] * p2 - d12[:, None] * p1) / den[:, None]
    return (u >= -1e-6) & (v >= -1e-6) & (u + v <= 1 + 1e-6) & keep[:, None]


def _part_faces(part):
    """All of a part's triangles, once per part: corners (m, 3, 3), unit normals, plane offsets and
    per-triangle boxes. Degenerate triangles are left out."""
    if 'faces' not in part:
        tri = part['world'][part['tris']]
        n = numpy.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        area = numpy.linalg.norm(n, axis=1)
        keep = area > 1e-12
        tri, n, area = tri[keep], n[keep], area[keep]
        n = n / area[:, None]
        part['faces'] = tri, n, numpy.einsum('ij,ij->i', n, tri[:, 0]), tri.min(axis=1), tri.max(axis=1)
    return part['faces']


def _faces(part, box, tol):
    """The part's triangles that reach into a box: corners (m, 3, 3), unit normals and plane offsets."""
    tri, n, d, tlo, thi = _part_faces(part)
    lo, hi = numpy.array(box[0]) - tol, numpy.array(box[1]) + tol
    keep = numpy.all((thi >= lo) & (tlo <= hi), axis=1)
    return tri[keep], n[keep], d[keep]


def _shared_area(ta, na, da, tb, nb, db, tol, budget):
    """Area of a's triangles covered by same-facing triangles of b in the same plane, its centre and
    the mean area of a's triangles that were sampled (the smaller, the finer the estimate).
    Only faces of b whose plane offset is within `tol` of a face's can share its plane: b's offsets
    are sorted once, so each face of a meets a window of them instead of every face of b. `budget`
    ([work left]) runs down with the face pairs compared and the points tested; at 0 it stops."""
    area, centre, tested = 0.0, numpy.zeros(3), []
    order = numpy.argsort(db, kind='stable')
    wide = tol * (1 + 1e-9) + 1e-12  # a little wider than the exact test below, never narrower
    lo = numpy.searchsorted(db[order], da - wide, 'left')
    count = numpy.searchsorted(db[order], da + wide, 'right') - lo
    ends = numpy.cumsum(count)
    start = 0
    while start < len(ta) and budget[0] > 0:
        base = int(ends[start - 1]) if start else 0
        stop = max(start + 1, int(numpy.searchsorted(ends, base + Z_CHUNK, 'right')))
        n, per = int(ends[stop - 1]) - base, count[start:stop]
        budget[0] -= n
        ia = numpy.repeat(numpy.arange(start, stop), per)
        ib = order[numpy.arange(n) - numpy.repeat(ends[start:stop] - per - base, per) + numpy.repeat(lo[start:stop], per)]
        same = (numpy.einsum('ij,ij->i', na[ia], nb[ib]) > 0.999) & (numpy.abs(da[ia] - db[ib]) < tol)
        ia, ib = ia[same], ib[same]
        start = stop
        if not len(ia):
            continue
        # Each face's sample points against its candidates of b, every pair at once; a point is
        # covered when any of them contains it.
        faces, firsts = numpy.unique(ia, return_index=True)
        t = ta[faces]
        pts = t[:, 0][:, None] + _BARY[None, :, :1] * (t[:, 1] - t[:, 0])[:, None] + _BARY[None, :, 1:] * (t[:, 2] - t[:, 0])[:, None]
        at = numpy.repeat(numpy.arange(len(faces)), numpy.diff(numpy.append(firsts, len(ia))))
        inside = numpy.concatenate([_inside_tris(pts[at[s:s + Z_TESTS]], tb[ib[s:s + Z_TESTS]]) for s in range(0, len(ia), Z_TESTS)])
        hits = numpy.logical_or.reduceat(inside, firsts, axis=0)
        budget[0] -= len(_BARY) * len(ia)
        cross = numpy.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
        for k, hit in enumerate(hits):
            tested.append(numpy.linalg.norm(cross[k]) / 2)
            if hit.any():
                a = tested[-1] * hit.mean()
                area += a
                centre += pts[k][hit].mean(axis=0) * a
    return area, (centre / area if area else centre), (sum(tested) / len(tested) if tested else 0.0)


def _side(result):
    area, centre, mean = result
    return [float(area), [float(v) for v in centre], float(mean)]


def z_fighting(parts, tol, size, test=None, known=(), budget=None):
    """`Z-fighting: ...`: same-facing faces of two parts in one plane (normals within 2.6 degrees,
    planes closer than 0.02 % of the model) that overlap by more than a small patch. Faces that
    meet back to back (a box resting on another) face opposite ways and stay quiet. Only pairs
    `test` accepts are measured; `known` gives the others as stored. The work stops at `budget`
    ([work left], Z_BUDGET by default). Returns (items, the pairs to store: [a, b, a's side, b's
    side], a first in part order, each side [area, centre, mean triangle area], and whether the
    check stopped early)."""
    least, plane = max(1e-6, (0.01 * size) ** 2), max(1e-4, PLANE * size)
    budget = [Z_BUDGET] if budget is None else budget
    order = {x['name']: i for i, x in enumerate(parts)}
    found, store = [], []

    def add(a, b, ab, ba):
        # Sampled from the side with the smaller triangles, unless only the other side saw it.
        fine, coarse = (ab, ba) if ab[2] <= ba[2] else (ba, ab)
        area, centre, _ = fine if fine[0] > 0 else coarse
        if max(ab[0], ba[0]) > least:
            store.append([a, b, _side(ab), _side(ba)])
        if area > least:
            found.append((-area, *sorted((a, b)), area, centre))

    for a, b, ab, ba in known:
        if order[a] > order[b]:
            a, b, ab, ba = b, a, ba, ab
        add(a, b, ab, ba)
    for i in range(len(parts)):
        for j in range(i + 1, len(parts)):
            a, b = parts[i], parts[j]
            if test is not None and not test(a['name'], b['name']):
                continue
            if budget[0] <= 0 or not _boxes_near(a['box'], b['box'], tol):
                continue
            box = (numpy.maximum(a['box'][0], b['box'][0]), numpy.minimum(a['box'][1], b['box'][1]))
            ta, na, da = _faces(a, box, plane)
            tb, nb, db = _faces(b, box, plane)
            if not len(ta) or not len(tb):
                continue
            add(a['name'], b['name'], _shared_area(ta, na, da, tb, nb, db, plane, budget), _shared_area(tb, nb, db, ta, na, da, plane, budget))
    found.sort(key=lambda f: (f[0], f[1], f[2]))
    near = KNOWN * size
    items = [_item(f'z:{x}|{y}', f"{x} / {y} ({area:.2g} m² at {', '.join(_m(v) for v in c)})", (x, y), (area, *c),
                   (max(least, 0.25 * area), near, near, near)) for _, x, y, area, c in found]
    return items, store, budget[0] <= 0


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
    side with no mirror twin and parts across the centre whose box is off centre. Returns the items."""
    tol = max(2 * tol, 0.01 * size)
    by_name = {x['name']: x for x in parts}
    items, paired = [], set()
    for x in sorted(parts, key=lambda q: q['name']):
        twin_name = other_side(x['name'])
        if not twin_name:
            continue
        paired.add(x['name'])
        twin = by_name.get(twin_name)
        if twin is None:
            items.append(_item(f"missing:{x['name']}", f"{x['name']} has no {twin_name}", (x['name'],)))
            continue
        if x['name'] > twin_name:
            continue
        parent = x['ob'].parent
        frame = numpy.array(parent.matrix_world.inverted()) if parent is not None and twin['ob'].parent == parent else None
        lo, hi = _mirror_box(_frame_box(x, frame), 0)
        tlo, thi = _frame_box(twin, frame)
        off = float(max(numpy.abs(lo - tlo).max(), numpy.abs(hi - thi).max()))
        if off > tol:
            items.append(_item(f"off:{x['name']}|{twin_name}", f"{twin_name} is {_m(off)} m off the mirror of {x['name']}", (x['name'], twin_name), (off,), (_drift(off, size),)))
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
                    skew.append(_item(f"skew:{x['name']}", f"{x['name']} {_m(abs(c))} m off centre", (x['name'],), (abs(c),), (_drift(c, size),)))
            elif max(abs(lo[k]), abs(hi[k])) > tol:
                mlo, mhi = _mirror_box((lo, hi), k)
                if not any(n != x['name'] and max(numpy.abs(mlo - b[0]).max(), numpy.abs(mhi - b[1]).max()) <= tol for n, b in boxes.items()):
                    lonely.append(x['name'])
        if lonely:
            items.append(_item('lonely:' + '|'.join(lonely), f'no mirror twin in {axis}: {_list(lonely, 4)}', lonely))
        items += skew
    return items


def size_check(dims, expected):
    """`Size: ...`: each axis of the model more than SIZE_OFF away from the brief's size (init --size;
    0 for an axis that does not matter), with the share it reaches. Returns the items."""
    items = []
    for word, i in AXES:
        want = expected[i] if expected else 0
        if want and abs(dims[i] - want) > SIZE_OFF * want:
            items.append(_item(f'size:{word}', f'{_m(dims[i])} m {word} (brief {_m(want)} m, {round(100 * dims[i] / want)} %)', (), (dims[i],), (KNOWN * want,)))
    return items


def _tris(n):
    return f'{n / 1000:.1f}k'.replace('.0k', 'k') if 1000 <= n < 10_000 else f'{round(n / 1000)}k' if n >= 10_000 else str(n)


def triangles(parts, budget):
    """`Triangles: ...`: past half the budget (init --budget), or one part holding DENSE_SHARE of a
    model of DENSE triangles or more: the total, then the (at most two) parts holding PART_SHARE or
    more of it. Returns the items."""
    counts = sorted(((len(x['tris']), x['name']) for x in parts), key=lambda c: (-c[0], c[1]))
    total = sum(n for n, _ in counts)
    if not total or not ((budget and total > budget / 2) or (total >= DENSE and counts[0][0] >= DENSE_SHARE * total)):
        return []
    said = f'{_tris(total)} of {_tris(budget)}' + (' (over the budget)' if total > budget else '') if budget else f'{_tris(total)} in all'
    items = [_item('total', said, (), (total,), (0.1 * total,))]
    for n, name in counts[:ITEMS_SHOWN - 1]:
        if n >= PART_SHARE * total:
            items.append(_item(f'part:{name}', f'{name} {_tris(n)} ({round(100 * n / total)} %)', (name,), (n,), (0.1 * n,)))
    return items


def _input(bsdf, name):
    socket = bsdf.inputs.get(name)
    if socket is None:
        return None
    if socket.is_linked:
        return 'linked'
    try:
        return tuple(round(float(v), 3) for v in socket.default_value)
    except TypeError:
        return round(float(socket.default_value), 3)


def _look(mat):
    """What a material looks like, to find two that look the same; None for a node graph other than
    Genio's paint presets (that comparison would be a guess)."""
    tree = mat.node_tree
    if tree is None:
        return ('plain', tuple(round(c, 3) for c in mat.diffuse_color), round(mat.roughness, 3), round(mat.metallic, 3))
    bsdf = next((n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    extra = sorted(n.bl_idname for n in tree.nodes if n.type not in ('BSDF_PRINCIPLED', 'OUTPUT_MATERIAL'))
    paint = mat.get('genio_paint')
    if bsdf is None or (extra and paint is None):
        return None
    glow = _input(bsdf, 'Emission Strength')
    look = [_input(bsdf, k) for k in ('Base Color', 'Roughness', 'Metallic', 'Alpha', 'Transmission Weight')]
    return ('bsdf', *look, glow, _input(bsdf, 'Emission Color') if glow else None, str(paint), tuple(extra))


def materials(parts):
    """`Materials: ...`: parts without a material (or with an empty slot), then groups of materials
    on shipped parts that look the same (colour, roughness, metallic, emission, paint presets).
    Returns the items."""
    bare = sorted(x['name'] for x in parts if not x['ob'].material_slots or any(s.material is None for s in x['ob'].material_slots))
    items = [_item('none:' + '|'.join(bare), f'none on {_list(bare, 4)}', bare)] if bare else []
    used = sorted({s.material for x in parts for s in x['ob'].material_slots if s.material is not None}, key=lambda m: m.name)
    groups = {}
    for mat in used:
        look = _look(mat)
        if look is not None:
            groups.setdefault(look, []).append(mat.name)
    for names in sorted(g for g in groups.values() if len(g) > 1):
        items.append(_item('same:' + '|'.join(names), f"{', '.join(names[:-1])} and {names[-1]} look the same"))
    return items


def _unbaked(mat):
    """Paint that ships only once baked: the Principled BSDF's colour, roughness or metallic fed by
    nodes, and no image texture (the glTF and FBX exporters ship neither noise nor presets)."""
    tree = mat.node_tree
    if tree is None or any(n.type == 'TEX_IMAGE' for n in tree.nodes):
        return False
    return any(n.type == 'BSDF_PRINCIPLED' and any(n.inputs[k].is_linked for k in ('Base Color', 'Roughness', 'Metallic') if k in n.inputs) for n in tree.nodes)


def _textured(mat):
    return mat.node_tree is not None and any(n.type == 'TEX_IMAGE' and n.image for n in mat.node_tree.nodes)


def bake(parts):
    """`Bake: ...`: materials whose paint is not baked yet, and parts without UVs when they need them
    (paint to bake, or image textures on the model, as after a bake). Returns the items."""
    mats = {s.material for x in parts for s in x['ob'].material_slots if s.material is not None}
    painted = sorted(m.name for m in mats if _unbaked(m))
    items = [_item('paint:' + '|'.join(painted), f'paint on {_list(painted, 4)} ships only after p.bake_maps')] if painted else []
    flat = sorted(x['name'] for x in parts if not x['ob'].data.uv_layers)
    if flat and (painted or any(_textured(m) for m in mats)):
        items.append(_item('uv:' + '|'.join(flat), f'no UVs on {_list(flat, 4)} (p.uv_atlas)', flat))
    return items


@contextlib.contextmanager
def _timed(clock, key):
    start = time.perf_counter()
    try:
        yield
    finally:
        clock[key] = round(clock.get(key, 0) + (time.perf_counter() - start) * 1000, 1)


def review(parts, *, previous, size, tol, ground_z, pierced, axis, other_side, test=None, known=None, seen=None,
           intended=(), dims=None, expected=None, budget=None, clock=None):
    """The step's text review. `parts` are genio_step._parts records (name, ob, world vertices,
    triangles, BVH tree, box, closed); `pierced` the pass-through check's notable pairs; `previous`
    the previous step's part table ({} for the first step; None when unknown: no Changes line).
    `test(name, name)` picks the pairs to examine (None: all) and `known` carries the others'
    results, as stored: {'contacts': [[a, b]], 'sunk': [...], 'z_fighting': [...]}. `seen` is what
    the previous step printed ({line: {item key: measures}}; None: print every item), `intended`
    the pairs (frozensets of names) left out of the Deep overlap and Z-fighting lines; `dims`,
    `expected` and `budget` feed the Size and Triangles lines. `clock` gets milliseconds per check.
    Returns {lines: as the agent reads them, full: every item printed, labels: the parts worth a
    label on the sheet as (name, flagged by a new item), table: this step's part table, pairs: this
    step's pair results to store, z_stopped, seen: what this review printed, counts: {line: [new,
    known]}, changed: the parts added, moved or changed}."""
    clock = {} if clock is None else clock
    table = part_table(parts)
    line, changed = changes(table, previous, tol) if previous is not None else (None, [])
    known = known or {}
    order = {x['name']: i for i, x in enumerate(parts)}
    with _timed(clock, 'contacts'):
        adj = contacts(parts, tol, test, [(order[a], order[b]) for a, b in known.get('contacts', [])])
    with _timed(clock, 'floating'):
        float_items = floating(parts, adj, ground_z, tol, size)
    with _timed(clock, 'deep_overlap'):
        sunk_items, sunk = deep_overlaps(parts, adj, pierced, size, test, known.get('sunk', []))
    with _timed(clock, 'z_fighting'):
        z_items, z_store, z_stopped = z_fighting(parts, tol, size, test, known.get('z_fighting', []))
    with _timed(clock, 'symmetry'):
        sym_items = symmetry(parts, axis, size, tol, other_side)
    with _timed(clock, 'size'):
        size_items = size_check(dims, expected) if dims is not None else []
        tri_items = triangles(parts, budget)
    with _timed(clock, 'materials'):
        mat_items, bake_items = materials(parts), bake(parts)
    meant = lambda items: [x for x in items if frozenset(x['names']) not in intended]  # noqa: E731
    lines, full, flagged, printed, counts = [line] if line else [], [line] if line else [], [], {}, {}
    for title, items in (('Floating', float_items), ('Deep overlap', meant(sunk_items)), ('Z-fighting', meant(z_items)),
                         ('Symmetry', sym_items), ('Size', size_items), ('Triangles', tri_items),
                         ('Materials', mat_items), ('Bake', bake_items)):
        if not items:
            continue
        before = None if seen is None else seen.get(title, {})
        stand = [before is not None and _known(x, before.get(x['k'])) for x in items]
        fresh = [x for x, s in zip(items, stand) if not s]
        full.append(f"{title}: {_items([x['t'] for x in items])}")
        said = _items([x['t'] for x in fresh]) if fresh else ''
        if any(stand):
            said = f'{said}; {sum(stand)} known' if said else f'{sum(stand)} known'
        lines.append(f'{title}: {said}')
        # Known items keep the measures they were printed with; new ones count as printed only when shown.
        printed[title] = {**{x['k']: before[x['k']] for x, s in zip(items, stand) if s}, **{x['k']: x['v'] for x in fresh[:ITEMS_SHOWN]}}
        counts[title] = [len(fresh), sum(stand)]
        names = [n for x in fresh for n in x['names']]
        flagged += [n for k, n in enumerate(names) if n not in flagged and n not in names[:k]]
    pairs = {'contacts': sorted([parts[i]['name'], parts[j]['name']] for i in adj for j in adj[i] if i < j), 'sunk': sunk, 'z_fighting': z_store}
    return {'lines': lines, 'full': full, 'labels': [(n, True) for n in flagged] + [(n, False) for n in changed if n not in flagged],
            'table': table, 'pairs': pairs, 'z_stopped': z_stopped, 'seen': printed, 'counts': counts, 'changed': changed}
