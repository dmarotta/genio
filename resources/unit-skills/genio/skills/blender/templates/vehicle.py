"""Vehicle plan (car, truck, boat, aircraft, spacecraft): change the parts, sizes and places to the brief's.

Steps: 1 p.blockout(PLAN); 2 body or hull (p.hull, p.sweep); 3 wheels or engines (p.revolve, p.capsule),
mirrored; 4 cabin, cockpit or bridge (glass, p.window_rows); 5 connectors (axles, struts, pylons: p.sweep);
6 detail (p.panel_lines, p.greebles); 7 lights (preset 'emissive'); 8 p.freeze, paint, one bake.
Triangles: low-poly 2-8k, mid 20-60k, high-poly 150-400k.
Sizes in metres (wide x long x tall): car 1.9 x 4.4 x 1.5 with wheels 0.66 across; truck 2.5 x 9 x 3.5;
rover 2.6 x 4 x 2.2; fighter jet 10 x 15 x 4; boat 3 x 10 x 4.
init gave the model --symmetry x: an L part with mirror=True plans its R twin.
"""
PAINT = p.material('Paint', '#b03a2e', preset='painted')
TYRE = p.material('Tyre', '#1d1d1f', preset='rubber')
GLASS = p.material('Glass', '#8fb3c9', preset='glass')

PLAN = p.plan({
    'Body': dict(at=(0, 0, 0.75), size=(1.5, 4.4, 0.6), mat=PAINT),
    'Cabin': dict(at=(0, 0.2, 1.3), size=(1.3, 2.2, 0.5), mat=GLASS),
    'Wheel front L': dict(at=(0.85, -1.35, 0.33), size=(0.2, 0.66, 0.66), shape='cylinder', mirror=True, mat=TYRE),
    'Wheel back L': dict(at=(0.85, 1.35, 0.33), size=(0.2, 0.66, 0.66), shape='cylinder', mirror=True, mat=TYRE),
})
