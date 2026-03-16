import * as fs from 'fs';
import * as zlib from 'zlib';
import * as path from 'path';
import * as vscode from 'vscode';

// ─── NIfTI-1 ─────────────────────────────────────────────────────────────────

interface Nifti1Info {
  fsPath: string;
  le: boolean;
  ndim: number;
  dims: number[];
  pixdims: number[];
  voxOffset: number;
  datatype: number;
  bitpix: number;
  dirMatrix: number[][] | null;
  headerBuf: Buffer;
}

function readNifti1HeaderBuf(fsPath: string): Buffer {
  if (fsPath.endsWith('.gz')) {
    const compressed = fs.readFileSync(fsPath);
    const decompressed = zlib.gunzipSync(compressed);
    return Buffer.from(decompressed.subarray(0, 348));
  }
  const fd = fs.openSync(fsPath, 'r');
  const buf = Buffer.alloc(348);
  fs.readSync(fd, buf, 0, 348, 0);
  fs.closeSync(fd);
  return buf;
}

function parseNifti1Info(fsPath: string): Nifti1Info {
  const headerBuf = readNifti1HeaderBuf(fsPath);
  const sizeLE = headerBuf.readInt32LE(0);
  const sizeBE = headerBuf.readInt32BE(0);
  if (sizeLE !== 348 && sizeBE !== 348) {
    throw new Error(`${path.basename(fsPath)}: not a NIfTI-1 file (sizeof_hdr=${sizeLE})`);
  }
  const le = sizeLE === 348;

  const readI16 = (off: number) => le ? headerBuf.readInt16LE(off) : headerBuf.readInt16BE(off);
  const readF32 = (off: number) => le ? headerBuf.readFloatLE(off) : headerBuf.readFloatBE(off);

  const ndim = readI16(40);
  const dims: number[] = [];
  for (let i = 1; i <= ndim; i++) { dims.push(readI16(40 + i * 2)); }

  const pixdims: number[] = [];
  for (let i = 1; i <= ndim; i++) { pixdims.push(readF32(76 + i * 4)); }

  const datatype = readI16(70);
  const bitpix = readI16(72);
  const rawVoxOffset = readF32(108);
  const voxOffset = rawVoxOffset >= 352 ? rawVoxOffset : 352;

  const qformCode = readI16(252);
  const sformCode = readI16(254);

  let dirMatrix: number[][] | null = null;
  if (sformCode > 0) {
    dirMatrix = [
      [readF32(280), readF32(284), readF32(288)],
      [readF32(296), readF32(300), readF32(304)],
      [readF32(312), readF32(316), readF32(320)],
    ];
  } else if (qformCode > 0) {
    const b = readF32(256), c = readF32(260), d = readF32(264), qfac = readF32(76);
    const a = Math.sqrt(Math.max(0, 1 - b*b - c*c - d*d));
    dirMatrix = [
      [a*a+b*b-c*c-d*d, 2*(b*c-a*d),    2*(b*d+a*c)],
      [2*(b*c+a*d),     a*a+c*c-b*b-d*d, 2*(c*d-a*b)],
      [2*(b*d-a*c),     2*(c*d+a*b),    a*a+d*d-b*b-c*c],
    ];
    if (qfac < 0) { for (let r = 0; r < 3; r++) { dirMatrix[r][2] *= -1; } }
  }

  return { fsPath, le, ndim, dims, pixdims, voxOffset, datatype, bitpix, dirMatrix, headerBuf };
}

function readNifti1VoxelData(info: Nifti1Info): Buffer {
  if (info.fsPath.endsWith('.gz')) {
    const compressed = fs.readFileSync(info.fsPath);
    const decompressed = zlib.gunzipSync(compressed);
    return Buffer.from(decompressed.subarray(info.voxOffset));
  }
  const stat = fs.statSync(info.fsPath);
  const dataSize = stat.size - info.voxOffset;
  if (dataSize <= 0) { throw new Error(`${path.basename(info.fsPath)}: no voxel data`); }
  const fd = fs.openSync(info.fsPath, 'r');
  const buf = Buffer.alloc(dataSize);
  fs.readSync(fd, buf, 0, dataSize, info.voxOffset);
  fs.closeSync(fd);
  return buf;
}

function matrixEq(a: number[][] | null, b: number[][] | null, tol = 1e-3): boolean {
  if (!a && !b) { return true; }
  if (!a || !b) { return false; }
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (Math.abs(a[i][j] - b[i][j]) > tol) { return false; }
    }
  }
  return true;
}

