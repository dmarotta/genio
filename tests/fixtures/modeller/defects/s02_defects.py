"""Known defects: a floating lamp, a sunk block, a decal flat on the top and a handle without its twin"""
p.sphere('Lamp', 0.08, loc=(0.3, -0.3, 1.4))
p.box('Block', (0.2, 0.2, 0.2), loc=(0, 0.25, 1.02))
p.plane('Decal', (0.3, 0.3), loc=(0, -0.2, 1.0))
p.box('Handle L', (0.1, 0.05, 0.03), loc=(0.55, 0, 0.95))
