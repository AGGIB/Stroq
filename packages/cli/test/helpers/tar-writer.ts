import { gzipSync } from 'node:zlib';

/**
 * A tar writer for the tests of the archive reader, so that every archive a test reads is spelled out:
 * which header fields it has, how a long name is carried, what comes after the end. It writes what the
 * real tools write (ustar, GNU long names, pax records) and, on purpose, what they never would (a wrong
 * checksum, a size that lies, a link, a tail with data in it). It shares no code with the reader.
 */
export const BLOCK = 512;

const encoder = new TextEncoder();
const bytesOf = (value: string | Uint8Array): Uint8Array =>
  typeof value === 'string' ? encoder.encode(value) : value;

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Octal digits and a NUL in `width` bytes, as GNU tar writes a number. */
export const octal = (value: number, width: number): string =>
  `${value.toString(8).padStart(width - 1, '0')}\0`;

/** The magic and version bytes of the formats. An empty magic is the old v7 format. */
export const FORMATS = {
  ustar: { magic: 'ustar\0', version: '00' },
  gnu: { magic: 'ustar ', version: ' \0' },
  v7: { magic: '', version: '' },
} as const;
export type Format = keyof typeof FORMATS;

export interface HeaderFields {
  readonly name: string | Uint8Array;
  readonly mode: number | string;
  readonly size: number | string | Uint8Array;
  readonly typeflag: string;
  readonly linkname: string;
  readonly format: Format;
  /** Bytes put at 345, which a ustar reader reads as the prefix of the name and a GNU reader does not. */
  readonly prefix: string | Uint8Array;
  /** `unsigned` is the sum a reader accepts; `signed` is the other sum some old writers wrote, and `wrong` is one more than the right sum. */
  readonly checksum: 'unsigned' | 'signed' | 'wrong' | string | Uint8Array;
  /**
   * Bytes put at an offset of the block, after every field and before the checksum is worked out: the
   * way to spell a field this writer has no option for (the owner, the times, the device numbers, the
   * version, a byte in the middle of the link name).
   */
  readonly patches: Readonly<Record<number, string | Uint8Array>>;
}

const SIZE_AT = 124;
const CHECKSUM_AT = 148;
const TYPEFLAG_AT = 156;

function put(block: Uint8Array, at: number, width: number, value: string | Uint8Array): void {
  const raw = bytesOf(value);
  if (raw.length > width) throw new Error(`a field of ${width} bytes was given ${raw.length}`);
  block.set(raw, at);
}

/** The sum of the 512 bytes with the checksum field read as spaces, as unsigned or as signed bytes. */
function sumOf(block: Uint8Array, signed: boolean): number {
  let total = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    const inField = i >= CHECKSUM_AT && i < CHECKSUM_AT + 8;
    const byte = inField ? 0x20 : (block[i] ?? 0);
    total += signed && byte > 127 ? byte - 256 : byte;
  }
  return total;
}

/** One header block. Fields not given are those of an ordinary file of no size. */
export function headerBlock(given: Partial<HeaderFields> = {}): Uint8Array {
  const fields: HeaderFields = {
    name: 'file',
    mode: 0o644,
    size: 0,
    typeflag: '0',
    linkname: '',
    format: 'ustar',
    prefix: '',
    checksum: 'unsigned',
    patches: {},
    ...given,
  };
  const block = new Uint8Array(BLOCK);
  put(block, 0, 100, fields.name);
  put(block, 100, 8, typeof fields.mode === 'number' ? octal(fields.mode, 8) : fields.mode);
  put(block, 108, 8, octal(0, 8));
  put(block, 116, 8, octal(0, 8));
  put(
    block,
    SIZE_AT,
    12,
    typeof fields.size === 'number' ? octal(fields.size, 12) : (fields.size as string | Uint8Array),
  );
  put(block, 136, 12, octal(0, 12));
  put(block, TYPEFLAG_AT, 1, fields.typeflag);
  put(block, 157, 100, fields.linkname);
  put(block, 257, 6, FORMATS[fields.format].magic);
  put(block, 263, 2, FORMATS[fields.format].version);
  put(block, 345, 155, fields.prefix);
  for (const [at, value] of Object.entries(fields.patches)) {
    const raw = bytesOf(value);
    if (Number(at) + raw.length > BLOCK) throw new Error(`a patch at ${at} is past the block`);
    block.set(raw, Number(at));
  }
  const unsigned = sumOf(block, false);
  const text = fields.checksum;
  const stored =
    text instanceof Uint8Array
      ? text
      : text === 'unsigned'
        ? `${unsigned.toString(8).padStart(6, '0')}\0 `
        : text === 'signed'
          ? `${sumOf(block, true).toString(8).padStart(6, '0')}\0 `
          : text === 'wrong'
            ? `${(unsigned + 1).toString(8).padStart(6, '0')}\0 `
            : text;
  put(block, CHECKSUM_AT, 8, stored);
  return block;
}

/** Data padded with zeros to a whole number of blocks. */
export function dataBlocks(data: string | Uint8Array): Uint8Array {
  const raw = bytesOf(data);
  const padded = new Uint8Array(Math.ceil(raw.length / BLOCK) * BLOCK);
  padded.set(raw);
  return padded;
}

