"""Small batch helpers. Coordinates in reports are Blender world space (Z up)."""
import argparse
import contextlib
import json
import math
import os
import sys

import bpy
import bmesh
import numpy
from mathutils import Vector


def export_objects(collection='Export'):
    group = bpy.data.collections.get(collection)
    if group is None:
        raise ValueError(f'Missing export collection: {collection}')
    return list(group.all_objects)


def _select(objects):
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.hide_set(False)
        obj.select_set(True)
    if objects:
        bpy.context.view_layer.objects.active = objects[0]


def _bakes_modifiers(obj):
    """The modifier rule shared by export, validate and preview: a mesh ships with
    its viewport modifiers applied unless it has shape keys (applying would destroy
    them). Armature modifiers always stay live so skinning survives."""
    return obj.type == 'MESH' and not obj.data.shape_keys and any(
        m.type != 'ARMATURE' and m.show_viewport for m in obj.modifiers)


def unapplied_modifiers(obj):
    """Non-armature modifiers that will not ship because the mesh has shape keys."""
    if obj.type != 'MESH' or not obj.data.shape_keys:
        return []
    return [m.name for m in obj.modifiers if m.type != 'ARMATURE' and m.show_viewport]


def _evaluated_meshes(objects):
    """New mesh datablocks from the evaluated depsgraph, Armature modifiers left out.
    The caller removes them."""
    paused = [m for o in objects for m in o.modifiers if m.type == 'ARMATURE' and m.show_viewport]
    for m in paused:
        m.show_viewport = False
    try:
        depsgraph = bpy.context.evaluated_depsgraph_get()
        return {o: bpy.data.meshes.new_from_object(o.evaluated_get(depsgraph),
            preserve_all_data_layers=True, depsgraph=depsgraph) for o in objects}
    finally:
        for m in paused:
            m.show_viewport = True


@contextlib.contextmanager
def shipped_meshes(objects, *, apply_modifiers=True):
    """Yield {mesh object: mesh datablock as it ships}. Baked meshes are temporary."""
    meshes = {o: o.data for o in objects if o.type == 'MESH'}
    baked = _evaluated_meshes([o for o in meshes if _bakes_modifiers(o)]) if apply_modifiers else {}
    try:
        yield {**meshes, **baked}
    finally:
        for mesh in baked.values():
            bpy.data.meshes.remove(mesh)


@contextlib.contextmanager
def modifiers_baked(objects, *, apply_modifiers=True, shipped=None):
    """Temporarily swap each baked mesh into its object and switch off the applied
    modifiers, so exporters and renders see exactly the shipped geometry. The scene
    is restored afterwards, including mesh names. `shipped` reuses meshes from an
    open shipped_meshes() instead of evaluating the modifiers again."""
    own = shipped_meshes(objects, apply_modifiers=apply_modifiers) if shipped is None else contextlib.nullcontext(shipped)
    with own as shipped:
        swapped = [(o, o.data, mesh) for o, mesh in shipped.items() if mesh is not o.data]
        names = {source: source.name for _, source, _ in swapped}
        toggled = []
        try:
            for obj, source, mesh in swapped:
                source.name = names[source] + ' (genio source)'
                mesh.name = names[source]
                obj.data = mesh
                for m in obj.modifiers:
                    if m.type != 'ARMATURE':
                        toggled.append((m, m.show_viewport, m.show_render))
                        m.show_viewport = m.show_render = False
            yield shipped
        finally:
            for m, viewport, render in toggled:
                m.show_viewport, m.show_render = viewport, render
            for obj, source, mesh in swapped:
                obj.data = source
                mesh.name = names[source] + ' (genio baked)'
            for source, name in names.items():
                source.name = name


