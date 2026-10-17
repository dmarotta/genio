"""Lighting the lanes with lanterns and stacking barrels, crates and flour sacks"""
import math
import bpy

TOP = 0.195
timber = p.material('Timber', '#6b4a2f', rough=0.85)
wood = p.material('WoodLight', '#9a6b42', rough=0.85)
iron = p.material('Iron', '#3a3a3e', rough=0.6, metal=0.6)
glow = p.material('LanternGlow', '#ffd27a', rough=0.4, emission=1.5)
barrel_mat = p.material('BarrelWood', '#8a5a34', rough=0.85)
sack = p.material('Sack', '#e3d3a8', rough=1.0)


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


col = p.collection('props')


def lantern(tag, x, y, yaw):
    # post with a short arm towards -Y (turned by yaw), lantern hanging from it
    ca, sa = math.cos(yaw), math.sin(yaw)

    def at(lx, ly, z):
        return (x + lx * ca - ly * sa, y + lx * sa + ly * ca, TOP + z)

    bits = [p.box(f'{tag}_post', (0.01, 0.01, 0.13), loc=at(0, 0, 0.065), rot=(0, 0, yaw), mat=timber, col=col),
            p.beam(f'{tag}_arm', at(0, 0, 0.12), at(0, -0.03, 0.12), 0.006, iron, col=col),
            p.box(f'{tag}_frame', (0.02, 0.02, 0.004), loc=at(0, -0.03, 0.082), rot=(0, 0, yaw), mat=iron, col=col),
            p.cylinder(f'{tag}_cap', 0.017, 0.014, loc=at(0, -0.03, 0.11), rot=(0, 0, yaw + math.pi / 4), mat=iron,
                       segments=4, radius_top=0.0, col=col),
            p.beam(f'{tag}_hook', at(0, -0.03, 0.12), at(0, -0.03, 0.115), 0.003, iron, col=col)]
    post = join(tag, bits)
    p.origin_to_base(post)
    g = p.box(f'{tag}_glow', (0.016, 0.016, 0.022), loc=at(0, -0.03, 0.095), rot=(0, 0, yaw), mat=glow, col=col)
    p.parent(g, post)


lantern('lantern_01', -0.205, 0.43, 0.0)
lantern('lantern_02', -0.035, 0.43, 0.0)
lantern('lantern_03', -0.17, -0.17, -math.pi / 4)
lantern('lantern_04', -0.11, -0.8, -math.pi / 2)
lantern('lantern_05', 0.63, 0.23, math.pi)


def barrel(name, x, y, z=0.0, s=1.0):
    prof = [(0.0, 0.0), (0.015 * s, 0.0), (0.019 * s, 0.019 * s), (0.015 * s, 0.038 * s), (0.0, 0.038 * s)]
    b = p.lathe(name, prof, 8, loc=(x, y, TOP + z), mat=barrel_mat, col=col)
    bands = [p.cylinder(f'{name}_band{i}', 0.0185 * s, 0.003, loc=(x, y, TOP + z + h * s), mat=iron, segments=8, col=col)
             for i, h in enumerate((0.009, 0.029))]
    p.parent(join(f'{name}_bands', bands), b)
    return b


barrel('barrel_01', 0.08, 0.51)
barrel('barrel_02', 0.118, 0.515, s=0.9)
barrel('barrel_03', -0.47, 0.4)
barrel('barrel_04', 0.7, 0.24, s=0.9)

crate_specs = [('crate_01', 0.1, 0.44, 0.0, 0.2, 0.032), ('crate_02', 0.1, 0.44, 0.032, 0.6, 0.026),
               ('crate_03', -0.19, -0.55, 0.0, 0.4, 0.03), ('crate_04', -0.16, -0.52, 0.0, 1.0, 0.024)]
for name, x, y, z, rz, s in crate_specs:
    c = p.box(name, (s, s, s), loc=(x, y, TOP + z + s / 2), rot=(0, 0, rz), mat=wood, col=col, bevel=0.002)
    slats = [p.box(f'{name}_slat{i}', (s + 0.002, 0.004, s + 0.002), loc=(x, y, TOP + z + s / 2), rot=(0, 0, rz + a),
                   mat=timber, col=col) for i, a in enumerate((0.0, math.pi / 2))]
    p.parent(join(f'{name}_slats', slats), c)
    p.origin_to_base(c)

for i, (x, y, rz) in enumerate([(-0.465, 0.47, 0.3), (-0.455, 0.505, 1.2), (-0.47, 0.54, 2.1)]):
    s = p.sphere(f'sack_{i + 1:02d}', 0.016, loc=(x, y, TOP + 0.012), mat=sack, subdiv=1, col=col)
    s.scale = (1.0, 0.8, 0.85)
    s.rotation_euler = (0, 0, rz)
    p.apply_scale(s)
    p.jitter(s, 0.002, 40 + i)
    p.origin_to_base(s)
