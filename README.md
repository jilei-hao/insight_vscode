# Medical Image Insight

A VS Code extension that displays metadata for medical imaging files — no conversion, no external tools needed. Just open the file.

## Supported Formats

| Extension | Format |
|-----------|--------|
| `.nii`, `.nii.gz` | NIfTI-1 / NIfTI-2 |
| `.nrrd`, `.seq.nrrd` | NRRD |
| `.vtk` | VTK Legacy |
| `.vtp` | VTK PolyData (XML) |
| `.vti` | VTK ImageData (XML) |

## Features

### Metadata Webview
Opening any supported file shows a formatted metadata panel instead of a binary hex dump. Displays geometry, data type, orientation, and format-specific fields grouped into sections.

### Explorer Badge
Supported files in the Explorer sidebar show an **IM** badge and a tooltip with a brief summary (dimensions, data type, space) on hover.

### Context Menu Command
Right-click any supported file in the Explorer → **Show Medical Image Metadata**.

## Usage

1. Open a folder containing medical image files in VS Code.
2. Click a `.nii.gz`, `.nrrd`, `.vtk`, `.vtp`, or `.vti` file — the metadata viewer opens automatically.
3. Hover over files in the Explorer to see a quick summary tooltip.
4. Right-click a file and choose **Show Medical Image Metadata** to open the viewer from the context menu.

## Parsed Fields

**NIfTI** — dimensions, voxel sizes, data type, intent code, qform/sform codes, q-offset, description string.

**NRRD** — type, dimension, sizes, spacings, space directions, space origin, encoding, endianness, content.

**VTK Legacy** — dataset type (STRUCTURED_POINTS, POLYDATA, …), dimensions, spacing, origin, point/cell counts.

**VTK XML (VTP)** — number of points, verts, lines, strips, polys; data array names.

**VTK XML (VTI)** — whole extent, derived dimensions, origin, spacing; data array names.

## Requirements

- VS Code 1.85 or later
- No external dependencies — parsing uses only Node.js built-ins (`fs`, `zlib`, `Buffer`)

## Extension Settings

This extension has no configurable settings.

## Known Limitations

- NIfTI-2 orientation fields (qform/sform) are not fully parsed yet.
- Binary VTK files are detected but geometry values are not decoded from binary blocks.
- Very large files: only the header is read, so metadata is fast regardless of file size.

## License

MIT © Jilei Hao
