import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { within } from '../commands/config-file.js';
import { ID_PATTERN } from './types.js';

/**
 * What a manifest is allowed to hold, exactly: the schema `manifest.ts` reads it against. An unknown
 * key, a sha that is not a sha or a copy id that climbs out of its directory is an error.
 */

const MAX_ENTRIES_PER_FILE = 1_000;
const MAX_EDIT_PATH = 64;
const MAX_PREFIX_CHARS = 8;
const MAX_SUFFIX_CHARS = 2;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const editPath = z.array(z.string().min(1)).min(1).max(MAX_EDIT_PATH);
const createdFrom = z.number().int().min(0);
const pathFits = (edit: {
  readonly path: readonly string[];
  readonly createdFrom: number;
}): boolean => edit.createdFrom <= edit.path.length;

const editSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('json-array-add'),
      path: editPath,
      value: z.json(),
      preexisting: z.boolean(),
      createdFrom,
    })
    .refine(pathFits, 'createdFrom is past the end of the path'),
  z
    .strictObject({
      kind: z.literal('json-set'),
      path: editPath,
      value: z.json(),
      previous: z.discriminatedUnion('present', [
        z.strictObject({ present: z.literal(false) }),
        // `masked` is there only when the value was credential-shaped and was not written down.
        z.strictObject({
          present: z.literal(true),
          value: z.json(),
          masked: z.literal(true).optional(),
        }),
      ]),
      createdFrom,
    })
    .refine(pathFits, 'createdFrom is past the end of the path'),
  z
    .strictObject({
      kind: z.literal('text-block'),
      id: z.string().regex(ID_PATTERN),
      lines: z.array(z.string()),
      previous: z.array(z.string()).nullable(),
      // Nothing but the one or two line breaks that Stroq writes before an appended block.
      prefix: z
        .string()
        .max(MAX_PREFIX_CHARS)
        .regex(/^(?:\r?\n){0,2}$/),
      closesLastLine: z.boolean(),
      // Nothing but the one line break that Stroq writes after the end marker.
      suffix: z
        .string()
        .max(MAX_SUFFIX_CHARS)
        .regex(/^(?:\r?\n)?$/),
    })
    .refine(
      (edit) => !edit.closesLastLine || edit.prefix !== '',
      'a prefix that ends the last line cannot be empty',
    ),
]);

const absolutePath = z.string().refine((path) => isAbsolute(path), 'a path is absolute');

const MAX_CREATED_DIRS = 32;

function strictAncestorsOf(path: string): Set<string> {
  const ancestors = new Set<string>();
  let current = dirname(path);
  for (;;) {
    ancestors.add(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
}

const createdDirsValid = (entry: {
  readonly created: boolean;
  readonly createdDirs?: readonly string[] | undefined;
  readonly real: string;
  readonly root: string | null;
}): boolean => {
  if (entry.createdDirs === undefined || entry.createdDirs.length === 0) return true;
  if (!entry.created) return false;
  if (entry.root === null) return false;
  const ancestors = strictAncestorsOf(entry.real);
  for (const dir of entry.createdDirs) {
    if (!ancestors.has(dir)) return false;
    if (dir === entry.root || !within(dir, entry.root)) return false;
  }
  return true;
};

const entrySchema = z
  .strictObject({
    recipe: z.string().min(1).max(128),
    created: z.boolean(),
    createdDirs: z.array(absolutePath).max(MAX_CREATED_DIRS).optional(),
    real: absolutePath,
    root: absolutePath.nullable(),
    edits: z.array(editSchema),
    shaBefore: sha256Hex.nullable(),
    shaAfter: sha256Hex,
    backup: z.string().regex(ID_PATTERN).nullable(),
    stroqVersion: z.string().min(1).max(64),
    appliedAt: z.iso.datetime(),
  })
  .refine(
    createdDirsValid,
    'createdDirs must be strict ancestors of the file, inside root, and present only for created files',
  );

const filesSchema = z.record(
  z.string().refine((key) => isAbsolute(key), 'a file is named by its absolute path'),
  z.array(entrySchema).max(MAX_ENTRIES_PER_FILE),
);

/**
 * Version 1 is what a Stroq before signed manifests wrote: it is still read exactly, so that one that
 * is not even that is reported as invalid, and one that is can be refused as unsigned. Version 2 is
 * the same files with a `mac` beside them (`manifest-seal.ts`).
 */
export const manifestSchema = z.discriminatedUnion('version', [
  z.strictObject({ version: z.literal(1), files: filesSchema }),
  z.strictObject({ version: z.literal(2), files: filesSchema, mac: sha256Hex }),
]);
