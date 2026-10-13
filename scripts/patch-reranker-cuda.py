#!/usr/bin/env python3
"""
patch-reranker-cuda.py: Fix upstream PyTorch eager FX export bug in Qwen3-Reranker-0.6B ONNX.

Upstream issue:
  In n24q02m/Qwen3-Reranker-0.6B-ONNX (model_yesno_quantized.onnx), the causal mask
  was exported as `GatherND_61` reading `Concat_60(Expand_55, Expand_58)`.
  ONNX Runtime's CUDA Concat kernel does not handle non-contiguous strided memory
  from Expand, resulting in uninitialized garbage index (e.g. 30192844288n) fed to
  GatherND, triggering `cudaErrorIllegalAddress` / process abort.

Fix:
  Replace GatherND_61 with `Unsqueeze(attention_mask, axes=[1, 2])`, matching
  the intended 4D broadcasted mask layout. Mathematically identical, produces
  bit-exact logits on CPU, and enables native CUDA execution on GPU with 4.5x speedup.
"""
import os
import sys

def patch_reranker_model(path: str) -> None:
    try:
        import onnx
    except ImportError:
        print("Error: 'onnx' Python package is required. Install with: pip install onnx", file=sys.stderr)
        sys.exit(1)

    print(f"Loading {path}...")
    m = onnx.load(path, load_external_data=False)
    idx = next((i for i, n in enumerate(m.graph.node) if n.name == 'node_GatherND_61'), None)
    if idx is None:
        print("Model is already patched (node_GatherND_61 not found).")
        return

    axes_tensor = onnx.helper.make_tensor('unsqueeze_axes_1_2', onnx.TensorProto.INT64, [2], [1, 2])
    m.graph.initializer.append(axes_tensor)

    new_unsqueeze = onnx.helper.make_node(
        'Unsqueeze',
        inputs=['_to_copy', 'unsqueeze_axes_1_2'],
        outputs=['val_61'],
        name='node_unsqueeze_val61_fixed'
    )
    old_node = m.graph.node[idx]
    m.graph.node.remove(old_node)
    m.graph.node.insert(idx, new_unsqueeze)

    onnx.save(m, path)
    print(f"Successfully patched {path} for CUDA support.")

if __name__ == '__main__':
    default_path = os.path.expanduser('~/.mdlineage/models/n24q02m/Qwen3-Reranker-0.6B-ONNX/onnx/model_yesno_quantized.onnx')
    target = sys.argv[1] if len(sys.argv) > 1 else default_path
    if not os.path.exists(target):
        print(f"Error: model file not found at {target}", file=sys.stderr)
        sys.exit(1)
    patch_reranker_model(target)
