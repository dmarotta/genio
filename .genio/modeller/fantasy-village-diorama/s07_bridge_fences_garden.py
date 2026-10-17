"""Spanning the stream with a little wooden bridge, adding fences and a vegetable garden"""
import math
import bpy
from mathutils import Matrix, Vector

TOP = 0.195
wood = p.material('WoodLight', '#9a6b42', rough=0.85)
timber = p.material('Timber', '#6b4a2f', rough=0.85)
stone = p.material('Stone', '#9a9a94', rough=0.95)
soil = p.material('GardenSoil', '#5b3b26', rough=1.0)
leaf = p.material('Cabbage', '#5e9e3a', rough=0.9)
pumpkin = p.material('Pumpkin', '#e07a2a', rough=0.7)


def drop(name):
    ob = bpy.data.objects.get(name)
    if ob:
        bpy.data.objects.remove(ob, do_unlink=True)


def join(name, objs):
    drop(name)
    keep = objs[0]
    with bpy.context.temp_override(active_object=keep, object=keep, selected_objects=objs,
                                   selected_editable_objects=objs):
        bpy.ops.object.join()
    keep.name = name
    keep.data.name = name
    return keep


def set_origin(ob, pt):
    pt = Vector(pt)
    ob.data.transform(ob.matrix_basis)
    ob.matrix_basis = Matrix.Identity(4)
    ob.data.transform(Matrix.Translation(-pt))
    ob.location = pt


# ---- bridge: arched plank deck with railings, built along local X ----
col = p.collection('bridge')
SPAN, WIDE, ARCH = 0.13, 0.09, 0.035


def deck_z(x):
    return TOP + 0.008 + ARCH * (1 - (x / SPAN) ** 2)


planks = []
n = 9
for i in range(n):
    x = -SPAN + (i + 0.5) * (2 * SPAN / n)
    slope = -2 * ARCH * x / SPAN ** 2
    planks.append(p.box(f'bridge_plank{i}', (2 * SPAN / n - 0.003, WIDE, 0.008), loc=(x, 0, deck_z(x)),
                        rot=(0, -math.atan(slope), 0), mat=wood, col=col))
deck = join('bridge_deck', planks)
rails = []
for s in (-1, 1):
    y = s * (WIDE / 2 - 0.004)
    xs = [-SPAN + 0.01, -0.045, 0.045, SPAN - 0.01]
    for i, x in enumerate(xs):
        rails.append(p.box(f'bridge_post{s}{i}', (0.01, 0.01, 0.06), loc=(x, y, deck_z(x) + 0.03), mat=timber, col=col))
    for i in range(len(xs) - 1):
        a, b = xs[i], xs[i + 1]
        rails.append(p.beam(f'bridge_rail{s}{i}', (a, y, deck_z(a) + 0.055), (b, y, deck_z(b) + 0.055), 0.008, timber, col=col))
rail = join('bridge_railings', rails)
ends = join('bridge_abutments', [
    p.box('bridge_stone_a', (0.03, WIDE + 0.02, 0.02), loc=(-SPAN - 0.005, 0, TOP + 0.008), mat=stone, col=col),
    p.box('bridge_stone_b', (0.03, WIDE + 0.02, 0.02), loc=(SPAN + 0.005, 0, TOP + 0.008), mat=stone, col=col)])
set_origin(deck, (0, 0, TOP))
for ob in (rail, ends):
    p.parent(ob, deck)
deck.location = (0.485, 0.135, TOP)
deck.rotation_euler = (0, 0, math.atan2(0.03, 0.23))


# ---- fences: posts and two rails along a polyline ----
def fence(name, pts, col, gap=None):
    bits = []
    for i in range(len(pts) - 1):
        a, b = Vector((*pts[i], 0)), Vector((*pts[i + 1], 0))
        if gap is not None and i == gap:
            continue
        L = (b - a).length
        k = max(1, round(L / 0.06))
        for j in range(k + 1):
            if j == 0 and i > 0 and gap != i - 1:
                continue
            q = a + (b - a) * (j / k)
            bits.append(p.box(f'{name}_p{i}_{j}', (0.011, 0.011, 0.065), loc=(q.x, q.y, TOP + 0.0325), mat=timber, col=col))
        for hi, h in enumerate((0.025, 0.05)):
            bits.append(p.beam(f'{name}_r{i}_{hi}', (a.x, a.y, TOP + h), (b.x, b.y, TOP + h), 0.007, wood, col=col))
    ob = join(name, bits)
    set_origin(ob, (pts[0][0], pts[0][1], TOP))
    return ob


col = p.collection('fences')
# garden fence, open on the side facing the teal cottage
g = [(-0.57, -0.29), (-0.57, -0.44), (-0.77, -0.44), (-0.77, -0.29), (-0.7, -0.29)]
fence('fence_garden', g, col)
fence('fence_pond', [(0.13, -0.84), (0.17, -0.64), (0.11, -0.44), (0.12, -0.3)], col)
fence('fence_east', [(0.66, 0.5), (0.68, 0.62), (0.62, 0.75)], col)

# ---- garden beds and crops ----
col = p.collection('garden')
bed = p.box('garden_bed', (0.17, 0.12, 0.014), loc=(-0.67, -0.365, TOP + 0.007), mat=soil, col=col)
p.origin_to_base(bed)
crops = []
for r, yy in enumerate((-0.4, -0.365, -0.33)):
    for c in range(4):
        xx = -0.735 + c * 0.044
        if r == 1:
            ob = p.sphere(f'garden_pumpkin{c}', 0.014, loc=(xx, yy, TOP + 0.022), mat=pumpkin, subdiv=1, col=col)
            ob.scale = (1.0, 1.0, 0.75)
        else:
            ob = p.sphere(f'garden_cabbage{r}{c}', 0.013, loc=(xx, yy, TOP + 0.024), mat=leaf, subdiv=1, col=col)
        p.apply_scale(ob)
        crops.append(ob)
p.parent(join('garden_crops', crops), bed)
