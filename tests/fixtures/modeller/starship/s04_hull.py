"""Rebuilding the engineering hull: a long smooth cigar with a flat shuttlebay stern and a recessed deflector mouth"""
import math
length = HULL_REAR - HULL_FRONT   # profile z runs from the stern (0) to the deflector rim (length)
L = length / 13.0
p.revolve('Engineering hull', [
    [(0.0, 0.0), (0.86, 0.0)],
    [(0.86, 0.0), (0.92, 0.06)],
    [(0.92, 0.06), (1.02, 0.4 * L), (1.16, 1.2 * L), (1.33, 2.5 * L), (1.46, 4.5 * L), (1.54, 7.0 * L),
     (1.565, 9.5 * L), (1.55, 11.5 * L), (1.5, 12.6 * L), (1.47, length)],
    [(1.47, length), (1.36, length + 0.07), (1.22, length + 0.06)],
    [(1.22, length + 0.06), (1.15, length - 0.12), (0.7, length - 0.3), (0.0, length - 0.34)],
], segments=96, loc=(0, HULL_REAR, HULL_Z), rot=(math.pi / 2, 0, 0), mat=HULL)
