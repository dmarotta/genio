"""A small table: a top on four legs"""
wood = p.material('Wood', '#8a5a33')
p.box('Top', (1.0, 1.0, 0.1), loc=(0, 0, 0.95), mat=wood)
for side, y in (('front', -0.45), ('back', 0.45)):
    p.mirror_pair(p.box(f'Leg {side} L', (0.05, 0.05, 0.9), loc=(0.45, y, 0.45), mat=wood))
