import * as fs from 'fs';
import * as zlib from 'zlib';
import * as path from 'path';
import { ImageMetadata, MetadataField, computeOrientationAxes } from './index';

const DATATYPE_MAP: Record<number, string> = {
  0: 'UNKNOWN',
  1: 'BINARY',
  2: 'UINT8',
  4: 'INT16',
  8: 'INT32',
  16: 'FLOAT32',
  32: 'COMPLEX64',
  64: 'FLOAT64',
  128: 'RGB24',
  255: 'ALL',
  256: 'INT8',
  512: 'UINT16',
  768: 'UINT32',
  1024: 'INT64',
  1280: 'UINT64',
  1536: 'FLOAT128',
  1792: 'COMPLEX128',
  2048: 'COMPLEX256',
};

const INTENT_MAP: Record<number, string> = {
  0: 'NONE',
  2: 'CORREL',
  3: 'TTEST',
  4: 'FTEST',
  5: 'ZSCORE',
  6: 'CHISQ',
  1001: 'ESTIMATE',
  1002: 'LABEL',
  1003: 'NEURONAME',
  1004: 'MATRIX',
  1005: 'SYMMATRIX',
  1006: 'DISPVECT',
  1007: 'VECTOR',
  1008: 'POINTSET',
  1009: 'TRIANGLE',
  1010: 'QUATERNION',
  1011: 'DIMLESS',
  2001: 'TIME_SERIES',
  2002: 'NODE_INDEX',
  2003: 'RGB_VECTOR',
  2004: 'RGBA_VECTOR',
  2005: 'SHAPE',
};

const FORM_CODE_MAP: Record<number, string> = {
  0: 'UNKNOWN',
  1: 'SCANNER_ANAT',
  2: 'ALIGNED_ANAT',
  3: 'TALAIRACH',
  4: 'MNI_152',
};

function fmt3(v: number): string { return v.toFixed(4).padStart(9); }

/** Format a 3×3 matrix as three "[ x  y  z ]" strings (one per voxel axis / column). */
function formatDirectionMatrix(M: number[][]): string[] {
  // Transpose: show column-as-axis (i, j, k axes as rows of output)
  return [0, 1, 2].map(col =>
    `[ ${fmt3(M[0][col])}  ${fmt3(M[1][col])}  ${fmt3(M[2][col])} ]`
  );
}

/**
 * Build 3×3 RAS matrix from NIfTI-1 quaternion (qform) parameters.
 * Returns M[worldRow][voxelCol].
 */
function quaternionToMatrix(b: number, c: number, d: number, qfac: number): number[][] {
  const a = Math.sqrt(Math.max(0, 1 - b * b - c * c - d * d));
  // Standard quaternion → rotation matrix (NIfTI spec, section 4.4.2)
  const R: number[][] = [
    [a*a+b*b-c*c-d*d,  2*(b*c - a*d),    2*(b*d + a*c)],
    [2*(b*c + a*d),    a*a+c*c-b*b-d*d,  2*(c*d - a*b)],
    [2*(b*d - a*c),    2*(c*d + a*b),    a*a+d*d-b*b-c*c],
  ];
  // qfac flips the k-axis direction
  if (qfac < 0) {
    for (let row = 0; row < 3; row++) { R[row][2] *= -1; }
  }
  return R;
}

/**
 * Parse the gzip header and return the byte offset where the deflate
 * compressed payload starts. Throws if the magic bytes are wrong.
 *
 * Gzip header layout (RFC 1952):
 *   2  magic (1f 8b)
 *   1  method (08)
 *   1  FLG
 *   4  MTIME
 *   1  XFL
 *   1  OS
 *   [FEXTRA] 2-byte len + data   if FLG & 0x04
 *   [FNAME]  null-terminated     if FLG & 0x08
 *   [FCOMMENT] null-terminated   if FLG & 0x10
 *   [FHCRC]  2 bytes             if FLG & 0x02
 */
