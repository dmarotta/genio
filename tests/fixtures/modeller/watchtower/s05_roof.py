"""Now adding the roof: corner posts, a pyramid of shingles and a finial"""
import math
wood = p.material('Wood', (0.42, 0.26, 0.13))
roof = p.material('Shingles', (0.55, 0.18, 0.12), rough=0.9)
S = 1.7
for i, (sx, sy) in enumerate([(1, 1), (-1, 1), (-1, -1), (1, -1)]):
    p.box(f'Roof post {i + 1}', (0.14, 0.14, 1.8), (sx * S, sy * S, 7.1 + 0.9), mat=wood)
p.cone('Roof', 2.25 * math.sqrt(2), 1.7, (0, 0, 8.0 + 0.85), mat=roof, segments=4, rot=(0, 0, math.pi / 4))
p.cylinder('Roof eave', 2.25 * math.sqrt(2), 0.12, (0, 0, 8.0), mat=wood, segments=4, rot=(0, 0, math.pi / 4))
p.cylinder('Finial', 0.06, 0.6, (0, 0, 9.95), mat=wood, segments=6)
