"""Building plan (house, tower, shop, hangar, ruin): change the parts, sizes and places to the brief's.

Steps: 1 p.blockout(PLAN); 2 walls with openings (p.box, p.boolean_cut; p.array for storeys); 3 roof (p.prism
for a gable, p.revolve for a dome); 4 doors and windows (frames, glass, p.window_rows along a wall); 5 trim
(cornices, sills, beams: p.beam, p.array); 6 props (steps, chimney, signs, lamps); 7 paint, one bake.
Triangles: low-poly 1-5k, mid 10-40k.
Sizes in metres: a storey 3 tall, a door 1 x 2.1, a window 1.2 x 1.4; cottage 8 x 6 x 7.5; watchtower 4 x 4 x 12;
hangar 30 x 40 x 12.
"""
WALL = p.material('Wall', '#d8cfc0')
ROOF = p.material('Roof', '#7a3b2e')
WOOD = p.material('Wood', '#6b4a2f')
STONE = p.material('Stone', '#8d8a84')

PLAN = p.plan({
    'Walls': dict(at=(0, 0, 2.5), size=(8, 6, 5), mat=WALL),
    'Roof': dict(at=(0, 0, 6.25), size=(8.6, 6.6, 2.5), shape='wedge', axis='x', mat=ROOF),
    'Step': dict(at=(0, -3.4, 0.1), size=(1.6, 0.8, 0.2), mat=STONE),
    'Door': dict(at=(0, -3.05, 1.25), size=(1.0, 0.1, 2.1), mat=WOOD),
})
