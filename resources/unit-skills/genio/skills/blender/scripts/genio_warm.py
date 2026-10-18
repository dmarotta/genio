"""Fill the bytecode cache before a Modeller's first step. modeller.mjs runs this; agents do not.

It imports what genio_step.py imports (bpy, numpy, mathutils and the helper modules), builds one box,
exports it through the GLB preset (so the glTF exporter's modules compile too) and runs the step checks.
The only argument after `--` is the marker file it writes when done.
"""
import os
import sys
import tempfile

import bpy

import genio_bpy
import genio_parts as p
import genio_step


def main():
    marker = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    p.collection(p.EXPORT)
    p.box('Warm', (1.0, 1.0, 1.0), loc=(0.0, 0.0, 0.5), mat=p.material('Warm', '#808080'))
    with tempfile.TemporaryDirectory() as tmp:
        genio_bpy.export(os.path.join(tmp, 'warm.glb'), target='web', fmt='glb')
    genio_step.inspect_model({})
    with open(marker, 'w', encoding='utf8') as f:
        f.write(bpy.app.version_string)


if __name__ == '__main__':
    main()