function skipGzipHeader(buf: Buffer): number {
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) {
    throw new Error('Not a gzip file (bad magic bytes)');
  }
  const flg = buf[3];
  let pos = 10;

  if (flg & 0x04) {          // FEXTRA
    const xlen = buf.readUInt16LE(pos);
    pos += 2 + xlen;
  }
  if (flg & 0x08) {          // FNAME — null-terminated
    while (pos < buf.length && buf[pos] !== 0) { pos++; }
    pos++;
  }
  if (flg & 0x10) {          // FCOMMENT — null-terminated
    while (pos < buf.length && buf[pos] !== 0) { pos++; }
    pos++;
  }
  if (flg & 0x02) { pos += 2; } // FHCRC

  return pos;
}

function readHeader(fsPath: string): Buffer {
  const isGz = fsPath.endsWith('.gz');

  if (isGz) {
    // Read 32 KB of compressed data — more than enough for a 540-byte header.
    const fd = fs.openSync(fsPath, 'r');
    const compBuf = Buffer.alloc(32768);
    const bytesRead = fs.readSync(fd, compBuf, 0, 32768, 0);
    fs.closeSync(fd);
    const compressed = compBuf.subarray(0, bytesRead);

    // Find where the deflate payload starts inside the gzip container.
    const deflateOffset = skipGzipHeader(compressed);
    const deflateData = compressed.subarray(deflateOffset);

    // inflateRawSync with Z_SYNC_FLUSH tolerates a truncated deflate stream.
    const decompressed = zlib.inflateRawSync(deflateData, {
      finishFlush: zlib.constants.Z_SYNC_FLUSH,
    });
    return decompressed.subarray(0, Math.min(decompressed.length, 540));
  } else {
    const fd = fs.openSync(fsPath, 'r');
    const buf = Buffer.alloc(540);
    const bytesRead = fs.readSync(fd, buf, 0, 540, 0);
    fs.closeSync(fd);
    return buf.subarray(0, bytesRead);
  }
}

