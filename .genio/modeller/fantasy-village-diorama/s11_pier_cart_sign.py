"""Adding a fishing pier on the pond, a hay cart by the windmill and a signpost at the square"""
import math
import bpy

TOP = 0.195
timber = p.material('Timber', '#6b4a2f', rough=0.85)
wood = p.material('WoodLight', '#9a6b42', rough=0.85)
hay = p.material('Hay', '#e2c25f', rough=1.0)
iron = p.material('Iron', '#3a3a3e', rough=0.6, metal=0.6)
plaster = p.material('Plaster', '#efe3c8', rough=0.9)


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


col = p.collection('props')

# fishing pier from the front bank out over the pond
PX, Y0, Y1, PZ = 0.44, -0.71, -0.53, TOP + 0.022
deck = [p.box(f'pier_plank{i}', (0.056, 0.016, 0.006), loc=(PX, Y0 + 0.01 + i * 0.019, PZ), mat=wood, col=col)
        for i in range(10)]
pier = join('pier', deck)
p.origin_to_base(pier)
legs = [p.cylinder(f'pier_leg{i}', 0.006, 0.03, loc=(PX + sx * 0.024, y, TOP + 0.01), mat=timber, segments=6, col=col)
        for i, (sx, y) in enumerate([(-1, -0.6), (1, -0.6), (-1, -0.54), (1, -0.54)])]
legs.append(p.beam('pier_rod', (PX + 0.02, -0.56, PZ + 0.005), (PX + 0.07, -0.47, PZ + 0.07), 0.003, timber, col=col))
legs.append(p.beam('pier_line', (PX + 0.07, -0.47, PZ + 0.07), (PX + 0.075, -0.45, TOP + 0.012), 0.0012, plaster, col=col))
p.parent(join('pier_posts', legs), pier)

# hay cart: bed, wheels, shafts and a pile of hay
CX, CY, YAW = -0.36, 0.6, 0.4
cart = p.box('cart', (0.085, 0.05, 0.012), loc=(0, 0, 0.035), mat=wood, col=col)
p.origin_to_base(cart)
bits = [p.box('cart_side_l', (0.085, 0.004, 0.02), loc=(0, 0.023, 0.05), mat=timber, col=col),
        p.box('cart_side_r', (0.085, 0.004, 0.02), loc=(0, -0.023, 0.05), mat=timber, col=col),
        p.cylinder('cart_axle', 0.003, 0.07, loc=(0, 0, 0.022), rot=(math.pi / 2, 0, 0), mat=iron, segments=6, col=col),
        p.beam('cart_shaft_l', (0.04, 0.018, 0.035), (0.11, 0.018, 0.006), 0.005, timber, col=col),
        p.beam('cart_shaft_r', (0.04, -0.018, 0.035), (0.11, -0.018, 0.006), 0.005, timber, col=col)]
for s in (-1, 1):
    bits.append(p.cylinder(f'cart_wheel{s}', 0.022, 0.006, loc=(0, s * 0.031, 0.022), rot=(math.pi / 2, 0, 0),
                           mat=timber, segments=10, col=col))
p.parent(join('cart_frame', bits), cart)
pile = p.sphere('cart_hay', 0.04, loc=(0, 0, 0.055), mat=hay, subdiv=1, col=col)
pile.scale = (1.0, 0.6, 0.5)
p.apply_scale(pile)
p.jitter(pile, 0.004, 77)
p.parent(pile, cart)
cart.location = (CX, CY, TOP)
cart.rotation_euler = (0, 0, YAW)

# signpost at the square pointing to the tavern, the mill and the bridge
SX, SY = 0.22, -0.13
post = p.box('signpost', (0.01, 0.01, 0.12), loc=(SX, SY, TOP + 0.06), mat=timber, col=col)
p.origin_to_base(post)
boards = []
for i, (tx, ty, z) in enumerate([(-0.12, 0.57, 0.105), (-0.6, 0.5, 0.085), (0.485, 0.135, 0.065)]):
    a = math.atan2(ty - SY, tx - SX)
    boards.append(p.prism(f'sign_board{i}', [(0, -0.009), (0.05, -0.009), (0.06, 0), (0.05, 0.009), (0, 0.009)], 0.004,
                          loc=(SX, SY, TOP + z), rot=(math.pi / 2, 0, a), mat=wood, col=col))
p.parent(join('signpost_boards', boards), post)