function validateNifti1Compat(infos: Nifti1Info[]): void {
  const ref = infos[0];
  for (let i = 1; i < infos.length; i++) {
    const info = infos[i];
    const name = path.basename(info.fsPath);
    if (info.ndim !== ref.ndim) {
      throw new Error(`${name}: ndim mismatch (${info.ndim} vs ${ref.ndim})`);
    }
    const spatialN = Math.min(3, ref.dims.length);
    for (let d = 0; d < spatialN; d++) {
      if (info.dims[d] !== ref.dims[d]) {
        throw new Error(`${name}: size mismatch in dim ${d + 1} (${info.dims[d]} vs ${ref.dims[d]})`);
      }
    }
    for (let d = 0; d < spatialN; d++) {
      if (Math.abs(info.pixdims[d] - ref.pixdims[d]) > 1e-3) {
        throw new Error(`${name}: spacing mismatch in dim ${d + 1} (${info.pixdims[d].toFixed(4)} vs ${ref.pixdims[d].toFixed(4)})`);
      }
    }
    if (!matrixEq(info.dirMatrix, ref.dirMatrix)) {
      throw new Error(`${name}: direction matrix mismatch`);
    }
    if (info.datatype !== ref.datatype) {
      throw new Error(`${name}: datatype mismatch (${info.datatype} vs ${ref.datatype})`);
    }
  }
}

function buildStackedNifti1Header(ref: Nifti1Info, nVolumes: number): Buffer {
  const h = Buffer.from(ref.headerBuf);
  const writeI16 = (off: number, v: number) => ref.le ? h.writeInt16LE(v, off) : h.writeInt16BE(v, off);
  const writeF32 = (off: number, v: number) => ref.le ? h.writeFloatLE(v, off) : h.writeFloatBE(v, off);

  const newNdim = ref.ndim + 1;
  writeI16(40, newNdim);
  writeI16(40 + newNdim * 2, nVolumes);
  writeF32(76 + newNdim * 4, 1.0);  // pixdim for new dim = 1.0
  writeF32(108, 352.0);              // vox_offset

  // Clear dim[newNdim+1 .. 7] to 1 to avoid stale values
  for (let d = newNdim + 1; d <= 7; d++) { writeI16(40 + d * 2, 1); }

  return h;
}

