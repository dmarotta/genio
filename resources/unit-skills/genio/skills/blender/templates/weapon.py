"""Weapon plan (rifle, pistol, sword, axe, launcher): change the parts, sizes and places to the brief's. The muzzle
or tip points to the front (-Y); a sword or axe stands on its pommel.

Steps: 1 p.blockout(PLAN); 2 body or receiver (p.box with a bevel, p.prism for a side profile); 3 barrel or blade
(p.revolve for a barrel, p.prism or p.loft for a blade); 4 grip, stock, magazine; 5 cuts and holes
(p.boolean_cut), then p.freeze; 6 sights, rails, bolts (p.array, p.greebles); 7 paint, one bake.
Triangles: low-poly 500-3k, mid 5-20k.
Sizes in metres (wide x long x tall): rifle 0.07 x 1.0 x 0.25; pistol 0.035 x 0.2 x 0.14; sword 0.25 x 0.05 x 1.0.
"""
STEEL = p.material('Steel', '#3c3f44', preset='brushed')
POLYMER = p.material('Polymer', '#26282b', rough=0.7)

PLAN = p.plan({
    'Receiver': dict(at=(0, 0, 0.17), size=(0.06, 0.34, 0.09), mat=STEEL),
    'Barrel': dict(at=(0, -0.35, 0.18), size=(0.025, 0.36, 0.025), shape='cylinder', mat=STEEL),
    'Stock': dict(at=(0, 0.33, 0.15), size=(0.05, 0.32, 0.12), mat=POLYMER),
    'Grip': dict(at=(0, 0.1, 0.07), size=(0.04, 0.06, 0.12), mat=POLYMER),
    'Magazine': dict(at=(0, -0.05, 0.065), size=(0.03, 0.07, 0.13), mat=POLYMER),
})
