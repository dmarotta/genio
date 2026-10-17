"""Polishing: rocks set in the soil edge, grass tufts, wildflowers, lily pads and reeds"""
import math
import random
import bpy

TOP = 0.195
rock_mat = p.material('Rock', '#8e8e88', rough=0.95)
tuft_mat = p.material('GrassTuft', '#7fb653', rough=0.9)
reed_mat = p.material('Reed', '#5c8a3a', rough=0.9)
lily = p.material('LilyPad', '#4f9a45', rough=0.7)
petals = [p.material('FlowerPink', '#e88ab0', rough=0.8), p.material('FlowerYellow', '#f2d04b', rough=0.8),
          p.material('FlowerWhite', '#f4f1ea', rough=0.8)]


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


# rocks bedded into the soil edge of the plinth
rocks = []
rng = random.Random(3)
for i in range(14):
    a = i * (2 * math.pi / 14) + rng.uniform(-0.15, 0.15)
    r = rng.uniform(0.028, 0.045)
    rk = p.sphere(f'rim_rock_{i:02d}', r, loc=(0.985 * math.cos(a), 0.985 * math.sin(a), rng.uniform(0.05, 0.12)),
                  mat=rock_mat, subdiv=1, col=p.collection('Base'))
    rk.scale = (0.6, 1.3, 0.8)
    rk.rotation_euler = (0, 0, a)
    p.apply_scale(rk)
    p.jitter(rk, r * 0.15, 60 + i)
    rocks.append(rk)
p.parent(join('base_rim_rocks', rocks), bpy.data.objects['base_plinth'])

# keep scatter off buildings, paths, water and the garden
blocked = [(-0.38, -0.22, 0.15), (-0.31, -0.62, 0.14), (0.24, 0.45, 0.15), (0.78, 0.33, 0.13), (0.78, -0.13, 0.13),
           (-0.7, -0.02, 0.12), (-0.12, 0.57, 0.24), (-0.6, 0.5, 0.15), (0.0, -0.02, 0.22), (0.42, -0.42, 0.29),
           (-0.67, -0.365, 0.14), (0.485, 0.135, 0.15), (0.1, 0.47, 0.07), (-0.17, -0.53, 0.05)]
for pts, w in [([(-0.02, -0.87), (0.06, -0.7), (-0.06, -0.45), (0.0, -0.2), (-0.1, 0.22), (-0.12, 0.36)], 0.09),
               ([(-0.12, 0.05), (-0.35, 0.12), (-0.5, 0.28)], 0.07), ([(0.14, 0.04), (0.37, 0.12), (0.6, 0.15), (0.76, 0.1)], 0.07),
               ([(0.36, 0.78), (0.5, 0.62), (0.56, 0.42), (0.48, 0.14), (0.5, -0.12), (0.46, -0.3)], 0.1)]:
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        for k in range(6):
            t = k / 5
            blocked.append((ax + (bx - ax) * t, ay + (by - ay) * t, w))


def free(x, y):
    if math.hypot(x, y) > 0.9:
        return False
    return all(math.hypot(x - bx, y - by) > br for bx, by, br in blocked)


def scatter(n, seed):
    rng = random.Random(seed)
    out = []
    while len(out) < n:
        x, y = rng.uniform(-0.9, 0.9), rng.uniform(-0.9, 0.9)
        if free(x, y):
            out.append((x, y))
            blocked.append((x, y, 0.025))
    return out


plants = p.collection('plants')
blades = []
for i, (x, y) in enumerate(scatter(55, 11)):
    for j in range(3):
        a = j * 2.1 + i
        blades.append(p.cylinder(f'tuft_{i:02d}_{j}', 0.006, 0.03, loc=(x + 0.006 * math.cos(a), y + 0.006 * math.sin(a), TOP + 0.013),
                                 rot=(0.25 * math.cos(a), 0.25 * math.sin(a), a), mat=tuft_mat, segments=3, radius_top=0.0, col=plants))
join('grass_tufts', blades)

flowers = []
for i, (x, y) in enumerate(scatter(36, 23)):
    flowers.append(p.sphere(f'flower_{i:02d}', 0.008, loc=(x, y, TOP + 0.012), mat=petals[i % 3], subdiv=1, col=plants))
    flowers.append(p.cylinder(f'flower_{i:02d}_stem', 0.002, 0.012, loc=(x, y, TOP + 0.006), mat=reed_mat, segments=3, col=plants))
join('wildflowers', flowers)

pads = [p.cylinder(f'lily_{i}', r, 0.003, loc=(x, y, TOP + 0.013), mat=lily, segments=7, col=plants)
        for i, (x, y, r) in enumerate([(0.36, -0.36, 0.022), (0.5, -0.5, 0.018), (0.45, -0.33, 0.014), (0.33, -0.5, 0.016)])]
pads.append(p.sphere('lily_flower', 0.006, loc=(0.36, -0.36, TOP + 0.018), mat=petals[0], subdiv=1, col=plants))
join('lily_pads', pads)

reeds = []
for i in range(9):
    a = -2.2 + i * 0.16
    x, y = 0.42 + 0.235 * math.cos(a), -0.42 + 0.235 * math.sin(a)
    h = 0.05 + 0.02 * (i % 3)
    reeds.append(p.cylinder(f'reed_{i}', 0.003, h, loc=(x, y, TOP + h / 2), rot=(0.1 * math.sin(i), 0.1 * math.cos(i), 0),
                            mat=reed_mat, segments=4, radius_top=0.0, col=plants))
join('reeds', reeds)
