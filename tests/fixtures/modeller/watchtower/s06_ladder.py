"""Cutting a hatch in the deck and adding the ladder, lantern and pennant"""
wood, dark = p.material('Wood', (0.42, 0.26, 0.13)), p.material('Wood dark', (0.28, 0.17, 0.08))
cloth = p.material('Pennant', (0.85, 0.75, 0.2))
glow = p.material('Lantern', (1.0, 0.75, 0.35), rough=0.3)
X = 0.9
for i, y in enumerate((-0.28, 0.28)):
    p.beam(f'Ladder rail {i + 1}', (X, y - 2.6, 0.0), (X, y - 0.9, 6.2), 0.08, dark)
rung = p.beam('Ladder rungs', (X, -0.32 - 2.55, 0.35), (X, 0.32 - 2.55, 0.35), 0.06, wood)
p.array(rung, 18, (0, 0.0935, 0.335))
hatch = p.box('Hatch cutter', (0.8, 0.8, 0.5), (X, -0.85, 6.15))
p.boolean_cut(bpy.data.objects['Deck planks'], hatch, 'Hatch')
p.box('Lantern', (0.18, 0.18, 0.26), (-1.5, 1.5, 7.55), mat=glow)
p.box('Pennant', (0.02, 0.5, 0.3), (0, 0.25, 10.1), mat=cloth)
