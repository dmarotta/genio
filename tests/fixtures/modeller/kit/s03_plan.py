"""The plan as data and its blockout, checked from inside Blender"""
import bmesh
from mathutils import Vector


def raises(fn, text):
    try:
        fn()
    except (ValueError, KeyError) as e:
        assert text in str(e), str(e)
    else:
        raise AssertionError(f'no error: {text}')


def near(a, b, tol=1e-4):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


PLAN = p.plan({
    'Hull': dict(at=(0, 0, 1), size=(2, 6, 2), shape='capsule'),
    'Tower': dict(at=(0, 1, 2.5), size=(1, 1.5, 1.5)),
    'Wing L': dict(at=(2.5, 0.5, 1), size=(3, 1.5, 0.2), mirror=True),
    'Engine L': dict(at=(3, 1.5, 1.6), size=(0.6, 2, 0.6), shape='cylinder', mirror=True),
    'Strut L': dict(between=('Hull', 'Engine L'), size=0.15, shape='cylinder', mirror=True),
    'Mast': dict(ends=((0, 1, 3.25), (0, 1.5, 4.5)), size=0.1, level=True),
    'Roof': dict(at=(0, -1.5, 2.3), size=(1.2, 1.5, 0.6), shape='wedge'),
    'Dish': dict(at=(0, -3.1, 1), size=(1.2, 0.2, 1.2), shape='disc', axis='y'),
    'Ball': dict(at=(0, 3.3, 1), size=(0.6, 0.6, 0.6), shape='sphere'),
})
# plan order, each twin right after its part; boxes from the planned shapes
assert list(PLAN) == ['Hull', 'Tower', 'Wing L', 'Wing R', 'Engine L', 'Engine R', 'Strut L', 'Strut R', 'Mast', 'Roof', 'Dish', 'Ball'], list(PLAN)
assert near(PLAN['Tower'].box[0], (-0.5, 0.25, 1.75)) and near(PLAN['Tower'].box[1], (0.5, 1.75, 3.25))
assert PLAN['Wing R'].at == (-2.5, 0.5, 1) and near(PLAN['Wing R'].box[0], (-4, -0.25, 0.9))
assert (PLAN['Hull'].axis, PLAN['Engine L'].axis, PLAN['Roof'].axis, PLAN['Ball'].axis) == ('y', 'y', 'y', 'z')
assert near(PLAN['Hull'].box[0], (-1, -3, 0), 1e-3) and near(PLAN['Hull'].box[1], (1, 3, 2), 1e-3)
# a part between two others runs from one's surface to the other's, sunk half its thickness into each
a, b = (Vector(e) for e in PLAN['Strut L'].ends)
assert 0.85 < Vector((a.x, a.z - 1)).length < 1.0 and (b - Vector(PLAN['Engine L'].at)).length < 0.4, (a, b)
assert near(PLAN['Strut R'].ends[1], (-b.x, b.y, b.z))
# level sections slide along the line: the mast's box is its section swept from end to end
assert near(PLAN['Mast'].box[0], (-0.05, 0.95, 3.25)) and near(PLAN['Mast'].box[1], (0.05, 1.55, 4.5))
assert near(PLAN.box[0], (-4, -3.2, 0), 1e-3) and near(PLAN.box[1], (4, 3.6, 4.5), 1e-3), PLAN.box
kept = p.planned()
assert list(kept['parts']) == list(PLAN) and abs(kept['scale'] - 8) < 1e-3, kept['scale']

raises(lambda: p.plan({'A': dict(at=(0, 0, 0), size=(1, 1, 1), colour='red')}), 'unknown plan key colour')
raises(lambda: p.plan({'A': dict(at=(0, 0, 0), size=(1, 1, 1), shape='beam')}), 'give it ends or between')
raises(lambda: p.plan({'A': dict(between=('B', 'C'), size=0.1)}), "not 'B', 'C'")
raises(lambda: p.plan({'Mast': dict(at=(0, 0, 0), size=(1, 1, 1), mirror=True)}), 'needs a side')
raises(lambda: p.plan({'A L': dict(at=(1, 0, 0), size=(1, 1, 1), mirror=True), 'A R': dict(at=(2, 0, 0), size=(1, 1, 1))}), 'A R is planned twice')
raises(lambda: p.plan({'A': dict(at=(0, 0, 0), size=(1, 0, 1))}), 'above 0')
# the failed plans above left the scene's plan as it was
assert list(p.planned()['parts']) == list(PLAN)

# the blockout: every planned part, named as planned, its box the plan's, each closed
parts = p.blockout(PLAN)
bpy.context.view_layer.update()
assert [o.name for o in parts] == list(PLAN)
for ob in parts:
    lo, hi = p.bounds([ob])
    assert near(lo, PLAN[ob.name].box[0], 1e-4) and near(hi, PLAN[ob.name].box[1], 1e-4), (ob.name, lo, hi, PLAN[ob.name].box)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    assert all(e.is_manifold for e in bm.edges) and bm.calc_volume(signed=True) > 0, ob.name
    bm.free()
assert {m.name for o in parts for m in o.data.materials} == {'Blockout'}
assert [o.name for o in p.blockout(PLAN, 'Ball')] == ['Ball']
raises(lambda: p.blockout(PLAN, 'Sail'), 'Not in the plan: Sail')