def export(path, *, target, fmt, collection='Export', apply_modifiers=True):
    """apply_modifiers=False is the opt-out for rigs whose modifier stack must stay
    editable downstream: every mesh then ships as its base mesh."""
    if target not in ('unity', 'godot', 'web') or fmt not in ('fbx', 'glb'):
        raise ValueError('Explicit target unity|godot|web and fmt fbx|glb required')
    objects = export_objects(collection)
    if not any(o.type == 'MESH' for o in objects):
        raise ValueError('Export collection contains no meshes')
    _select(objects)
    path = os.path.abspath(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if apply_modifiers:
        for obj in objects:
            if unapplied_modifiers(obj):
                print(f'genio_bpy: {obj.name} has shape keys; modifiers not applied: '
                    f'{", ".join(unapplied_modifiers(obj))}', file=sys.stderr)
    # Modifiers are baked per mesh by modifiers_baked, so the exporters' own
    # all-or-nothing modifier switches stay off.
    with modifiers_baked(objects, apply_modifiers=apply_modifiers):
        if fmt == 'fbx':
            # Experimental space baking breaks rigs. Keep it off for all presets.
            axes = {'unity': ('-Z', 'Y'), 'godot': ('-Z', 'Y'), 'web': ('-Z', 'Y')}
            forward, up = axes[target]
            bpy.ops.export_scene.fbx(filepath=path, use_selection=True,
                object_types={'MESH', 'ARMATURE', 'EMPTY'}, axis_forward=forward, axis_up=up,
                global_scale=1.0, apply_unit_scale=True, apply_scale_options='FBX_SCALE_ALL',
                bake_space_transform=False, add_leaf_bones=False, use_mesh_modifiers=False,
                bake_anim=True, path_mode='AUTO')
        else:
            bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True,
                export_yup=True, export_apply=False, export_animations=True,
                export_skins=True, export_texcoords=True, export_normals=True,
                export_materials='EXPORT')
    return path


def apply_transforms(*, collection='Export'):
    objects = export_objects(collection)
    if any(o.type == 'ARMATURE' or (o.type == 'MESH' and o.find_armature()) for o in objects):
        raise ValueError('Apply transforms before rigging; rigged assets require a rig-specific workflow')
    _select([o for o in objects if o.type == 'MESH'])
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)


def decimate(ratio, *, collection='Export'):
    if not 0 < ratio <= 1:
        raise ValueError('ratio must be in (0, 1]')
    for obj in export_objects(collection):
        if obj.type != 'MESH':
            continue
        if obj.find_armature() or obj.data.shape_keys:
            raise ValueError('Decimate before rigging/shape keys')
        _select([obj])
        mod = obj.modifiers.new('Genio decimate', 'DECIMATE')
        mod.ratio = ratio
        bpy.ops.object.modifier_apply(modifier=mod.name)


def _load(path, collection='Export'):
    """Destructive to the batch scene only. Does not save or modify the input file."""
    path = os.path.abspath(path)
    ext = os.path.splitext(path)[1].lower()
    if ext == '.blend':
        bpy.ops.wm.open_mainfile(filepath=path)
        return export_objects(collection)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == '.glb':
        bpy.ops.import_scene.gltf(filepath=path)
    else:
        raise ValueError('Expected .blend, .fbx or .glb')
    group = bpy.data.collections.new(collection)
    bpy.context.scene.collection.children.link(group)
    for obj in list(bpy.context.scene.objects):
        group.objects.link(obj)
    return export_objects(collection)


def _bounds(shipped):
    """World-space bounds of {object: shipped mesh}, from vertices, not bound_box."""
    points = []
    for obj, mesh in shipped.items():
        co = numpy.empty(len(mesh.vertices) * 3, dtype=numpy.float64)
        mesh.vertices.foreach_get('co', co)
        matrix = numpy.array(obj.matrix_world)
        points.append(co.reshape(-1, 3) @ matrix[:3, :3].T + matrix[:3, 3])
    points = numpy.concatenate(points) if points else numpy.empty((0, 3))
    if not len(points):
        raise ValueError('No mesh vertices to inspect')
    return Vector(points.min(axis=0).tolist()), Vector(points.max(axis=0).tolist())


def validate(path=None, *, collection='Export', apply_modifiers=True):
    objects = _load(path, collection) if path else export_objects(collection)
    with shipped_meshes(objects, apply_modifiers=apply_modifiers) as shipped:
        return _validate(shipped, apply_modifiers)


def _ints(items, attr, n, width=1):
    out = numpy.empty(n * width, dtype=numpy.int32)
    items.foreach_get(attr, out)
    return out.reshape(-1, width) if width > 1 else out


def _shells(n, a, b):
    """Connected components of n nodes joined by the pairs (a[i], b[i]): per node, the smallest
    node of its component (hooking and pointer jumping, numpy only)."""
    label = numpy.arange(n)
    while True:
        la, lb = label[a], label[b]
        apart = la != lb
        if not apart.any():
            return label
        numpy.minimum.at(label, numpy.maximum(la[apart], lb[apart]), numpy.minimum(la[apart], lb[apart]))
        while True:
            up = label[label]
            if numpy.array_equal(up, label):
                break
            label = up


