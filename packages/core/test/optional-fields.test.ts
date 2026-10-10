import { describe, expectTypeOf, it } from 'vitest';
import type { ToolClassification } from '../src/actions/classify-tool.js';
import type { AuditEntry, AuditEntryInput } from '../src/audit/audit-log.js';
import type { PreResult } from '../src/engine.js';
import type { ToolResources as ExportedToolResources } from '../src/index.js';
import type { PostToolEvent, PreToolEvent, ToolResources } from '../src/types.js';

/**
 * Fields that features still to come will fill, added now so that those changes can be made one
 * at a time without all of them touching the same declarations. None of them is set by anything
 * yet, and every one is optional, so each producer written before them still compiles.
 *
 * `tsc` is the test: this directory is part of the project (`pnpm typecheck`), and a type
 * assertion that does not hold is a compile error. Vitest runs the file only so that it stays
 * in the suite; `expectTypeOf` does nothing at run time.
 */

/** True when `K` is optional on `T`: an object that lacks it is still a `T`. */
type IsOptional<T, K extends keyof T> = Omit<T, K> extends T ? true : false;

describe('the optional fields the next features fill', () => {
  it('PreResult.signals is an optional list of strings', () => {
    expectTypeOf<IsOptional<PreResult, 'signals'>>().toEqualTypeOf<true>();
    expectTypeOf<PreResult['signals']>().toEqualTypeOf<readonly string[] | undefined>();
  });

  it('PreToolEvent.callId is an optional string, and a PostToolEvent has it too', () => {
    expectTypeOf<IsOptional<PreToolEvent, 'callId'>>().toEqualTypeOf<true>();
    expectTypeOf<PreToolEvent['callId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<PostToolEvent['callId']>().toEqualTypeOf<string | undefined>();
  });

  it('ToolClassification.resources is an optional ToolResources', () => {
    expectTypeOf<IsOptional<ToolClassification, 'resources'>>().toEqualTypeOf<true>();
    expectTypeOf<ToolClassification['resources']>().toEqualTypeOf<ToolResources | undefined>();
  });

  it('ToolResources has the shape the task lock reads, and the core index exports it', () => {
    expectTypeOf<ToolResources>().toEqualTypeOf<{
      readonly paths: readonly {
        readonly path: string;
        readonly real?: string;
        readonly op: 'read' | 'write';
      }[];
      readonly pathsComplete: boolean;
      readonly urls: readonly {
        readonly url: string;
        readonly host: string;
        readonly method?: string;
      }[];
      readonly shell: boolean;
    }>();
    expectTypeOf<ExportedToolResources>().toEqualTypeOf<ToolResources>();
  });

  it('the audit entry input has optional taskId and callId, and an entry keeps them', () => {
    expectTypeOf<IsOptional<AuditEntryInput, 'taskId'>>().toEqualTypeOf<true>();
    expectTypeOf<IsOptional<AuditEntryInput, 'callId'>>().toEqualTypeOf<true>();
    expectTypeOf<AuditEntryInput['taskId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AuditEntryInput['callId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AuditEntry['taskId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AuditEntry['callId']>().toEqualTypeOf<string | undefined>();
  });
});
