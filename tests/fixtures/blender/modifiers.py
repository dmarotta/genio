"""Build a modifier test scene, export it and write independent facts as JSON.

Usage (after --): <scenario> <facts.json>, scenario is bevel-array, shape-keys or rig.
Exports <scenario>.glb, <scenario>.fbx and <scenario>.blend into the working directory.
"""
import json
import os
import sys

import bpy
import genio_bpy as g

scenario, facts_path = sys.argv[sys.argv.index('--') + 1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
export = bpy.data.collections.new('Export')
bpy.context.scene.collection.children.link(export)


def cube(name):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([(x, y, z) for x in (-1, 1) for y in (-1, 1) for z in (0, 2)], [],
        [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)])
    mesh.update()
    mesh.uv_layers.new()
    obj = bpy.data.objects.new(name, mesh)
    export.objects.link(obj)
    return obj


def bevel_array(obj):
    bevel = obj.modifiers.new('Bevel', 'BEVEL')
    bevel.width, bevel.segments = 0.1, 2
    array = obj.modifiers.new('Array', 'ARRAY')
    array.count = 3
    return obj


obj = bevel_array(cube('Tower'))
if scenario == 'shape-keys':
    obj.shape_key_add(name='Basis')
    key = obj.shape_key_add(name='Tall')
    for point in key.data:
        point.co.z *= 1.5
elif scenario == 'rig':
    armature = bpy.data.objects.new('Rig', bpy.data.armatures.new('Rig'))
    export.objects.link(armature)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode='EDIT')
    bone = armature.data.edit_bones.new('Root')
    bone.head, bone.tail = (0, 0, 0), (0, 0, 1)
    bpy.ops.object.mode_set(mode='OBJECT')
    obj.parent = armature
    group = obj.vertex_groups.new(name='Root')
    group.add(range(len(obj.data.vertices)), 1.0, 'REPLACE')
    obj.modifiers.new('Armature', 'ARMATURE').object = armature
elif scenario != 'bevel-array':
    raise ValueError(f'Unknown scenario {scenario}')

depsgraph = bpy.context.evaluated_depsgraph_get()
evaluated = obj.evaluated_get(depsgraph).to_mesh()
evaluated.calc_loop_triangles()
obj.data.calc_loop_triangles()
before = {'mesh': obj.data.name, 'meshes': len(bpy.data.meshes),
    'modifiers': [(m.name, m.show_viewport, m.show_render) for m in obj.modifiers]}
facts = {'base_triangles': len(obj.data.loop_triangles), 'evaluated_triangles': len(evaluated.loop_triangles),
    'evaluated_vertices': len(evaluated.vertices)}
obj.evaluated_get(depsgraph).to_mesh_clear()

g.export(f'{scenario}.glb', target='web', fmt='glb')
g.export(f'{scenario}.fbx', target='unity', fmt='fbx')
facts['validation'] = g.validate()
after = {'mesh': obj.data.name, 'meshes': len(bpy.data.meshes),
    'modifiers': [(m.name, m.show_viewport, m.show_render) for m in obj.modifiers]}
facts['scene_restored'] = before == after
facts['version'] = list(bpy.app.version)
bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(f'{scenario}.blend'))
with open(facts_path, 'w', encoding='utf8') as f:
    json.dump(facts, f, indent=2)
