"""Stylised character plan (hero, knight, robot, creature on two legs): proportions in head heights, in an A-pose,
facing the front (-Y). Change the parts, sizes and places to the brief's.

Steps: 1 p.blockout(PLAN); 2 torso and pelvis (p.hull or p.loft); 3 head (p.sphere or p.revolve; the face's
features as parts); 4 arms and legs (p.capsule or p.sweep), mirrored; 5 hands and feet; 6 clothes, armour and
hair as parts of their own; 7 paint, one bake. Name every limb with its side (Arm upper L).
Triangles: low-poly 1-5k, mid 8-20k.
Proportions: 6 heads tall (3 to 4 for chibi), shoulders 2 heads wide, the hands reach mid-thigh, the legs are
half the height. Realistic characters are not built from primitives.
init gave the model --symmetry x: an L part with mirror=True plans its R twin.
"""
SKIN = p.material('Skin', '#e0ac69')
CLOTH = p.material('Cloth', '#3d5a80')
BOOT = p.material('Boot', '#3b2a20')
H = 0.3  # one head height: six of them make 1.8 m

PLAN = p.plan({
    'Head': dict(at=(0, 0, 5.45 * H), size=(0.8 * H, 0.9 * H, H), shape='sphere', mat=SKIN),
    'Torso': dict(at=(0, 0, 4.0 * H), size=(1.6 * H, 0.9 * H, 2.0 * H), shape='capsule', axis='z', mat=CLOTH),
    'Pelvis': dict(at=(0, 0, 2.95 * H), size=(1.3 * H, 0.8 * H, 0.6 * H), mat=CLOTH),
    'Arm upper L': dict(ends=((0.75 * H, 0, 4.7 * H), (1.25 * H, 0, 3.75 * H)), size=0.32 * H, shape='capsule', mirror=True, mat=CLOTH),
    'Arm lower L': dict(ends=((1.25 * H, 0, 3.75 * H), (1.65 * H, 0, 2.8 * H)), size=0.27 * H, shape='capsule', mirror=True, mat=SKIN),
    'Leg upper L': dict(ends=((0.35 * H, 0, 2.85 * H), (0.4 * H, 0, 1.5 * H)), size=0.45 * H, shape='capsule', mirror=True, mat=CLOTH),
    'Leg lower L': dict(ends=((0.4 * H, 0, 1.5 * H), (0.42 * H, 0, 0.15 * H)), size=0.38 * H, shape='capsule', mirror=True, mat=CLOTH),
    'Foot L': dict(at=(0.42 * H, -0.2 * H, 0.1 * H), size=(0.4 * H, 0.9 * H, 0.2 * H), mirror=True, mat=BOOT),
})
