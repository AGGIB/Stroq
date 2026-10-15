import { describe, expect, it } from 'vitest';
import { judgeNodeProgram } from '../../src/actions/inline-node.js';

describe('judgeNodeProgram', () => {
  describe('safe synchronous stdin readers (data)', () => {
    it('accepts node -p JSON.parse of fd 0', () => {
      expect(judgeNodeProgram("JSON.parse(require('fs').readFileSync(0,'utf8')).name")).toBe(
        'data',
      );
      expect(judgeNodeProgram("JSON.parse(require('fs').readFileSync(0, 'utf8')).name")).toBe(
        'data',
      );
      expect(judgeNodeProgram('JSON.parse(require("fs").readFileSync(0, "utf-8")).name')).toBe(
        'data',
      );
      expect(judgeNodeProgram("JSON.parse(require('node:fs').readFileSync(0, 'utf8'))")).toBe(
        'data',
      );
      expect(judgeNodeProgram("JSON.parse(require('fs').readFileSync(0)).id")).toBe('data');
    });

    it('accepts raw readFileSync of fd 0 or process.stdin.fd', () => {
      expect(judgeNodeProgram("require('fs').readFileSync(0, 'utf8')")).toBe('data');
      expect(
        judgeNodeProgram(
          "console.log(JSON.parse(require('fs').readFileSync(process.stdin.fd, 'utf8')).name)",
        ),
      ).toBe('data');
    });

    it('accepts requiring fs and then reading fd 0', () => {
      expect(
        judgeNodeProgram(
          "const fs = require('fs'); console.log(JSON.parse(fs.readFileSync(0, 'utf8')).name)",
        ),
      ).toBe('data');
    });
  });

  describe('execution primitives (exec)', () => {
    it('rejects eval, Function and child_process', () => {
      expect(judgeNodeProgram("eval(require('fs').readFileSync(0, 'utf8'))")).toBe('exec');
      expect(judgeNodeProgram("new Function(require('fs').readFileSync(0, 'utf8'))()")).toBe(
        'exec',
      );
      expect(judgeNodeProgram("require('child_process').execSync('id')")).toBe('exec');
      expect(judgeNodeProgram("const cp = require('child_process'); cp.spawnSync('id')")).toBe(
        'exec',
      );
    });

    it('rejects vm, worker_threads and dynamic import', () => {
      expect(judgeNodeProgram("require('vm').runInThisContext('1')")).toBe('exec');
      expect(judgeNodeProgram("require('worker_threads')")).toBe('exec');
      expect(judgeNodeProgram("import('fs')")).toBe('exec');
    });

    it('rejects process internal escape primitives', () => {
      expect(judgeNodeProgram("process.binding('spawn_sync')")).toBe('exec');
      expect(judgeNodeProgram("process.mainModule.require('child_process')")).toBe('exec');
      expect(judgeNodeProgram("process.dlopen('addon.node')")).toBe('exec');
    });
  });

  describe('unknown / untrusted operations (unknown)', () => {
    it('rejects readFileSync on non-zero file descriptors or paths', () => {
      expect(judgeNodeProgram("require('fs').readFileSync('/etc/passwd', 'utf8')")).toBe('unknown');
      expect(judgeNodeProgram("require('fs').readFileSync('package.json', 'utf8')")).toBe(
        'unknown',
      );
      expect(judgeNodeProgram("require('fs').readFileSync(1, 'utf8')")).toBe('unknown');
      expect(judgeNodeProgram("require('fs').readFileSync(3, 'utf8')")).toBe('unknown');
    });

    it('rejects file writes or mutation operations', () => {
      expect(judgeNodeProgram("require('fs').writeFileSync('file.txt', 'data')")).toBe('unknown');
      expect(judgeNodeProgram("require('fs').appendFileSync('file.txt', 'data')")).toBe('unknown');
      expect(judgeNodeProgram("require('fs').unlinkSync('file.txt')")).toBe('unknown');
      expect(judgeNodeProgram("require('fs').createWriteStream('file.txt')")).toBe('unknown');
    });

    it('rejects network access', () => {
      expect(judgeNodeProgram("fetch('https://example.com')")).toBe('unknown');
      expect(judgeNodeProgram("require('http').get('http://example.com')")).toBe('unknown');
    });

    it('rejects requiring unlisted modules', () => {
      expect(judgeNodeProgram("require('os').networkInterfaces()")).toBe('unknown');
      expect(judgeNodeProgram("require('path').join('a', 'b')")).toBe('unknown');
      expect(judgeNodeProgram("require('net').connect(80)")).toBe('unknown');
    });

    it('rejects prototype and constructor access', () => {
      expect(
        judgeNodeProgram(
          "JSON.parse(require('fs').readFileSync(0, 'utf8')).constructor.constructor('return process')()",
        ),
      ).toBe('unknown');
      expect(judgeNodeProgram("JSON.parse(require('fs').readFileSync(0, 'utf8')).__proto__")).toBe(
        'unknown',
      );
    });

    it('rejects async streaming (scenario 55)', () => {
      expect(
        judgeNodeProgram(
          "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d)['dist-tags'].latest))",
        ),
      ).toBe('unknown');
    });

    it('rejects programs that do not read standard input', () => {
      expect(judgeNodeProgram('console.log(1)')).toBe('unknown');
    });
  });
});