def _flipped_bmesh(mesh):
    """Faces that recalculated outward winding turns around, by bmesh (the slow, general way)."""
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.normal_update()
    before = {f: f.normal.copy() for f in bm.faces}
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    flipped = sum(before[f].dot(f.normal) < -0.5 for f in bm.faces)
    bm.free()
    return flipped


def _topology(mesh):
    """The validation's edge and face counts for one mesh, from its arrays (numpy): the same counts
    bmesh gave, without a Python loop per element (1.7 s of loops at 423k triangles)."""
    nv, ne, nf, nl = len(mesh.vertices), len(mesh.edges), len(mesh.polygons), len(mesh.loops)
    ev = _ints(mesh.edges, 'vertices', ne, 2)
    lv, le = _ints(mesh.loops, 'vertex_index', nl), _ints(mesh.loops, 'edge_index', nl)
    total = _ints(mesh.polygons, 'loop_total', nf)
    area = numpy.empty(nf, dtype=numpy.float32)
    mesh.polygons.foreach_get('area', area)
    faces = numpy.bincount(le, minlength=ne)
    # The two loops of each manifold edge; they run the same way along it when winding is inconsistent.
    two = numpy.nonzero(faces == 2)[0]
    at = (numpy.cumsum(faces) - faces)[two]
    order = numpy.argsort(le, kind='stable')
    first, second = order[at], order[at + 1]
    non_manifold = int((faces != 2).sum())
    inconsistent = int((lv[first] == lv[second]).sum())
    # Compare against consistent outward winding. For open surfaces outward is ambiguous, so report
    # only inconsistent adjacency there. A closed, consistent shell is outward when its volume is
    # positive, so it flips whole or not at all; anything else asks bmesh.
    flipped = None
    if not non_manifold and inconsistent:
        flipped = _flipped_bmesh(mesh)
    elif not non_manifold:
        poly = numpy.repeat(numpy.arange(nf), total)
        shell = _shells(nf, poly[first], poly[second])
        tri = _ints(mesh.loop_triangles, 'vertices', len(mesh.loop_triangles), 3)
        tri_poly = _ints(mesh.loop_triangles, 'polygon_index', len(mesh.loop_triangles))
        co = numpy.empty(nv * 3, dtype=numpy.float64)
        mesh.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3)
        if nv:
            co -= co.mean(axis=0)  # less cancellation far from the origin
        six = numpy.einsum('ij,ij->i', co[tri[:, 0]], numpy.cross(co[tri[:, 1]], co[tri[:, 2]]))
        volume = numpy.bincount(shell[tri_poly], weights=six, minlength=nf)
        scale = numpy.bincount(shell[tri_poly], weights=numpy.abs(six), minlength=nf)
        roots = numpy.unique(shell)
        if numpy.any(numpy.abs(volume[roots]) <= 1e-9 * scale[roots] + 1e-30):
            flipped = _flipped_bmesh(mesh)
        else:
            flipped = int(((volume < 0)[shell] & (area > 0)).sum())
    return {'non_manifold_edges': non_manifold, 'inconsistent_winding_edges': inconsistent, 'flipped_faces': flipped,
            'loose_vertices': int((numpy.bincount(ev.ravel(), minlength=nv) == 0).sum()),
            'loose_edges': int((faces == 0).sum()), 'ngons': int((total > 4).sum()),
            'degenerate_faces': int((area < 1e-12).sum())}


def _validate(shipped, apply_modifiers):
    lo, hi = _bounds(shipped)
    reports = []
    for obj, mesh in shipped.items():
        mesh.calc_loop_triangles()
        obj.data.calc_loop_triangles()
        origin = obj.matrix_world.translation
        obj_lo = _bounds({obj: mesh})[0] if mesh.vertices else origin
        report = {
            'name': obj.name, 'triangles': len(mesh.loop_triangles),
            'vertices': len(mesh.vertices), 'base_triangles': len(obj.data.loop_triangles),
            'modifiers_applied': mesh is not obj.data, 'unapplied_modifiers': unapplied_modifiers(obj),
            'materials': len(mesh.materials), 'has_uv': bool(mesh.uv_layers),
            'unapplied_rotation': any(abs(v) > 1e-5 for v in obj.rotation_euler),
            'unapplied_scale': any(abs(v - 1) > 1e-5 for v in obj.scale),
            'negative_determinant': obj.matrix_world.determinant() < 0,
            'origin': list(origin), 'origin_ground_distance': origin.z - obj_lo.z,
            'origin_at_ground': abs(origin.z - obj_lo.z) < 1e-4,
        }
        report.update(_topology(mesh))
        reports.append(report)
    return {'schema': 'genio.blender-validation.v2', 'coordinate_system': 'Blender world Z-up',
        'bounds': {'min': list(lo), 'max': list(hi)}, 'dimensions': list(hi - lo),
        'ground_z': lo.z, 'unit_scale_meters': bpy.context.scene.unit_settings.scale_length,
        'mesh_count': len(shipped), 'material_count': len({m for mesh in shipped.values() for m in mesh.materials if m}),
        'triangles': sum(r['triangles'] for r in reports), 'vertices': sum(r['vertices'] for r in reports),
        'base_triangles': sum(r['base_triangles'] for r in reports), 'modifiers_applied': apply_modifiers,
        'meshes': reports,
        'limitations': 'Geometry is the mesh as export() ships it: viewport modifiers applied except on meshes with shape keys, Armature modifiers left live (rest pose). Flipped faces are relative to recalculated winding for closed meshes; open surfaces have no unambiguous outside.'}


