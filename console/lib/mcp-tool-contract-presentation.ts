/** Display controls explicitly; preserve every original code point in the captured contract. */
export function mcpToolContractText(value: string) {
  return value.replace(
    /[\u007f-\u009f\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
export function formatMcpToolContract(value: string) {
  return mcpToolContractText(JSON.stringify(JSON.parse(value), null, 2));
}
