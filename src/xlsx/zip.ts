import { deflateRawSync } from 'node:zlib';

/**
 * A minimal ZIP writer, just enough to build an .xlsx container.
 *
 * Why hand-rolled rather than a library: the whole server deliberately has two
 * runtime dependencies (the MCP SDK and zod). An .xlsx file is a ZIP of a handful
 * of XML parts, and the subset needed for a data table — local headers, a central
 * directory and a single end-of-directory record — is small, fully specified and
 * easy to verify byte for byte in tests. Pulling in a spreadsheet library would
 * add an order of magnitude more code than this file to the image.
 *
 * Only two storage methods are emitted: raw stored (0) and deflate (8), the two
 * every reader supports. Identity CRC-32 and the sizes are always written, so a
 * reader can verify the archive; `unzip -t` and Excel both accept the result.
 */

/** CRC-32 (IEEE 802.3) lookup table, built once per process. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Path inside the archive, always with forward slashes. */
  name: string;
  data: string | Uint8Array;
}

export interface ZipOptions {
  /** Timestamp recorded for every entry. Fixed by tests so output is reproducible. */
  modifiedAt?: Date;
  /** Deflate depth. 9 keeps the workbook small; the input is tiny anyway. */
  level?: number;
}

export function createZip(entries: readonly ZipEntry[], options: ZipOptions = {}): Buffer {
  const modifiedAt = options.modifiedAt ?? new Date();
  const level = options.level ?? 9;
  const { time, date } = dosDateTime(modifiedAt);

  const chunks: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data);
    const deflated = deflateRawSync(raw, { level });

    // Storing beats deflating on very small parts (a stored entry has no
    // deflate wrapper at all), so pick whichever is actually smaller.
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(raw);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // general purpose flag: UTF-8 names
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    chunks.push(localHeader, name, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central directory signature
    centralHeader.writeUInt16LE(0x031e, 4); // version made by: 3.0, UNIX host
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // flags: UTF-8 names
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attributes
    // External attributes: regular file, mode 0644, so `unzip` on Unix extracts
    // the parts with sane permissions instead of 000. The shift overflows a signed
    // 32-bit integer, so it is forced back into the unsigned range.
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralDirectory.push(centralHeader, name);
    offset += localHeader.length + name.length + payload.length;
  }

  const centralSize = centralDirectory.reduce((total, chunk) => total + chunk.length, 0);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, ...centralDirectory, end]);
}

/**
 * Converts a date to the MS-DOS time/date pair the ZIP format requires.
 *
 * The format cannot represent years before 1980 and stores seconds in two-second
 * steps, so both are clamped instead of overflowing into a corrupt header.
 */
function dosDateTime(value: Date): { time: number; date: number } {
  const year = Math.max(1980, value.getFullYear());
  const date = ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate();
  const time = (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2);
  return { time: time & 0xffff, date: date & 0xffff };
}