def preview(path, out, *, collection='Export', apply_modifiers=True):
    objects = _load(path, collection)
    with modifiers_baked(objects, apply_modifiers=apply_modifiers) as shipped:
        return _preview(objects, shipped, out)


def _preview(objects, shipped, out):
    lo, hi = _bounds(shipped)
    center = (lo + hi) / 2
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    included = set(objects)
    for obj in scene.objects:
        obj.hide_render = obj not in included
    camera = bpy.data.objects.new('Genio preview camera', bpy.data.cameras.new('Genio preview camera'))
    scene.collection.objects.link(camera)
    camera.location = center + Vector((1, -1, 0.8)).normalized() * max((hi - lo).length * 2, 1)
    camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = max((hi - lo).length * 1.2, 0.01)
    camera.data.clip_end = max((hi - lo).length * 10, 1000)
    scene.camera = camera
    scene.render.resolution_x = scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'MATERIAL'
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = os.path.abspath(out)
    os.makedirs(os.path.dirname(scene.render.filepath), exist_ok=True)
    bpy.ops.render.render(write_still=True)
    return scene.render.filepath


def convert(source, out, *, target, collection='Export', apply_modifiers=True):
    source_ext, out_ext = os.path.splitext(source)[1].lower(), os.path.splitext(out)[1].lower()
    if (source_ext, out_ext) not in (('.fbx', '.glb'), ('.glb', '.fbx')):
        raise ValueError('Conversion supports FBX to GLB or GLB to FBX')
    _load(source, collection)
    return export(out, target=target, fmt=out_ext[1:], collection=collection, apply_modifiers=apply_modifiers)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    for command in ('export', 'validate', 'preview', 'convert', 'apply-transforms', 'decimate'):
        p = sub.add_parser(command)
        p.add_argument('input')
        p.add_argument('--collection', default='Export')
        if command in ('export', 'validate', 'preview', 'convert'):
            p.add_argument('--keep-modifiers', dest='apply_modifiers', action='store_false',
                help='Ship base meshes: do not apply modifiers (rig opt-out)')
        if command != 'validate':
            p.add_argument('output')
        if command in ('export', 'convert'):
            p.add_argument('--target', required=True, choices=('unity', 'godot', 'web'))
        if command == 'export':
            p.add_argument('--fmt', required=True, choices=('fbx', 'glb'))
        if command == 'decimate':
            p.add_argument('--ratio', required=True, type=float)
        if command == 'validate':
            p.add_argument('--out', help='Write JSON report here (stdout also contains Blender diagnostics)')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    kw = {'collection': args.collection}
    if args.command in ('export', 'validate', 'preview', 'convert'):
        kw['apply_modifiers'] = args.apply_modifiers
    if args.command == 'validate':
        result = validate(args.input, **kw)
        if args.out:
            with open(args.out, 'w', encoding='utf8') as f:
                json.dump(result, f, indent=2)
    elif args.command == 'preview':
        result = preview(args.input, args.output, **kw)
    elif args.command == 'convert':
        result = convert(args.input, args.output, target=args.target, **kw)
    else:
        _load(args.input, args.collection)
        if args.command == 'export':
            result = export(args.output, target=args.target, fmt=args.fmt, **kw)
        else:
            if not args.output.lower().endswith('.blend'):
                raise ValueError('Cleanup output must be .blend; export it explicitly afterward')
            if args.command == 'decimate':
                decimate(args.ratio, **kw)
            else:
                apply_transforms(**kw)
            bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.output))
            result = args.output
    print(json.dumps(result))


if __name__ == '__main__':
    main()
