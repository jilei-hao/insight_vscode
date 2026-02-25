import * as fs from 'fs';
import * as zlib from 'zlib';
import * as path from 'path';
import { ImageMetadata, MetadataField } from './index';

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

function getOrientString(qformCode: number, sformCode: number): string {
  const dominant = sformCode > 0 ? sformCode : qformCode;
  return FORM_CODE_MAP[dominant] ?? `CODE_${dominant}`;
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

    // descrip: char[80] at offset 148
    const descripBytes = buf.subarray(148, 228);
    const nullIdx = descripBytes.indexOf(0);
    const descrip = descripBytes.subarray(0, nullIdx >= 0 ? nullIdx : 80).toString('ascii').trim();

    const dtypeName = DATATYPE_MAP[datatype] ?? `TYPE_${datatype}`;

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
      { label: 'Q-Offset (x,y,z)', value: `${qoffsetX.toFixed(3)}, ${qoffsetY.toFixed(3)}, ${qoffsetZ.toFixed(3)}`, group: 'Orientation' },
    );

    if (descrip) {
      fields.push({ label: 'Description', value: descrip, group: 'Header' });
    }

    const orient = getOrientString(qformCode, sformCode);
    const spatialDims = dims.slice(0, 3);
    const brief = `${spatialDims.join('×')}  ${dtypeName}  ${orient}`;

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

    fields.push(
      { label: 'Format', value: 'NIfTI-2', group: 'Header' },
      { label: 'Endian', value: le ? 'Little-Endian' : 'Big-Endian', group: 'Header' },
      { label: 'Dimensions (ndim)', value: String(ndim), group: 'Geometry' },
      { label: 'Sizes', value: dims.join(' × '), group: 'Geometry' },
      { label: 'Voxel Sizes', value: pixdims.map(v => v.toFixed(4)).join(' × '), group: 'Geometry' },
      { label: 'Data Type', value: `${dtypeName} (${datatype})`, group: 'Data' },
    );

    const spatialDims = dims.slice(0, 3);
    const brief = `${spatialDims.join('×')}  ${dtypeName}  NIfTI-2`;

    return { format, fields, brief };
  }
}
