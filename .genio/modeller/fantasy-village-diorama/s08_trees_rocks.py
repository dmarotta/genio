"""Planting round trees and pines, bushes, and scattering rocks"""
import math
import bpy

TOP = 0.195
bark = p.material('Bark', '#5a3d27', rough=0.95)
leaf_a = p.material('LeafDeep', '#4f8a3a', rough=0.9)
leaf_b = p.material('LeafLight', '#6aa84f', rough=0.9)
pine = p.material('Pine', '#2f6b45', rough=0.9)
bush_mat = p.material('Bush', '#5a9a40', rough=0.9)
rock_mat = p.material('Rock', '#8e8e88', rough=0.95)


def drop(name):
    ob = bpy.data.objects.get(name)
    if ob:
        bpy.data.objects.remove(ob, do_unlink=True)


def join(name, objs):
    drop(name)
    keep = objs[0]
    with bpy.context.temp_override(active_object=keep, object=keep, selected_objects=objs,
                                   selected_editable_objects=objs):
        bpy.ops.object.join()
    keep.name = name
    keep.data.name = name
    return keep


trees = p.collection('trees')


def round_tree(tag, x, y, s, mat, seed):
    s *= 1.35
    trunk = p.cylinder(tag, 0.013 * s, 0.08 * s, loc=(x, y, TOP + 0.04 * s), mat=bark, segments=6,
                       radius_top=0.009 * s, col=trees)
    p.origin_to_base(trunk)
    blobs = [p.sphere(f'{tag}_c0', 0.07 * s, loc=(x, y, TOP + 0.13 * s), mat=mat, subdiv=1, col=trees),
             p.sphere(f'{tag}_c1', 0.045 * s, loc=(x + 0.04 * s, y - 0.02 * s, TOP + 0.1 * s), mat=mat, subdiv=1, col=trees),
             p.sphere(f'{tag}_c2', 0.04 * s, loc=(x - 0.035 * s, y + 0.02 * s, TOP + 0.175 * s), mat=mat, subdiv=1, col=trees)]
    for i, b in enumerate(blobs):
        p.jitter(b, 0.007 * s, seed + i)
    p.parent(join(f'{tag}_canopy', blobs), trunk)


def pine_tree(tag, x, y, s, seed):
    s *= 1.35
    trunk = p.cylinder(tag, 0.011 * s, 0.06 * s, loc=(x, y, TOP + 0.03 * s), mat=bark, segments=6, col=trees)
    p.origin_to_base(trunk)
    tiers = []
    for i, (r, z) in enumerate([(0.065, 0.05), (0.05, 0.1), (0.034, 0.145)]):
        t = p.cylinder(f'{tag}_t{i}', r * s, 0.08 * s, loc=(x, y, TOP + (z + 0.04) * s), mat=pine, segments=7,
                       radius_top=0.0, rot=(0, 0, seed + i * 0.4), col=trees)
        tiers.append(t)
    p.parent(join(f'{tag}_needles', tiers), trunk)


round_tree('tree_01', 0.05, 0.82, 1.0, leaf_a, 1)
round_tree('tree_02', -0.42, 0.75, 1.1, leaf_b, 4)
round_tree('tree_03', 0.72, -0.5, 0.9, leaf_a, 7)
round_tree('tree_04', -0.82, 0.22, 0.95, leaf_b, 10)
round_tree('tree_05', 0.3, -0.8, 0.8, leaf_b, 13)
pine_tree('pine_01', 0.22, 0.8, 1.1, 0.3)
pine_tree('pine_02', -0.2, 0.84, 1.25, 0.9)
pine_tree('pine_03', -0.5, -0.75, 1.0, 1.7)

# bushes: two or three lumpy balls each
for i, (x, y, s) in enumerate([(-0.25, -0.37, 1.0), (0.34, 0.6, 0.9), (0.86, -0.3, 0.8), (-0.33, 0.38, 1.0),
                               (0.15, -0.26, 0.8), (-0.2, -0.86, 0.9), (0.62, 0.72, 0.9)]):
    balls = [p.sphere(f'bush_{i + 1:02d}_a', 0.028 * s, loc=(x, y, TOP + 0.018 * s), mat=bush_mat, subdiv=1, col=trees),
             p.sphere(f'bush_{i + 1:02d}_b', 0.022 * s, loc=(x + 0.026 * s, y + 0.008, TOP + 0.014 * s), mat=bush_mat, subdiv=1, col=trees)]
    for j, b in enumerate(balls):
        p.jitter(b, 0.004, i * 3 + j)
    bush = join(f'bush_{i + 1:02d}', balls)
    p.origin_to_base(bush)

# rocks: squashed, jittered low-poly lumps
rocks = p.collection('rocks')
for i, (x, y, r, rz) in enumerate([(0.68, -0.28, 0.03, 0.3), (0.66, -0.64, 0.035, 1.1), (0.33, 0.85, 0.03, 0.7),
                                   (0.43, 0.83, 0.022, 2.0), (-0.1, -0.62, 0.022, 0.5), (0.62, -0.02, 0.025, 1.4),
                                   (-0.86, -0.12, 0.03, 2.4), (-0.05, 0.4, 0.018, 0.2)]):
    rk = p.sphere(f'rock_{i + 1:02d}', r, loc=(x, y, TOP + r * 0.35), mat=rock_mat, subdiv=1, col=rocks)
    rk.scale = (1.25, 1.0, 0.7)
    rk.rotation_euler = (0, 0, rz)
    p.apply_scale(rk)
    p.jitter(rk, r * 0.15, 20 + i)
    p.origin_to_base(rk)
