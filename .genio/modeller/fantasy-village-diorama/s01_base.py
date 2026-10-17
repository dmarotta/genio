"""Blocking out the base: a round soil plinth with a grassy top"""
soil = p.material('Soil', '#7a5236', rough=0.95)
soil_dark = p.material('SoilDark', '#5b3b26', rough=0.95)
grass = p.material('Grass', '#6fa64a', rough=0.9)
base = p.collection('Base')
p.cylinder('base_plinth', 1.0, 0.16, loc=(0, 0, 0.08), mat=soil, segments=28, radius_top=0.97, col=base)
p.cylinder('base_rim', 1.02, 0.03, loc=(0, 0, 0.015), mat=soil_dark, segments=28, col=base)
p.cylinder('base_grass', 0.985, 0.04, loc=(0, 0, 0.175), mat=grass, segments=28, radius_top=0.96, col=base)
