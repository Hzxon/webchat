// Photos and files on the page (R-005, D-123): getting one ready to send, and opening one received.
import { decryptFile } from '../../shared/e2ee';
import { fileTypeOf, isPhotoType, LIMITS, type FileDTO } from '../../shared/types';
import { api } from './api';

/** What the message box sends: the bytes to encrypt and upload, and the sealed field without its id and key yet. */
export interface Attachment {
  blob: Blob;
  file: FileDTO;
}

export const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** What an older page, a push and the chat list show for a file message. */
export const fileText = (file: FileDTO) => (isPhotoType(file.type) ? '📷 Photo' : `📎 ${file.name}, ${formatSize(file.size)}`);

/** The server drops a file after 7 days; the page tells from the message's time and asks for nothing. */
export const isExpired = (sentAt: number) => sentAt + LIMITS.fileDays * 86_400_000 <= Date.now();

function draw(image: ImageBitmap, width: number, height: number) {
  const canvas = document.createElement('canvas');
  [canvas.width, canvas.height] = [width, height];
  const context = canvas.getContext('2d')!;
  // JPEG has no transparency: a transparent PNG gets white behind it, not black.
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvas;
}

const toBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The photo could not be read.'))), 'image/jpeg', 0.85));

/** A tiny copy, at most 8 pixels a side, to blur while the photo loads and after it expires; a push still carries it whole (D-017). */
function previewOf(image: ImageBitmap): string {
  const scale = 8 / Math.max(image.width, image.height);
  return draw(image, Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale))).toDataURL('image/png');
}

/**
 * Checks a picked file and gets it ready. A photo is drawn again at most 1600 pixels on its longer
 * side as a JPEG, which also drops its GPS position and device details. Throws an Error whose
 * message the page shows.
 */
export async function prepareFile(picked: File): Promise<Attachment> {
  // Only the first bytes of a large file: a photo shrinks, anything else that large is refused.
  const head = new Uint8Array(await picked.slice(0, picked.size > LIMITS.fileBytes ? 16 : picked.size).arrayBuffer());
  const type = fileTypeOf(picked.name, head);
  if (!type) throw new Error('WebChat sends photos, PDFs, Office files, text and zip files only.');
  if (!isPhotoType(type)) {
    if (picked.size > LIMITS.fileBytes) throw new Error('A file is at most 10 MB.');
    return { blob: picked, file: { id: '', key: '', name: picked.name.slice(-LIMITS.fileNameLength), type, size: picked.size } };
  }
  const image = await createImageBitmap(picked);
  const scale = Math.min(1, LIMITS.photoPixels / Math.max(image.width, image.height));
  const [width, height] = [Math.round(image.width * scale), Math.round(image.height * scale)];
  const blob = await toBlob(draw(image, width, height));
  const preview = previewOf(image);
  image.close();
  const name = `${picked.name.replace(/\.[^.]*$/, '').slice(0, LIMITS.fileNameLength - 4)}.jpg`;
  return { blob, file: { id: '', key: '', name, type: 'image/jpeg', size: blob.size, width, height, preview } };
}

/** A file whose contents are not what its sealed field says. */
export class RefusedFileError extends Error {}

const opened = new Map<string, Promise<string>>();

/**
 * Downloads, decrypts and checks a file, and returns an address of its plain bytes on this page. A
 * file is refused unless its type is on the list and its first bytes match the type its name
 * claims, whatever the sender's page did (D-123).
 */
export function openFile(file: FileDTO): Promise<string> {
  let url = opened.get(file.id);
  if (!url) {
    url = (async () => {
      const { url: address } = await api.fileAddress(file.id);
      const res = await fetch(address);
      if (!res.ok) throw new Error('The file could not be downloaded.');
      const plain = await decryptFile(file.key, new Uint8Array(await res.arrayBuffer()));
      if (fileTypeOf(file.name, plain) !== file.type) throw new RefusedFileError('This file was refused: its contents do not match its name.');
      return URL.createObjectURL(new Blob([plain], { type: file.type }));
    })();
    // A failure may pass, as a lost connection does, so the next try starts over.
    url.catch(() => opened.delete(file.id));
    opened.set(file.id, url);
  }
  return url;
}

/** Saves a file to the device. It is never opened inside the page. */
export async function downloadFile(file: FileDTO) {
  const link = document.createElement('a');
  link.href = await openFile(file);
  link.download = file.name;
  link.click();
  // The device has the file now; do not hold up to 10 MB for the rest of the visit.
  opened.delete(file.id);
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
