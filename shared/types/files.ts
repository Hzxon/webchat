

/**
 * A photo or file, sealed in a message's content as its `file` field (R-005, D-123). The server
 * holds only the ciphertext under `id`; the key, name and preview never reach it.
 */
export interface FileDTO {
  id: string;
  /** Base64url of the file's own AES-256-GCM key. */
  key: string;
  name: string;
  type: string;
  /** Plain bytes. */
  size: number;
  /** For a photo: its size after resizing, and a tiny blurred copy as a data URL. */
  width?: number;
  height?: number;
  preview?: string;
}

/** Where a member uploads a file's ciphertext with one PUT: the server's own route, or a presigned storage address (R-005). */
export interface UploadDTO {
  id: string;
  url: string;
}

// The types a message may carry, by the extension of its name, and how each file starts. No
// programs, scripts, HTML or SVG (R-005). Office files from before 2007 share one container format.
export const ZIP = [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06]];
export const OLE = [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]];
export const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
export const FILE_TYPES: Record<string, { type: string; starts: number[][] }> = {
  jpg: { type: 'image/jpeg', starts: [[0xff, 0xd8, 0xff]] },
  jpeg: { type: 'image/jpeg', starts: [[0xff, 0xd8, 0xff]] },
  png: { type: 'image/png', starts: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  gif: { type: 'image/gif', starts: [text('GIF87a'), text('GIF89a')] },
  webp: { type: 'image/webp', starts: [text('RIFF')] },
  pdf: { type: 'application/pdf', starts: [text('%PDF-')] },
  doc: { type: 'application/msword', starts: OLE },
  ppt: { type: 'application/vnd.ms-powerpoint', starts: OLE },
  xls: { type: 'application/vnd.ms-excel', starts: OLE },
  docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', starts: ZIP },
  pptx: { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', starts: ZIP },
  xlsx: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', starts: ZIP },
  zip: { type: 'application/zip', starts: ZIP },
  txt: { type: 'text/plain', starts: [[]] },
};

/** The types a file may have, for the file picker and the sealed field's check. */
export const FILE_TYPE_LIST = [...new Set(Object.values(FILE_TYPES).map((t) => t.type))];
export const FILE_EXTENSIONS = Object.keys(FILE_TYPES).map((e) => `.${e}`);
export const isPhotoType = (type: string) => type.startsWith('image/');

/**
 * The type of a file by its name, when it is on the list and its bytes start as that type does;
 * otherwise null. The receiving device checks every file with it after decrypting, whatever the
 * sender's page did: a check on the sender's side stops no attacker (D-123).
 */
export function fileTypeOf(name: string, bytes: Uint8Array): string | null {
  const entry = FILE_TYPES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()];
  if (!entry || !name.includes('.')) return null;
  if (!entry.starts.some((start) => start.every((b, i) => bytes[i] === b))) return null;
  if (entry.type === 'image/webp' && String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP') return null;
  if (entry.type === 'text/plain') {
    try {
      if (new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\0')) return null;
    } catch {
      return null;
    }
  }
  return entry.type;
}
