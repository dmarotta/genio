"""Adding the neck: a slim swept-back pylon from the saucer's underside to the engineering hull, flaring at its base"""
# Along the neck from its top: centre (y, z), chord and width; the top inside the saucer, the base inside the hull
keys = [((-3.6, 5.78), 2.7, 0.72), ((-3.25, 5.46), 2.55, 0.68), ((-2.55, 4.86), 2.4, 0.64), ((-1.7, 4.16), 2.5, 0.66),
        ((-0.9, 3.56), 2.9, 0.72), ((-0.25, 3.11), 3.5, 0.84), ((0.15, 2.81), 3.9, 0.92)]
p.sweep('Neck', [(0.0, y, z) for (y, z), _, _ in keys], p.rect(1, 1, 0.48, per=8), scale=[(w, ch) for _, ch, w in keys], level=True,
        mat=HULL, smooth=50)
