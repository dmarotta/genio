"""Laying the plank deck on two joists"""
wood, dark = p.material('Wood', (0.42, 0.26, 0.13)), p.material('Wood dark', (0.28, 0.17, 0.08))
plank_mat = p.material('Planks', (0.55, 0.37, 0.2))
for i, y in enumerate((-1.15, 1.15)):
    p.box(f'Deck joist {i + 1}', (3.5, 0.22, 0.22), (0, y, 6.0), mat=dark)
plank = p.box('Deck planks', (0.25, 3.6, 0.08), (-1.68, 0, 6.15), mat=plank_mat, bevel=0.012)
p.array(plank, 13, (0.28, 0, 0))
