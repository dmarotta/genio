"""Raising the tavern: stone ground floor, timber-framed upper floor and a hanging sign"""
import math
import bpy
import bmesh

TOP = 0.195
plaster = p.material('Plaster', '#efe3c8', rough=0.9)
timber = p.material('Timber', '#6b4a2f', rough=0.85)
stone = p.material('Stone', '#9a9a94', rough=0.95)
glass = p.material('WindowGlow', '#f3d27a', rough=0.4, emission=0.3)
roof_mat = p.material('RoofTavern', '#9b3b28', rough=0.8)
iron = p.material('Iron', '#3a3a3e', rough=0.6, metal=0.6)
gold = p.material('SignGold', '#e0b040', rough=0.5, metal=0.3)


def _col(col):
    return col if hasattr(col, 'objects') else bpy.data.collections[col]


def drop(name):
    ob = bpy.data.objects.get(name)
    if ob:
        bpy.data.objects.remove(ob, do_unlink=True)


def mesh_part(name, verts, faces, mat, col):
    drop(name)
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    _col(col).objects.link(ob)
    return ob


def join(name, objs):
    drop(name)
    keep = objs[0]
    with bpy.context.temp_override(active_object=keep, object=keep, selected_objects=objs,
                                   selected_editable_objects=objs):
        bpy.ops.object.join()
    keep.name = name
    keep.data.name = name
    return keep


def gable_solid(name, w, d, rh, z, mat, col):
    hw, hd = w / 2, d / 2
    v = [(-hw, -hd, z), (hw, -hd, z), (hw, hd, z), (-hw, hd, z), (-hw, 0, z + rh), (hw, 0, z + rh)]
    f = [(0, 3, 2, 1), (0, 1, 5, 4), (2, 3, 4, 5), (1, 2, 5), (3, 0, 4)]
    return mesh_part(name, v, f, mat, col)


def gable_slabs(name, w, d, rh, z, ov, mat, col):
    hd = d / 2
    th = math.atan2(rh, hd)
    t = 0.016
    length = math.hypot(hd, rh) + ov
    slabs = []
    for side in (-1, 1):
        cy = side * (hd / 2 + math.sin(th) * t / 2 + math.cos(th) * ov / 2)
        cz = z + rh / 2 + math.cos(th) * t / 2 - math.sin(th) * ov / 2
        slabs.append(p.box(f'{name}_{"f" if side < 0 else "b"}', (w + 2 * ov, length, t), loc=(0, cy, cz),
                           rot=(-side * th, 0, 0), mat=mat, col=col))
    return join(name, slabs)


col = p.collection('tavern')
W, D, H1 = 0.30, 0.20, 0.12       # stone ground floor
UW, UD, H2 = 0.33, 0.22, 0.11     # jettied upper floor
RH = 0.13
walls = p.box('tavern_walls', (W, D, H1), loc=(0, 0, H1 / 2), mat=stone, col=col, bevel=0.004)
p.origin_to_base(walls)
parts = [p.box('tavern_upper', (UW, UD, H2), loc=(0, 0, H1 + H2 / 2), mat=plaster, col=col)]
z_eave = H1 + H2
parts.append(gable_solid('tavern_gable', UW - 0.002, UD - 0.002, RH, z_eave, plaster, col))
parts.append(gable_slabs('tavern_roof', UW, UD, RH, z_eave, 0.03, roof_mat, col))
parts.append(p.box('tavern_chimney', (0.045, 0.045, RH + 0.08), loc=(-UW * 0.3, UD * 0.15, z_eave + (RH + 0.08) / 2 - 0.01),
                   mat=stone, col=col))

# timber framing on the upper front and sides
fy = -UD / 2 - 0.004
beams = [p.box('tavern_bm_low', (UW + 0.008, 0.012, 0.014), loc=(0, fy, H1 + 0.007), mat=timber, col=col),
         p.box('tavern_bm_top', (UW + 0.008, 0.012, 0.012), loc=(0, fy, z_eave - 0.006), mat=timber, col=col)]
