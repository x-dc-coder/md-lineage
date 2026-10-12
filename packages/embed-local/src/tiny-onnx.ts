/**
 * 68-byte ONNX identity model (IR 8, opset 13, input `x` float[1] → output `y`).
 * The device probe loads this buffer and never downloads a model.
 */
const TINY_ONNX_HEX =
  '08083a3a0a100a017812017922084964656e74697479120474696e795a0f0a0178120a0a08080112040a020801620f0a0179120a0a08080112040a02080142040a00100d';

export const TINY_ONNX: Uint8Array = hexToBytes(TINY_ONNX_HEX);

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('tiny onnx hex is truncated');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isInteger(byte)) throw new Error('tiny onnx hex is not hexadecimal');
    out[i] = byte;
  }
  return out;
}