async function stackNiftiFiles(uris: vscode.Uri[]): Promise<void> {
  // Parse and validate
  const infos = uris.map(u => parseNifti1Info(u.fsPath));
  validateNifti1Compat(infos);

  const ref = infos[0];
  const N = uris.length;
  const dir = path.dirname(ref.fsPath);
  const newNdim = ref.ndim + 1;
  const outputDims = [...ref.dims.slice(0, 3), N];

  const isGz = uris.every(u => u.fsPath.endsWith('.gz'));
  const defaultName = `stacked_${N}vols.nii${isGz ? '.gz' : ''}`;
  const outputName = await vscode.window.showInputBox({
    prompt: 'Output filename (saved to same directory)',
    value: defaultName,
    validateInput: v => v.trim() ? null : 'Filename cannot be empty',
  });
  if (!outputName) { return; }

  const outputPath = path.join(dir, outputName.trim());
  if (fs.existsSync(outputPath)) {
    const choice = await vscode.window.showWarningMessage(
      `${path.basename(outputPath)} already exists. Overwrite?`,
      'Overwrite', 'Cancel'
    );
    if (choice !== 'Overwrite') { return; }
  }

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Stacking ${N} NIfTI volumes…`,
    cancellable: false,
  }, async progress => {
    progress.report({ message: 'Reading volumes…' });
    const volumeBuffers = infos.map(info => readNifti1VoxelData(info));

    progress.report({ message: 'Writing output…' });
    const newHeader = buildStackedNifti1Header(ref, N);
    const extender = Buffer.alloc(4);
    const raw = Buffer.concat([newHeader, extender, ...volumeBuffers]);
    const output = outputPath.endsWith('.gz') ? zlib.gzipSync(raw) : raw;
    fs.writeFileSync(outputPath, output);
  });

  vscode.window.showInformationMessage(
    `Stacked ${N} volumes → ${path.basename(outputPath)}  [${outputDims.join('×')}]  NIfTI-${newNdim}D`
  );
}

// ─── NRRD ─────────────────────────────────────────────────────────────────────

interface NrrdInfo {
  fsPath: string;
  kvPairs: Record<string, string>;
  dimension: number;
  sizes: number[];
  spaceDirs: string;   // raw 'space directions' field value
  type: string;
  encoding: string;
  dataOffset: number;  // byte offset where data begins (inline data files only)
}

function parseNrrdInfo(fsPath: string): NrrdInfo {
  const fileBuf = fs.readFileSync(fsPath);

  // Find data separator: \n\n or \r\n\r\n
  let dataOffset = -1;
  for (let i = 0; i < fileBuf.length - 1; i++) {
    if (fileBuf[i] === 0x0a && fileBuf[i + 1] === 0x0a) {
      dataOffset = i + 2; break;
    }
    if (fileBuf[i] === 0x0d && fileBuf[i + 1] === 0x0a &&
        i + 3 < fileBuf.length && fileBuf[i + 2] === 0x0d && fileBuf[i + 3] === 0x0a) {
      dataOffset = i + 4; break;
    }
  }
  if (dataOffset === -1) {
    throw new Error(`${path.basename(fsPath)}: NRRD data separator not found`);
  }

  const headerText = fileBuf.subarray(0, dataOffset).toString('utf8');
  const lines = headerText.split(/\r?\n/);

  if (!lines[0]?.startsWith('NRRD')) {
    throw new Error(`${path.basename(fsPath)}: not a valid NRRD file`);
  }

  const kvPairs: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith('#')) { continue; }
    const sep = line.includes(':=') ? ':=' : ':';
    const idx = line.indexOf(sep);
    if (idx !== -1) {
      kvPairs[line.substring(0, idx).trim().toLowerCase()] = line.substring(idx + sep.length).trim();
    }
  }

  const dataFile = kvPairs['data file'] ?? kvPairs['datafile'];
  if (dataFile) {
    throw new Error(`${path.basename(fsPath)}: detached NRRD (separate data file) is not supported`);
  }

  const dimension = parseInt(kvPairs['dimension'] ?? '0', 10);
  const sizesRaw = (kvPairs['sizes'] ?? '').split(/\s+/).filter(Boolean);
  const sizes = sizesRaw.map(Number);
  const encoding = (kvPairs['encoding'] ?? 'raw').toLowerCase();
  const type = kvPairs['type'] ?? '';
  const spaceDirs = kvPairs['space directions'] ?? '';

  if (!['raw', 'gzip', 'gz'].includes(encoding)) {
    throw new Error(`${path.basename(fsPath)}: unsupported NRRD encoding '${encoding}' (only raw/gzip supported)`);
  }

  return { fsPath, kvPairs, dimension, sizes, spaceDirs, type, encoding, dataOffset };
}

function readNrrdVoxelData(info: NrrdInfo): Buffer {
  const fileBuf = fs.readFileSync(info.fsPath);
  const rawData = fileBuf.subarray(info.dataOffset);
  if (info.encoding === 'gzip' || info.encoding === 'gz') {
    return Buffer.from(zlib.gunzipSync(rawData));
  }
  return Buffer.from(rawData);
}

function validateNrrdCompat(infos: NrrdInfo[]): void {
  const ref = infos[0];
  for (let i = 1; i < infos.length; i++) {
    const info = infos[i];
    const name = path.basename(info.fsPath);

    if (info.dimension !== ref.dimension) {
      throw new Error(`${name}: dimension mismatch (${info.dimension} vs ${ref.dimension})`);
    }
    if (info.type !== ref.type) {
      throw new Error(`${name}: type mismatch ('${info.type}' vs '${ref.type}')`);
    }
    if (info.sizes.length !== ref.sizes.length) {
      throw new Error(`${name}: sizes length mismatch`);
    }
    for (let d = 0; d < ref.sizes.length; d++) {
      if (info.sizes[d] !== ref.sizes[d]) {
        throw new Error(`${name}: size mismatch in dim ${d + 1} (${info.sizes[d]} vs ${ref.sizes[d]})`);
      }
    }
    // Compare space directions as normalized strings
    if (normalizeSpaceDirs(info.spaceDirs) !== normalizeSpaceDirs(ref.spaceDirs)) {
      throw new Error(`${name}: space directions mismatch`);
    }
  }
}

function normalizeSpaceDirs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function buildStackedNrrdHeader(ref: NrrdInfo, nVolumes: number): string {
  const kv = ref.kvPairs;
  const version = ref.kvPairs['nrrd version'] ?? 'NRRD0004';  // not a real field, use magic line

  // Reconstruct header lines in order
  const lines: string[] = [];

  // We'll read the original file's magic line
  const fileBuf = fs.readFileSync(ref.fsPath);
  const magic = fileBuf.toString('utf8').split('\n')[0].trim();
  lines.push(magic);

  // Output fields in canonical order, modifying what's needed
  const newDimension = ref.dimension + 1;
  const newSizes = [...ref.sizes, nVolumes].join(' ');

  // Space directions: append ' none' for the new stacked axis
  let newSpaceDirs = ref.spaceDirs;
  if (newSpaceDirs) { newSpaceDirs = newSpaceDirs + ' none'; }

  // Rebuild key fields
  const fieldOrder = [
    'type', 'dimension', 'space', 'sizes', 'space directions',
    'kinds', 'endian', 'encoding', 'space origin', 'spacings',
    'measurement frame', 'content',
  ];

  const overrides: Record<string, string> = {
    'dimension': String(newDimension),
    'sizes': newSizes,
    'space directions': newSpaceDirs || '',
    'encoding': 'raw',  // always write raw
  };

  // Append ' list' to kinds if present
  if (kv['kinds']) {
    overrides['kinds'] = kv['kinds'] + ' list';
  }

  const written = new Set<string>();
  for (const key of fieldOrder) {
    const val = overrides[key] ?? kv[key];
    if (val !== undefined && val !== '') {
      lines.push(`${key}: ${val}`);
      written.add(key);
    }
  }

  // Any remaining key-value pairs not yet written
  for (const [key, val] of Object.entries(kv)) {
    if (!written.has(key) && key !== 'data file' && key !== 'datafile') {
      lines.push(`${key}: ${val}`);
    }
  }

  return lines.join('\n') + '\n\n';
}

async function stackNrrdFiles(uris: vscode.Uri[]): Promise<void> {
  const infos = uris.map(u => parseNrrdInfo(u.fsPath));
  validateNrrdCompat(infos);

  const ref = infos[0];
  const N = uris.length;
  const dir = path.dirname(ref.fsPath);
  const outputDims = [...ref.sizes, N];

  const defaultName = `stacked_${N}vols.nrrd`;
  const outputName = await vscode.window.showInputBox({
    prompt: 'Output filename (saved to same directory)',
    value: defaultName,
    validateInput: v => v.trim() ? null : 'Filename cannot be empty',
  });
  if (!outputName) { return; }

  const outputPath = path.join(dir, outputName.trim());
  if (fs.existsSync(outputPath)) {
    const choice = await vscode.window.showWarningMessage(
      `${path.basename(outputPath)} already exists. Overwrite?`,
      'Overwrite', 'Cancel'
    );
    if (choice !== 'Overwrite') { return; }
  }

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Stacking ${N} NRRD volumes…`,
    cancellable: false,
  }, async progress => {
    progress.report({ message: 'Reading volumes…' });
    const volumeBuffers = infos.map(info => readNrrdVoxelData(info));

    progress.report({ message: 'Writing output…' });
    const headerStr = buildStackedNrrdHeader(ref, N);
    const headerBuf = Buffer.from(headerStr, 'utf8');
    const output = Buffer.concat([headerBuf, ...volumeBuffers]);
    fs.writeFileSync(outputPath, output);
  });

  vscode.window.showInformationMessage(
    `Stacked ${N} volumes → ${path.basename(outputPath)}  [${outputDims.join('×')}]  NRRD ${ref.dimension + 1}D`
  );
}

