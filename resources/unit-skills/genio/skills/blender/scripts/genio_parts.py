"""Modeller part helpers: data-API primitives that behave the same on Blender 4.2 and 5.x.

Step scripts get this module preloaded as `p` (and `bpy`). Nothing here needs
bpy.ops or a UI context, so nothing fails a poll in background mode. Every part
is named: building a part again replaces the old one, so a step can run twice
without leaving `Leg.001` behind, and the live view can diff parts by name.

Conventions: metres, Z up, the model stands on z = 0 with its footprint centred
on the origin and its front facing -Y. Deliverable parts live in the `Export`
collection (or collections inside it); boolean cutters go to the hidden
`Cutters` collection; review cameras and lights never enter `Export`.
"""
import math
import random
import re

import bpy
import bmesh
import numpy
from mathutils import Matrix, Vector

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


def material(name, color, rough=0.8, metal=0.0, emission=0.0):
    """One material per name, reused on later calls. Sets the Principled BSDF for export and
    diffuse_color for Workbench, which the review sheet renders with."""
    name = _clean(name)
    rgb = _hex(color)
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
    child.parent = parent_ob
    child.matrix_parent_inverse = parent_ob.matrix_world.inverted()
    return child


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