/** One pax record, `<length> <key>=<value>\n`, where the length counts its own digits. */
export function paxRecord(key: string, value: string | Uint8Array): Uint8Array {
  const body = concat([encoder.encode(` ${key}=`), bytesOf(value), encoder.encode('\n')]);
  let length = body.length + 1;
  while (String(length).length + body.length !== length)
    length = String(length).length + body.length;
  return concat([encoder.encode(String(length)), body]);
}

export const paxRecords = (records: Readonly<Record<string, string>>): Uint8Array =>
  concat(Object.entries(records).map(([key, value]) => paxRecord(key, value)));

/** The blocks of a typeflag-`x` (or `g`) header and its records. */
export function paxBlocks(
  records: Uint8Array | Readonly<Record<string, string>>,
  typeflag: 'x' | 'g' = 'x',
): Uint8Array[] {
  const data = records instanceof Uint8Array ? records : paxRecords(records);
  return [headerBlock({ name: 'PaxHeader/entry', typeflag, size: data.length }), dataBlocks(data)];
}

/** How the name of an entry is carried when it does not fit the 100 bytes of the header. */
export type NameVia = 'header' | 'prefix' | 'pax' | 'gnu';

export interface TarEntry {
  readonly name: string;
  readonly data?: string | Uint8Array;
  readonly mode?: number;
  readonly typeflag?: string;
  readonly linkname?: string;
  readonly via?: NameVia;
  /** More pax records, written in a pax header before the entry. */
  readonly pax?: Readonly<Record<string, string>>;
  /** Fields to put in the header whatever the rest says. */
  readonly header?: Partial<HeaderFields>;
}

function splitForPrefix(name: string): { prefix: string; rest: string } {
  for (let slash = name.lastIndexOf('/'); slash > 0; slash = name.lastIndexOf('/', slash - 1)) {
    const prefix = name.slice(0, slash);
    const rest = name.slice(slash + 1);
    if (encoder.encode(prefix).length <= 155 && encoder.encode(rest).length <= 100) {
      return { prefix, rest };
    }
  }
  throw new Error('no place to split the name for a ustar prefix');
}

/** The blocks of one entry: its extended or long-name header if it needs one, its header, its data. */
export function entryBlocks(entry: TarEntry): Uint8Array[] {
  const data = bytesOf(entry.data ?? '');
  const via = entry.via ?? 'header';
  const before: Uint8Array[] = [];
  const records: Record<string, string> = { ...entry.pax };
  let name: string | Uint8Array = entry.name;
  let prefix = '';
  if (via === 'prefix') {
    const split = splitForPrefix(entry.name);
    name = split.rest;
    prefix = split.prefix;
  } else if (via === 'pax') {
    records['path'] = entry.name;
    name = 'pax-name-placeholder';
  } else if (via === 'gnu') {
    const long = concat([encoder.encode(entry.name), new Uint8Array(1)]);
    before.push(
      headerBlock({ name: '././@LongLink', typeflag: 'L', size: long.length, format: 'gnu' }),
      dataBlocks(long),
    );
    name = encoder.encode(entry.name).slice(0, 100);
  }
  if (Object.keys(records).length > 0) before.push(...paxBlocks(records));
  const typeflag = entry.typeflag ?? '0';
  const header = headerBlock({
    name,
    prefix,
    mode: entry.mode ?? (typeflag === '5' ? 0o755 : 0o644),
    typeflag,
    linkname: entry.linkname ?? '',
    size: typeflag === '0' || typeflag === '\0' ? data.length : 0,
    ...(via === 'gnu' ? { format: 'gnu' as const } : {}),
    ...entry.header,
  });
  return [...before, header, ...(data.length > 0 ? [dataBlocks(data)] : [])];
}

export interface TarOptions {
  /**
   * What ends the archive: `two` zero blocks (the standard), `padded` two blocks and zeros up to a
   * record of 20 blocks as tar programs write it, `one` block, or `none`.
   */
  readonly end?: 'two' | 'padded' | 'one' | 'none';
  /** Bytes written after the end. */
  readonly after?: Uint8Array;
}

const zeros = (blocks: number): Uint8Array => new Uint8Array(blocks * BLOCK);

/** An archive of entries, or of blocks already made. */
export function tarOf(
  entries: readonly (TarEntry | Uint8Array)[],
  options: TarOptions = {},
): Uint8Array {
  const body = concat(
    entries.flatMap((entry) => (entry instanceof Uint8Array ? [entry] : entryBlocks(entry))),
  );
  const end = options.end ?? 'two';
  let tail = zeros(0);
  if (end === 'two') tail = zeros(2);
  if (end === 'one') tail = zeros(1);
  if (end === 'padded') tail = zeros(Math.max(2, 20 - ((body.length / BLOCK) % 20)));
  return concat([body, tail, options.after ?? zeros(0)]);
}

export const gzip = (bytes: Uint8Array): Uint8Array => new Uint8Array(gzipSync(bytes));

/** A gzipped archive of entries. */
export const tgzOf = (
  entries: readonly (TarEntry | Uint8Array)[],
  options: TarOptions = {},
): Uint8Array => gzip(tarOf(entries, options));
