import * as fs from 'fs';
import { ImageMetadata, MetadataField, computeOrientationAxes } from './index';

export function parseNrrd(fsPath: string): ImageMetadata {
  const fd = fs.openSync(fsPath, 'r');
  let headerText = '';
  const chunkSize = 4096;
  const buf = Buffer.alloc(chunkSize);
  let offset = 0;
  let found = false;

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buf, 0, chunkSize, offset);
      if (bytesRead === 0) { break; }
      const chunk = buf.subarray(0, bytesRead).toString('utf8');
      headerText += chunk;
      offset += bytesRead;

      if (headerText.includes('\n\n') || headerText.includes('\r\n\r\n')) {
        found = true;
        break;
      }

      // Safety limit: don't read more than 64KB for header
      if (offset > 65536) { break; }
    }
  } finally {
    fs.closeSync(fd);
  }

  // Trim to header section
  const nnIdx = headerText.indexOf('\n\n');
  const crnnIdx = headerText.indexOf('\r\n\r\n');
  let endIdx = -1;
  if (nnIdx !== -1 && crnnIdx !== -1) {
    endIdx = Math.min(nnIdx, crnnIdx);
  } else if (nnIdx !== -1) {
    endIdx = nnIdx;
  } else if (crnnIdx !== -1) {
    endIdx = crnnIdx;
  }

  const header = endIdx !== -1 ? headerText.substring(0, endIdx) : headerText;
  const lines = header.split(/\r?\n/);

  // Validate NRRD magic
  if (!lines[0]?.startsWith('NRRD')) {
    throw new Error(`Not a valid NRRD file (magic: ${lines[0]?.substring(0, 10)})`);
  }

  const version = lines[0].trim();
  const kvPairs: Record<string, string> = {};

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith('#')) { continue; }

    // key:= value (key-value pair with :=)
    const kvEqIdx = line.indexOf(':=');
    if (kvEqIdx !== -1) {
      const key = line.substring(0, kvEqIdx).trim();
      const val = line.substring(kvEqIdx + 2).trim();
      kvPairs[key.toLowerCase()] = val;
      continue;
    }

    // key: value (field definition)
    const kvIdx = line.indexOf(':');
    if (kvIdx !== -1) {
      const key = line.substring(0, kvIdx).trim();
      const val = line.substring(kvIdx + 1).trim();
      kvPairs[key.toLowerCase()] = val;
    }
  }

  const fields: MetadataField[] = [
    { label: 'NRRD Version', value: version, group: 'Header' },
  ];

  const keyOrder: Array<[string, string, string]> = [
    ['type', 'Data Type', 'Data'],
    ['dimension', 'Dimensions', 'Geometry'],
    ['space', 'Space', 'Geometry'],
    ['sizes', 'Sizes', 'Geometry'],
    ['spacings', 'Spacings', 'Geometry'],
    ['space directions', 'Space Directions', 'Geometry'],
    ['space origin', 'Space Origin', 'Geometry'],
    ['encoding', 'Encoding', 'Header'],
    ['endian', 'Endian', 'Header'],
    ['content', 'Content', 'Header'],
    ['measurement frame', 'Measurement Frame', 'Geometry'],
    ['data file', 'Data File', 'Header'],
  ];

  for (const [key, label, group] of keyOrder) {
    const val = kvPairs[key];
    if (val !== undefined) {
      fields.push({ label, value: val, group });
    }
  }

  // Add any remaining key-value pairs not in the standard list
  const coveredKeys = new Set(keyOrder.map(([k]) => k));
  for (const [key, val] of Object.entries(kvPairs)) {
    if (!coveredKeys.has(key)) {
      fields.push({ label: key, value: val, group: 'Other' });
    }
  }

  // --- Orientation from space directions ---
  const spaceDirsRaw = kvPairs['space directions'] ?? '';
  const spaceField = (kvPairs['space'] ?? '').toLowerCase();

  // Determine if we need to convert LPS→RAS (flip first two world components)
  const isLPS = spaceField.includes('left-posterior') || spaceField === 'lps';
  const isLAS = spaceField.includes('left-anterior') || spaceField === 'las';

  /**
   * Parse a NRRD direction vector like "(1,0,0)" or "none".
   * Returns null for "none" (non-spatial dimensions in 4D files).
   */
  function parseVec(s: string): number[] | null {
    const trimmed = s.trim();
    if (trimmed === 'none') { return null; }
    const nums = trimmed.replace(/[()]/g, '').split(/[\s,]+/).map(Number);
    return nums.length >= 3 ? nums : null;
  }

  // Space directions value looks like: "(1,0,0) (0,1,0) (0,0,1)"
  // or "none (1,0,0) (0,1,0) (0,0,1)" for 4D with non-spatial first dim
  const vecTokens = spaceDirsRaw.match(/\([^)]*\)|none/g) ?? [];
  const spatialVecs = vecTokens.map(parseVec).filter((v): v is number[] => v !== null);

  let orientAxes = '';
  if (spatialVecs.length >= 3) {
    // Build M[worldRow][voxelCol]: columns are the direction vectors
    const M: number[][] = [
      [spatialVecs[0][0], spatialVecs[1][0], spatialVecs[2][0]],
      [spatialVecs[0][1], spatialVecs[1][1], spatialVecs[2][1]],
      [spatialVecs[0][2], spatialVecs[1][2], spatialVecs[2][2]],
    ];

    // Convert to RAS if the space is LPS or LAS (flip rows 0 and 1)
    if (isLPS || isLAS) {
      for (let col = 0; col < 3; col++) { M[0][col] *= -1; M[1][col] *= -1; }
    }

    orientAxes = computeOrientationAxes(M);

    const fmt = (v: number) => v.toFixed(4).padStart(9);
    fields.push(
      { label: 'Orientation Axes', value: orientAxes, group: 'Orientation' },
      { label: 'i-axis direction', value: `[ ${fmt(spatialVecs[0][0])}  ${fmt(spatialVecs[0][1])}  ${fmt(spatialVecs[0][2])} ]`, group: 'Orientation' },
      { label: 'j-axis direction', value: `[ ${fmt(spatialVecs[1][0])}  ${fmt(spatialVecs[1][1])}  ${fmt(spatialVecs[1][2])} ]`, group: 'Orientation' },
      { label: 'k-axis direction', value: `[ ${fmt(spatialVecs[2][0])}  ${fmt(spatialVecs[2][1])}  ${fmt(spatialVecs[2][2])} ]`, group: 'Orientation' },
    );
  }

  const sizes = kvPairs['sizes'] ?? '';
  const type = kvPairs['type'] ?? '';
  const space = kvPairs['space'] ?? '';
  const sizeParts = sizes.split(/\s+/).filter(Boolean);
  const brief = `${sizeParts.join('×')}  ${type}${orientAxes ? '  ' + orientAxes : (space ? '  ' + space : '')}`;

  return { format: 'NRRD', fields, brief };
}
