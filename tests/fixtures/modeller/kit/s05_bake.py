"""Panel seams as a mask, baked into the texture: darker lines between the plates, no extra triangles"""
import numpy

paint = p.material('Tank paint', '#c0c0c0', rough=0.5)
tank = p.capsule('Tank', (0, -1.5, 0.5), (0, 1.5, 0.5), 0.5, mat=paint)
faces = len(tank.data.polygons)
assert p.panel_lines(tank, size=0.5, gap=0.03, bake_only=True) > 8 and len(tank.data.polygons) == faces
p.uv_atlas()
p.bake_maps(size=256, samples=1)
me = tank.data
px = numpy.empty(256 * 256 * 4, dtype=numpy.float32)
bpy.data.images['Baked_basecolor'].pixels.foreach_get(px)
px = px.reshape(256, 256, 4)[..., :3].mean(axis=2)
uv = numpy.empty(len(me.loops) * 2)
me.uv_layers.active.data.foreach_get('uv', uv)
uv = uv.reshape(-1, 2)
seam = numpy.empty(len(me.loops) * 3, dtype=numpy.float32)
me.attributes['genio_seam'].data.foreach_get('vector', seam)
side = numpy.empty(len(me.loops), dtype=numpy.float32)
me.attributes['genio_seam_w'].data.foreach_get('value', side)
edge = numpy.minimum(seam.reshape(-1, 3).min(axis=1), side) - 1  # each corner's distance to its plate's edge
texel = lambda q: px[min(int(q[1] * 256), 255), min(int(q[0] * 256), 255)]  # noqa: E731
on_seam = [texel(uv[i]) for i in numpy.nonzero(edge < 1e-6)[0]]
inner = [texel(uv[f.loop_start:f.loop_start + f.loop_total].mean(axis=0)) for f in me.polygons
         if (edge[f.loop_start:f.loop_start + f.loop_total] > 0.08).all()]
assert len(on_seam) > 50 and len(inner) > 20, (len(on_seam), len(inner))
assert numpy.median(on_seam) < 0.75 * numpy.median(inner), (numpy.median(on_seam), numpy.median(inner))
