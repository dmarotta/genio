"""Adding X-bracing and a mid-height ring beam between the legs"""
wood, dark = p.material('Wood', (0.42, 0.26, 0.13)), p.material('Wood dark', (0.28, 0.17, 0.08))
H, BASE, TOP = 6.0, 1.6, 1.2
CORNERS = [(1, 1), (-1, 1), (-1, -1), (1, -1)]


def at(sx, sy, z):
    r = BASE + (TOP - BASE) * z / H
    return (sx * r, sy * r, z)


for side in range(4):
    a, b = CORNERS[side], CORNERS[(side + 1) % 4]
    for lvl, (z0, z1) in enumerate([(0.4, 3.0), (3.0, 5.6)]):
        p.beam(f'Brace {side + 1}.{lvl + 1}a', at(*a, z0), at(*b, z1), 0.13, dark)
        p.beam(f'Brace {side + 1}.{lvl + 1}b', at(*b, z0), at(*a, z1), 0.13, dark)
    p.beam(f'Ring beam {side + 1}', at(*a, 3.0), at(*b, 3.0), 0.18, wood)
