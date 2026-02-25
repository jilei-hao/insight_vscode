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
