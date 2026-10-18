"""Modeller part helpers: data-API primitives that behave the same on Blender 4.2 and 5.x.

Step scripts get this module preloaded as `p` (and `bpy`). Nothing here needs
bpy.ops or a UI context, so nothing fails a poll in background mode. Every part
is named: building a part again replaces the old one, so a step can run twice
without leaving `Leg.001` behind, and the live view can diff parts by name.

Conventions: metres, Z up, the model stands on z = 0 with its footprint centred
on the origin and its front facing -Y. Deliverable parts live in the `Export`
collection (or collections inside it); boolean cutters go to the hidden
`Cutters` collection; review cameras and lights never enter `Export`.

Hard-surface kit: mesh() from raw geometry, smooth() shading with sharp edges by
angle, revolve(), sweep(), hull() and capsule() surfaces whose faces know where
they sit (so panel_lines() cuts seams in rows and columns), window_rows(),
greebles() and material presets. Plan as data: plan() lays the model out before
any geometry, blockout() builds every planned part as a simple shape, and the
review's Plan line compares the built parts with it.

Paint: camo() and weathering() put procedural paint on a material (world-space
nodes feeding its Principled BSDF); bake_maps() bakes every part's paint into one
shared PBR texture set with one Cycles bake per map, on a temporary joined copy.
"""
import json
import math
import os
import random
import re
import time

import bpy
import bmesh
import numpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

import genio_bpy

VERSION = tuple(bpy.app.version[:2])
EEVEE = 'BLENDER_EEVEE_NEXT' if VERSION < (5, 0) else 'BLENDER_EEVEE'
EXPORT, CUTTERS = 'Export', 'Cutters'
_SUFFIX = re.compile(r'\.\d{3}$')

# How each target sees a Blender model built to the conventions above. The
# exporters (genio_bpy presets) convert Z up to Y up; 1 Blender unit is 1 metre.
CONVENTIONS = {
    'unity': {'format': 'fbx', 'front': 'Unity +Z (Blender -Y)', 'up': 'Y', 'unit': 'metre'},
    'godot': {'format': 'glb', 'front': 'glTF +Z, Godot MODEL_FRONT (Blender -Y)', 'up': 'Y', 'unit': 'metre'},
    'web': {'format': 'glb', 'front': 'glTF +Z (Blender -Y)', 'up': 'Y', 'unit': 'metre'},
}


def _clean(name):
    if not isinstance(name, str) or not name.strip():
        raise ValueError('Parts and materials need a name')
    if _SUFFIX.search(name):
        raise ValueError(f'{name!r}: pick a real name instead of a .001 suffix')
    return name.strip()


def collection(name=EXPORT, parent=None):
    """Get or make a collection. Collections other than Export/Cutters nest inside Export
    by default, so `p.collection('Roof')` groups parts that still ship."""
    name = _clean(name)
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
        if parent is None:
            parent = bpy.context.scene.collection if name in (EXPORT, CUTTERS) else collection(EXPORT)
        parent.children.link(col)
    return col


def _hex(color):
    """'#rrggbb' (sRGB, as designers write it) to linear RGB; tuples pass through as linear."""
    if isinstance(color, str):
        h = color.lstrip('#')
        if len(h) != 6:
            raise ValueError(f'Colour {color!r}: use #rrggbb')
        srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
        return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb)
    if len(color) != 3:
        raise ValueError('Colour needs three channels (r, g, b)')
    return tuple(float(c) for c in color)


# Realistic starting points: roughness, metallic and emission, then other Principled BSDF inputs.
# Every material sets all of these inputs (to the Principled defaults without a preset), so calling
# material() again under the same name with another preset leaves nothing of the old one behind.
PRESETS = {
    'brushed': {'rough': 0.32, 'metal': 1.0, 'Anisotropic': 0.6},
    'painted': {'rough': 0.42, 'metal': 0.0, 'Coat Weight': 0.35, 'Coat Roughness': 0.08},
    'glass': {'rough': 0.03, 'metal': 0.0, 'Transmission Weight': 1.0, 'IOR': 1.45},
    'emissive': {'rough': 0.5, 'metal': 0.0, 'emission': 4.0},
    'rubber': {'rough': 0.92, 'metal': 0.0, 'Specular IOR Level': 0.25},
}
_PRESET_INPUTS = {'Anisotropic': 0.0, 'Coat Weight': 0.0, 'Coat Roughness': 0.03, 'Transmission Weight': 0.0, 'IOR': 1.5, 'Specular IOR Level': 0.5}


def material(name, color, rough=None, metal=None, emission=None, preset=None):
    """One material per name, reused on later calls. Sets the Principled BSDF for export and
    diffuse_color for Workbench, which the review sheet renders with. `preset` ('brushed', 'painted',
    'glass', 'emissive', 'rubber') gives roughness, metallic, emission and the inputs that make that
    look; rough, metal and emission given as well win. Without one: rough 0.8, metal 0, no emission."""
    name = _clean(name)
    rgb = _hex(color)
    if preset is not None and preset not in PRESETS:
        raise ValueError(f'No material preset {preset!r}: use one of {", ".join(PRESETS)}')
    look = {'rough': 0.8, 'metal': 0.0, 'emission': 0.0, **_PRESET_INPUTS, **PRESETS.get(preset, {})}
    rough = look['rough'] if rough is None else rough
    metal = look['metal'] if metal is None else metal
    emission = look['emission'] if emission is None else emission
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    if mat.node_tree is None:  # 4.2 starts without nodes; 5.x always has a tree
        mat.use_nodes = True
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is None:
        bsdf = mat.node_tree.nodes.new('ShaderNodeBsdfPrincipled')
        out = next((n for n in mat.node_tree.nodes if n.type == 'OUTPUT_MATERIAL'), None) or mat.node_tree.nodes.new('ShaderNodeOutputMaterial')
        mat.node_tree.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    for key in _PRESET_INPUTS:
        bsdf.inputs[key].default_value = look[key]
    if emission:
        bsdf.inputs['Emission Color'].default_value = (*rgb, 1)
    bsdf.inputs['Emission Strength'].default_value = emission
    mat.diffuse_color = (*rgb, 1)
    mat.roughness, mat.metallic = rough, metal
    return mat


def _replace(name):
    old = bpy.data.objects.get(name)
    if old is not None:
        data = old.data
        bpy.data.objects.remove(old)
        if isinstance(data, bpy.types.Mesh) and data.users == 0:
            bpy.data.meshes.remove(data)
        # The view layer keeps the removed object's slot (None in view_layer.objects) until it
        # syncs: anything iterating it after a remove or a rebuild crashed (about 3 ms).
        bpy.context.view_layer.update()
    orphan = bpy.data.meshes.get(name)
    if orphan is not None and orphan.users == 0:
        bpy.data.meshes.remove(orphan)


def _object(name, bm, mat, col, loc, rot, smooth=False):
    name = _clean(name)
    _replace(name)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if mat is not None:
        me.materials.append(mat)
    if smooth:
        me.shade_smooth()
    ob = bpy.data.objects.new(name, me)
    (col or collection()).objects.link(ob)
    ob.location = loc
    ob.rotation_euler = rot
    return ob


def box(name, size, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, col=None, bevel=0.0):
    """Box of size (x, y, z) centred on loc. bevel > 0 adds a Bevel modifier of that width."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    ob = _object(name, bm, mat, col, loc, rot)
    if bevel:
        _bevel(ob, bevel)
    return ob


def cylinder(name, radius, depth, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, col=None,
             segments=16, radius_top=None, smooth=False):
    """Cylinder along local Z, centred on loc. radius_top tapers it (0 makes a cone)."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments, radius1=radius,
                          radius2=radius if radius_top is None else radius_top, depth=depth)
    return _object(name, bm, mat, col, loc, rot, smooth)


def cone(name, radius, depth, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, col=None, segments=16):
    return cylinder(name, radius, depth, loc, rot, mat, col, segments, radius_top=0.0)


def sphere(name, radius, loc=(0, 0, 0), mat=None, col=None, subdiv=2, smooth=True):
    """Icosphere; subdiv 1 is a faceted low-poly ball."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=radius)
    return _object(name, bm, mat, col, loc, (0, 0, 0), smooth)


def plane(name, size, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, col=None):
    """Flat (x, y) rectangle. Open surface: add solidify() if it must have thickness."""
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=0.5)
    bmesh.ops.scale(bm, vec=Vector((size[0], size[1], 1)), verts=bm.verts)
    return _object(name, bm, mat, col, loc, rot)


def beam(name, a, b, thickness, mat=None, col=None):
    """Square beam from point a to point b (posts, braces, rails). Steep beams keep their
    sides square to the world axes; shallow ones keep a face pointing up."""
    a, b = Vector(a), Vector(b)
    d = b - a
    if d.length < 1e-9:
        raise ValueError(f'{name}: beam ends are the same point')
    ob = box(name, (thickness, thickness, d.length), (a + b) / 2, mat=mat, col=col)
    steep = abs(d.normalized().z) > 0.7
    ob.rotation_euler = (Vector((0, 0, 1)).rotation_difference(d) if steep else d.to_track_quat('Z', 'Y')).to_euler()
    return ob


def prism(name, points, depth, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, col=None):
    """Extrude a 2D outline [(x, y), ...] (counter-clockwise) along local Z by depth, centred.
    Gables, wedges, blades, signs: any flat shape with thickness."""
    if len(points) < 3:
        raise ValueError('prism needs at least three outline points')
    bm = bmesh.new()
    verts = [bm.verts.new((x, y, -depth / 2)) for x, y in points]
    face = bm.faces.new(verts)
    top = bmesh.ops.extrude_face_region(bm, geom=[face])
    bmesh.ops.translate(bm, vec=(0, 0, depth), verts=[v for v in top['geom'] if isinstance(v, bmesh.types.BMVert)])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _object(name, bm, mat, col, loc, rot)


def lathe(name, profile, segments=16, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, col=None, smooth=False):
    """Spin a profile [(radius, z), ...] from bottom to top around local Z: vases, barrels,
    columns, bottles. Profile points at radius 0 close the ends."""
    if len(profile) < 2:
        raise ValueError('lathe needs at least two profile points')
    bm = bmesh.new()
    verts = [bm.verts.new((r, 0, z)) for r, z in profile]
    edges = [bm.edges.new((verts[i], verts[i + 1])) for i in range(len(verts) - 1)]
    bmesh.ops.spin(bm, geom=verts + edges, cent=(0, 0, 0), axis=(0, 0, 1), angle=2 * math.pi,
                   steps=segments, use_duplicate=False)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _object(name, bm, mat, col, loc, rot, smooth)


def loft(name, sections, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, col=None, closed=True, caps=True, smooth=False):
    """Skin a surface through cross-sections in order: hulls, fuselages, bottles, sails. Each section
    is a list of (x, y, z) points, all with the same count; a section of one point is a pointed tip.
    closed: each section is a loop, and caps fills the first and last loops. closed=False gives an
    open sheet through open lines (a sail, a roof skin)."""
    if len(sections) < 2:
        raise ValueError(f'{name}: loft needs at least two sections')
    n = max(len(s) for s in sections)
    if n < (3 if closed else 2) or any(len(s) not in (1, n) for s in sections):
        raise ValueError(f'{name}: every section needs the same number of points ({n}; at least {3 if closed else 2}), or one for a tip')
    bm = bmesh.new()
    rings = [[bm.verts.new(pt) for pt in s] for s in sections]
    for a, b in zip(rings, rings[1:]):
        if len(a) == len(b) == 1:
            raise ValueError(f'{name}: two one-point sections in a row')
        for i in range(n if closed else n - 1):
            j = (i + 1) % n
            bm.faces.new((a[0], b[j], b[i]) if len(a) == 1 else (a[i], a[j], b[0]) if len(b) == 1 else (a[i], a[j], b[j], b[i]))
    if closed and caps:
        for ring in (rings[0], rings[-1]):
            if len(ring) > 1:
                bm.faces.new(ring)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _object(name, bm, mat, col, loc, rot, smooth)


def jitter(ob, amount, seed):
    """Seeded vertex noise for rocks and foliage; the same seed gives the same shape."""
    rng = random.Random(seed)
    for v in ob.data.vertices:
        v.co += Vector([rng.uniform(-amount, amount) for _ in range(3)])
    ob.data.update()
    return ob


def _modifier(ob, name, kind):
    """Modifiers are named too: adding one again replaces it instead of stacking a copy."""
    old = ob.modifiers.get(name)
    if old is not None:
        ob.modifiers.remove(old)
    return ob.modifiers.new(name, kind)


def bevel(ob, width, segments=2, angle=30.0, name='Bevel'):
    """Rounded edges where faces meet at more than `angle` degrees."""
    mod = _modifier(ob, name, 'BEVEL')
    mod.width, mod.segments = width, segments
    mod.limit_method, mod.angle_limit = 'ANGLE', math.radians(angle)
    return mod


_bevel = bevel  # box() takes a `bevel` width argument that shadows the function


def array(ob, count, offset, name='Array'):
    """count copies, each moved by the constant offset (x, y, z) in metres."""
    mod = _modifier(ob, name, 'ARRAY')
    mod.count, mod.use_relative_offset, mod.use_constant_offset = count, False, True
    mod.constant_offset_displace = offset
    return mod


def mirror(ob, axes=(True, False, False), about=None, name='Mirror'):
    """Mirror across the object's own axes, or across another object's (about=...)."""
    mod = _modifier(ob, name, 'MIRROR')
    mod.use_axis = axes
    if about is not None:
        mod.mirror_object = about
    return mod


def solidify(ob, thickness, offset=-1.0, name='Solidify'):
    mod = _modifier(ob, name, 'SOLIDIFY')
    mod.thickness, mod.offset = thickness, offset
    return mod


def subsurf(ob, levels=1, name='Subdivision'):
    """Smooth subdivision (organic shapes). Each level roughly quadruples triangles."""
    mod = _modifier(ob, name, 'SUBSURF')
    mod.levels = mod.render_levels = levels
    return mod


def boolean_cut(ob, cutter, name='Cut'):
    """Non-destructive difference. The cutter moves to the hidden Cutters collection and never ships."""
    cutters = collection(CUTTERS)
    cutters.hide_render = True
    for c in list(cutter.users_collection):
        c.objects.unlink(cutter)
    cutters.objects.link(cutter)
    cutter.display_type = 'WIRE'
    cutter.hide_render = True
    mod = _modifier(ob, name, 'BOOLEAN')
    mod.operation, mod.object, mod.solver = 'DIFFERENCE', cutter, 'EXACT'
    return mod


def freeze(*parts):
    """Apply finished parts' modifiers for good (Subdivision, Bevel, Boolean, Mirror, Array...): each
    part keeps exactly the shape it ships, and later steps stop evaluating its modifiers again (every
    step is a fresh Blender, and a .blend keeps no modifier results). Parts or names; none: every part
    in Export. Armature modifiers stay; a part with shape keys keeps its stack (it ships without it).
    Returns the parts it froze."""
    obs = list(dict.fromkeys(_get(o) for o in parts)) if parts else export_objects()
    live = [o for o in obs if genio_bpy._bakes_modifiers(o)]
    baked = genio_bpy._evaluated_meshes(live)
    for ob in live:
        old = ob.data
        for m in [m for m in ob.modifiers if m.type != 'ARMATURE' and m.show_viewport]:
            ob.modifiers.remove(m)
        ob.data = baked[ob]
        if old.users == 0:
            bpy.data.meshes.remove(old)
        ob.data.name = ob.name
    return live


def part(name):
    """An existing part by name; a clear error names the parts that do exist."""
    ob = bpy.data.objects.get(name)
    if ob is None:
        names = sorted(o.name for o in export_objects())
        known = ', '.join(names[:40]) + (f' and {len(names) - 40} more' if len(names) > 40 else '') if names else 'none'
        raise KeyError(f'No part named {name!r}. Parts: {known}')
    return ob


def remove(*names):
    """Delete parts by name (missing names are ignored, so a step stays re-runnable)."""
    for n in names:
        _replace(n)


def parent(child, parent_ob):
    """Parent without moving the child."""
    bpy.context.view_layer.update()  # a part placed in this script has no world matrix until the layer syncs
    child.parent = parent_ob
    child.matrix_parent_inverse = parent_ob.matrix_world.inverted()
    return child


_INTENDED = 'genio_intended'  # scene property: the pairs of parts meant to overlap, as JSON


def intended(*parts):
    """Mark parts as meant to overlap or share faces (a keel through the hull, a decal on a panel):
    the text review leaves every pair among them out of its Deep overlap and Z-fighting lines. Parts
    or names, two or more. The scene keeps the marks, so later steps and replays have them. Returns
    every marked pair."""
    names = list(dict.fromkeys(_get(o).name for o in parts))
    if len(names) < 2:
        raise ValueError('intended needs two or more parts')
    pairs = set(intended_pairs()) | {tuple(sorted((a, b))) for i, a in enumerate(names) for b in names[i + 1:]}
    bpy.context.scene[_INTENDED] = json.dumps(sorted(pairs))
    return sorted(pairs)


def intended_pairs():
    """The pairs p.intended() marked, as sorted (name, name) tuples."""
    try:
        return [tuple(x) for x in json.loads(bpy.context.scene.get(_INTENDED, '[]'))]
    except (TypeError, ValueError):
        return []


def _get(ob):
    return part(ob) if isinstance(ob, str) else ob


def _flip(mesh):
    """Reverse the winding of every face (a mirrored mesh would otherwise face inwards)."""
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()


def join(name, parts, col=None):
    """One part from several (parts or names), as they ship: modifiers applied, materials kept. It
    takes the first part's origin, rotation and parent; the parts are removed and their children
    move to the new part without moving. `name` may be one of theirs."""
    name = _clean(name)
    obs = list(dict.fromkeys(_get(o) for o in parts))
    if not obs:
        raise ValueError('join needs at least one part')
    other = [o.name for o in obs if o.type != 'MESH']
    if other:
        raise ValueError(f'join takes mesh parts only, not {_names_of(other)}')
    bpy.context.view_layer.update()
    first = obs[0]
    at, turn, _ = first.matrix_world.decompose()
    frame = Matrix.LocRotScale(at, turn, None)
    up = first.parent
    while up in obs:
        up = up.parent
    col = col or (first.users_collection[0] if first.users_collection else None)
    kids = [(c, c.matrix_world.copy()) for o in obs for c in o.children if c not in obs]
    mats, bm = [], bmesh.new()
    with evaluated(obs) as shipped:
        for ob in obs:
            me = shipped[ob].copy()
            m = frame.inverted() @ ob.matrix_world
            me.transform(m)
            if m.determinant() < 0:
                _flip(me)
            slots = [s.material for s in ob.material_slots] or [None]
            for s in slots:
                if s not in mats:
                    mats.append(s)
            remap = [mats.index(s) for s in slots]
            index = numpy.zeros(len(me.polygons), dtype=numpy.int32)
            me.polygons.foreach_get('material_index', index)
            me.polygons.foreach_set('material_index', numpy.array(remap, dtype=numpy.int32)[numpy.minimum(index, len(remap) - 1)])
            bm.from_mesh(me)
            bpy.data.meshes.remove(me)
    for n in [o.name for o in obs]:
        _replace(n)
    ob = _object(name, bm, None, col, (0, 0, 0), (0, 0, 0))
    for m in mats:
        ob.data.materials.append(m)
    ob.matrix_world = frame
    if up is not None:
        parent(ob, up)
    for c, world in kids:
        c.parent = ob
        c.matrix_parent_inverse = frame.inverted()
        c.matrix_basis = world
    return ob


_join = join  # ring() takes a `join` flag that shadows the function


def _world_mesh(objects):
    """World-space vertices (n, 3) and polygons of the shipped meshes of `objects`, as one mesh."""
    pts, polys, at = [], [], 0
    with evaluated(objects) as shipped:
        for ob, me in shipped.items():
            pts.append(world_vertices(ob, me))
            polys += [tuple(i + at for i in pl.vertices) for pl in me.polygons]
            at += len(me.vertices)
    return (numpy.concatenate(pts) if pts else numpy.empty((0, 3))), polys


def _gap(pts, polys, below, below_polys):
    """The smallest vertical gap between the bottom of one mesh and the top of another under it,
    probed along vertical rays through both meshes' vertices; None when nothing is under it."""
    if not len(below) or not below_polys:
        return None
    mine, theirs = BVHTree.FromPolygons(pts.tolist(), polys), BVHTree.FromPolygons(below.tolist(), below_polys)
    top = max(pts[:, 2].max(), below[:, 2].max()) + 1.0
    bottom = min(pts[:, 2].min(), below[:, 2].min()) - 1.0
    gaps = []
    for x, y, z in pts:
        hit = theirs.ray_cast(Vector((x, y, top)), Vector((0, 0, -1)))[0]
        if hit is not None:
            gaps.append(z - hit.z)
    lo, hi = pts[:, :2].min(axis=0), pts[:, :2].max(axis=0)
    for x, y, z in below:
        if lo[0] <= x <= hi[0] and lo[1] <= y <= hi[1]:
            hit = mine.ray_cast(Vector((x, y, bottom)), Vector((0, 0, 1)))[0]
            if hit is not None:
                gaps.append(hit.z - z)
    return min(gaps) if gaps else None


