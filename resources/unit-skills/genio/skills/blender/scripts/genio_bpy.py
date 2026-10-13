"""Small batch helpers. Coordinates in reports are Blender world space (Z up)."""
import argparse
import json
import math
import os
import sys

import bpy
import bmesh
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


def export(path, *, target, fmt, collection='Export'):
    if target not in ('unity', 'godot', 'web') or fmt not in ('fbx', 'glb'):
        raise ValueError('Explicit target unity|godot|web and fmt fbx|glb required')
    objects = export_objects(collection)
    if not any(o.type == 'MESH' for o in objects):
        raise ValueError('Export collection contains no meshes')
    _select(objects)
    path = os.path.abspath(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if fmt == 'fbx':
        # Experimental space baking breaks rigs. Keep it off for all presets.
        axes = {'unity': ('-Z', 'Y'), 'godot': ('-Z', 'Y'), 'web': ('-Z', 'Y')}
        forward, up = axes[target]
        bpy.ops.export_scene.fbx(filepath=path, use_selection=True,
            object_types={'MESH', 'ARMATURE', 'EMPTY'}, axis_forward=forward, axis_up=up,
            global_scale=1.0, apply_unit_scale=True, apply_scale_options='FBX_SCALE_ALL',
            bake_space_transform=False, add_leaf_bones=False, use_mesh_modifiers=True,
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


def _bounds(objects):
    points = [o.matrix_world @ Vector(c) for o in objects if o.type == 'MESH' for c in o.bound_box]
    if not points:
        raise ValueError('No meshes to inspect')
    lo = Vector([min(p[i] for p in points) for i in range(3)])
    hi = Vector([max(p[i] for p in points) for i in range(3)])
    return lo, hi


def validate(path=None, *, collection='Export'):
    objects = _load(path, collection) if path else export_objects(collection)
    meshes = [o for o in objects if o.type == 'MESH']
    lo, hi = _bounds(objects)
    reports = []
    for obj in meshes:
        mesh = obj.data
        mesh.calc_loop_triangles()
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bm.normal_update()
        non_manifold = sum(not e.is_manifold for e in bm.edges)
        inconsistent = sum(e.is_manifold and not e.is_contiguous for e in bm.edges)
        # Compare against consistent outward winding. For open surfaces outward
        # is ambiguous, so report only inconsistent adjacency there.
        before = {f: f.normal.copy() for f in bm.faces}
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        flipped = sum(before[f].dot(f.normal) < -0.5 for f in bm.faces) if non_manifold == 0 else None
        obj_lo, _ = _bounds([obj])
        origin = obj.matrix_world.translation
        report = {
            'name': obj.name, 'triangles': len(mesh.loop_triangles),
            'materials': len(mesh.materials), 'has_uv': bool(mesh.uv_layers),
            'unapplied_rotation': any(abs(v) > 1e-5 for v in obj.rotation_euler),
            'unapplied_scale': any(abs(v - 1) > 1e-5 for v in obj.scale),
            'negative_determinant': obj.matrix_world.determinant() < 0,
            'origin': list(origin), 'origin_ground_distance': origin.z - obj_lo.z,
            'origin_at_ground': abs(origin.z - obj_lo.z) < 1e-4,
            'non_manifold_edges': non_manifold, 'inconsistent_winding_edges': inconsistent,
            'flipped_faces': flipped, 'loose_vertices': sum(not v.link_edges for v in bm.verts),
            'loose_edges': sum(not e.link_faces for e in bm.edges),
            'ngons': sum(len(f.verts) > 4 for f in bm.faces),
            'degenerate_faces': sum(f.calc_area() < 1e-12 for f in bm.faces),
        }
        reports.append(report)
        bm.free()
    return {'schema': 'genio.blender-validation.v1', 'coordinate_system': 'Blender world Z-up',
        'bounds': {'min': list(lo), 'max': list(hi)}, 'dimensions': list(hi - lo),
        'ground_z': lo.z, 'unit_scale_meters': bpy.context.scene.unit_settings.scale_length,
        'mesh_count': len(meshes), 'material_count': len({m for o in meshes for m in o.data.materials if m}),
        'triangles': sum(r['triangles'] for r in reports), 'meshes': reports,
        'limitations': 'Base mesh topology; modifiers not evaluated. Flipped faces are relative to recalculated winding for closed meshes; open surfaces have no unambiguous outside.'}


def preview(path, out, *, collection='Export'):
    objects = _load(path, collection)
    lo, hi = _bounds(objects)
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


def convert(source, out, *, target, collection='Export'):
    source_ext, out_ext = os.path.splitext(source)[1].lower(), os.path.splitext(out)[1].lower()
    if (source_ext, out_ext) not in (('.fbx', '.glb'), ('.glb', '.fbx')):
        raise ValueError('Conversion supports FBX to GLB or GLB to FBX')
    _load(source, collection)
    return export(out, target=target, fmt=out_ext[1:], collection=collection)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    for command in ('export', 'validate', 'preview', 'convert', 'apply-transforms', 'decimate'):
        p = sub.add_parser(command)
        p.add_argument('input')
        p.add_argument('--collection', default='Export')
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