for i, x in enumerate([-UW / 2 + 0.006, -0.055, 0.055, UW / 2 - 0.006]):
    beams.append(p.box(f'tavern_bm_v{i}', (0.012, 0.012, H2), loc=(x, fy, H1 + H2 / 2), mat=timber, col=col))
beams.append(p.beam('tavern_bm_d0', (-0.055, fy, H1 + 0.01), (-0.11, fy, z_eave - 0.01), 0.01, timber, col=col))
beams.append(p.beam('tavern_bm_d1', (0.055, fy, H1 + 0.01), (0.11, fy, z_eave - 0.01), 0.01, timber, col=col))
for s in (-1, 1):
    sx = s * (UW / 2 + 0.004)
    beams.append(p.box(f'tavern_bm_side{s}', (0.012, UD + 0.008, 0.014), loc=(sx, 0, H1 + 0.007), mat=timber, col=col))
    beams.append(p.box(f'tavern_bm_sidev{s}', (0.012, 0.012, H2), loc=(sx, 0, H1 + H2 / 2), mat=timber, col=col))
parts.append(join('tavern_beams', beams))

# door and windows
gy = -D / 2 - 0.004
parts.append(p.box('tavern_door', (0.07, 0.012, 0.09), loc=(0, gy, 0.045), mat=timber, col=col))
wins = [p.box('tavern_w0', (0.045, 0.01, 0.04), loc=(-0.095, gy, 0.065), mat=glass, col=col),
        p.box('tavern_w1', (0.045, 0.01, 0.04), loc=(0.095, gy, 0.065), mat=glass, col=col),
        p.box('tavern_w2', (0.035, 0.01, 0.04), loc=(-0.11 + 0.0, fy - 0.002, H1 + 0.06), mat=glass, col=col),
        p.box('tavern_w3', (0.035, 0.01, 0.04), loc=(0.0, fy - 0.002, H1 + 0.06), mat=glass, col=col),
        p.box('tavern_w4', (0.035, 0.01, 0.04), loc=(0.11, fy - 0.002, H1 + 0.06), mat=glass, col=col),
        p.box('tavern_w5', (0.01, 0.04, 0.04), loc=(W / 2 + 0.004, 0, 0.065), mat=glass, col=col),
        p.box('tavern_w6', (0.01, 0.04, 0.04), loc=(-W / 2 - 0.004, 0, 0.065), mat=glass, col=col)]
parts.append(join('tavern_windows', wins))

# hanging sign on an iron bracket off the front corner
bx, bz = W / 2 - 0.02, H1 - 0.012
reach = gy - 0.09
parts.append(join('tavern_bracket', [
    p.beam('tavern_br_arm', (bx, gy, bz), (bx, reach, bz), 0.008, iron, col=col),
    p.beam('tavern_br_brace', (bx, gy, bz - 0.045), (bx, reach + 0.03, bz), 0.006, iron, col=col),
    p.beam('tavern_br_c0', (bx, reach + 0.012, bz), (bx, reach + 0.012, bz - 0.025), 0.003, iron, col=col),
    p.beam('tavern_br_c1', (bx, reach + 0.062, bz), (bx, reach + 0.062, bz - 0.025), 0.003, iron, col=col)]))
sign = p.box('tavern_sign', (0.008, 0.07, 0.05), loc=(bx, reach + 0.037, bz - 0.05), mat=timber, col=col)
parts.append(sign)
mug = [p.box('tavern_mug', (0.012, 0.024, 0.026), loc=(bx, reach + 0.035, bz - 0.052), mat=gold, col=col),
       p.box('tavern_mug_handle', (0.012, 0.008, 0.014), loc=(bx, reach + 0.052, bz - 0.05), mat=gold, col=col)]
parts.append(join('tavern_sign_emblem', mug))

for ob in parts:
    p.parent(ob, walls)
walls.location = (-0.12, 0.57, TOP)
