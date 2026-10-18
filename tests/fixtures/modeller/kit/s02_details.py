"""Panel seams, window rows and greebles, checked from inside Blender"""
import math
import bmesh


def closed(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    ok = all(e.is_manifold for e in bm.edges)
    bm.free()
    return ok


def sharp(ob):
    return sum(e.use_edge_sharp for e in ob.data.edges)


def raises(fn, text):
    try:
        fn()
    except (ValueError, KeyError) as e:
        assert text in str(e), str(e)
    else:
        raise AssertionError(f'no error: {text}')


hull = p.material('Hull', '#c9ccd1', preset='painted')
seam = p.material('Seam', '#555555')
profile = [[(0, 1.0), (0.6, 0.9), (1.2, 0.5), (1.5, 0.0)], [(1.5, 0.0), (0.0, 0.0)]]


def dome(name, x):
    return p.revolve(name, profile, segments=64, loc=(x, 0, 0), mat=hull)


# panel_lines on a surface of revolution: plates in rows along each piece and columns around; the
# strips between them get the seam material and sharp edges, and the part stays closed
plated = dome('Dome', 0)
faces, edges = len(plated.data.polygons), sharp(plated)
plates = p.panel_lines(plated, size=0.4, mat=seam)
assert closed(plated) and len(plated.data.polygons) > faces and sharp(plated) > edges
assert [m.name for m in plated.data.materials] == ['Hull', 'Seam'] and any(f.material_index == 1 for f in plated.data.polygons)
# 'stations' cuts only where the pieces meet; 'concentric' adds rows, 'radial' columns, 'grid' both
counts = {pattern: p.panel_lines(dome(f'Dome {pattern}', 4 + 4 * i), size=0.4, pattern=pattern)
          for i, pattern in enumerate(('stations', 'concentric', 'radial'))}
assert counts['stations'] == 2 and 2 < counts['concentric'] < plates and 2 < counts['radial'] < plates, (counts, plates)
assert closed(p.part('Dome radial')) and closed(p.part('Dome concentric'))
# a region keeps the seams to part of the surface
assert p.panel_lines(dome('Dome top', 16), size=0.4, region=lambda c: c.z > 0.5) < plates
# a plain box is cut into plates on a grid in its own space: 2 x 1 x 1 at 0.5 makes 16 + 16 + 8
crate = p.box('Crate', (2, 1, 1), loc=(0, 4, 0.5), mat=hull)
assert p.panel_lines(crate, size=0.5) == 40 and closed(crate)
raises(lambda: p.panel_lines(p.box('Plain', (1, 1, 1), loc=(3, 4, 0.5), mat=hull), pattern='radial'), 'follows a part from p.revolve')
# bake_only: no new faces, a mask on the corners and seam paint on the material
tank = p.capsule('Tank', (0, 7, 0.5), (0, 10, 0.5), 0.5, mat=p.material('Tank paint', '#aa4422'))
faces = len(tank.data.polygons)
assert p.panel_lines(tank, size=0.5, bake_only=True) > 4 and len(tank.data.polygons) == faces
assert {a.domain for a in tank.data.attributes if a.name.startswith('genio_seam')} == {'CORNER'}
paint = bpy.data.materials['Tank paint']
assert 'seams' in paint['genio_paint'] and any(n.type == 'ATTRIBUTE' for n in paint.node_tree.nodes)
raises(lambda: p.panel_lines(p.capsule('Bare', (3, 7, 0.5), (3, 9, 0.5), 0.4), bake_only=True), 'give the part a material first')

# window_rows: one window every two widths round a ring, on the dome's surface, lit
ring = p.circle(1.3, 64, center=(0, 0, 0.45))
windows = p.window_rows('Windows', plated, [ring], size=(0.12, 0.08), closed=True)
count = len(windows.data.polygons) // 6
assert count == int(2 * math.pi * 1.3 // 0.24), count
assert all(1.0 < math.hypot(v.co.x, v.co.y) < 1.6 and 0.2 < v.co.z < 0.8 for v in windows.data.vertices)
light = windows.data.materials[0]
assert light.name == 'Window light' and next(n for n in light.node_tree.nodes if n.type == 'BSDF_PRINCIPLED').inputs['Emission Strength'].default_value > 0
raises(lambda: p.window_rows('Far', plated, [[(10, 10, 10)]]), 'no window found the surface')

# greebles: seeded, within the region and the triangle budget, in the part's own material
first = sorted(tuple(round(c, 6) for c in v.co) for v in p.greebles('Greebles', plated, region=lambda q: q.z > 0.6, density=60, seed=4, budget=900).data.vertices)
again = p.greebles('Greebles', plated, region=lambda q: q.z > 0.6, density=60, seed=4, budget=900)
assert sorted(tuple(round(c, 6) for c in v.co) for v in again.data.vertices) == first
assert sum(len(f.vertices) - 2 for f in again.data.polygons) <= 900 and all(v.co.z > 0.5 for v in again.data.vertices)
assert again.data.materials[0].name == 'Hull'
assert len(p.greebles('Other greebles', plated, region=lambda q: q.z > 0.6, density=60, seed=5, budget=900).data.vertices) > 0
