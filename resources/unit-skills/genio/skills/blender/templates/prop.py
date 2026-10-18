"""Prop plan (barrel, crate, lamp, chest, bottle, furniture): one to three main shapes, then detail.

Steps: 1 p.blockout(PLAN); 2 the main shapes for real (p.lathe or p.revolve for round things, p.box with a
bevel, p.loft); 3 detail (bands, handles, rivets: p.ring, p.panel_lines, p.greebles); 4 bevels, then
p.freeze; 5 paint (p.camo, p.weathering, material presets), one bake at 1024 px.
Triangles: low-poly 200-2k, mid 2-10k.
Sizes in metres: barrel 0.6 x 0.6 x 0.9; crate 0.8 x 0.8 x 0.8; chair 0.5 x 0.5 x 0.9; street lamp 0.4 x 0.4 x 4;
chest 0.9 x 0.5 x 0.6.
"""
WOOD = p.material('Wood', '#8a5a33')
IRON = p.material('Iron', '#4a4d52', preset='brushed')

PLAN = p.plan({
    'Body': dict(at=(0, 0, 0.45), size=(0.6, 0.6, 0.9), shape='cylinder', mat=WOOD),
    'Lid': dict(at=(0, 0, 0.92), size=(0.56, 0.56, 0.04), shape='cylinder', mat=IRON),
})