def drop(ob, on=None, gap=0.0):
    """Move a part (with its children) straight down or up until it rests on the ground, z = 0, or
    on top of `on` (a part, a name or a list) under it; `gap` leaves a space. Returns the move in metres."""
    ob = _get(ob)
    bpy.context.view_layer.update()
    group = [o for o in (ob, *ob.children_recursive) if o.type == 'MESH']
    pts, polys = _world_mesh(group)
    if not len(pts):
        raise ValueError(f'{ob.name} has no mesh to rest on anything')
    if on is None:
        rest = pts[:, 2].min()
    else:
        targets = [_get(o) for o in (on if isinstance(on, (list, tuple)) else [on])]
        rest = _gap(pts, polys, *_world_mesh([o for o in targets if o.type == 'MESH' and o not in group]))
        if rest is None:
            raise ValueError(f'Nothing of {_names_of([o.name for o in targets])} is under {ob.name}')
    move = gap - rest
    ob.matrix_world = Matrix.Translation((0, 0, move)) @ ob.matrix_world
    return move


_SIDE = re.compile(r'(?<![^\s_.\-])(Left|Right|left|right|LEFT|RIGHT|L|R|l|r)(?![^\s_.\-\d])')
_OTHER_SIDE = {'Left': 'Right', 'left': 'right', 'LEFT': 'RIGHT', 'L': 'R', 'l': 'r'}
_OTHER_SIDE.update({v: k for k, v in list(_OTHER_SIDE.items())})


def _other_side(name):
    """`Arm L` -> `Arm R`, `Left Wing` -> `Right Wing`; None when the name has no side."""
    swapped = _SIDE.sub(lambda m: _OTHER_SIDE[m.group(1)], name)
    return swapped if swapped != name else None


def _copy(ob, name):
    """A copy of an object with its own mesh, in the same collections and under the same parent."""
    _replace(name)
    copy = ob.copy()
    if ob.data is not None:
        copy.data = ob.data.copy()
        copy.data.name = name
    copy.name = name
    for c in ob.users_collection:
        c.objects.link(copy)
    return copy


def _mirrored(ob, name, across, flip, under):
    world = across @ ob.matrix_world @ flip
    copy = _copy(ob, name)
    if ob.type == 'MESH':
        copy.data.transform(flip, shape_keys=True)
        _flip(copy.data)
    for m in [m for m in copy.modifiers if m.type == 'BOOLEAN']:
        copy.modifiers.remove(m)
    if under is None:
        copy.matrix_world = world
    else:
        copy.parent = under[0]
        copy.matrix_parent_inverse = under[1].inverted()
        copy.matrix_basis = world
    for child in ob.children:
        _mirrored(child, _clean(_other_side(child.name) or f'{name} {child.name}'), across, flip, (copy, world))
    return copy


def mirror_pair(ob, name=None):
    """The part's twin on the other side, with its children: a real copy mirrored across the model's
    centre plane x = 0 (across its parent's own x = 0 when it has a parent). Named by swapping
    L/R or Left/Right (`Arm L` makes `Arm R`) unless `name` is given. Modifiers come along; boolean
    cuts do not (cut the twin too)."""
    ob = _get(ob)
    new = name or _other_side(ob.name)
    if not new:
        raise ValueError(f"{ob.name!r} has no side in its name (L, R, Left, Right): pass name='...'")
    bpy.context.view_layer.update()
    flip = Matrix.Diagonal((-1.0, 1.0, 1.0, 1.0))
    frame = ob.parent.matrix_world if ob.parent else Matrix.Identity(4)
    return _mirrored(ob, _clean(new), frame @ flip @ frame.inverted(), flip, None)


def ring(ob, count, center=(0, 0, 0), axis='Z', arc=360.0, join=True):
    """`count` copies of a part turned around an axis through `center` (posts round a well, crenels,
    spokes, bolts): build the first one where it goes, then ring it. A full circle spaces them
    evenly; a smaller `arc` (degrees) puts the last one at its end. join=True makes them one part
    under the part's name; join=False keeps them apart as name_1 ... name_N."""
    ob = _get(ob)
    if count < 2:
        raise ValueError('ring needs a count of 2 or more')
    if str(axis).upper() not in ('X', 'Y', 'Z'):
        raise ValueError("axis is 'X', 'Y' or 'Z'")
    c = Vector((*center, 0.0)[:3])
    bpy.context.view_layer.update()
    step = math.radians(arc) / (count if abs(arc) >= 360 else count - 1)
    base, world = ob.name, ob.matrix_world.copy()
    parts = [ob]
    for i in range(1, count):
        copy = _copy(ob, _clean(f'{base}_{i + 1}'))
        copy.matrix_world = Matrix.Translation(c) @ Matrix.Rotation(step * i, 4, str(axis).upper()) @ Matrix.Translation(-c) @ world
        parts.append(copy)
    if join:
        return _join(base, parts)
    _replace(f'{base}_1')
    ob.name = f'{base}_1'
    return parts


def export_objects(col=EXPORT):
    group = bpy.data.collections.get(col)
    return list(group.all_objects) if group else []


def evaluated(objects=None):
    """Context manager yielding {object: mesh as it ships} under genio_bpy's modifier rule, the
    same geometry export, validation and the review sheet use. World transforms are not applied."""
    return genio_bpy.shipped_meshes([o for o in (export_objects() if objects is None else objects) if o.type == 'MESH'])


def world_vertices(ob, mesh):
    """(n, 3) numpy array of a mesh's vertices in world space."""
    co = numpy.empty(len(mesh.vertices) * 3, dtype=numpy.float64)
    mesh.vertices.foreach_get('co', co)
    m = numpy.array(ob.matrix_world)
    return co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]


def bounds(objects=None):
    """World-space (min, max) of the shipped geometry, from vertices."""
    with evaluated(objects) as meshes:
        try:
            return genio_bpy._bounds(meshes)
        except ValueError:
            raise ValueError('Nothing to measure: the Export collection has no mesh vertices') from None


def _roots(objects):
    return [o for o in objects if o.parent is None or o.parent not in objects]


def ground(objects=None):
    """Move the whole model so its lowest point sits on z = 0."""
    objects = export_objects() if objects is None else objects
    lo, _ = bounds(objects)
    for ob in _roots(objects):
        ob.location.z -= lo.z
    return -lo.z


def center(objects=None):
    """Move the whole model so its footprint is centred on the origin (x, y)."""
    objects = export_objects() if objects is None else objects
    lo, hi = bounds(objects)
    mid = (lo + hi) / 2
    for ob in _roots(objects):
        ob.location.x -= mid.x
        ob.location.y -= mid.y
    return (-mid.x, -mid.y)


def origin_to_base(ob):
    """Put one part's origin at the bottom centre of its geometry without moving it.
    Engines then place and scale the part from its foot."""
    lo, hi = bounds([ob])
    world = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    local = ob.matrix_world.inverted() @ world
    ob.data.transform(Matrix.Translation(-local))
    ob.matrix_world = ob.matrix_world @ Matrix.Translation(local)
    ob.data.update()
    return ob


def apply_scale(ob):
    """Bake the object's scale into its mesh, so bevels and solidify stay even and engines see scale 1."""
    if ob.data.users > 1:
        raise ValueError(f'{ob.name} shares its mesh; give it its own before baking scale')
    ob.data.transform(Matrix.Diagonal((*ob.scale, 1.0)))
    ob.scale = (1, 1, 1)
    ob.data.update()
    return ob


def cleanup():
    """Safe cleanup between steps: drop cutters nothing uses, objects in no collection and
    orphan meshes and materials. Never touches parts in Export."""
    used = {m.object for o in bpy.data.objects for m in o.modifiers if m.type == 'BOOLEAN' and m.object}
    cutters = bpy.data.collections.get(CUTTERS)
    removed = []
    for ob in list(cutters.objects) if cutters else []:
        if ob not in used:
            removed.append(ob.name)
            _replace(ob.name)
    for ob in list(bpy.data.objects):
        if not ob.users_collection:
            removed.append(ob.name)
            bpy.data.objects.remove(ob)
    for coll in (bpy.data.meshes, bpy.data.materials):
        for block in list(coll):
            if block.users == 0:
                coll.remove(block)
    return removed


