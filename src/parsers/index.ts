import * as path from 'path';
import { parseNifti } from './nifti';
import { parseNrrd } from './nrrd';
import { parseVtk } from './vtk';
import { parseVtkXml } from './vtkxml';

export interface MetadataField {
  label: string;
  value: string;
  group?: string;
}

export interface ImageMetadata {
  format: string;
  fields: MetadataField[];
  brief: string;
  error?: string;
}

function getExtension(fsPath: string): string {
  const basename = path.basename(fsPath);

  // Handle multi-part extensions first
  if (basename.endsWith('.nii.gz')) { return '.nii.gz'; }
  if (basename.endsWith('.seq.nrrd')) { return '.seq.nrrd'; }

  return path.extname(fsPath).toLowerCase();
}

/**
 * Compute per-axis anatomical orientation labels from a 3×3 direction matrix
 * expressed in RAS space.
 *
 * M[worldRow][voxelCol]:
 *   worldRow 0 = R(+)/L(-),  1 = A(+)/P(-),  2 = S(+)/I(-)
 *   voxelCol 0 = i-axis,     1 = j-axis,      2 = k-axis
 *
 * Returns e.g. "L→R  P→A  I→S"
 */
export function computeOrientationAxes(M: number[][]): string {
  const pos = ['R', 'A', 'S'];
  const neg = ['L', 'P', 'I'];
  const axes: string[] = [];
  for (let col = 0; col < 3; col++) {
    let maxAbs = 0, maxRow = 0, maxSign = 1;
    for (let row = 0; row < 3; row++) {
      const v = M[row][col];
      if (Math.abs(v) > maxAbs) { maxAbs = Math.abs(v); maxRow = row; maxSign = v > 0 ? 1 : -1; }
    }
    const posEnd = maxSign > 0 ? pos[maxRow] : neg[maxRow];
    const negEnd = maxSign > 0 ? neg[maxRow] : pos[maxRow];
    axes.push(`${negEnd}→${posEnd}`);
  }
  return axes.join('  ');
}

export function getMetadata(fsPath: string): ImageMetadata {
  const ext = getExtension(fsPath);

  try {
    switch (ext) {
      case '.nii':
      case '.nii.gz':
        return parseNifti(fsPath);

      case '.nrrd':
      case '.seq.nrrd':
        return parseNrrd(fsPath);

      case '.vtk':
        return parseVtk(fsPath);

      case '.vtp':
      case '.vti':
        return parseVtkXml(fsPath);

      default:
        return {
          format: 'Unknown',
          fields: [{ label: 'Extension', value: ext || path.extname(fsPath) }],
          brief: 'Unsupported format',
          error: `Unsupported file extension: ${ext}`,
        };
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      format: 'Unknown',
      fields: [],
      brief: 'Parse error',
      error: message,
    };
  }
}
