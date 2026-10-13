# Engine formats

- Unity: engine root can be nested. PNG textures, WAV/OGG audio, FBX models/motions. Keep GLB/glTF sources under the engine's ArtSource/3D outside Assets until a unit converts them or verifies an importer. .meta, Humanoid configuration, sprites and materials are unit work.
- Godot: use engine-relative paths and lowercase/snake_case; GLB, OGG music and WAV SFX. Keep out of .godot and addons.
- Unreal: raw media goes under SourceArt; Content requires imported .uasset files. Import and wiring are unit work.
- Other worlds: follow measured own-media conventions and configured folders.

Prefer formats covered by the world's .gitattributes. Surface LFS warnings. Do not edit the attributes file or fetch LFS objects as part of generation.
