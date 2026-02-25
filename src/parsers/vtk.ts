import * as fs from 'fs';
import { ImageMetadata, MetadataField } from './index';

export function parseVtk(fsPath: string): ImageMetadata {
  const fd = fs.openSync(fsPath, 'r');
  const buf = Buffer.alloc(2048);
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
  } finally {
    fs.closeSync(fd);
  }

  const text = buf.subarray(0, bytesRead).toString('utf8');
  const lines = text.split(/\r?\n/);

  if (lines.length < 4) {
    throw new Error('VTK file too short');
  }

  // Validate VTK header
  if (!lines[0].startsWith('# vtk DataFile')) {
    throw new Error(`Not a valid legacy VTK file (header: ${lines[0].substring(0, 30)})`);
  }

  const versionLine = lines[0].trim();
  const title = lines[1]?.trim() ?? '';
  const dataFormat = lines[2]?.trim().toUpperCase() ?? '';
  const datasetLine = lines[3]?.trim() ?? '';

  let datasetType = '';
  const datasetMatch = datasetLine.match(/^DATASET\s+(\S+)/i);
  if (datasetMatch) {
    datasetType = datasetMatch[1].toUpperCase();
  }

  const fields: MetadataField[] = [
    { label: 'Format', value: 'VTK Legacy', group: 'Header' },
    { label: 'Version', value: versionLine, group: 'Header' },
    { label: 'Title', value: title, group: 'Header' },
    { label: 'Data Format', value: dataFormat, group: 'Header' },
    { label: 'Dataset Type', value: datasetType, group: 'Geometry' },
  ];

  // Parse subsequent keyword lines
  let dimensions = '';
  let spacing = '';
  let origin = '';
  let points = '';
  let cells = '';
  let cellTypes = '';

  for (let i = 4; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { continue; }

    const upper = line.toUpperCase();

    if (upper.startsWith('DIMENSIONS')) {
      dimensions = line.substring('DIMENSIONS'.length).trim();
      fields.push({ label: 'Dimensions', value: dimensions, group: 'Geometry' });
    } else if (upper.startsWith('SPACING')) {
      spacing = line.substring('SPACING'.length).trim();
      fields.push({ label: 'Spacing', value: spacing, group: 'Geometry' });
    } else if (upper.startsWith('ORIGIN')) {
      origin = line.substring('ORIGIN'.length).trim();
      fields.push({ label: 'Origin', value: origin, group: 'Geometry' });
    } else if (upper.startsWith('POINTS')) {
      points = line.substring('POINTS'.length).trim();
      fields.push({ label: 'Points', value: points, group: 'Data' });
    } else if (upper.startsWith('CELLS ')) {
      cells = line.substring('CELLS'.length).trim();
      fields.push({ label: 'Cells', value: cells, group: 'Data' });
    } else if (upper.startsWith('CELL_TYPES')) {
      cellTypes = line.substring('CELL_TYPES'.length).trim();
      fields.push({ label: 'Cell Types', value: cellTypes, group: 'Data' });
    } else if (upper.startsWith('POINT_DATA') || upper.startsWith('CELL_DATA')) {
      fields.push({ label: upper.split(' ')[0], value: line.substring(upper.split(' ')[0].length).trim(), group: 'Data' });
    } else if (upper.startsWith('SCALARS') || upper.startsWith('VECTORS') || upper.startsWith('NORMALS') || upper.startsWith('TENSORS')) {
      fields.push({ label: upper.split(' ')[0], value: line.substring(upper.split(' ')[0].length).trim(), group: 'Data' });
    }
  }

  const dimOrPoints = dimensions || (points ? `${points.split(/\s+/)[0]} points` : '');
  const brief = `${datasetType}  ${dimOrPoints}`;

  return { format: 'VTK Legacy', fields, brief };
}