export function parseNifti(fsPath: string): ImageMetadata {
  const buf = readHeader(fsPath);

  if (buf.length < 4) {
    throw new Error('File too small to be a valid NIfTI file');
  }

  // Detect endianness from sizeof_hdr
  const sizeofHdrLE = buf.readInt32LE(0);
  const sizeofHdrBE = buf.readInt32BE(0);

  let le: boolean;
  let format: string;

  if (sizeofHdrLE === 348 || sizeofHdrBE === 348) {
    le = sizeofHdrLE === 348;
    format = 'NIfTI-1';
  } else if (sizeofHdrLE === 540 || sizeofHdrBE === 540) {
    le = sizeofHdrLE === 540;
    format = 'NIfTI-2';
  } else {
    throw new Error(`Unrecognized sizeof_hdr: ${sizeofHdrLE} (LE) / ${sizeofHdrBE} (BE)`);
  }

  const fields: MetadataField[] = [];

  if (format === 'NIfTI-1') {
    if (buf.length < 348) {
      throw new Error('Buffer too small for NIfTI-1 header');
    }

    const readI16 = (offset: number) => le ? buf.readInt16LE(offset) : buf.readInt16BE(offset);
    const readF32 = (offset: number) => le ? buf.readFloatLE(offset) : buf.readFloatBE(offset);

    // dim array: 8 int16 at offset 40
    const ndim = readI16(40);
    const dims: number[] = [];
    for (let i = 1; i <= Math.min(ndim, 7); i++) {
      dims.push(readI16(40 + i * 2));
    }

    // pixdim array: 8 float32 at offset 76
    const pixdims: number[] = [];
    for (let i = 1; i <= Math.min(ndim, 7); i++) {
      pixdims.push(readF32(76 + i * 4));
    }

    const datatype = readI16(70);
    const bitpix = readI16(72);
    const intentCode = readI16(68);
    const qformCode = readI16(252);
    const sformCode = readI16(254);
    const qoffsetX = readF32(268);
    const qoffsetY = readF32(272);
    const qoffsetZ = readF32(276);

    // Quaternion params for qform
    const quaternB = readF32(256);
    const quaternC = readF32(260);
    const quaternD = readF32(264);
    const qfac = readF32(76); // pixdim[0]

    // sform matrix: srow_x at 280, srow_y at 296, srow_z at 312 (4 float32 each)
    const srowX = [readF32(280), readF32(284), readF32(288), readF32(292)];
    const srowY = [readF32(296), readF32(300), readF32(304), readF32(308)];
    const srowZ = [readF32(312), readF32(316), readF32(320), readF32(324)];

    // descrip: char[80] at offset 148
    const descripBytes = buf.subarray(148, 228);
    const nullIdx = descripBytes.indexOf(0);
    const descrip = descripBytes.subarray(0, nullIdx >= 0 ? nullIdx : 80).toString('ascii').trim();

    const dtypeName = DATATYPE_MAP[datatype] ?? `TYPE_${datatype}`;

    // Build direction matrix in RAS space: M[worldRow][voxelCol]
    let dirMatrix: number[][] | null = null;
    let orientAxes = '';

    if (sformCode > 0) {
      // Use sform (most reliable when available)
      dirMatrix = [
        [srowX[0], srowX[1], srowX[2]],
        [srowY[0], srowY[1], srowY[2]],
        [srowZ[0], srowZ[1], srowZ[2]],
      ];
    } else if (qformCode > 0) {
      // Fall back to quaternion-derived rotation matrix
      dirMatrix = quaternionToMatrix(quaternB, quaternC, quaternD, qfac);
      // Scale each column by the corresponding voxel size
      for (let col = 0; col < 3; col++) {
        const scale = pixdims[col] ?? 1;
        for (let row = 0; row < 3; row++) { dirMatrix[row][col] *= scale; }
      }
    }

    if (dirMatrix) {
      orientAxes = computeOrientationAxes(dirMatrix);
    }

    fields.push(
      { label: 'Format', value: 'NIfTI-1', group: 'Header' },
      { label: 'Endian', value: le ? 'Little-Endian' : 'Big-Endian', group: 'Header' },
      { label: 'Dimensions (ndim)', value: String(ndim), group: 'Geometry' },
      { label: 'Sizes', value: dims.join(' × '), group: 'Geometry' },
      { label: 'Voxel Sizes (mm)', value: pixdims.map(v => v.toFixed(4)).join(' × '), group: 'Geometry' },
      { label: 'Data Type', value: `${dtypeName} (${datatype})`, group: 'Data' },
      { label: 'Bits per Voxel', value: String(bitpix), group: 'Data' },
      { label: 'Intent Code', value: `${INTENT_MAP[intentCode] ?? intentCode}`, group: 'Data' },
      { label: 'qform_code', value: `${FORM_CODE_MAP[qformCode] ?? qformCode} (${qformCode})`, group: 'Orientation' },
      { label: 'sform_code', value: `${FORM_CODE_MAP[sformCode] ?? sformCode} (${sformCode})`, group: 'Orientation' },
      { label: 'Q-Offset (x,y,z mm)', value: `${qoffsetX.toFixed(3)}, ${qoffsetY.toFixed(3)}, ${qoffsetZ.toFixed(3)}`, group: 'Orientation' },
    );

    if (orientAxes) {
      fields.push({ label: 'Orientation Axes', value: orientAxes, group: 'Orientation' });
    }

    if (dirMatrix) {
      const rows = formatDirectionMatrix(dirMatrix);
      fields.push(
        { label: 'i-axis direction (RAS)', value: rows[0], group: 'Orientation' },
        { label: 'j-axis direction (RAS)', value: rows[1], group: 'Orientation' },
        { label: 'k-axis direction (RAS)', value: rows[2], group: 'Orientation' },
      );
    }

    if (dirMatrix && sformCode > 0) {
      fields.push(
        { label: 'sform Translation (mm)', value: `${srowX[3].toFixed(3)}, ${srowY[3].toFixed(3)}, ${srowZ[3].toFixed(3)}`, group: 'Orientation' },
      );
    }

    if (descrip) {
      fields.push({ label: 'Description', value: descrip, group: 'Header' });
    }

    const spatialDims = dims.slice(0, 3);
    const brief = `${spatialDims.join('×')}  ${dtypeName}${orientAxes ? '  ' + orientAxes : ''}`;

    return { format, fields, brief };
  } else {
    // NIfTI-2
    if (buf.length < 80) {
      throw new Error('Buffer too small for NIfTI-2 header');
    }

    const readI16 = (offset: number) => le ? buf.readInt16LE(offset) : buf.readInt16BE(offset);
    const readI64 = (offset: number): bigint => le ? buf.readBigInt64LE(offset) : buf.readBigInt64BE(offset);
    const readF64 = (offset: number) => le ? buf.readDoubleLE(offset) : buf.readDoubleBE(offset);

    const datatype = readI16(12);
    const dtypeName = DATATYPE_MAP[datatype] ?? `TYPE_${datatype}`;

    // dim: int64[8] at offset 16
    const ndim = Number(readI64(16));
    const dims: number[] = [];
    for (let i = 1; i <= Math.min(ndim, 7); i++) {
      dims.push(Number(readI64(16 + i * 8)));
    }

    // pixdim: float64[8] at offset 104
    const pixdims: number[] = [];
    for (let i = 1; i <= Math.min(ndim, 7); i++) {
      pixdims.push(readF64(104 + i * 8));
    }

    // NIfTI-2 sform: srow_x at 280, srow_y at 312, srow_z at 344 (8 float64 each)
    // NIfTI-2 qform codes at offset 344 (int32) ... actually at 500 and 504
    // srow_x[4]: float64[4] at 280; srow_y at 312; srow_z at 344
    let orientAxes = '';
    let dirMatrix: number[][] | null = null;
    if (buf.length >= 376) {
      const srowX2 = [readF64(280), readF64(288), readF64(296), readF64(304)];
      const srowY2 = [readF64(312), readF64(320), readF64(328), readF64(336)];
      const srowZ2 = [readF64(344), readF64(352), readF64(360), readF64(368)];
      dirMatrix = [
        [srowX2[0], srowX2[1], srowX2[2]],
        [srowY2[0], srowY2[1], srowY2[2]],
        [srowZ2[0], srowZ2[1], srowZ2[2]],
      ];
      orientAxes = computeOrientationAxes(dirMatrix);
    }

    fields.push(
      { label: 'Format', value: 'NIfTI-2', group: 'Header' },
      { label: 'Endian', value: le ? 'Little-Endian' : 'Big-Endian', group: 'Header' },
      { label: 'Dimensions (ndim)', value: String(ndim), group: 'Geometry' },
      { label: 'Sizes', value: dims.join(' × '), group: 'Geometry' },
      { label: 'Voxel Sizes', value: pixdims.map(v => v.toFixed(4)).join(' × '), group: 'Geometry' },
      { label: 'Data Type', value: `${dtypeName} (${datatype})`, group: 'Data' },
    );

    if (orientAxes) {
      fields.push({ label: 'Orientation Axes', value: orientAxes, group: 'Orientation' });
    }
    if (dirMatrix) {
      const rows = formatDirectionMatrix(dirMatrix);
      fields.push(
        { label: 'i-axis direction (RAS)', value: rows[0], group: 'Orientation' },
        { label: 'j-axis direction (RAS)', value: rows[1], group: 'Orientation' },
        { label: 'k-axis direction (RAS)', value: rows[2], group: 'Orientation' },
      );
    }

    const spatialDims = dims.slice(0, 3);
    const brief = `${spatialDims.join('×')}  ${dtypeName}${orientAxes ? '  ' + orientAxes : '  NIfTI-2'}`;

    return { format, fields, brief };
  }
}