def stats(objects=None):
    """Shipped triangle and vertex counts per part, plus bounds: what the receipt reports."""
    objects = export_objects() if objects is None else objects
    parts = []
    with evaluated(objects) as meshes:
        for ob, mesh in meshes.items():
            mesh.calc_loop_triangles()
            parts.append({'name': ob.name, 'triangles': len(mesh.loop_triangles), 'vertices': len(mesh.vertices),
                          'modifiers': [m.type for m in ob.modifiers]})
        out = {'triangles': sum(x['triangles'] for x in parts), 'vertices': sum(x['vertices'] for x in parts),
               'objects': len(parts), 'parts': parts}
        if out['vertices']:
            lo, hi = genio_bpy._bounds(meshes)
            out.update(min=list(lo), max=list(hi), dimensions=list(hi - lo))
    return out


# Hard-surface kit -------------------------------------------------------------------------------
# Parts from raw geometry, smooth shading with sharp edges by angle, surfaces of revolution, sweeps,
# hulls from stations and capsules. Their faces carry where they sit on the surface: a column around
# it (`col` of `cols`) and a place along a band (a profile piece or a station span: `t` from 0 to 1
# over its length), so panel_lines() cuts seams in rows and columns that follow the shape.

SMOOTH = 35.0  # degrees: the kit's parts shade smooth, and edges sharper than this stay crisp
_GRID = (('genio_col', 'INT'), ('genio_cols', 'INT'), ('genio_band', 'INT'), ('genio_t', 'FLOAT'),
         ('genio_band_len', 'FLOAT'), ('genio_width', 'FLOAT'))
# panel_lines(bake_only=True): per face corner, its distances to its panel's edges plus 1 (0: no panel)
_SEAM, _SEAM_W = 'genio_seam', 'genio_seam_w'
_FAR = 1e4  # metres: the distance to an edge of its panel that a face does not have
PATTERNS = ('grid', 'radial', 'concentric', 'stations')
HULL_SECTIONS = {'round': (2.0, 2.0), 'box': (6.0, 6.0), 'deck': (6.0, 2.0)}  # superellipse powers above and below the middle


def _number(x):
    return isinstance(x, (int, float, numpy.number))


def _shade(me, angle, crisp=None):
    """Smooth shading with edges sharper than `angle` degrees kept sharp (None: flat), and the edges
    `crisp` names (vertex index pairs) sharp whatever their angle."""
    if angle is None:
        me.shade_flat()
        return
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(angle))
    if crisp:
        n = len(me.vertices)
        ev = genio_bpy._ints(me.edges, 'vertices', len(me.edges), 2).astype(numpy.int64)
        pairs = numpy.asarray(crisp, dtype=numpy.int64).reshape(-1, 2)
        key = lambda a: a.min(axis=1) * n + a.max(axis=1)  # noqa: E731
        attr = me.attributes.get('sharp_edge') or me.attributes.new('sharp_edge', 'BOOLEAN', 'EDGE')
        flags = numpy.zeros(len(me.edges), dtype=bool)
        attr.data.foreach_get('value', flags)
        attr.data.foreach_set('value', flags | numpy.isin(key(ev), key(pairs)))


def smooth(ob, angle=SMOOTH):
    """Smooth shading with edges sharper than `angle` degrees kept crisp: round surfaces read round
    while folds, rims and corners stay sharp, the commonest need of a realistic part. angle=None
    shades it flat. The kit's parts start this way (their `smooth=`). Returns the part."""
    ob = _get(ob)
    _shade(ob.data, angle)
    return ob


def _part(name, verts, faces, mat=None, col=None, loc=(0, 0, 0), rot=(0, 0, 0), smooth=SMOOTH, crisp=None, grid=None):
    """A named part from vertices and faces (lists of vertex indices), its winding made consistent
    (outward on closed shells) and shaded by _shade(); `grid` gives each face its _GRID values."""
    me = bpy.data.meshes.new('genio part')
    me.from_pydata(numpy.asarray(verts, dtype=numpy.float64).tolist(), [], [[int(i) for i in f] for f in faces])
    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = _object(name, bm, mat, col, loc, rot)
    if grid is not None:
        for (key, kind), values in zip(_GRID, grid):
            ob.data.attributes.new(key, kind, 'FACE').data.foreach_set('value', values)
    _shade(ob.data, smooth, crisp)
    return ob


def mesh(name, verts, faces, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, col=None, smooth=SMOOTH):
    """A part from raw geometry: `verts` [(x, y, z), ...] and `faces` [(i, j, k, ...), ...] of three or
    more vertex indices each, in any winding (made consistent, outward on a closed shell). Smooth with
    sharp edges by angle; smooth=None shades it flat. It replaces a part of the same name."""
    count = len(verts)
    if count < 3 or not len(faces):
        raise ValueError(f'{name}: a mesh needs three or more vertices and a face')
    for f in faces:
        if len(f) < 3 or len(set(f)) != len(f) or min(f) < 0 or max(f) >= count:
            raise ValueError(f'{name}: face {tuple(f)} needs three or more different vertex indices from 0 to {count - 1}')
    return _part(name, verts, faces, mat, col, loc, rot, smooth)


def from_bmesh(name, bm, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, col=None, smooth=SMOOTH):
    """A part from a bmesh of your own (it is freed), for what p.mesh's lists cannot say. Its winding
    stays as you made it; smooth with sharp edges by angle, like p.mesh."""
    ob = _object(name, bm, mat, col, loc, rot)
    _shade(ob.data, smooth)
    return ob


def weighted_normals(ob, weight=50, name='Weighted normals'):
    """A Weighted Normal modifier (large faces keep flat shading next to bevels and small faces),
    keeping sharp edges sharp."""
    mod = _modifier(_get(ob), name, 'WEIGHTED_NORMAL')
    mod.mode, mod.weight, mod.keep_sharp = 'FACE_AREA', weight, True
    return mod


def curve(points, n=4, closed=False):
    """A smooth line through `points` (tuples, all of one length: (x, y, z), (r, z), or any numbers to
    carry along together): Catmull-Rom, `n` points per span, every given point kept exactly.
    closed=True runs on from the last point back to the first (not repeated). n=1 keeps the points."""
    rows = [[float(c) for c in q] for q in points]
    if len(rows) < 2 or len({len(r) for r in rows}) != 1:
        raise ValueError('curve needs two or more points, all with the same number of values')
    pts = numpy.array(rows)
    if n <= 1:
        return [tuple(q) for q in pts.tolist()]
    ext = numpy.vstack([pts[-1:], pts, pts[:2]]) if closed else numpy.vstack([pts[:1], pts, pts[-1:]])
    t = (numpy.arange(n) / n)[:, None]
    out = []
    for i in range(len(pts) if closed else len(pts) - 1):
        p0, p1, p2, p3 = ext[i:i + 4]
        out.append(0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t ** 2 + (3 * p1 - p0 - 3 * p2 + p3) * t ** 3))
    if not closed:
        out.append(pts[-1:])
    return [tuple(q) for q in numpy.vstack(out).tolist()]


def circle(radius, n=32, center=(0, 0), start=0.0):
    """`n` points on a circle, counter-clockwise from `start` degrees off +X: an outline (x, y) for
    p.sweep, or round a 3D `center` a ring (x, y, z) at its height, for a path or a window row."""
    c = [float(v) for v in center]
    a = math.radians(start) + 2 * math.pi * numpy.arange(n) / n
    xy = numpy.stack([c[0] + radius * numpy.cos(a), c[1] + radius * numpy.sin(a)], 1)
    return [tuple(q) + tuple(c[2:]) for q in xy.tolist()]


def rect(width, height, radius=0.0, per=4, center=(0, 0)):
    """A rectangle outline of (x, y) points, counter-clockwise, its corners rounded by `radius` in
    `per` steps each: a section for p.sweep."""
    radius = max(0.0, min(radius, width / 2 - 1e-6, height / 2 - 1e-6))
    cx, cy = center
    pts = []
    for qx, qy, a0 in ((1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270)):
        if radius <= 0:
            pts.append((cx + qx * width / 2, cy + qy * height / 2))
            continue
        ox, oy = cx + qx * (width / 2 - radius), cy + qy * (height / 2 - radius)
        for k in range(per + 1):
            a = math.radians(a0 + 90 * k / per)
            pts.append((ox + radius * math.cos(a), oy + radius * math.sin(a)))
    return pts


def _loop_length(ring):
    return float(numpy.linalg.norm(numpy.roll(ring, -1, axis=0) - ring, axis=1).sum())


def _skin_geometry(rings, bands, along, crisp=(), wrap=False, caps=False):
    """Vertices, faces, face grid (_GRID values) and crisp edges of a surface through closed loops of
    points (`rings`, all of one count; a loop of one point repeated is a pole). `bands[s]` is the band
    of the span from ring s to the next and `along[s]` ring s's distance along the surface (with
    `wrap`, one more: back to the first ring); `crisp` lists rings whose loop edges stay sharp. wrap
    joins the last ring to the first; caps closes open end loops with a fan."""
    rings = [numpy.asarray(r, dtype=numpy.float64) for r in rings]
    k = len(rings[0])
    if k < 3 or any(len(r) != k for r in rings):
        raise ValueError('every loop needs the same number of points, three or more')
    reach = max(float(numpy.ptp(numpy.vstack(rings), axis=0).max()), 1e-9)
    verts, index, pole, at = [], [], [], 0
    for r in rings:
        if float(numpy.ptp(r, axis=0).max()) <= 1e-7 * reach:
            verts.append(r.mean(axis=0)[None])
            index.append(numpy.full(k, at))
            pole.append(True)
            at += 1
        else:
            verts.append(r)
            index.append(numpy.arange(at, at + k))
            pole.append(False)
            at += k
    count = len(rings)
    spans = count if wrap else count - 1
    start, end = {}, {}
    for s in range(spans):
        b = bands[s]
        start[b] = min(start.get(b, along[s]), along[s])
        end[b] = max(end.get(b, along[s + 1]), along[s + 1])
    perimeter = [0.0 if p else _loop_length(r) for r, p in zip(rings, pole)]
    nxt = numpy.roll(numpy.arange(k), -1)
    faces, grid = [], [[] for _ in _GRID]

    def put(rows, col, cols, band, t, length, width):
        faces.extend(rows.tolist())
        for values, v in zip(grid, (col, cols, band, t, length, width)):
            values.extend(v if isinstance(v, (range, list)) else [v] * k)

    for s in range(spans):
        a, b = s, (s + 1) % count
        if pole[a] and pole[b]:
            continue
        A, B = index[a], index[b]
        rows = numpy.stack([A, B[nxt], B], 1) if pole[a] else numpy.stack([A, A[nxt], B], 1) if pole[b] else numpy.stack([A, A[nxt], B[nxt], B], 1)
        band = bands[s]
        length = max(end[band] - start[band], 1e-9)
        put(rows, range(k), k, band, ((along[s] + along[s + 1]) / 2 - start[band]) / length, length, (perimeter[a] + perimeter[b]) / 2 / k)
    if caps and not wrap:
        for r, last in ((0, False), (count - 1, True)):
            if pole[r]:
                continue
            verts.append(rings[r].mean(axis=0)[None])
            centre, loop = numpy.full(k, at), index[r]
            at += 1
            put(numpy.stack([centre, loop, loop[nxt]] if last else [centre, loop[nxt], loop], 1), [0] * k, 0, -1, 0.0, 0.0, 0.0)
    sharp = [(int(index[r][i]), int(index[r][(i + 1) % k])) for r in crisp if not pole[r] for i in range(k)]
    kinds = [numpy.int32 if kind == 'INT' else numpy.float32 for _, kind in _GRID]
    return numpy.vstack(verts), faces, [numpy.array(v, dtype=t) for v, t in zip(grid, kinds)], sharp


def _round_rings(profile, segments, rx=1.0, ry=1.0):
    """Loops round local Z through a profile of (radius, z) points, x and y scaled by rx and ry."""
    a = 2 * math.pi * numpy.arange(segments) / segments
    c, s = numpy.cos(a) * rx, numpy.sin(a) * ry
    return [numpy.stack([max(r, 0.0) * c, max(r, 0.0) * s, numpy.full(segments, float(z))], 1) for r, z in profile]


def _along(points):
    pts = numpy.asarray(points, dtype=numpy.float64)
    return numpy.concatenate([[0.0], numpy.cumsum(numpy.linalg.norm(numpy.diff(pts, axis=0), axis=1))]).tolist()


def revolve(name, pieces, segments=64, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, col=None, n=4, smooth=SMOOTH):
    """A surface of revolution round local Z: saucers, domes, hulls, nacelles, bottles. `pieces` is a
    profile of (radius, z) points, or a list of profile pieces: each is smoothed through its points
    (p.curve, `n` per span) and the joins between pieces stay crisp (a rim, a step, a lip). Points
    at radius 0 close the ends as poles. Smooth with sharp edges by angle; its faces know their
    piece, for p.panel_lines. p.lathe stays the plain version."""
    if pieces and _number(pieces[0][0]):
        pieces = [pieces]
    if not pieces or any(len(piece) < 2 for piece in pieces):
        raise ValueError(f'{name}: revolve needs a profile of two or more (radius, z) points, or a list of such pieces')
    if segments < 3:
        raise ValueError(f'{name}: revolve needs three or more segments')
    profile, bands, crisp = [], [], []
    for k, piece in enumerate(pieces):
        dense = curve(piece, n)
        if profile:
            crisp.append(len(profile) - 1)
            if math.dist(profile[-1], dense[0]) < 1e-9:
                dense = dense[1:]
            else:
                crisp.append(len(profile))
        profile += dense
        bands += [k] * len(dense)
    verts, faces, grid, sharp = _skin_geometry(_round_rings(profile, segments), bands[1:], _along(profile), crisp)
    return _part(name, verts, faces, mat, col, loc, rot, smooth, sharp, grid)


