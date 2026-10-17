"""Modeller part helpers: data-API primitives that behave the same on Blender 4.2 and 5.x.

Step scripts get this module preloaded as `p` (and `bpy`). Nothing here needs
bpy.ops or a UI context, so nothing fails a poll in background mode. Every part
is named: building a part again replaces the old one, so a step can run twice
without leaving `Leg.001` behind, and the live view can diff parts by name.

Conventions: metres, Z up, the model stands on z = 0 with its footprint centred
on the origin and its front facing -Y. Deliverable parts live in the `Export`
collection (or collections inside it); boolean cutters go to the hidden
`Cutters` collection; review cameras and lights never enter `Export`.

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
        glow = (tuple(old.inputs['Emission Color'].default_value), old.inputs['Emission Strength'].default_value) if old else None
        self.nt.nodes.clear()
        out = self.nt.nodes.new('ShaderNodeOutputMaterial')
        self.bsdf = self.nt.nodes.new('ShaderNodeBsdfPrincipled')
        self.nt.links.new(self.bsdf.outputs['BSDF'], out.inputs['Surface'])
        if glow:
            self.bsdf.inputs['Emission Color'].default_value, self.bsdf.inputs['Emission Strength'].default_value = glow
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
    camo_spec, wear_spec = spec.get('camo'), spec.get('weathering')
    rough, metal = mat.roughness, mat.metallic
    base = (*mat.diffuse_color[:3], 1.0)
    g = _Graph(mat)
    P = g.P
    s = (camo_spec or wear_spec)['scale']  # pattern size; the weathering keeps its own
    lines = 0.0
    if camo_spec:
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
    r = g.lerp(g.noise(P, 4.0 / s), max(rough - 0.1, 0.0), min(rough + 0.12, 1.0))
    m = metal
    if wear_spec:
        lines = max(lines, wear_spec['panel_lines'])
    if lines:
        c = g.panel_lines(c, lines, s)
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
