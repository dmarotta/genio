"""Starship: the plan, the layout constants and the profiles every step builds from"""
HULL = p.material('Hull', '#c9ccd1', rough=0.45, metal=0.3)

# Layout in metres, in the model's final place: standing on z = 0, centred, front to -Y (left is +X).
SAUCER_C = (0.0, -8.3, 5.96)  # the saucer's centre
HULL_Z = 1.56                  # the engineering hull's centreline height
HULL_FRONT, HULL_REAR = -3.4, 9.6
NAC_X, NAC_Z, NAC_FRONT, NAC_REAR, NAC_R = 3.5, 7.06, -0.6, 15.0, 0.62
NECK_TOP, NECK_BASE = (0.0, -3.6, 5.78), (0.0, 0.15, 2.81)

PLAN = p.plan({
    'Saucer': dict(at=(0, -8.3, 5.85), size=(13.4, 13.4, 1.32), shape='disc', mat=HULL),
    'Bridge module': dict(at=(0, -8.3, 6.68), size=(4.6, 4.6, 0.68), shape='disc', mat=HULL),
    'Lower dome': dict(at=(0, -8.3, 5.05), size=(3.7, 3.7, 0.62), shape='disc', mat=HULL),
    'Engineering hull': dict(at=(0, 3.07, HULL_Z), size=(3.12, 13.07, 3.12), shape='capsule', mat=HULL),
    'Neck': dict(ends=(NECK_TOP, NECK_BASE), size=(0.82, 3.3), level=True, mat=HULL),
    'Nacelle L': dict(at=(NAC_X, (NAC_FRONT + NAC_REAR) / 2, NAC_Z), size=(2 * NAC_R, NAC_REAR - NAC_FRONT, 2 * NAC_R),
                      shape='capsule', mirror=True, mat=HULL),
    'Pylon L': dict(ends=((0.6, 7.6, HULL_Z + 1.1), (NAC_X, 8.6, NAC_Z - 0.3)), size=(0.25, 1.6), level=True, mirror=True, mat=HULL),
})

# Saucer profile pieces as (radius, height above SAUCER_C); joins between pieces stay crisp
SAUCER_TOP = [(0.0, 0.55), (1.0, 0.52), (2.0, 0.46), (3.2, 0.36), (4.4, 0.265), (5.5, 0.19), (6.4, 0.14), (6.7, 0.12)]
SAUCER_RIM = [(6.7, 0.12), (6.73, 0.0), (6.7, -0.12)]
SAUCER_BOTTOM = [(6.7, -0.12), (6.45, -0.17), (5.6, -0.27), (4.5, -0.4), (3.4, -0.54), (2.4, -0.655), (1.6, -0.72),
                 (0.8, -0.755), (0.0, -0.77)]