def _frames(q, closed, up):
    """Rotation-minimising frames along points q (m, 3): unit tangents, rights and ups. The first up
    is `up` square to the path (world +Y where the path runs along `up`); it then turns with the path
    without twisting (double reflection), and a closed path spreads its leftover turn round the loop."""
    m = len(q)
    d = numpy.roll(q, -1, axis=0) - numpy.roll(q, 1, axis=0) if closed else numpy.gradient(q, axis=0)
    T = d / numpy.maximum(numpy.linalg.norm(d, axis=1), 1e-12)[:, None]
    B = numpy.zeros_like(q)
    for hint in (up, (0.0, 1.0, 0.0), (1.0, 0.0, 0.0)):
        h = numpy.asarray(hint, dtype=numpy.float64)
        b = h - T[0].dot(h) * T[0]
        if numpy.linalg.norm(b) > 1e-3 * numpy.linalg.norm(h):
            break
    B[0] = b / numpy.linalg.norm(b)
    last = None
    for i in range(m if closed else m - 1):
        j = (i + 1) % m
        v1 = q[j] - q[i]
        c1 = v1.dot(v1)
        r = B[i]
        if c1 > 1e-20:
            rl = B[i] - (2 / c1) * v1.dot(B[i]) * v1
            tl = T[i] - (2 / c1) * v1.dot(T[i]) * v1
            v2 = T[j] - tl
            c2 = v2.dot(v2)
            r = rl - (2 / c2) * v2.dot(rl) * v2 if c2 > 1e-20 else rl
        r = r - r.dot(T[j]) * T[j]
        r = r / max(numpy.linalg.norm(r), 1e-12)
        if closed and j == 0:
            last = r
        else:
            B[j] = r
    if last is not None:
        turn = math.atan2(numpy.cross(last, B[0]).dot(T[0]), last.dot(B[0]))
        for i in range(1, m):
            a, k = turn * i / m, T[i]
            B[i] = B[i] * math.cos(a) + numpy.cross(k, B[i]) * math.sin(a) + k * k.dot(B[i]) * (1 - math.cos(a))
    return T, numpy.cross(T, B), B


def _outlines(section, count, name):
    """One closed outline of (x, y) points per path point: `section` is one outline, or one per point."""
    outlines = [section] * count if _number(section[0][0]) else list(section)
    if len(outlines) != count:
        raise ValueError(f'{name}: {len(outlines)} sections for {count} path points; give one section, or one per point')
    k = len(outlines[0])
    if k < 3 or any(len(o) != k for o in outlines):
        raise ValueError(f'{name}: every section needs the same number of (x, y) points, three or more')
    return numpy.array([[[float(v) for v in q[:2]] for q in o] for o in outlines])


