"""Raising four tapered timber legs on stone footings"""
wood = p.material('Wood', (0.42, 0.26, 0.13))
stone = p.material('Stone', (0.48, 0.48, 0.5), rough=0.95)
H, BASE, TOP = 6.0, 1.6, 1.2
for i, (sx, sy) in enumerate([(1, 1), (-1, 1), (-1, -1), (1, -1)]):
    p.beam(f'Leg {i + 1}', (sx * BASE, sy * BASE, 0.0), (sx * TOP, sy * TOP, H + 0.1), 0.28, wood)
    p.cylinder(f'Footing {i + 1}', 0.36, 0.3, (sx * BASE, sy * BASE, 0.15), mat=stone, segments=6)
