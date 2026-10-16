"""Fencing the deck with posts, a top rail and balusters"""
wood, dark = p.material('Wood', (0.42, 0.26, 0.13)), p.material('Wood dark', (0.28, 0.17, 0.08))
S, Z0, Z1 = 1.7, 6.19, 7.1
for i, (sx, sy) in enumerate([(1, 1), (-1, 1), (-1, -1), (1, -1)]):
    p.box(f'Rail post {i + 1}', (0.16, 0.16, Z1 - Z0), (sx * S, sy * S, (Z0 + Z1) / 2), mat=wood)
for i, (loc, size) in enumerate([((0, S, Z1), (2 * S + 0.16, 0.12, 0.1)), ((0, -S, Z1), (2 * S + 0.16, 0.12, 0.1)),
                                 ((S, 0, Z1), (0.12, 2 * S, 0.1)), ((-S, 0, Z1), (0.12, 2 * S, 0.1))]):
    p.box(f'Top rail {i + 1}', size, loc, mat=wood)
for i, (loc, offset) in enumerate([((-S + 0.3, S, 6.62), (0.3, 0, 0)), ((-S + 0.3, -S, 6.62), (0.3, 0, 0)),
                                   ((S, -S + 0.3, 6.62), (0, 0.3, 0))]):
    bal = p.box(f'Balusters {i + 1}', (0.06, 0.06, 0.86), loc, mat=dark)
    p.array(bal, 11, offset)