def sweep(name, path, section, scale=None, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, col=None, n=4, closed=False, caps=True,
          up=(0, 0, 1), level=False, smooth=SMOOTH):
    """A tube along a path: pipes, cables, rails, necks, pylons, struts, fuselages. `path` is (x, y, z)
    points, smoothed through (p.curve, `n` per span); `section` a closed outline of (x, y) points
    (p.circle, p.rect), or one outline per path point (all of one count) to change shape along it;
    `scale` one number or (sx, sy) per path point (0 makes a tip). The section's x runs to the path's
    right and its y to the path's up (`up`, world Z; world +Y on a path along it) and turns with the
    path without twisting; level=True keeps every section level instead, x along world X and y along
    world Y (a neck, pylon or leg swept back; the path must climb or fall). closed=True makes a loop
    (a ring, a torus); caps closes the two ends."""
    path = [tuple(float(c) for c in q) for q in path]
    m = len(path)
    if m < 2 or any(len(q) != 3 for q in path):
        raise ValueError(f'{name}: sweep needs a path of two or more (x, y, z) points')
    outlines = _outlines(section, m, name)
    k = outlines.shape[1]
    if scale is None:
        sizes = numpy.ones((m, 2))
    elif len(scale) != m:
        raise ValueError(f'{name}: {len(scale)} scales for {m} path points')
    else:
        sizes = numpy.array([(float(s), float(s)) if _number(s) else (float(s[0]), float(s[1])) for s in scale])
    dense = numpy.array(curve(numpy.hstack([numpy.array(path), sizes, outlines.reshape(m, -1)]), n, closed))
    q, size, o = dense[:, :3], dense[:, 3:5], dense[:, 5:].reshape(len(dense), k, 2)
    if level:
        right, upward = numpy.tile((1.0, 0.0, 0.0), (len(q), 1)), numpy.tile((0.0, 1.0, 0.0), (len(q), 1))
    else:
        _, right, upward = _frames(q, closed, up)
    rings = q[:, None] + (o[..., :1] * size[:, None, :1]) * right[:, None] + (o[..., 1:] * size[:, None, 1:]) * upward[:, None]
    spans = len(q) if closed else len(q) - 1
    per, last = max(n, 1), (m if closed else m - 1) - 1
    along = _along(numpy.vstack([q, q[:1]]) if closed else q)
    verts, faces, grid, sharp = _skin_geometry(list(rings), [min(s // per, last) for s in range(spans)], along, (), closed, caps and not closed)
    return _part(name, verts, faces, mat, col, loc, rot, smooth, sharp, grid)


def _superellipse(kind, points):
    """A named hull section in a 1 x 1 square, `points` round, counter-clockwise from +X."""
    top, bottom = HULL_SECTIONS[kind]
    a = 2 * math.pi * numpy.arange(points) / points
    c, s = numpy.cos(a), numpy.sin(a)
    e = numpy.where(s >= 0, top, bottom)
    return numpy.stack([0.5 * numpy.sign(c) * numpy.abs(c) ** (2 / e), 0.5 * numpy.sign(s) * numpy.abs(s) ** (2 / e)], 1)


def hull(name, stations, section='round', points=24, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, col=None, n=4, caps=True, smooth=SMOOTH):
    """A hull, body or fuselage from stations along Y (front -Y to back +Y): each (y, width, height, z)
    is the cross-section at y, `width` across x and `height` up, centred at height z; a fifth item
    gives that station its own section. Sections: 'round', 'box', 'deck' (flat on top, round below),
    or your own closed outline of (x, y) points in a 1 x 1 square centred on (0, 0); `points` is
    their count for the named ones. Width or height 0 makes a point (a bow, a tail cone). Smoothed
    through the stations (p.curve, `n` per span); its faces know their station span."""
    rows = [tuple(st) for st in stations]
    if len(rows) < 2 or any(len(st) < 4 for st in rows):
        raise ValueError(f'{name}: hull needs two or more stations (y, width, height, z)')
    own = [st[4] for st in rows if len(st) > 4 and not isinstance(st[4], str)] + ([] if isinstance(section, str) else [section])
    k = len(own[0]) if own else points

    def outline(x):
        if isinstance(x, str):
            if x not in HULL_SECTIONS:
                raise ValueError(f'{name}: no hull section {x!r}: use {", ".join(HULL_SECTIONS)} or your own outline')
            return _superellipse(x, k)
        o = numpy.array([[float(v) for v in q[:2]] for q in x])
        if o.shape != (k, 2):
            raise ValueError(f'{name}: every section needs {k} (x, y) points')
        return o

    data = [[float(v) for v in st[:4]] + outline(st[4] if len(st) > 4 else section).ravel().tolist() for st in rows]
    dense = numpy.array(curve(data, n))
    y, z = dense[:, 0], dense[:, 3]
    w, h = numpy.maximum(dense[:, 1], 0.0), numpy.maximum(dense[:, 2], 0.0)
    o = dense[:, 4:].reshape(len(dense), k, 2)
    rings = numpy.stack([o[..., 0] * w[:, None], numpy.repeat(y[:, None], k, 1), z[:, None] + o[..., 1] * h[:, None]], -1)
    per = max(n, 1)
    bands = [min(s // per, len(rows) - 2) for s in range(len(dense) - 1)]
    verts, faces, grid, sharp = _skin_geometry(list(rings), bands, _along(numpy.stack([y, z], 1)), caps=caps)
    return _part(name, verts, faces, mat, col, loc, rot, smooth, sharp, grid)


def _turn(d):
    """The rotation taking local Z along `d`: steep directions keep the part's sides square to the
    world axes, shallow ones keep its local Y up (as beam() does)."""
    d = Vector(d).normalized()
    return Vector((0, 0, 1)).rotation_difference(d) if abs(d.z) > 0.7 else d.to_track_quat('Z', 'Y')


def _capsule_profile(length, ra, rb, ends, segments, step=None):
    """(radius, z) points of a capsule from z = -length/2 to +length/2 and the band of each span: the
    end at -z, the middle (loops about `step` apart when given), the end at +z."""
    pair = (ends, ends) if isinstance(ends, str) else tuple(ends)
    if len(pair) != 2 or any(e not in ('round', 'flat', 'point') for e in pair):
        raise ValueError("capsule ends are 'round', 'flat' or 'point', or one of those per end")
    ea, eb = (0.0 if kind == 'flat' else r for kind, r in zip(pair, (ra, rb)))
    if ea + eb > 0.98 * length:
        f = 0.98 * length / (ea + eb)
        ea, eb = ea * f, eb * f
    steps = max(2, segments // 4)

    def end(kind, r, e, tip, sign):
        if kind == 'round':
            return [(r * math.sin(a), tip + sign * e * (1 - math.cos(a))) for a in numpy.linspace(0, math.pi / 2, steps + 1)]
        return [(0.0, tip), (r, tip + sign * e)]

    a = end(pair[0], ra, ea, -length / 2, 1)
    b = end(pair[1], rb, eb, length / 2, -1)[::-1]
    (r0, z0), (r1, z1) = a[-1], b[0]
    cuts = max(1, round((z1 - z0) / step)) if step else 1
    middle = [(r0 + (r1 - r0) * i / cuts, z0 + (z1 - z0) * i / cuts) for i in range(1, cuts)]
    return a + middle + b, [0] * (len(a) - 1) + [1] * cuts + [2] * (len(b) - 1)


def capsule(name, a, b, radius, ends='round', segments=24, mat=None, col=None, smooth=SMOOTH):
    """A capsule from point a to point b, tips included: nacelles, tanks, limbs, pods. `radius` is one
    number, or (at a, at b) for a taper; `ends` 'round', 'flat' or 'point', or one per end (a, b)."""
    a, b = Vector(a), Vector(b)
    length = (b - a).length
    if length < 1e-9:
        raise ValueError(f'{name}: capsule ends a and b are the same point')
    ra, rb = (float(radius), float(radius)) if _number(radius) else (float(radius[0]), float(radius[1]))
    # Loops along the middle about a face's width apart: square faces, so panel_lines can cut rows.
    profile, bands = _capsule_profile(length, ra, rb, ends, segments, 2 * math.pi * max(ra, rb) / segments)
    verts, faces, grid, sharp = _skin_geometry(_round_rings(profile, segments), bands, _along(profile))
    return _part(name, verts, faces, mat, col, (a + b) / 2, _turn(b - a).to_euler(), smooth, sharp, grid)


def _surface(target):
    """A part's shipped surface in world space: vertices, triangles, unit normals, areas and a BVH."""
    target = _get(target)
    bpy.context.view_layer.update()
    with evaluated([target]) as shipped:
        me = shipped.get(target)
        if me is None:
            raise ValueError(f'{target.name} is not a mesh part')
        me.calc_loop_triangles()
        pts = world_vertices(target, me)
        tris = genio_bpy._ints(me.loop_triangles, 'vertices', len(me.loop_triangles), 3)
    if not len(tris):
        raise ValueError(f'{target.name} has no faces')
    corner = pts[tris]
    n = numpy.cross(corner[:, 1] - corner[:, 0], corner[:, 2] - corner[:, 0])
    area = numpy.linalg.norm(n, axis=1)
    return pts, tris, n / numpy.maximum(area, 1e-12)[:, None], area / 2, BVHTree.FromPolygons(pts.tolist(), tris.tolist())


def _square(z, x):
    """Unit x and y square to the unit z, x as close to the given direction as the plane allows."""
    x = numpy.asarray(x, dtype=numpy.float64) - z * z.dot(x)
    if numpy.linalg.norm(x) < 1e-6:
        x = numpy.cross(z, (1.0, 0.0, 0.0) if abs(z[0]) < 0.9 else (0.0, 1.0, 0.0))
    x = x / numpy.linalg.norm(x)
    return x, numpy.cross(z, x)


def _boxes_part(name, frames, kinds, mat, col):
    """One part of many small boxes or 8-sided cylinders: `frames` are (centre, x, y, z) with the axes
    scaled to the full size, `kinds` 'box' or 'cylinder' each."""
    bm = bmesh.new()
    for (c, x, y, z), kind in zip(frames, kinds):
        m = Matrix([(*x, 0), (*y, 0), (*z, 0), (*c, 1)]).transposed()
        if kind == 'box':
            bmesh.ops.create_cube(bm, size=1.0, matrix=m)
        else:
            bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=8, radius1=0.5, radius2=0.5, depth=1.0, matrix=m)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _object(name, bm, mat, col, (0, 0, 0), (0, 0, 0))


def window_rows(name, target, rows, size=(0.4, 0.25), spacing=None, mat=None, col=None, depth=0.04, reach=None, closed=False):
    """Windows (portholes, lit panels, vents) along rows on a part's surface, as one part. Each row is
    a line of (x, y, z) points near the surface (p.circle round a 3D centre makes a ring); a window
    (`size`: its width along the row and its height) sits every `spacing` metres (twice its width) on
    the surface nearest the row, facing out, half sunk, `depth` thick; a point with no surface within
    `reach` (four window widths) gets none. closed=True runs every row back to its start. `mat`
    defaults to the emissive 'Window light'. Returns the part."""
    target = _get(target)
    w, h = (float(size), float(size)) if _number(size) else (float(size[0]), float(size[1]))
    spacing = spacing or 2 * w
    reach = reach or 4 * max(w, h)
    *_, tree = _surface(target)
    frames = []
    for row in rows:
        pts = numpy.array([[float(c) for c in q] for q in row], dtype=numpy.float64)
        if pts.ndim != 2 or pts.shape[1] != 3 or len(pts) < 1:
            raise ValueError(f'{name}: each row is a list of (x, y, z) points')
        if closed and len(pts) > 1:
            pts = numpy.vstack([pts, pts[:1]])
        seg = numpy.diff(pts, axis=0)
        cum = numpy.concatenate([[0.0], numpy.cumsum(numpy.linalg.norm(seg, axis=1))])
        total = cum[-1]
        if total < 1e-9:
            places = [0.0]
        elif closed:
            count = max(1, int(total // spacing))
            places = (numpy.arange(count) + 0.5) * total / count
        else:
            count = int(total // spacing) + 1
            places = (total - (count - 1) * spacing) / 2 + numpy.arange(count) * spacing
        for s in places:
            i = min(int(numpy.searchsorted(cum, s, 'right')) - 1, len(seg) - 1) if len(seg) else 0
            if len(seg):
                q = pts[i] + seg[i] * ((s - cum[i]) / max(cum[i + 1] - cum[i], 1e-12))
                along = seg[i]
            else:
                q, along = pts[0], (1.0, 0.0, 0.0)
            loc, normal, _, _ = tree.find_nearest(Vector(q), reach)
            if loc is None:
                continue
            z = numpy.array(normal)
            x, y = _square(z, along)
            frames.append((numpy.array(loc) + z * depth * 0.1, x * w, y * h, z * depth))
    if not frames:
        raise ValueError(f'{name}: no window found the surface of {target.name} within {reach:g} m; bring the rows nearer to it')
    mat = mat if mat is not None else material('Window light', '#ffd9a0', preset='emissive')
    return _boxes_part(name, frames, ['box'] * len(frames), mat, col)


GREEBLE_TRIANGLES = {'box': 12, 'cylinder': 28}


def greebles(name, target, region=None, density=20.0, sizes=(0.05, 0.25), height=(0.2, 0.8), shapes=('box', 'cylinder'), seed=0,
             mat=None, col=None, budget=4000):
    """Small detail on a part's surface, as one part: boxes and 8-sided cylinders standing on it,
    turned to its normal at random, about `density` per square metre of the region, each `sizes`
    metres across and `height` times that tall, at most `budget` triangles. `region(point)` (a world
    point on the surface) picks where; seeded, so the same seed gives the same greebles. `mat`
    defaults to the part's own first material. Returns the part."""
    target = _get(target)
    if mat is None and target.type == 'MESH' and target.data.materials:
        mat = target.data.materials[0]
    unknown = [s for s in shapes if s not in GREEBLE_TRIANGLES]
    if not shapes or unknown:
        raise ValueError(f"{name}: greeble shapes are 'box' and 'cylinder'")
    pts, tris, normals, area, _ = _surface(target)
    centres = pts[tris].mean(axis=1)
    keep = numpy.array([bool(region(Vector(c))) for c in centres]) if region else numpy.ones(len(tris), dtype=bool)
    area = numpy.where(keep, area, 0.0)
    if area.sum() <= 0:
        raise ValueError(f'{name}: the region holds no surface of {target.name}')
    rng = numpy.random.RandomState(seed)
    wanted = int(round(density * area.sum()))
    picks = rng.choice(len(tris), size=max(wanted, 0), p=area / area.sum()) if wanted else []
    frames, kinds, used = [], [], 0
    for t in picks:
        kind = shapes[rng.randint(len(shapes))]
        if used + GREEBLE_TRIANGLES[kind] > budget:
            break
        used += GREEBLE_TRIANGLES[kind]
        r1, r2 = math.sqrt(rng.uniform()), rng.uniform()
        a, b, c = pts[tris[t]]
        p = a * (1 - r1) + b * r1 * (1 - r2) + c * r1 * r2
        z = normals[t]
        turn = rng.uniform(0, 2 * math.pi)
        x, y = _square(z, numpy.cross(z, (0.0, 0.0, 1.0)) if abs(z[2]) < 0.9 else (1.0, 0.0, 0.0))
        x, y = x * math.cos(turn) + y * math.sin(turn), y * math.cos(turn) - x * math.sin(turn)
        wide = rng.uniform(*sizes)
        deep = wide * (rng.uniform(0.5, 1.0) if kind == 'box' else 1.0)
        tall = wide * rng.uniform(*height)
        frames.append((p + z * tall * 0.35, x * wide, y * deep, z * tall))
        kinds.append(kind)
    if not frames:
        raise ValueError(f'{name}: no greeble fits: raise density or budget')
    return _boxes_part(name, frames, kinds, mat, col)


def _face_cells(centre, normal, size):
    """Panel cells for faces without the kit's surface data: a grid of `size` in the part's space on the
    two axes square to each face's main direction. Returns (key rows, colour)."""
    axis = numpy.abs(normal).argmax(axis=1)
    side = numpy.take_along_axis(normal, axis[:, None], 1)[:, 0] > 0
    u = numpy.take_along_axis(centre, ((axis + 1) % 3)[:, None], 1)[:, 0]
    v = numpy.take_along_axis(centre, ((axis + 2) % 3)[:, None], 1)[:, 0]
    w = numpy.take_along_axis(centre, axis[:, None], 1)[:, 0]
    iu, iv, layer = (numpy.floor(x / size).astype(numpy.int64) for x in (u, v, w))
    keys = numpy.stack([axis, side, layer, iu, iv], 1)
    return keys, 6 + (axis * 2 + side) * 4 + (iu % 2) * 2 + iv % 2


def _cut_cells(me, size, plain):
    """Cut faces bigger than a panel that lack the kit's surface data (a box's sides) along the grid
    planes at multiples of `size`, so they split into panels instead of one each."""
    if not len(me.polygons):
        return
    starts = genio_bpy._ints(me.polygons, 'loop_start', len(me.polygons))
    totals = genio_bpy._ints(me.polygons, 'loop_total', len(me.polygons))
    corner = numpy.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', corner)
    co = corner.reshape(-1, 3)[genio_bpy._ints(me.loops, 'vertex_index', len(me.loops))]
    lo, hi = numpy.minimum.reduceat(co, starts), numpy.maximum.reduceat(co, starts)
    big = plain & (totals > 0) & (numpy.sort(hi - lo, axis=1)[:, 1] > 1.25 * size)
    if not big.any():
        return
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    faces = [bm.faces[i] for i in numpy.nonzero(big)[0]]
    for k in range(3):
        normal = Vector([1.0 if j == k else 0.0 for j in range(3)])
        for at in numpy.arange(math.ceil(lo[big, k].min() / size), math.floor(hi[big, k].max() / size) + 1) * size:
            crossing = [f for f in faces if min(v.co[k] for v in f.verts) < at - 1e-6 and max(v.co[k] for v in f.verts) > at + 1e-6]
            if not crossing:
                continue
            geom = list({g for f in crossing for g in (f, *f.edges, *f.verts)})
            done = bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=normal * float(at), plane_no=normal)
            fresh = {g for g in done['geom'] if isinstance(g, bmesh.types.BMFace)}
            faces = [f for f in faces if f.is_valid and f not in fresh] + list(fresh)
    bm.to_mesh(me)
    bm.free()


def _panels(me, size, pattern, region, gridded):
    """Each face's panel (-1: none) and the colour of its panel: panels of one colour never touch,
    so each colour insets in one go. Faces with the kit's surface data get rows along their band and
    columns around (a power-of-two share of the segments, so the columns of finer rows line up with
    coarser ones); the others cells of a grid in the part's space."""
    count = len(me.polygons)
    centre, normal = numpy.empty(count * 3), numpy.empty(count * 3)
    me.polygons.foreach_get('center', centre)
    me.polygons.foreach_get('normal', normal)
    centre, normal = centre.reshape(-1, 3), normal.reshape(-1, 3)
    keep = numpy.array([bool(region(Vector(c))) for c in centre]) if region else numpy.ones(count, dtype=bool)
    values = {}
    for key, kind in _GRID if gridded else ():
        values[key] = numpy.empty(count, dtype=numpy.int32 if kind == 'INT' else numpy.float32)
        me.attributes[key].data.foreach_get('value', values[key])
    surface = values['genio_cols'] > 0 if gridded else numpy.zeros(count, dtype=bool)
    keys = numpy.zeros((count, 5), dtype=numpy.int64)
    colour = numpy.zeros(count, dtype=numpy.int64)
    if surface.any():
        band, t, length = values['genio_band'], values['genio_t'], values['genio_band_len']
        col, cols, width = values['genio_col'], values['genio_cols'], values['genio_width']
        row = numpy.zeros(count, dtype=numpy.int64)
        offset = 0
        for b in numpy.unique(band[surface]):
            on = surface & (band == b)
            rows = max(1, int(round(float(length[on][0]) / size))) if pattern in ('grid', 'concentric') else 1
            row[on] = offset + numpy.minimum(rows - 1, numpy.floor(t[on] * rows).astype(numpy.int64))
            offset += rows
        column = numpy.zeros(count, dtype=numpy.int64)
        for r in numpy.unique(row[surface]):
            on = surface & (row == r)
            segments = int(cols[on][0])
            split = 1
            if pattern in ('grid', 'radial'):
                around = float(width[on].mean()) * segments
                options = [segments >> j for j in range(segments.bit_length()) if segments % (1 << j) == 0]
                split = min(options, key=lambda c: abs(math.log(max(around / c, 1e-9) / size)))
            column[on] = col[on] // (segments // split)
            # Columns alternate; an odd ring of them gives its last column a third colour.
            alternate = column[on] % 2 if split > 1 else numpy.zeros(int(on.sum()), dtype=numpy.int64)
            if split > 1 and split % 2:
                alternate[column[on] == split - 1] = 2
            colour[on] = (r % 2) * 3 + alternate
        keys[surface] = numpy.stack([numpy.full(int(surface.sum()), -1), cols[surface], numpy.zeros(int(surface.sum())), row[surface], column[surface]], 1)
    plain = ~surface
    if plain.any():
        keys[plain], colour[plain] = _face_cells(centre[plain], normal[plain], size)
    panel = numpy.full(count, -1, dtype=numpy.int64)
    if keep.any():
        panel[keep] = numpy.unique(keys[keep], axis=0, return_inverse=True)[1].reshape(-1)
    return panel, colour


def _seam_mask(me, panel):
    """Per face corner, its distance to each edge of its face that is an edge of its panel (up to four;
    the others _FAR), plus 1, in two attributes; 0 on faces outside every panel. The bake reads them
    as lines (panel_lines(bake_only=True)); distances are linear over a flat face, so they interpolate
    exactly."""
    nf, nl = len(me.polygons), len(me.loops)
    start = genio_bpy._ints(me.polygons, 'loop_start', nf)
    total = genio_bpy._ints(me.polygons, 'loop_total', nf)
    vert = genio_bpy._ints(me.loops, 'vertex_index', nl)
    edge = genio_bpy._ints(me.loops, 'edge_index', nl)
    co = numpy.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    face = numpy.repeat(numpy.arange(nf), total)
    # The face on the other side of each corner's edge (the corner's vertex to the next one's), -1 at a border.
    order = numpy.argsort(edge, kind='stable')
    uses = numpy.bincount(edge, minlength=len(me.edges))
    first = numpy.cumsum(uses) - uses
    other = numpy.full(nl, -1)
    two = numpy.nonzero(uses == 2)[0]
    a, b = order[first[two]], order[first[two] + 1]
    other[a], other[b] = face[b], face[a]
    mine = panel[face]
    border = (mine >= 0) & ((other < 0) | (panel[numpy.maximum(other, 0)] != mine))
    nxt = start[face] + (numpy.arange(nl) - start[face] + 1) % total[face]
    out = numpy.full((nl, 4), -1.0)
    for k in numpy.unique(total):
        faces = numpy.nonzero((total == k) & (panel >= 0))[0]
        if not len(faces):
            continue
        loops = start[faces][:, None] + numpy.arange(k)
        p = co[vert[loops]]
        s0, s1 = co[vert[loops]], co[vert[nxt[loops]]]
        along = s1 - s0
        d = numpy.linalg.norm(numpy.cross(p[:, :, None] - s0[:, None], along[:, None]), axis=-1) / numpy.maximum(numpy.linalg.norm(along, axis=-1), 1e-12)[:, None]
        edges = border[loops]
        d = numpy.where(edges[:, None, :], d, _FAR)
        pick = numpy.argsort(~edges, axis=1, kind='stable')[:, :4]
        d = numpy.take_along_axis(d, numpy.broadcast_to(pick[:, None, :], (len(faces), k, pick.shape[1])), axis=2)
        if d.shape[2] < 4:
            d = numpy.concatenate([d, numpy.full((len(faces), k, 4 - d.shape[2]), _FAR)], axis=2)
        out[loops.ravel()] = d.reshape(-1, 4)
    out += 1.0
    for key, kind, values in ((_SEAM, 'FLOAT_VECTOR', out[:, :3]), (_SEAM_W, 'FLOAT', out[:, 3])):
        old = me.attributes.get(key)
        if old is not None:
            me.attributes.remove(old)
        me.attributes.new(key, kind, 'CORNER').data.foreach_set('vector' if kind == 'FLOAT_VECTOR' else 'value', values.astype(numpy.float32).ravel())


def panel_lines(ob, size=0.8, pattern='grid', gap=0.012, depth=0.006, region=None, mat=None, bake_only=False, strength=0.6):
    """Panel seams on a part: plates about `size` metres, the strips between them recessed `gap`
    wide each side (each plate inset by `gap` and raised `depth`; a negative depth sinks it), every
    seam edge sharp; `mat` paints the strips. On parts from p.revolve, p.sweep, p.hull and p.capsule
    the plates follow the shape: 'grid' rows along each piece or station span and columns around,
    'radial' columns only, 'concentric' rows only, 'stations' a seam at each piece or station
    joint; on other parts 'grid' cuts a grid in the part's space. `region(point)` (the face centre in
    the part's space) picks where. bake_only=True adds no triangles: the seams become a mask that
    p.bake_maps turns into darker (`strength`), rougher lines. Once per part. Returns the plates."""
    ob = _get(ob)
    if pattern not in PATTERNS:
        raise ValueError(f'{ob.name}: panel pattern is one of {", ".join(PATTERNS)}')
    if size <= 0 or gap <= 0:
        raise ValueError(f'{ob.name}: panel size and gap must be above 0')
    me = ob.data
    gridded = all(me.attributes.get(key) is not None for key, _ in _GRID)
    if pattern != 'grid' and not gridded:
        raise ValueError(f"{ob.name}: pattern {pattern!r} follows a part from p.revolve, p.sweep, p.hull or p.capsule; use 'grid' here")
    if not bake_only:
        surface = numpy.zeros(len(me.polygons), dtype=numpy.int32)
        if gridded:
            me.attributes['genio_cols'].data.foreach_get('value', surface)
        _cut_cells(me, size, surface <= 0)
    panel, colour = _panels(me, size, pattern, region, gridded)
    plates = int(panel.max()) + 1
    if not plates:
        raise ValueError(f'{ob.name}: no faces in the region')
    if bake_only:
        if not me.materials or any(m is None for m in me.materials):
            raise ValueError(f'{ob.name}: give the part a material first; the seams are painted on it')
        _seam_mask(me, panel)
        for m in dict.fromkeys(me.materials):
            _store(m, 'seams', {'gap': gap, 'strength': strength})
            _repaint(m)
        return plates
    index = None
    if mat is not None:
        if mat.name not in [m.name for m in me.materials if m]:
            me.materials.append(mat)
        index = [m.name if m else '' for m in me.materials].index(mat.name)
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    groups = {}
    for i in numpy.nonzero(panel >= 0)[0]:
        groups.setdefault(int(colour[i]), []).append(bm.faces[int(i)])
    for c in sorted(groups):
        for f in bmesh.ops.inset_region(bm, faces=groups[c], thickness=gap, depth=depth, use_even_offset=True)['faces']:
            if index is not None:
                f.material_index = index
            for e in f.edges:
                e.smooth = False
    bm.to_mesh(me)
    bm.free()
    me.update()
    return plates


# Plan as data -----------------------------------------------------------------------------------
# The model's layout written down before any geometry: every main part's place, size and simple
# shape. Step 1 builds them all (blockout), later steps replace each by name and read its numbers
# from the plan, and the review's Plan line compares the built parts with it.

_PLAN = 'genio_plan'  # scene property: the planned parts' boxes and the plan's size, as JSON
PLAN_SHAPES = ('box', 'cylinder', 'disc', 'sphere', 'capsule', 'cone', 'wedge', 'beam')
_PLAN_KEYS = ('at', 'size', 'shape', 'axis', 'mirror', 'ends', 'between', 'level', 'mat')


class PlanPart:
    """One planned part: `at` (its centre), `size` ((x, y, z), or the thickness of a part between two
    points), `shape`, `axis` (the long or round axis, 'x', 'y' or 'z'), `ends` (the two points of a
    part between two points, else None; `level` when its sections stay level), `box` ((min, max) of
    its planned shape) and `mat`."""

    def __init__(self, name, at, size, shape, axis=None, ends=None, mat=None, level=False):
        self.name, self.at, self.size, self.shape, self.axis, self.ends, self.mat, self.level = name, at, size, shape, axis, ends, mat, level
        self.box = None

    def mirrored(self, name):
        flip = lambda v: (-v[0], v[1], v[2])  # noqa: E731
        return PlanPart(name, flip(self.at), self.size, self.shape, self.axis, self.ends and tuple(flip(e) for e in self.ends), self.mat, self.level)

    def __repr__(self):
        where = f'ends={self.ends}' if self.ends else f'at={self.at}'
        return f'PlanPart({self.name!r}, {where}, size={self.size}, shape={self.shape!r})'


class Plan(dict):
    """p.plan()'s result: part name -> PlanPart, in plan order."""

    @property
    def box(self):
        return (tuple(min(p.box[0][k] for p in self.values()) for k in range(3)), tuple(max(p.box[1][k] for p in self.values()) for k in range(3)))


def _xyz(value, what, name):
    try:
        v = tuple(float(c) for c in value)
    except TypeError:
        v = ()
    if len(v) != 3:
        raise ValueError(f'{name}: {what} is (x, y, z)')
    return v


def _plan_axis(size, shape):
    """The axis a round or long shape runs along when the plan does not say: z for a disc, the longer
    of x and y for a wedge's ridge, else the one size unlike the other two (a wheel's thickness, a
    nacelle's length), else the longest."""
    if shape == 'disc':
        return 'z'
    if shape == 'wedge':
        return 'x' if size[0] > size[1] else 'y'
    for k in range(3):
        a, b = size[(k + 1) % 3], size[(k + 2) % 3]
        if abs(a - b) <= 0.02 * max(a, b) and abs(size[k] - a) > 0.02 * max(size[k], a):
            return 'xyz'[k]
    return 'xyz'[max(range(3), key=lambda k: (size[k], k))]


def _unit_shape(shape, sa, sb, sl, segments=32):
    """A shape along local Z centred on the origin: `sa` across x, `sb` across y, `sl` long. Returns
    vertices, faces and the face grid (None for a box)."""
    if shape in ('box', 'beam'):
        verts = numpy.array([(x, y, z) for z in (-0.5, 0.5) for y in (-0.5, 0.5) for x in (-0.5, 0.5)]) * (sa, sb, sl)
        return verts, [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (1, 3, 7, 5), (3, 2, 6, 7), (2, 0, 4, 6)], None
    radius = 1.0  # the profile's radius; the loops scale it to sa / 2 across x and sb / 2 across y
    if shape in ('cylinder', 'disc'):
        profile, bands = [(0.0, -sl / 2), (1.0, -sl / 2), (1.0, sl / 2), (0.0, sl / 2)], [0, 1, 2]
    elif shape == 'cone':
        profile, bands = [(0.0, -sl / 2), (1.0, -sl / 2), (0.0, sl / 2)], [0, 1]
    elif shape == 'sphere':
        a = numpy.linspace(0, math.pi, segments // 2 + 1)
        profile, bands = list(zip(numpy.sin(a).tolist(), (-numpy.cos(a) * sl / 2).tolist())), [0] * (segments // 2)
    else:  # capsule: round ends as long as it is thick
        radius = max(sa, sb) / 2
        profile, bands = _capsule_profile(sl, radius, radius, 'round', segments)
    # Loops along a long straight stretch about half a thickness apart: an edge as long as the part
    # would pass through whatever is sunk into it, which the review reads as a part through another.
    step = max(max(sa, sb) / 2, sl / 24)
    dense, spans = [profile[0]], []
    for (r0, z0), (r1, z1), band in zip(profile, profile[1:], bands):
        cuts = max(1, math.ceil(abs(z1 - z0) / step - 1e-9))
        dense += [(r0 + (r1 - r0) * i / cuts, z0 + (z1 - z0) * i / cuts) for i in range(1, cuts + 1)]
        spans += [band] * cuts
    profile, bands = dense, spans
    rings = _round_rings(profile, segments, sa / 2 / radius, sb / 2 / radius)
    verts, faces, grid, _ = _skin_geometry(rings, bands, _along(profile))
    return verts, faces, grid


def _plan_geometry(e, segments=32):
    """A planned part's simple shape in the model's space: vertices, faces and face grid."""
    if e.ends is not None:
        a, b = Vector(e.ends[0]), Vector(e.ends[1])
        length = (b - a).length
        if length < 1e-9:
            raise ValueError(f'{e.name}: its two ends are the same point')
        sa, sb = (float(e.size), float(e.size)) if _number(e.size) else (float(e.size[0]), float(e.size[1]))
        verts, faces, grid = _unit_shape(e.shape, sa, sb, length, segments)
        if e.level:
            # Level sections slid along the line from a to b: x across world X, y along world Y.
            return numpy.array(a) + (verts[:, 2:] / length + 0.5) * numpy.array(b - a) + verts * (1.0, 1.0, 0.0), faces, grid
        turn = numpy.array(_turn(b - a).to_matrix())
        return verts @ turn.T + numpy.array((a + b) / 2), faces, grid
    sx, sy, sz = e.size
    if e.shape == 'wedge':
        ridge = [(0, -sy / 2, sz / 2), (0, sy / 2, sz / 2)] if e.axis == 'y' else [(-sx / 2, 0, sz / 2), (sx / 2, 0, sz / 2)]
        base = [(x, y, -sz / 2) for x, y in ((-sx / 2, -sy / 2), (sx / 2, -sy / 2), (sx / 2, sy / 2), (-sx / 2, sy / 2))]
        faces = [(0, 3, 2, 1), (1, 2, 5, 4), (3, 0, 4, 5), (0, 1, 4), (2, 3, 5)] if e.axis == 'y' else [(0, 3, 2, 1), (0, 1, 5, 4), (2, 3, 4, 5), (3, 0, 4), (1, 2, 5)]
        return numpy.array(base + ridge) + e.at, faces, None
    k = 'xyz'.index(e.axis or 'z')
    verts, faces, grid = _unit_shape(e.shape, e.size[(k + 1) % 3], e.size[(k + 2) % 3], e.size[k], segments)
    world = numpy.empty_like(verts)
    world[:, (k + 1) % 3], world[:, (k + 2) % 3], world[:, k] = verts[:, 0], verts[:, 1], verts[:, 2]
    return world + e.at, faces, grid


def _between(name, a, b, shapes, thickness):
    """The two ends of a part joining planned parts a and b: where the line between their centres
    leaves each one's planned shape, each sunk into it by half the part's thickness."""
    ca, cb = Vector(a.at), Vector(b.at)
    d = cb - ca
    if d.length < 1e-9:
        raise ValueError(f'{name}: {a.name} and {b.name} share a centre; give the part its ends instead')
    d.normalize()
    hit_a = shapes[a.name].ray_cast(cb, -d)[0]
    hit_b = shapes[b.name].ray_cast(ca, d)[0]
    pa, pb = hit_a or ca, hit_b or cb
    sink = thickness / 2
    return tuple(pa - d * sink), tuple(pb + d * sink)


def plan(parts):
    """The model's layout as data, written in lib.py before any geometry: {name: dict(at=(x, y, z),
    size=(x, y, z), shape='box', axis=None, mirror=False, mat=None)}, in the model's final place
    (standing on z = 0, centred, front to -Y). Shapes: box, cylinder, disc, sphere, capsule, cone,
    wedge (a gable whose ridge runs along `axis`); a round or long shape runs along `axis` (default:
    the size unlike the other two). A part between two points: ends=((x, y, z), (x, y, z)), or
    between=('A', 'B') two parts planned before it, with `size` its thickness and shape 'beam'
    (default), 'capsule', 'cylinder' or 'cone'; level=True keeps its sections level, as p.sweep's
    `level` (a neck, a pylon, a leg swept back). mirror=True plans the twin across x = 0 too
    (`Nacelle L` plans `Nacelle R`). Returns the Plan (name -> part: .at, .size, .box, .shape,
    .axis, .ends) and keeps it in the scene for the review's Plan line; p.blockout(PLAN) builds it."""
    if not isinstance(parts, dict) or not parts:
        raise ValueError('plan takes a dict of parts: {name: dict(at=(x, y, z), size=(x, y, z)), ...}')
    out, shapes = Plan(), {}
    for raw, spec in parts.items():
        name = _clean(raw)
        if not isinstance(spec, dict):
            raise ValueError(f'{name}: plan each part as dict(at=..., size=...)')
        unknown = sorted(set(spec) - set(_PLAN_KEYS))
        if unknown:
            raise ValueError(f'{name}: unknown plan key {", ".join(unknown)}; the keys are {", ".join(_PLAN_KEYS)}')
        joins = spec.get('ends') is not None or spec.get('between') is not None
        shape = spec.get('shape') or ('beam' if joins else 'box')
        if shape not in PLAN_SHAPES:
            raise ValueError(f'{name}: no plan shape {shape!r}: use one of {", ".join(PLAN_SHAPES)}')
        if joins:
            if shape not in ('beam', 'capsule', 'cylinder', 'cone'):
                raise ValueError(f"{name}: a part between two points is a 'beam', 'capsule', 'cylinder' or 'cone'")
            size = spec.get('size')
            thick = float(size) if _number(size) else tuple(float(v) for v in (size or ()))
            if not (thick > 0 if _number(thick) else len(thick) == 2 and min(thick) > 0):
                raise ValueError(f'{name}: size is its thickness, one number or (width, height)')
            if spec.get('between') is not None:
                pair = tuple(spec['between'])
                missing = [x for x in pair if x not in out]
                if len(pair) != 2 or missing:
                    raise ValueError(f'{name}: between names two parts planned before it, not {", ".join(map(repr, missing or pair))}')
                ends = _between(name, out[pair[0]], out[pair[1]], shapes, thick if _number(thick) else max(thick))
            else:
                ends = tuple(_xyz(x, 'each end', name) for x in spec['ends'])
                if len(ends) != 2:
                    raise ValueError(f'{name}: ends is two (x, y, z) points')
            entry = PlanPart(name, tuple((Vector(ends[0]) + Vector(ends[1])) / 2), thick, shape, None, ends, spec.get('mat'), bool(spec.get('level')))
        else:
            if shape == 'beam':
                raise ValueError(f'{name}: a beam runs between two points: give it ends or between')
            if spec.get('at') is None or spec.get('size') is None:
                raise ValueError(f'{name}: plan it with at=(x, y, z) and size=(x, y, z)')
            at, size = _xyz(spec['at'], 'at', name), _xyz(spec['size'], 'size', name)
            if min(size) <= 0:
                raise ValueError(f'{name}: every size must be above 0')
            axis = spec.get('axis') or _plan_axis(size, shape)
            if axis not in ('x', 'y', 'z') or (shape == 'wedge' and axis == 'z'):
                raise ValueError(f"{name}: axis is 'x', 'y' or 'z' (a wedge's ridge: 'x' or 'y')")
            entry = PlanPart(name, at, size, shape, axis, None, spec.get('mat'))
        entries = [entry]
        if spec.get('mirror'):
            twin = _other_side(name)
            if not twin:
                raise ValueError(f"{name}: mirror=True needs a side in the name (L, R, Left, Right)")
            entries.append(entry.mirrored(twin))
        for e in entries:
            if e.name in out:
                raise ValueError(f'{e.name} is planned twice')
            verts, faces, _ = _plan_geometry(e)
            e.box = (tuple(verts.min(axis=0).tolist()), tuple(verts.max(axis=0).tolist()))
            shapes[e.name] = BVHTree.FromPolygons(verts.tolist(), [list(f) for f in faces])
            out[e.name] = e
    lo, hi = out.box
    bpy.context.scene[_PLAN] = json.dumps({'parts': {n: {'box': [list(e.box[0]), list(e.box[1])]} for n, e in out.items()},
                                           'scale': max(h - l for l, h in zip(lo, hi))})
    return out


def planned():
    """The plan p.plan() keeps in the scene: {'parts': {name: {'box': [min, max]}}, 'scale': metres}, or None."""
    try:
        return json.loads(bpy.context.scene.get(_PLAN, '')) or None
    except (TypeError, ValueError):
        return None


def blockout(plan, *names, mat=None, col=None):
    """Every planned part (or the ones named) as its simple shape, named as planned: step 1 shows the
    whole model, and later steps replace each part by name. A part takes its plan's `mat`, else
    `mat`, else one grey 'Blockout' material. Returns the parts."""
    if not isinstance(plan, Plan):
        raise ValueError('blockout takes the plan p.plan() returned')
    todo = list(names) or list(plan)
    unknown = [n for n in todo if n not in plan]
    if unknown:
        raise KeyError(f'Not in the plan: {_names_of(unknown)}. Planned: {_names_of(list(plan))}')
    grey, out = None, []
    for n in todo:
        e = plan[n]
        m = e.mat if e.mat is not None else mat
        if m is None:
            grey = grey or material('Blockout', '#9ca3ab', rough=0.7)
            m = grey
        verts, faces, grid = _plan_geometry(e)
        flat = e.shape in ('box', 'beam', 'wedge')
        out.append(_part(n, verts - numpy.array(e.at), faces, _mat(m), col, e.at, (0, 0, 0), None if flat else SMOOTH, grid=grid))
    return out


# Paint ----------------------------------------------------------------------------------------

# Camo palettes: the ground colour, then patch colours from the widest patches to the smallest,
# and the pattern ('blotch', or 'digital' pixels).
CAMO = {
    'red': (('#8e1f1c', '#a33d22', '#4a0f13', '#c8433a', '#211b1c'), 'blotch'),
    'woodland': (('#55603a', '#6f6a3d', '#2f3b23', '#76593a', '#1d1e19'), 'blotch'),
    'desert': (('#c6ab7c', '#a5885a', '#dac59c', '#8a6b46', '#5b4934'), 'blotch'),
    'arctic': (('#d7dcdf', '#b2bac0', '#eff1f2', '#88919a', '#474e55'), 'blotch'),
    'urban': (('#7a7e83', '#5b5f64', '#a2a6aa', '#3c3f43', '#1e2023'), 'blotch'),
    'digital': (('#6d787e', '#4d5860', '#98a1a6', '#36414a', '#1d2428'), 'digital'),
}
# Per patch colour: noise offset, noise scale (per metre at scale 1) and threshold.
_PATCHES = (((13.1, 7.3, 2.9), 0.48, 0.57), ((0.0, 0.0, 0.0), 0.4, 0.58), ((21.0, 3.0, 11.0), 0.62, 0.61), ((5.0, 31.0, 17.0), 0.8, 0.635))
_MECH_HEIGHT = 8.5  # reference height for preset sizes; scale=None fits the model
_PAINT = 'genio_paint'  # material custom property: the presets applied, so a repaint is exact
_OBJECT_CO = 'genio_object'  # object-space positions carried onto the joined bake copy
MAPS = ('basecolor', 'roughmetal')
# Rays per shading sample for the edge-wear Bevel and the grime AO nodes. Each texel gets
# `samples` of these: at 8 spp, 4 and 4 looked the same as the mech's 8 and 16 and baked faster.
_BEVEL_RAYS, _AO_RAYS = 4, 4
BAKES = []  # what bake_maps() did in the current step; the step receipt lists it


def _socket(sockets, identifier):
    return next(s for s in sockets if s.identifier == identifier)


def _nodes(mat):
    """The material's node tree, switched on (4.2 materials can start without one)."""
    if mat.node_tree is None or (VERSION < (5, 0) and not mat.use_nodes):
        mat.use_nodes = True
    return mat.node_tree


class _Graph:
    """Paint node builder on a material's tree, feeding its Principled BSDF. Sockets or
    constants go into every input; the procedural graph is world-space (Position, Normal)."""

    def __init__(self, mat):
        self.nt = _nodes(mat)
        old = next((n for n in self.nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        # The glow and the preset's inputs (coat, transmission...) carry over; the paint sets the rest.
        kept = [(key, tuple(old.inputs[key].default_value) if key == 'Emission Color' else old.inputs[key].default_value)
                for key in ('Emission Color', 'Emission Strength', *_PRESET_INPUTS) if not old.inputs[key].is_linked] if old else []
        self.nt.nodes.clear()
        out = self.nt.nodes.new('ShaderNodeOutputMaterial')
        self.bsdf = self.nt.nodes.new('ShaderNodeBsdfPrincipled')
        self.nt.links.new(self.bsdf.outputs['BSDF'], out.inputs['Surface'])
        for key, value in kept:
            self.bsdf.inputs[key].default_value = value
        geo = self.nt.nodes.new('ShaderNodeNewGeometry')
        self.P, self.N = geo.outputs['Position'], geo.outputs['Normal']

    def put(self, inp, x):
        if isinstance(x, bpy.types.NodeSocket):
            self.nt.links.new(x, inp)
        else:
            inp.default_value = x

    def node(self, kind, ins=(), **props):
        nd = self.nt.nodes.new(kind)
        for k, v in props.items():
            setattr(nd, k, v)
        for key, x in ins:
            self.put(nd.inputs[key], x)
        return nd

    def math(self, op, a, b=0.0, clamp=False):
        return self.node('ShaderNodeMath', ((0, a), (1, b)), operation=op, use_clamp=clamp).outputs[0]

    def vec(self, op, a, b=None):
        nd = self.node('ShaderNodeVectorMath', ((0, a),) + (((1, b),) if b is not None else ()), operation=op)
        return nd.outputs['Value'] if op in ('LENGTH', 'DOT_PRODUCT', 'DISTANCE') else nd.outputs['Vector']

    def xyz(self, v):
        return self.node('ShaderNodeSeparateXYZ', ((0, v),)).outputs

    def noise(self, v, scale, detail=2.0, rough=0.5, out='Fac'):
        return self.node('ShaderNodeTexNoise', (('Vector', v), ('Scale', scale), ('Detail', detail), ('Roughness', rough))).outputs[out]

    def step(self, x, edge, w=0.012):
        """Soft threshold: 0 below edge, 1 above."""
        return self.node('ShaderNodeMapRange', ((0, x), (1, edge - w), (2, edge + w), (3, 0.0), (4, 1.0)),
                         interpolation_type='SMOOTHSTEP').outputs[0]

    def mix(self, fac, a, b, blend='MIX'):
        nd = self.node('ShaderNodeMix', data_type='RGBA', blend_type=blend, clamp_result=True)
        for key, x in (('Factor_Float', fac), ('A_Color', a), ('B_Color', b)):
            self.put(_socket(nd.inputs, key), x)
        return _socket(nd.outputs, 'Result_Color')

    def lerp(self, fac, a, b):
        nd = self.node('ShaderNodeMix', data_type='FLOAT')
        for key, x in (('Factor_Float', fac), ('A_Float', a), ('B_Float', b)):
            self.put(_socket(nd.inputs, key), x)
        return _socket(nd.outputs, 'Result_Float')

    def shade(self, c, k):
        """Colour times a grey factor (grain, grime)."""
        grey = self.node('ShaderNodeCombineColor', ((0, k), (1, k), (2, k))).outputs[0]
        return self.mix(1.0, c, grey, 'MULTIPLY')

    def panel_lines(self, c, strength, s):
        """Rectangular plate seams on a world grid, skipping the axis a face looks along."""
        cells = (0.9 * s, 0.85 * s, 0.7 * s)
        q = self.vec('DIVIDE', self.vec('ADD', self.P, (0.23 * s, 0.41 * s, 0.17 * s)), cells)
        g = self.xyz(self.vec('ABSOLUTE', self.vec('SUBTRACT', self.vec('FRACTION', q), (0.5, 0.5, 0.5))))
        n = self.xyz(self.vec('ABSOLUTE', self.N))
        lines = 0.0
        for i in range(3):
            on = self.math('GREATER_THAN', g[i], 0.5 - 0.012 / cells[i] * s)
            lines = self.math('MAXIMUM', lines, self.math('MULTIPLY', on, self.math('LESS_THAN', n[i], 0.55)))
        return self.mix(self.math('MULTIPLY', lines, strength), c, (*_hex('#120a0a'), 1.0))

    def weather(self, c, s, wear, dirt, wear_color):
        """Edge wear, scratches, crevice grime (AO), mud low down and rain streaks. Returns
        (colour, wear mask); the Bevel and AO nodes only work in Cycles, which bakes them."""
        P = self.P
        bevel = self.node('ShaderNodeBevel', (('Radius', 0.02 * s),), samples=_BEVEL_RAYS).outputs['Normal']
        edges = self.math('LESS_THAN', self.vec('DOT_PRODUCT', bevel, self.N), 0.96)
        worn = self.math('MULTIPLY', edges, self.step(self.noise(P, 7.0 / s, 4.0, 0.6), 0.56, 0.03))
        scratch = self.step(self.noise(self.vec('MULTIPLY', P, (1.0, 1.0, 0.25)), 22.0 / s, 1.0), 0.70, 0.01)
        hit = self.math('MAXIMUM', self.math('MULTIPLY', worn, wear), self.math('MULTIPLY', scratch, 0.6 * wear))
        c = self.mix(hit, c, (*_hex(wear_color), 1.0))
        if dirt:
            ao = self.node('ShaderNodeAmbientOcclusion', (('Distance', 0.4 * s),), samples=_AO_RAYS).outputs['AO']
            c = self.shade(c, self.lerp(ao, 1.0 - 0.65 * min(dirt, 1.0), 1.0))
            low = self.math('SUBTRACT', 1.0, self.math('DIVIDE', self.xyz(P)[2], 2.4 * s), clamp=True)
            mud = self.step(self.math('MULTIPLY', low, self.noise(P, 2.2 / s, 4.0, 0.6)), 0.3, 0.12)
            c = self.mix(self.math('MULTIPLY', mud, 0.75 * dirt), c, (*_hex('#3b2e24'), 1.0))
            streak = self.step(self.noise(self.vec('MULTIPLY', P, (7.0, 7.0, 0.5)), 1.4 / s, 2.0), 0.6, 0.06)
            c = self.mix(self.math('MULTIPLY', streak, 0.35 * dirt), c, (*_hex('#2a2320'), 1.0))
        return c, hit

    def seams(self, c, r, gap, strength):
        """panel_lines(bake_only=True) seams: each face corner's distances to its panel's edges (+ 1,
        so a part without them reads 0) mark darker, rougher lines `gap` wide each side of an edge."""
        a = self.node('ShaderNodeAttribute', attribute_type='GEOMETRY', attribute_name=_SEAM)
        b = self.node('ShaderNodeAttribute', attribute_type='GEOMETRY', attribute_name=_SEAM_W)
        x = self.xyz(a.outputs['Vector'])
        d = self.math('MINIMUM', self.math('MINIMUM', x[0], x[1]), self.math('MINIMUM', x[2], b.outputs['Fac']))
        line = self.math('MULTIPLY', self.math('GREATER_THAN', d, 0.5), self.math('SUBTRACT', 1.0, self.step(self.math('SUBTRACT', d, 1.0), gap, 0.25 * gap)))
        c = self.mix(self.math('MULTIPLY', line, strength), c, (*_hex('#15171a'), 1.0))
        return c, self.lerp(line, r, 0.85)

    def finish(self, c, rough, metal):
        for key, x in (('Base Color', c), ('Roughness', rough), ('Metallic', metal)):
            self.put(self.bsdf.inputs[key], x)


def _mat(mat):
    if not isinstance(mat, str):
        return mat
    found = bpy.data.materials.get(mat)
    if found is None:
        raise KeyError(f'No material named {mat!r}. Materials: {_names_of(sorted(m.name for m in bpy.data.materials)) or "none"}')
    return found


def _fit(scale):
    """Pattern size in mech units: scale=None fits the model (its height over 8.5 m)."""
    if scale is not None:
        if scale <= 0:
            raise ValueError('scale must be above 0')
        return float(scale)
    try:
        lo, hi = bounds()
    except ValueError:
        return 1.0
    return max(hi.z - lo.z, 0.05) / _MECH_HEIGHT


def _repaint(mat):
    """Rebuild a material's paint graph from its presets and its plain colour, roughness and
    metallic, so applying a preset again replaces it instead of stacking."""
    spec = json.loads(mat.get(_PAINT, '{}'))
    camo_spec, wear_spec, seam_spec = spec.get('camo'), spec.get('weathering'), spec.get('seams')
    rough, metal = mat.roughness, mat.metallic
    base = (*mat.diffuse_color[:3], 1.0)
    g = _Graph(mat)
    P = g.P
    s = (camo_spec or wear_spec or {}).get('scale', 1.0)  # pattern size; the weathering keeps its own
    lines = 0.0
    if not camo_spec and not wear_spec:
        c, r = base, rough  # panel seams alone keep the plain colour and roughness
    elif camo_spec:
        colours = [(*_hex(h), 1.0) for h in camo_spec['colors']]
        warp = g.node('ShaderNodeVectorMath', ((0, g.vec('SUBTRACT', g.noise(P, 0.8 / s, 2.0, 0.5, 'Color'), (0.5, 0.5, 0.5))),), operation='SCALE')
        warp.inputs['Scale'].default_value = 0.7 * s
        Pw = g.vec('ADD', P, warp.outputs['Vector'])
        k = 1.0
        if camo_spec['pattern'] == 'digital':
            Pw = g.vec('SNAP', Pw, (0.1 * s, 0.1 * s, 0.1 * s))
            k = 1.6
        seed = camo_spec['seed']
        c = colours[0]
        for (offset, scale, edge), colour in zip(_PATCHES, colours[1:]):
            shifted = g.vec('ADD', Pw, tuple(o + seed * d for o, d in zip(offset, (17.3, 5.1, 9.7))))
            c = g.mix(g.step(g.noise(shifted, k * scale / s, 2.0, 0.55), edge, 0.01), c, colour)
        c = g.shade(c, g.lerp(g.noise(P, 9.0 / s, 5.0, 0.6), 0.86, 1.1))
        lines = camo_spec['panel_lines']
    else:
        c = g.shade(base, g.lerp(g.noise(P, 6.0 / s, 4.0, 0.6), 0.8, 1.15))
    if camo_spec or wear_spec:
        r = g.lerp(g.noise(P, 4.0 / s), max(rough - 0.1, 0.0), min(rough + 0.12, 1.0))
    m = metal
    if wear_spec:
        lines = max(lines, wear_spec['panel_lines'])
    if lines:
        c = g.panel_lines(c, lines, s)
    if seam_spec:
        c, r = g.seams(c, r, seam_spec['gap'], seam_spec['strength'])
    if wear_spec:
        c, hit = g.weather(c, wear_spec['scale'], wear_spec['wear'], wear_spec['dirt'], wear_spec['wear_color'])
        r = g.lerp(hit, r, wear_spec['bare_rough'])
        m = g.lerp(hit, metal, wear_spec['bare_metal'])
    g.finish(c, r, m)
    return mat


def _store(mat, key, value):
    spec = json.loads(mat.get(_PAINT, '{}'))
    spec[key] = value
    mat[_PAINT] = json.dumps(spec)


def camo(mat, palette='woodland', scale=None, panel_lines=0.6, wear=0.8, dirt=1.0, seed=0, pattern=None):
    """Camouflage paint on a material: a palette name from CAMO ('red', 'woodland', 'desert',
    'arctic', 'urban', 'digital') or your own ['#ground', '#patch', ...] (2 to 5 colours),
    warped noise patches (pattern='digital' makes them pixels), grain, panel lines, and the
    weathering() look unless wear and dirt are 0. scale=None sizes the pattern to the model
    (1.0 is the 8.5 m mech's). Procedural until bake_maps() turns it into textures."""
    mat = _mat(mat)
    if isinstance(palette, str):
        if palette not in CAMO:
            raise ValueError(f'No camo palette {palette!r}: use one of {", ".join(CAMO)} or a list of #rrggbb colours')
        colours, kind = CAMO[palette]
    else:
        colours, kind = tuple(palette), 'blotch'
        if not 2 <= len(colours) <= 5:
            raise ValueError('A camo palette is 2 to 5 colours: the ground, then the patches')
    for h in colours:
        _hex(h)
    kind = pattern or kind
    if kind not in ('blotch', 'digital'):
        raise ValueError("pattern is 'blotch' or 'digital'")
    s = _fit(scale)
    _store(mat, 'camo', {'colors': list(colours), 'pattern': kind, 'scale': s, 'panel_lines': panel_lines, 'seed': seed})
    _store(mat, 'weathering', {'scale': s, 'wear': wear, 'dirt': dirt, 'panel_lines': 0.0, 'wear_color': '#77706a',
                               'bare_rough': 0.35, 'bare_metal': 0.85} if wear or dirt else None)
    mat.diffuse_color = (*_hex(colours[0]), 1.0)  # the review sheet's Workbench colour
    return _repaint(mat)


def weathering(mat, wear=0.8, dirt=1.0, scale=None, panel_lines=0.0, wear_color='#8c8780', bare_rough=0.35, bare_metal=0.85):
    """Battle wear on a material's own colour (or on its camo): worn and scratched edges showing
    bare metal (wear_color, bare_rough, bare_metal), crevice grime, mud on the lower part and rain
    streaks (dirt), optional panel lines. Applying it again replaces it."""
    mat = _mat(mat)
    _hex(wear_color)
    _store(mat, 'weathering', {'scale': _fit(scale), 'wear': wear, 'dirt': dirt, 'panel_lines': panel_lines,
                               'wear_color': wear_color, 'bare_rough': bare_rough, 'bare_metal': bare_metal})
    return _repaint(mat)


def uv_atlas(objects=None, angle=66.0, margin=0.003):
    """One shared, non-overlapping UV atlas over the parts, which bake_maps() needs. Applies their
    modifiers first (shape-keyed parts keep theirs) so the atlas covers exactly what ships and
    array or mirror copies get texels of their own. Returns the share of the atlas in use."""
    obs = [o for o in (export_objects() if objects is None else objects) if o.type == 'MESH']
    if not obs:
        raise ValueError('uv_atlas: no mesh parts')
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    baked = genio_bpy._evaluated_meshes([o for o in obs if genio_bpy._bakes_modifiers(o)])
    for ob in obs:
        old = ob.data
        if ob in baked:
            ob.modifiers.clear()
            ob.data = baked[ob]
        elif old.users > 1:
            ob.data = old.copy()  # shared meshes would share texels
        if ob.data is not old:
            if old.users == 0:
                bpy.data.meshes.remove(old)
            ob.data.name = ob.name
        for uv in list(ob.data.uv_layers):
            ob.data.uv_layers.remove(uv)
        ob.data.uv_layers.new(name='UVMap')
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for ob in obs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=0.0, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.select_all(action='SELECT')
    # Box packing: as tight as the exact-shape packer on the mech's 88 parts, in 0.01 s instead of
    # 3.6 s, and that packer took 40 s or more on four beveled boxes.
    bpy.ops.uv.pack_islands(rotate=True, shape_method='AABB', margin_method='FRACTION', margin=margin)
    bpy.ops.object.mode_set(mode='OBJECT')
    used = 0.0
    for ob in obs:
        uv = numpy.empty(len(ob.data.loops) * 2)
        ob.data.uv_layers.active.data.foreach_get('uv', uv)
        uv = uv.reshape(-1, 2)
        for poly in ob.data.polygons:
            x, y = uv[poly.loop_start:poly.loop_start + poly.loop_total].T
            used += abs(numpy.dot(x, numpy.roll(y, 1)) - numpy.dot(y, numpy.roll(x, 1))) / 2
    return round(used, 4)


class _Rig:
    """Temporary bake wiring on one material: an Emission shader fed by whatever its Principled
    BSDF gets, an image node to bake into, and Object coordinates read from the joined copy's
    attribute. undo() puts the tree back as it was."""

    def __init__(self, mat):
        self.mat = mat
        # A 4.2 material without nodes renders its plain colour, roughness and metallic.
        self.plain = mat.node_tree is None or (VERSION < (5, 0) and not mat.use_nodes)
        nt = self.nt = _nodes(mat)
        self.added, self.swapped = [], []
        out = nt.get_output_node('CYCLES')
        surface = out.inputs['Surface'] if out else None
        self.old = surface.links[0].from_socket if surface and surface.is_linked else None
        bsdf = None if self.plain else (self.old.node if self.old and self.old.node.type == 'BSDF_PRINCIPLED'
                                        else next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None))

        def source(name, const):
            if bsdf is None:
                return const
            inp = bsdf.inputs[name]
            return inp.links[0].from_socket if inp.is_linked else (tuple(inp.default_value) if name == 'Base Color' else inp.default_value)

        self.base = source('Base Color', tuple(mat.diffuse_color))
        if out is None:
            out = self.new('ShaderNodeOutputMaterial')
            out.target = 'CYCLES'
        self.out = out
        self.emit = self.new('ShaderNodeEmission')
        nt.links.new(self.emit.outputs[0], out.inputs['Surface'])
        self.rm = self.new('ShaderNodeCombineColor')
        self.rm.inputs[0].default_value = 1.0
        for i, x in ((1, source('Roughness', mat.roughness)), (2, source('Metallic', mat.metallic))):
            self.put(self.rm.inputs[i], x)
        self.target = self.new('ShaderNodeTexImage')
        for nd in list(nt.nodes):
            if nd.type == 'TEX_COORD' and nd.object is None and nd.outputs['Object'].is_linked:
                attr = self.new('ShaderNodeAttribute')
                attr.attribute_type, attr.attribute_name = 'GEOMETRY', _OBJECT_CO
                for link in list(nd.outputs['Object'].links):
                    to = link.to_socket
                    nt.links.remove(link)
                    nt.links.new(attr.outputs['Vector'], to)
                    self.swapped.append((nd.outputs['Object'], to))

    def new(self, kind):
        nd = self.nt.nodes.new(kind)
        self.added.append(nd)
        return nd

    def put(self, inp, x):
        if isinstance(x, bpy.types.NodeSocket):
            self.nt.links.new(x, inp)
        else:
            inp.default_value = x

    def show(self, key, image):
        self.put(self.emit.inputs['Color'], self.base if key == 'basecolor' else self.rm.outputs[0])
        self.target.image = image
        self.target.select = True
        self.nt.nodes.active = self.target

    def undo(self):
        for src, to in self.swapped:
            self.nt.links.new(src, to)
        for nd in self.added:
            self.nt.nodes.remove(nd)
        if self.old is not None:
            self.nt.links.new(self.old, self.out.inputs['Surface'])
        if self.plain and VERSION < (5, 0):
            self.mat.use_nodes = False


def _textured(mat, images):
    """Make mat a plain image-textured PBR material: the baked base colour, and roughness (G) and
    metallic (B) from the packed map, the layout the glTF exporter ships as metallicRoughness."""
    nt = _nodes(mat)
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    bsdf.inputs['Roughness'].default_value, bsdf.inputs['Metallic'].default_value = mat.roughness, mat.metallic
    if 'roughmetal' in images:
        rm = nt.nodes.new('ShaderNodeTexImage')
        rm.image = images['roughmetal']
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(rm.outputs['Color'], sep.inputs['Color'])
        nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
        nt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    if 'basecolor' in images:
        base = nt.nodes.new('ShaderNodeTexImage')
        base.image = images['basecolor']
        nt.links.new(base.outputs['Color'], bsdf.inputs['Base Color'])
        nt.nodes.active = base  # Workbench's texture mode shows the active image
        px = numpy.empty(base.image.size[0] * base.image.size[1] * 4, dtype=numpy.float32)
        base.image.pixels.foreach_get(px)
        px = px.reshape(-1, 4)[:, :3]
        px = px[px.sum(axis=1) > 0]
        if len(px):
            mat.diffuse_color = (*px.mean(axis=0).tolist(), 1.0)
    if _PAINT in mat:
        del mat[_PAINT]
    return mat


def _use_gpu():
    """Switch Cycles to the first GPU backend with a device; None when there is none."""
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for kind in ('OPTIX', 'CUDA', 'HIP', 'ONEAPI', 'METAL'):
        try:
            prefs.compute_device_type = kind
        except TypeError:
            continue
        prefs.get_devices()
        if any(d.type == kind for d in prefs.devices):
            for d in prefs.devices:
                d.use = d.type == kind
            return kind
    return None


def bake_maps(objects=None, size=1024, samples=8, maps=MAPS, margin=None, material='Baked', gpu=False, out_dir=None):
    """Bake what every part's material feeds its Principled BSDF (camo() and weathering() paint,
    or any node graph) into one shared texture set: base colour, and roughness (G) plus metallic
    (B). The parts must share one non-overlapping UV atlas (uv_atlas()).

    Fast: the parts are copied as they ship and joined into one temporary mesh, so Cycles syncs
    and bakes once per map instead of once per part per map, on every core (the kernel starts
    Blender with all of them for a step that calls this), at `samples` (8 looks the same as 32 on
    this kind of paint). The originals are hidden from render meanwhile, so AO and bevel rays
    see the same geometry. gpu=True tries the GPU; it is off by default because it competes
    with the player's game or editor. The copy is deleted afterwards; the parts, their names
    and hierarchy are untouched.

    Then the maps are saved as PNGs (out_dir, default the model's data folder) and packed, and
    the parts get one shared image-textured material named `material`, or with material=None
    each part's own materials are rewired to the textures. Returns what it did, with seconds."""
    t0 = time.perf_counter()
    obs = [part(o) if isinstance(o, str) else o for o in (export_objects() if objects is None else objects)]
    obs = [o for o in obs if o.type == 'MESH']
    if not obs:
        raise ValueError('bake_maps: no mesh parts to bake')
    maps = tuple(maps)
    if not maps or any(k not in MAPS for k in maps):
        raise ValueError(f'maps are any of {MAPS}')
    no_uv = [o.name for o in obs if not o.data.uv_layers]
    uv_names = {o.data.uv_layers.active.name for o in obs if o.data.uv_layers}
    if no_uv or len(uv_names) > 1:
        what = f'{_names_of(no_uv)} have no UV map' if no_uv else f'the parts use different UV maps ({", ".join(sorted(uv_names))})'
        raise ValueError(f'bake_maps needs one shared UV atlas, but {what}. Run p.uv_atlas() first.')
    bare = [o.name for o in obs if not o.material_slots or any(s.material is None for s in o.material_slots)]
    if bare:
        raise ValueError(f'bake_maps: {_names_of(bare)} have an empty material slot; give every part a material')
    mats = list(dict.fromkeys(s.material for o in obs for s in o.material_slots))
    margin = max(4, size * 3 // 512) if margin is None else margin
    out_dir = out_dir or os.path.join(os.environ.get('GENIO_MODELLER_DATA') or bpy.app.tempdir, 'bake')
    prefix = material or 'Baked'
    images = {}
    for key in maps:
        old = bpy.data.images.get(f'{prefix}_{key}')
        if old is not None:
            bpy.data.images.remove(old)
        images[key] = bpy.data.images.new(f'{prefix}_{key}', size, size, alpha=False, is_data=key == 'roughmetal')
        if key == 'roughmetal':
            images[key].colorspace_settings.name = 'Non-Color'

    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    scene = bpy.context.scene
    saved = [(scene.render, 'engine', scene.render.engine)]
    scene.render.engine = 'CYCLES'
    bake = scene.render.bake
    saved += [(owner, key, getattr(owner, key)) for owner, key in (
        (scene.cycles, 'device'), (scene.cycles, 'samples'), (bake, 'margin'), (bake, 'margin_type'), (bake, 'target'), (bake, 'use_clear'))]
    hidden = [(o, o.hide_render) for o in obs]
    rigs, meshes, joined = [], [], None
    seconds = {}
    try:
        device = _use_gpu() if gpu else None
        if gpu and device is None:
            print('bake_maps: no GPU found, baking on the CPU')
        scene.cycles.device = 'GPU' if device else 'CPU'
        scene.cycles.samples = samples
        bake.margin, bake.margin_type, bake.target, bake.use_clear = margin, 'EXTEND', 'IMAGE_TEXTURES', True
        rigs = [_Rig(m) for m in mats]
        copies = []
        with evaluated(obs) as shipped:
            for ob, mesh in shipped.items():
                me = mesh.copy()
                meshes.append(me)
                for i, slot in enumerate(ob.material_slots):
                    me.materials[i] = slot.material
                co = numpy.empty(len(me.vertices) * 3, dtype=numpy.float32)
                me.vertices.foreach_get('co', co)
                me.attributes.new(_OBJECT_CO, 'FLOAT_VECTOR', 'POINT').data.foreach_set('vector', co)
                c = bpy.data.objects.new('genio bake copy', me)
                scene.collection.objects.link(c)
                c.matrix_world = ob.matrix_world.copy()
                if me.shape_keys:
                    c.shape_key_clear()
                copies.append(c)
        for ob in obs:
            ob.hide_render = True
        joined = copies[0]
        with bpy.context.temp_override(active_object=joined, object=joined, selected_objects=copies, selected_editable_objects=copies):
            bpy.ops.object.join()
        for o in bpy.context.view_layer.objects:
            o.select_set(False)
        joined.select_set(True)
        bpy.context.view_layer.objects.active = joined
        for key in maps:
            for rig in rigs:
                rig.show(key, images[key])
            t = time.perf_counter()
            with bpy.context.temp_override(active_object=joined, object=joined, selected_objects=[joined], selected_editable_objects=[joined]):
                bpy.ops.object.bake(type='EMIT', margin=margin, margin_type='EXTEND', use_clear=True, target='IMAGE_TEXTURES')
            seconds[key] = round(time.perf_counter() - t, 2)
    finally:
        if joined is not None:
            bpy.data.objects.remove(joined)
        for me in meshes:
            if me.users == 0:
                bpy.data.meshes.remove(me)
        for o, was in hidden:
            o.hide_render = was
        for rig in rigs:
            rig.undo()
        for owner, key, value in saved:
            setattr(owner, key, value)

    os.makedirs(out_dir, exist_ok=True)
    files = {}
    for key, img in images.items():
        img.filepath_raw = files[key] = os.path.join(out_dir, f'{prefix}_{key}.png')
        img.file_format = 'PNG'
        img.save()
        img.pack()
    if material:
        shared = _textured(bpy.data.materials.get(material) or bpy.data.materials.new(_clean(material)), images)
        for ob in obs:
            me = ob.data
            me.materials.clear()
            me.materials.append(shared)
            me.polygons.foreach_set('material_index', [0] * len(me.polygons))
            me.update()
    else:
        for m in mats:
            _textured(m, images)
    result = {'parts': len(obs), 'materials': len(mats), 'size': size, 'samples': samples, 'device': device or 'CPU',
              'threads': scene.render.threads, 'bakes': len(maps), 'bake_s': seconds,
              'total_s': round(time.perf_counter() - t0, 2), 'files': files, 'material': material}
    BAKES.append(result)
    print(f"bake_maps: {len(obs)} parts as one joined copy, {size} px, {samples} spp on {result['device']} "
          f"({result['threads']} threads): " + ', '.join(f'{k} {v} s' for k, v in seconds.items()) + f"; {result['total_s']} s in all")
    return result


def _names_of(names):
    return ', '.join(names[:6]) + (f' and {len(names) - 6} more' if len(names) > 6 else '')
