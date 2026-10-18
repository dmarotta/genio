"""Every hard-surface kit shape once, checked from inside Blender"""
import math
import bmesh


def solid(ob):
    """Closed (every edge between two faces) and its volume, positive when it faces outwards."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    closed = all(e.is_manifold for e in bm.edges)
    volume = bm.calc_volume(signed=True)
    bm.free()
    return closed, volume


def size(ob):
    lo, hi = p.bounds([ob])
    return hi - lo


def near(a, b, tol=1e-4):
    return len(a) == len(b) and all(abs(x - y) <= tol for x, y in zip(a, b))


def sharp(ob):
    return sum(e.use_edge_sharp for e in ob.data.edges)


def raises(fn, text):
    try:
        fn()
    except (ValueError, KeyError) as e:
        assert text in str(e), str(e)
    else:
        raise AssertionError(f'no error: {text}')


def face_values(ob, key):
    values = [0] * len(ob.data.polygons)
    ob.data.attributes[key].data.foreach_get('value', values)
    return values


steel = p.material('Steel', '#888888', preset='brushed')

# mesh: a cube from eight corners, its faces wound every which way, comes out closed and facing out
corners = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]
sides = [(0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
cube = p.mesh('Cube', corners, sides, loc=(10, 0, 0), mat=steel)
closed, volume = solid(cube)
assert closed and abs(volume - 1) < 1e-6, volume
assert len(cube.data.polygons) == 6 and sharp(cube) == 12 and all(f.use_smooth for f in cube.data.polygons)
p.mesh('Cube', corners, sides, loc=(10, 0, 0), mat=steel)
assert [o.name for o in bpy.data.objects if o.name.startswith('Cube')] == ['Cube']
raises(lambda: p.mesh('Bad', [(0, 0, 0), (1, 0, 0), (0, 1, 0)], [(0, 1, 3)]), 'vertex indices from 0 to 2')

# smooth: flat, or round sides with the rims kept crisp
p.smooth('Cube', None)
assert not any(f.use_smooth for f in p.part('Cube').data.polygons)
drum = p.smooth(p.cylinder('Drum', 0.5, 1, loc=(12, 0, 0.5), segments=32))
assert all(f.use_smooth for f in drum.data.polygons) and sharp(drum) == 64, sharp(drum)

# from_bmesh and weighted normals
bm = bmesh.new()
bmesh.ops.create_cube(bm, size=0.5)
block = p.from_bmesh('Block', bm, loc=(14, 0, 0.25), mat=steel)
assert len(block.data.polygons) == 6 and tuple(block.location) == (14, 0, 0.25)
mod = p.weighted_normals(block)
assert mod.type == 'WEIGHTED_NORMAL' and mod.keep_sharp and p.weighted_normals('Block') and len(block.modifiers) == 1

# curve, circle, rect
pts = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (2, 1, 1)]
line = p.curve(pts, 4)
assert len(line) == 13 and all(near(line[4 * i], q) for i, q in enumerate(pts))
loop = p.curve(pts, 4, closed=True)
assert len(loop) == 16 and near(loop[12], pts[3])
assert p.curve(pts, 1) == [tuple(float(c) for c in q) for q in pts]
raises(lambda: p.curve([(0, 0), (1, 0, 0)]), 'same number of values')
area = lambda pts: sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1])) / 2  # noqa: E731
disc = p.circle(2, 64)
assert len(disc) == 64 and near(disc[0], (2, 0)) and abs(area(disc) - 4 * math.pi) < 0.03
assert near(p.circle(1, 4, center=(1, 2, 3))[1], (1, 3, 3))
assert len(p.rect(2, 1)) == 4 and abs(area(p.rect(2, 1)) - 2) < 1e-9
rounded = p.rect(2, 1, 0.25, per=4)
assert len(rounded) == 20 and abs(area(rounded) - (2 - (4 - math.pi) * 0.0625)) < 0.01

# revolve: a ball from a half circle; pieces joined crisp even where they meet at a shallow angle
half = [(math.sin(a), -math.cos(a)) for a in (i * math.pi / 32 for i in range(33))]
ball = p.revolve('Ball', half, segments=64, loc=(0, 6, 1), n=1, mat=steel)
closed, volume = solid(ball)
assert closed and abs(volume / (4 / 3 * math.pi) - 1) < 0.01, volume
lid = p.revolve('Lid', [[(0, 1), (1, 1)], [(1, 1), (2, 0.85)], [(2, 0.85), (2, 0), (0, 0)]], segments=48, loc=(4, 6, 0), n=1, mat=steel)
assert solid(lid)[0] and sharp(lid) == 3 * 48, sharp(lid)
assert set(face_values(lid, 'genio_cols')) == {48} and set(face_values(lid, 'genio_band')) == {0, 1, 2}

# sweep: a straight tube, a torus without a twist at its seam, level sections, a tip
tube = p.sweep('Tube', [(0, -2, 1), (0, 2, 1)], p.circle(0.5, 32), loc=(0, 10, 0), mat=steel)
closed, volume = solid(tube)
assert closed and near(size(tube), (1, 4, 1), 1e-3) and abs(volume / math.pi - 1) < 0.01, (size(tube), volume)
torus = p.sweep('Torus', p.circle(2, 32, center=(0, 0, 0)), p.circle(0.3, 24), closed=True, loc=(6, 10, 0.3), mat=steel)
closed, volume = solid(torus)
assert closed and abs(volume / (2 * math.pi ** 2 * 2 * 0.09) - 1) < 0.03, volume
areas = [f.area for f in torus.data.polygons]
assert max(areas) / min(areas) < 1.5, max(areas) / min(areas)
neck = p.sweep('Neck', [(0, 0, 3), (0, 1, 2), (0, 1.5, 1)], p.rect(0.4, 1.0), level=True, loc=(-6, 10, 0), mat=steel)
assert solid(neck)[0] and len({round(v.co.z, 6) for v in neck.data.vertices}) == 9
spike = p.sweep('Spike', [(0, 0, 0), (0, 0, 1)], p.circle(0.2, 8), scale=[1, 0], loc=(-8, 10, 0), mat=steel)
assert solid(spike)[0] and len(spike.data.vertices) == 4 * 8 + 2

# hull: stations along y from a pointed bow, a deck section
body = p.hull('Body', [(-2, 0, 0, 0.5), (-1, 1.2, 0.8, 0.6), (1, 1.6, 0.9, 0.6), (2, 1.4, 0.8, 0.6)], section='deck', loc=(0, 14, 0), mat=steel)
closed, volume = solid(body)
d = size(body)
assert closed and volume > 0 and abs(d.y - 4) < 1e-6 and abs(d.x - 1.6) < 0.05 and abs(d.z - 0.9) < 0.05, (d, volume)
assert set(face_values(body, 'genio_band')) == {-1, 0, 1, 2}
three, four = [(0, 0), (1, 0), (0, 1)], [(0, 0), (1, 0), (1, 1), (0, 1)]
raises(lambda: p.hull('Bad hull', [(0, 1, 1, 0, three), (1, 1, 1, 0, four)]), 'every section needs 3 (x, y) points')

# capsule: tips at a and b, round ends; a taper with a flat and a pointed end
pod = p.capsule('Pod', (4, 12, 1), (4, 16, 1), 0.5, mat=steel)
closed, volume = solid(pod)
assert closed and near(size(pod), (1, 4, 1), 0.01) and abs(volume / (math.pi * 0.25 * 3 + 4 / 3 * math.pi * 0.125) - 1) < 0.03, volume
tank = p.capsule('Tank', (6, 12, 0), (6, 12, 2), (0.5, 0.25), ends=('flat', 'point'), mat=steel)
bpy.context.view_layer.update()
lo, hi = p.bounds([tank])
assert solid(tank)[0] and abs(lo.z) < 1e-6 and abs(hi.z - 2) < 1e-6
assert sum(abs((tank.matrix_world @ v.co).z) < 1e-6 for v in tank.data.vertices) == 25
raises(lambda: p.capsule('Bad', (0, 0, 0), (0, 0, 1), 0.2, ends='square'), "'round', 'flat' or 'point'")

# material presets; given values win; a material made again without its preset loses it


def bsdf(mat):
    return next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')


glass = p.material('Glass', '#9fc7e0', preset='glass')
assert bsdf(glass).inputs['Transmission Weight'].default_value == 1 and abs(glass.roughness - 0.03) < 1e-6
assert bsdf(p.material('Lamp', '#ffeeaa', preset='emissive')).inputs['Emission Strength'].default_value == 4
brushed = p.material('Brushed', '#888888', preset='brushed', rough=0.5)
assert brushed.metallic == 1 and brushed.roughness == 0.5 and abs(bsdf(brushed).inputs['Anisotropic'].default_value - 0.6) < 1e-6
assert abs(bsdf(p.material('Paint', '#aa2222', preset='painted')).inputs['Coat Weight'].default_value - 0.35) < 1e-6
assert abs(p.material('Tyre', '#222222', preset='rubber').roughness - 0.92) < 1e-6
p.material('Glass', '#9fc7e0')
assert bsdf(glass).inputs['Transmission Weight'].default_value == 0 and abs(glass.roughness - 0.8) < 1e-6
raises(lambda: p.material('Odd', '#ffffff', preset='velvet'), 'No material preset')
