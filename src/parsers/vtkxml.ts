import * as fs from 'fs';
import { ImageMetadata, MetadataField } from './index';

function extractAttr(text: string, attr: string): string {
  const pattern = new RegExp(`${attr}="([^"]*)"`, 'i');
  const m = text.match(pattern);
  return m ? m[1] : '';
}

function extractAllAttr(text: string, attr: string): string[] {
  const pattern = new RegExp(`${attr}="([^"]*)"`, 'gi');
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    results.push(m[1]);
  }
  return results;
}

export function parseVtkXml(fsPath: string): ImageMetadata {
  const fd = fs.openSync(fsPath, 'r');
  const buf = Buffer.alloc(4096);
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
  } finally {
    fs.closeSync(fd);
  }

  const text = buf.subarray(0, bytesRead).toString('utf8');

  // Validate VTK XML
  if (!text.includes('VTKFile')) {
    throw new Error('Not a valid VTK XML file (missing VTKFile element)');
  }

  // Extract VTKFile attributes
  const vtkFileMatch = text.match(/<VTKFile[^>]*>/s);
  const vtkFileTag = vtkFileMatch ? vtkFileMatch[0] : text.substring(0, 200);

  const fileType = extractAttr(vtkFileTag, 'type');
  const version = extractAttr(vtkFileTag, 'version');
  const byteOrder = extractAttr(vtkFileTag, 'byte_order');
  const compressor = extractAttr(vtkFileTag, 'compressor');

  const format = fileType === 'PolyData' ? 'VTK PolyData (VTP)' :
                 fileType === 'ImageData' ? 'VTK ImageData (VTI)' :
                 `VTK XML (${fileType})`;

  const fields: MetadataField[] = [
    { label: 'Format', value: format, group: 'Header' },
    { label: 'VTK Version', value: version, group: 'Header' },
    { label: 'Byte Order', value: byteOrder, group: 'Header' },
  ];

  if (compressor) {
    fields.push({ label: 'Compressor', value: compressor, group: 'Header' });
  }

  let brief = '';

  if (fileType === 'PolyData') {
    // Extract Piece attributes for VTP
    const pieceMatch = text.match(/<Piece[^>]*>/s);
    const pieceTag = pieceMatch ? pieceMatch[0] : '';

    const nPoints = extractAttr(pieceTag, 'NumberOfPoints');
    const nVerts = extractAttr(pieceTag, 'NumberOfVerts');
    const nLines = extractAttr(pieceTag, 'NumberOfLines');
    const nStrips = extractAttr(pieceTag, 'NumberOfStrips');
    const nPolys = extractAttr(pieceTag, 'NumberOfPolys');

    if (nPoints) { fields.push({ label: 'Number of Points', value: nPoints, group: 'Geometry' }); }
    if (nVerts) { fields.push({ label: 'Number of Verts', value: nVerts, group: 'Geometry' }); }
    if (nLines) { fields.push({ label: 'Number of Lines', value: nLines, group: 'Geometry' }); }
    if (nStrips) { fields.push({ label: 'Number of Strips', value: nStrips, group: 'Geometry' }); }
    if (nPolys) { fields.push({ label: 'Number of Polys', value: nPolys, group: 'Geometry' }); }

    brief = `PolyData  ${nPoints} pts  ${nPolys} polys`;

  } else if (fileType === 'ImageData') {
    // Extract ImageData attributes for VTI
    const imageDataMatch = text.match(/<ImageData[^>]*>/s);
    const imageDataTag = imageDataMatch ? imageDataMatch[0] : '';

    const wholeExtent = extractAttr(imageDataTag, 'WholeExtent');
    const origin = extractAttr(imageDataTag, 'Origin');
    const spacing = extractAttr(imageDataTag, 'Spacing');

    if (wholeExtent) { fields.push({ label: 'Whole Extent', value: wholeExtent, group: 'Geometry' }); }
    if (origin) { fields.push({ label: 'Origin', value: origin, group: 'Geometry' }); }
    if (spacing) { fields.push({ label: 'Spacing', value: spacing, group: 'Geometry' }); }

    // Derive dimensions from WholeExtent (x0 x1 y0 y1 z0 z1)
    let dims = '';
    if (wholeExtent) {
      const parts = wholeExtent.trim().split(/\s+/);
      if (parts.length >= 6) {
        const dx = parseInt(parts[1]) - parseInt(parts[0]) + 1;
        const dy = parseInt(parts[3]) - parseInt(parts[2]) + 1;
        const dz = parseInt(parts[5]) - parseInt(parts[4]) + 1;
        dims = `${dx}×${dy}×${dz}`;
        fields.push({ label: 'Dimensions', value: dims, group: 'Geometry' });
      }
    }

    brief = `${dims}  ${spacing}`;
  }

  // Extract DataArray names from PointData and CellData
  const dataArrayNames = extractAllAttr(text, 'Name');
  if (dataArrayNames.length > 0) {
    fields.push({ label: 'Data Arrays', value: dataArrayNames.join(', '), group: 'Data' });
  }

  // Look for PointData and CellData attribute lists
  const pointDataMatch = text.match(/<PointData[^>]*Scalars="([^"]*)"[^>]*>/i) ||
                         text.match(/<PointData[^>]*Vectors="([^"]*)"[^>]*>/i);
  if (pointDataMatch) {
    fields.push({ label: 'Active PointData', value: pointDataMatch[1], group: 'Data' });
  }

  return { format, fields, brief: brief || `VTK XML ${fileType}` };
}
