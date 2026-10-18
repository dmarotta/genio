"""Test fixture: references with a known answer, made from the starship in the open .blend.

Args after --: <out dir>. Writes two reference folders as Genio stages them (images and references.json):
  planted/  front, side and top silhouettes of the ship with the Saucer 12 % wider (its children with it),
            the Engineering hull 0.5 m lower and the Neck gone, each tagged with its view and its span
  whole/    the ship as it is: the side view mirrored (bow to the right), no spans (the brief's size
            scales them), and an untagged notes file
and answer.json: the planted saucer growth in x and y, in metres.
"""
import json
import os
import sys

import bpy
import numpy
from mathutils import Matrix

import genio_parts as p
import genio_refmatch as rm

out = sys.argv[sys.argv.index('--') + 1]
blend = bpy.data.filepath


def entry(file, **extra):
    return {'file': file, 'source': 'test', 'bytes': 1, 'type': 'image' if file.endswith('.png') else 'text', 'addedAt': '', **extra}


def write(folder, entries):
    with open(os.path.join(out, folder, 'references.json'), 'w', encoding='utf8') as f:
        json.dump(entries, f)


for folder in ('planted', 'whole'):
    os.makedirs(os.path.join(out, folder), exist_ok=True)

saucer, hull = p.part('Saucer'), p.part('Engineering hull')
lo, hi = rm._frame([saucer])
answer = {'saucer_x': float(hi[0] - lo[0]) * 0.12, 'saucer_y': float(hi[1] - lo[1]) * 0.12, 'hull_z': 0.5}
c = saucer.matrix_world.translation.copy()
saucer.matrix_world = Matrix.Translation(c) @ Matrix.Diagonal((1.12, 1.12, 1, 1)) @ Matrix.Translation(-c) @ saucer.matrix_world
hull.location.z -= 0.5
p.remove('Neck')
bpy.context.view_layer.update()
planted = []
for view in ('front', 'side', 'top'):
    path = os.path.join(out, 'planted', f'planted_{view}.png')
    frame = rm.render_reference(path, view)
    # span: metres across the shape, left to right (the frame is RES px across)
    planted.append(entry(os.path.basename(path), view=view, span=frame * rm.shape_of(path).shape[1] / rm.RES))
write('planted', planted)

bpy.ops.wm.open_mainfile(filepath=blend)
whole = []
for view in ('front', 'side', 'top'):
    path = os.path.join(out, 'whole', f'whole_{view}.png')
    rm.render_reference(path, view)
    whole.append(entry(os.path.basename(path), view=view))
img = bpy.data.images.load(os.path.join(out, 'whole', 'whole_side.png'))
px = numpy.empty(img.size[0] * img.size[1] * 4, dtype=numpy.float32)
img.pixels.foreach_get(px)
img.pixels.foreach_set(px.reshape(img.size[1], img.size[0], 4)[:, ::-1].ravel())
img.save()
with open(os.path.join(out, 'whole', 'notes.md'), 'w', encoding='utf8') as f:
    f.write('A classic starship.\n')
write('whole', whole + [entry('notes.md', note='what it is')])
with open(os.path.join(out, 'answer.json'), 'w', encoding='utf8') as f:
    json.dump(answer, f)
