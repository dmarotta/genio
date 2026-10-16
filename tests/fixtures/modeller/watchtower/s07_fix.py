"""Fixing review notes: roof posts poke through the roof; ladder rails were offset along the climb, not across it"""
wood, dark = p.material('Wood', (0.42, 0.26, 0.13)), p.material('Wood dark', (0.28, 0.17, 0.08))
S = 1.7
for i, (sx, sy) in enumerate([(1, 1), (-1, 1), (-1, -1), (1, -1)]):
    p.box(f'Roof post {i + 1}', (0.14, 0.14, 0.95), (sx * S, sy * S, 7.1 + 0.475), mat=wood)
p.remove('Ladder rail 1', 'Ladder rail 2', 'Ladder rungs')
X, Y = 0.9, -1.15
for i, dx in enumerate((-0.25, 0.25)):
    p.box(f'Ladder rail {i + 1}', (0.07, 0.07, 6.9), (X + dx, Y, 3.45), mat=dark)
p.array(p.box('Ladder rungs', (0.5, 0.05, 0.05), (X, Y, 0.3), mat=wood), 19, (0, 0, 0.33))
