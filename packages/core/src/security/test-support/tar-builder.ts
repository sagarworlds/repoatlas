import { Readable } from "node:stream";

/**
 * Test helper: builds raw ustar archives in memory so tests can craft malicious tarballs
 * without the network or the `tar` package's own (sanitising) writer.
 */
export interface TarEntrySpec {
  path: string;
  type?: "file" | "dir" | "symlink" | "hardlink";
  content?: string | Buffer;
  /** Link target for symlink/hardlink entries. */
  linkTarget?: string;
  /** Put the path in a pax extended header (needed for NUL bytes or names > 100 bytes). */
  pax?: boolean;
  /** Override the size field (to lie about the content size). */
  declaredSize?: number;
}

const BLOCK = 512;

function writeString(block: Buffer, offset: number, length: number, value: string): void {
  Buffer.from(value, "utf8").copy(block, offset, 0, length);
}

function octal(value: number, digits: number): string {
  return `${value.toString(8).padStart(digits, "0")}\0`;
}

function header(name: string, typeflag: string, size: number, linkName: string): Buffer {
  const block = Buffer.alloc(BLOCK);
  writeString(block, 0, 100, name);
  writeString(block, 100, 8, octal(0o644, 7));
  writeString(block, 108, 8, octal(0, 7));
  writeString(block, 116, 8, octal(0, 7));
  writeString(block, 124, 12, octal(size, 11));
  writeString(block, 136, 12, octal(0, 11));
  block.fill(0x20, 148, 156); // checksum field counts as spaces while summing
  writeString(block, 156, 1, typeflag);
  writeString(block, 157, 100, linkName);
  writeString(block, 257, 6, "ustar\0");
  writeString(block, 263, 2, "00");
  let sum = 0;
  for (const byte of block) sum += byte;
  writeString(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

function padded(data: Buffer): Buffer {
  const rest = data.length % BLOCK;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rest)]);
}

/** One pax record: "<length> <key>=<value>\n" where length includes itself. */
function paxRecord(key: string, value: string): Buffer {
  const body = Buffer.from(` ${key}=${value}\n`, "utf8");
  let length = body.length + 1;
  while (String(length).length + body.length !== length)
    length = String(length).length + body.length;
  return Buffer.concat([Buffer.from(String(length)), body]);
}

export function buildTar(entries: TarEntrySpec[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? "file";
    const content =
      typeof entry.content === "string"
        ? Buffer.from(entry.content)
        : (entry.content ?? Buffer.alloc(0));
    const typeflag = { file: "0", dir: "5", symlink: "2", hardlink: "1" }[type];
    const hasData = type === "file";
    const size = entry.declaredSize ?? (hasData ? content.length : 0);

    let name = entry.path;
    if (entry.pax === true || Buffer.byteLength(name) > 100) {
      const records = paxRecord("path", entry.path);
      parts.push(header("PaxHeader/entry", "x", records.length, ""), padded(records));
      name = "pax-placeholder";
    }
    parts.push(header(name, typeflag, size, entry.linkTarget ?? ""));
    if (hasData) parts.push(padded(content));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** A Readable over the archive bytes, delivered in small chunks like a network stream. */
export function tarStream(archive: Buffer, chunkSize = 4096): Readable {
  const chunks: Buffer[] = [];
  for (let i = 0; i < archive.length; i += chunkSize)
    chunks.push(archive.subarray(i, i + chunkSize));
  return Readable.from(chunks, { objectMode: false });
}
