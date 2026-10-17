"""Adding the stone well in the square and a windmill with four sails and a flag"""
import math
import bpy
from mathutils import Matrix, Vector

TOP = 0.205  # the square's dirt sits a touch above the grass
stone = p.material('Stone', '#9a9a94', rough=0.95)
stone_dark = p.material('StoneDark', '#7c7c78', rough=0.95)
timber = p.material('Timber', '#6b4a2f', rough=0.85)
water = p.material('Water', '#4d9ccf', rough=0.15)
plaster = p.material('Plaster', '#efe3c8', rough=0.9)
roof_red = p.material('RoofRed', '#b5452f', rough=0.8)
sailcloth = p.material('Sailcloth', '#f4ecd8', rough=0.9)
flag_mat = p.material('FlagBlue', '#3f6fa8', rough=0.8)
glass = p.material('WindowGlow', '#f3d27a', rough=0.4, emission=0.3)
iron = p.material('Iron', '#3a3a3e', rough=0.6, metal=0.6)


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


def place(root, parts, x, y, z, yaw=0.0):
    for ob in parts:
        p.parent(ob, root)
    root.location = (x, y, z)
    root.rotation_euler = (0, 0, yaw)


# ---- well ----
col = p.collection('well')
ring = p.cylinder('well_ring', 0.065, 0.06, loc=(0, 0, 0.03), mat=stone, segments=10, col=col)
p.origin_to_base(ring)
parts = [p.cylinder('well_lip', 0.072, 0.012, loc=(0, 0, 0.062), mat=stone_dark, segments=10, col=col),
         p.cylinder('well_water', 0.05, 0.006, loc=(0, 0, 0.066), mat=water, segments=10, col=col)]
posts = [p.box('well_post_l', (0.012, 0.012, 0.15), loc=(-0.058, 0, 0.11), mat=timber, col=col),
         p.box('well_post_r', (0.012, 0.012, 0.15), loc=(0.058, 0, 0.11), mat=timber, col=col),
         p.cylinder('well_axle', 0.006, 0.13, loc=(0, 0, 0.15), rot=(0, math.pi / 2, 0), mat=timber, segments=6, col=col),
         p.beam('well_rope', (0, 0, 0.15), (0, 0, 0.11), 0.003, timber, col=col)]
parts.append(join('well_frame', posts))
parts.append(p.cylinder('well_bucket', 0.014, 0.02, loc=(0, 0, 0.1), mat=timber, segments=8, radius_top=0.017, col=col))
th = math.atan2(0.04, 0.05)
slabs = [p.box(f'well_roof_{s}', (0.16, math.hypot(0.05, 0.04) + 0.015, 0.01),
               loc=(0, s * 0.03, 0.205), rot=(-s * th, 0, 0), mat=roof_red, col=col) for s in (-1, 1)]
parts.append(join('well_roof', slabs))
place(ring, parts, 0.02, -0.03, TOP, yaw=0.35)

# ---- windmill ----
col = p.collection('windmill')
tower = p.cylinder('windmill_tower', 0.1, 0.3, loc=(0, 0, 0.15), mat=plaster, segments=8, radius_top=0.072, col=col)
p.origin_to_base(tower)
parts = [p.cylinder('windmill_footing', 0.108, 0.03, loc=(0, 0, 0.015), mat=stone, segments=8, col=col),
         p.cylinder('windmill_cap', 0.088, 0.11, loc=(0, 0, 0.355), mat=roof_red, segments=8, radius_top=0.0, col=col),
         p.box('windmill_door', (0.04, 0.012, 0.065), loc=(0, -0.096, 0.0425), mat=timber, col=col),
         join('windmill_windows', [
             p.box('windmill_w0', (0.025, 0.01, 0.03), loc=(0, -0.083, 0.2), mat=glass, col=col),
             p.box('windmill_w1', (0.01, 0.025, 0.03), loc=(0.09, 0, 0.12), mat=glass, col=col)]),
         join('windmill_flagpole', [
             p.beam('windmill_pole', (0, 0, 0.4), (0, 0, 0.52), 0.005, iron, col=col),
             p.sphere('windmill_finial', 0.008, loc=(0, 0, 0.522), mat=roof_red, subdiv=1, col=col)])]
flag = p.prism('windmill_flag', [(0, 0), (0.07, 0.02), (0, 0.04)], 0.004, loc=(0.003, 0, 0.47),
               rot=(math.pi / 2, 0, 0), mat=flag_mat, col=col)
parts.append(flag)

# hub and sails, pivot on the axle so they can turn
HUB = (0, -0.1, 0.31)
hub = p.cylinder('windmill_hub', 0.02, 0.05, loc=HUB, rot=(math.pi / 2, 0, 0), mat=timber, segments=8, col=col)
sail_parts = []
for k in range(4):
    a = math.pi / 4 + k * math.pi / 2
    d = Vector((math.sin(a), 0, math.cos(a)))
    perp = Vector((math.cos(a), 0, -math.sin(a)))
    h = Vector(HUB) + Vector((0, -0.03, 0))
    sail_parts.append(p.beam(f'windmill_arm{k}', h, h + d * 0.22, 0.008, timber, col=col))
    c = h + d * 0.13 + perp * 0.024
    sail_parts.append(p.box(f'windmill_sail{k}', (0.042, 0.004, 0.16), loc=tuple(c), rot=(0, a, 0), mat=sailcloth, col=col))
    for j, t in enumerate((0.07, 0.13, 0.19)):
        q = h + d * t + perp * 0.024
        sail_parts.append(p.beam(f'windmill_rib{k}{j}', q - perp * 0.024, q + perp * 0.024 - Vector((0, 0.004, 0)),
                                 0.004, timber, col=col))
sails = join('windmill_sails', sail_parts)
set_origin(sails, HUB)
p.parent(sails, hub)
parts.append(hub)
place(tower, parts, -0.6, 0.5, 0.195, yaw=math.atan2(-0.3 - -0.6, -(-0.4 - 0.5)))
