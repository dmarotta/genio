"""Shaping the saucer: a smooth high-poly lens with a rounded rim, the raised bridge deck and the lower sensor dome"""
p.revolve('Saucer', [SAUCER_TOP, SAUCER_RIM, SAUCER_BOTTOM], segments=192, loc=SAUCER_C, mat=HULL)

# Bridge deck: a stepped dome rising from the saucer top, its flat underside hidden inside the saucer
p.revolve('Bridge module', [
    [(0.0, 1.06), (0.2, 1.055), (0.36, 1.02), (0.44, 0.96)],
    [(0.44, 0.96), (0.47, 0.9)],
    [(0.47, 0.9), (0.75, 0.86), (1.05, 0.8), (1.3, 0.74)],
    [(1.3, 0.74), (1.36, 0.68)],
    [(1.36, 0.68), (1.7, 0.6), (2.05, 0.5), (2.3, 0.44)],
    [(2.3, 0.44), (2.3, 0.38), (0.0, 0.38)],
], segments=128, loc=SAUCER_C, mat=HULL)

# Lower sensor dome under the saucer, with its small sensor bulb
p.revolve('Lower dome', [
    [(0.0, -1.22), (0.18, -1.205), (0.3, -1.16), (0.36, -1.09)],
    [(0.36, -1.09), (0.55, -1.0), (0.85, -0.93), (1.2, -0.86), (1.6, -0.79), (1.85, -0.73)],
    [(1.85, -0.73), (1.85, -0.6), (0.0, -0.6)],
], segments=128, loc=SAUCER_C, mat=HULL)
