"""Building three more cottages: a mossy one across the stream, a hipped terracotta and a teal one"""
import math
import bpy
import bmesh
from mathutils import Matrix

TOP = 0.195
plaster = p.material('Plaster', '#efe3c8', rough=0.9)
timber = p.material('Timber', '#6b4a2f', rough=0.85)
stone = p.material('Stone', '#9a9a94', rough=0.95)
glass = p.material('WindowGlow', '#f3d27a', rough=0.4, emission=0.3)
moss = p.material('RoofMoss', '#6d8f3a', rough=1.0)
moss_tuft = p.material('MossTuft', '#86a845', rough=1.0)
terracotta = p.material('RoofTerracotta', '#c0673a', rough=0.8)
teal = p.material('RoofTeal', '#4f7f86', rough=0.8)


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


def roof_solid(name, w, d, rh, z, inset, mat, col):
    """Hip (inset > 0) or gable (inset 0) block, ridge along local X."""
    hw, hd = w / 2, d / 2
    r = max(hw - inset, 0.001)
    v = [(-hw, -hd, z), (hw, -hd, z), (hw, hd, z), (-hw, hd, z), (-r, 0, z + rh), (r, 0, z + rh)]
    f = [(0, 3, 2, 1), (0, 1, 5, 4), (2, 3, 4, 5), (1, 2, 5), (3, 0, 4)]
    return mesh_part(name, v, f, mat, col)


def gable_slabs(name, w, d, rh, z, ov, mat, col):
    hd = d / 2
    th = math.atan2(rh, hd)
    t = 0.014
    length = math.hypot(hd, rh) + ov
    slabs = []
    for side in (-1, 1):
        # centre of the slope, pushed out by half the thickness and down by half the overhang
        cy = side * (hd / 2 + math.sin(th) * t / 2 + math.cos(th) * ov / 2)
        cz = z + rh / 2 + math.cos(th) * t / 2 - math.sin(th) * ov / 2
        slabs.append(p.box(f'{name}_{"f" if side < 0 else "b"}', (w + 2 * ov, length, t), loc=(0, cy, cz),
                           rot=(-side * th, 0, 0), mat=mat, col=col))
    return join(name, slabs)


def cottage(tag, x, y, yaw, w, d, h, rh, roof, roof_mat, ridge='x', chimney=True, extra=()):
    col = p.collection(tag)
    walls = p.box(f'{tag}_walls', (w, d, h), loc=(0, 0, h / 2), mat=plaster, col=col, bevel=0.004)
    p.origin_to_base(walls)
    parts = [p.box(f'{tag}_plinth', (w + 0.014, d + 0.014, 0.024), loc=(0, 0, 0.012), mat=stone, col=col)]
    rw, rd = (w, d) if ridge == 'x' else (d, w)
    if roof == 'thatch':
        r = roof_solid(f'{tag}_roof', rw + 0.07, rd + 0.07, rh + 0.02, h - 0.02, rd * 0.3, roof_mat, col)
        p.bevel(r, 0.008, segments=1)
        parts.append(r)
    elif roof == 'hip':
        parts.append(roof_solid(f'{tag}_roof', rw + 0.04, rd + 0.04, rh, h, rd * 0.45, roof_mat, col))
    else:
        parts.append(roof_solid(f'{tag}_gable', rw - 0.002, rd - 0.002, rh, h, 0.0, plaster, col))
        parts.append(gable_slabs(f'{tag}_roof', rw, rd, rh, h, 0.025, roof_mat, col))
    if ridge == 'y':
        # turn the roof about the cottage centre, not about each part's own origin
        for ob in parts[1:]:
            ob.data.transform(ob.matrix_basis)
            ob.matrix_basis = Matrix.Identity(4)
            ob.data.transform(Matrix.Rotation(math.pi / 2, 4, 'Z'))
    # door and windows on the front (-Y) face, one window on the left (+X) side
    fy = -d / 2 - 0.004
    parts.append(p.box(f'{tag}_door', (0.045, 0.012, 0.075), loc=(-w * 0.12, fy, 0.0375 + 0.01), mat=timber, col=col))
    wins = [p.box(f'{tag}_win_a', (0.035, 0.01, 0.035), loc=(w * 0.24, fy, h * 0.6), mat=glass, col=col),
            p.box(f'{tag}_win_b', (0.01, 0.035, 0.035), loc=(w / 2 + 0.004, 0, h * 0.6), mat=glass, col=col)]
    if w > 0.17:
        wins.append(p.box(f'{tag}_win_c', (0.03, 0.01, 0.03), loc=(-w * 0.38, fy, h * 0.62), mat=glass, col=col))
    parts.append(join(f'{tag}_windows', wins))
    if chimney:
        parts.append(p.box(f'{tag}_chimney', (0.035, 0.035, rh + 0.06), loc=(w * 0.28, d * 0.12, h + (rh + 0.06) / 2 - 0.01),
                           mat=stone, col=col))
    for make in extra:
        parts.append(make(col))
    for ob in parts:
        p.parent(ob, walls)
    walls.location = (x, y, TOP)
    walls.rotation_euler = (0, 0, yaw)
    return walls


def facing(x, y, tx, ty):
    return math.atan2(tx - x, -(ty - y))


def moss_tufts(tag, w, d, h, rh):
    def make(col):
        hd = d / 2
        tufts = []
        for i, (u, v) in enumerate([(-0.3, -0.45), (0.15, -0.7), (0.32, -0.25), (-0.1, 0.5)]):
            yy = v * hd
            zz = h + rh * (1 - abs(v)) + 0.016
            t = p.sphere(f'{tag}_tuft_{i}', 0.022, loc=(u * w, yy, zz), mat=moss_tuft, subdiv=1, col=col)
            t.scale = (1.3, 1.0, 0.45)
            p.apply_scale(t)
            tufts.append(t)
        return join(f'{tag}_moss', tufts)
    return make


cottage('cottage_04', 0.78, 0.33, facing(0.78, 0.33, 0.7, 0.1), 0.17, 0.14, 0.12, 0.09, 'gable', moss,
        extra=[moss_tufts('cottage_04', 0.17, 0.14, 0.12, 0.09)])
cottage('cottage_05', 0.78, -0.13, facing(0.78, -0.13, 0.5, -0.13), 0.16, 0.15, 0.12, 0.1, 'hip', terracotta)
cottage('cottage_06', -0.7, -0.02, facing(-0.7, -0.02, -0.7, -0.4), 0.15, 0.14, 0.12, 0.09, 'hip', teal, chimney=False)