// ─── Entry point ──────────────────────────────────────────────────────────────

function isNifti(fsPath: string): boolean {
  return fsPath.endsWith('.nii') || fsPath.endsWith('.nii.gz');
}

function isNrrd(fsPath: string): boolean {
  return fsPath.endsWith('.nrrd') || fsPath.endsWith('.seq.nrrd');
}

export async function stackMedicalImages(
  clickedUri: vscode.Uri,
  allUris: vscode.Uri[]
): Promise<void> {
  const uris = allUris && allUris.length > 1 ? allUris : [clickedUri];

  if (uris.length < 2) {
    vscode.window.showErrorMessage(
      'Stack Images requires 2+ files. Cmd+click (macOS) or Ctrl+click (Windows/Linux) to multi-select, then right-click.'
    );
    return;
  }

  // Determine format from clicked file
  const firstPath = uris[0].fsPath;

  try {
    if (isNifti(firstPath)) {
      for (const u of uris) {
        if (!isNifti(u.fsPath)) {
          throw new Error(`Mixed formats: expected NIfTI, got ${path.basename(u.fsPath)}`);
        }
      }
      await stackNiftiFiles(uris);
    } else if (isNrrd(firstPath)) {
      for (const u of uris) {
        if (!isNrrd(u.fsPath)) {
          throw new Error(`Mixed formats: expected NRRD, got ${path.basename(u.fsPath)}`);
        }
      }
      await stackNrrdFiles(uris);
    } else {
      vscode.window.showErrorMessage('Stacking is supported for NIfTI (.nii, .nii.gz) and NRRD (.nrrd) files only.');
    }
  } catch (e: any) {
    vscode.window.showErrorMessage(`Stack failed: ${e.message}`);
  }
}
