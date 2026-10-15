import { describe, expect, it } from 'vitest';
import { neutralizeControls } from '../../src/util/controls.js';

describe('neutralizeControls', () => {
  it('neutralizes all C0 controls except tab and newline', () => {
    // 0x00 to 0x08
    for (let code = 0; code <= 0x08; code += 1) {
      const char = String.fromCharCode(code);
      const expected = `\\u${code.toString(16).padStart(4, '0')}`;
      expect(neutralizeControls(`prefix${char}suffix`)).toBe(`prefix${expected}suffix`);
    }

    // 0x0b to 0x1f
    for (let code = 0x0b; code <= 0x1f; code += 1) {
      const char = String.fromCharCode(code);
      const expected = `\\u${code.toString(16).padStart(4, '0')}`;
      expect(neutralizeControls(`prefix${char}suffix`)).toBe(`prefix${expected}suffix`);
    }
  });

  it('preserves tab (0x09) and newline (0x0a) as untouched whitespace', () => {
    expect(neutralizeControls('\t')).toBe('\t');
    expect(neutralizeControls('\n')).toBe('\n');
    expect(neutralizeControls('line1\n\tline2\n')).toBe('line1\n\tline2\n');
  });

  it('neutralizes DEL (0x7f) and the C1 control block (0x80 to 0x9f)', () => {
    expect(neutralizeControls('\u007f')).toBe('\\u007f');

    for (let code = 0x80; code <= 0x9f; code += 1) {
      const char = String.fromCharCode(code);
      const expected = `\\u${code.toString(16).padStart(4, '0')}`;
      expect(neutralizeControls(`test${char}`)).toBe(`test${expected}`);
    }
  });

  it('neutralizes bidirectional override controls (U+202A to U+202E)', () => {
    const bidiOverrides = [
      ['\u202a', '\\u202a'], // LRE
      ['\u202b', '\\u202b'], // RLE
      ['\u202c', '\\u202c'], // PDF
      ['\u202d', '\\u202d'], // LRO
      ['\u202e', '\\u202e'], // RLO
    ] as const;

    for (const [char, escape] of bidiOverrides) {
      expect(neutralizeControls(`file${char}name`)).toBe(`file${escape}name`);
    }
  });

  it('neutralizes bidirectional isolate controls (U+2066 to U+2069)', () => {
    const bidiIsolates = [
      ['\u2066', '\\u2066'], // LRI
      ['\u2067', '\\u2067'], // RLI
      ['\u2068', '\\u2068'], // FSI
      ['\u2069', '\\u2069'], // PDI
    ] as const;

    for (const [char, escape] of bidiIsolates) {
      expect(neutralizeControls(`path${char}part`)).toBe(`path${escape}part`);
    }
  });

  it('leaves ordinary multi-byte international text and emojis intact', () => {
    const samples = [
      'Hello, world! 1234567890 -_=+[]{}',
      'Защита терминала от внедрения команд',
      '日本語のテキストと漢字',
      '한국어 텍스트',
      'العربية بدون تحكم',
      '🚀 Security shields: 🛡️ ✨ 🔒',
    ];

    for (const text of samples) {
      expect(neutralizeControls(text)).toBe(text);
    }
  });

  it('produces valid JSON-compatible escape sequences that round-trip safely', () => {
    const hostile = 'danger\u001b[31mred\u0007\r\u007f\u202ehack';
    const neutralized = neutralizeControls(hostile);

    expect(neutralized).not.toContain('\u001b');
    expect(neutralized).not.toContain('\u0007');
    expect(neutralized).not.toContain('\r');
    expect(neutralized).not.toContain('\u007f');
    expect(neutralized).not.toContain('\u202e');

    const jsonString = JSON.stringify(neutralized);
    const parsed = JSON.parse(jsonString);
    expect(parsed).toBe(neutralized);
  });
});
