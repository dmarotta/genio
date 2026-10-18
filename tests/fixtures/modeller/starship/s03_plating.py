"""Plating the saucer: recessed panel seams over the top and underside, the bridge deck and the sensor dome, and a ring of windows"""
import math
seam = p.material('Panel seam', '#8a8e95', rough=0.6, metal=0.3)
p.panel_lines('Saucer', size=0.8, region=lambda c: math.hypot(c.x, c.y) < 6.6, mat=seam)
p.panel_lines('Bridge module', size=0.6, gap=0.01, mat=seam)
p.panel_lines('Lower dome', size=0.6, gap=0.01, mat=seam)
p.window_rows('Saucer windows', 'Saucer', [p.circle(6.55, 96, center=(SAUCER_C[0], SAUCER_C[1], SAUCER_C[2] + 0.14))],
              size=(0.22, 0.1), closed=True)
