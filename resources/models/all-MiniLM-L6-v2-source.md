# all-MiniLM-L6-v2 (topic boundaries)

Not bundled. `src/main/pipeline/sentenceEmbedder.ts` downloads these two files into `userData/models/all-MiniLM-L6-v2/` the first time topic detection runs, checks each against the size and SHA-256 below, and skips topic detection when they cannot be had.

| File | Source | Size | SHA-256 |
| --- | --- | --- | --- |
| `model_quantized.onnx` | https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx | 22972370 bytes | `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1` |
| `vocab.txt` | https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/vocab.txt | 231508 bytes | `07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3` |

- Model: sentence-transformers/all-MiniLM-L6-v2 (Nils Reimers, Iryna Gurevych; based on Microsoft's MiniLM-L6-H384-uncased), int8-quantised ONNX export by Xenova for Transformers.js. The vocabulary is the BERT uncased WordPiece vocabulary (30522 tokens).
- Licence: Apache License 2.0, https://www.apache.org/licenses/LICENSE-2.0.
- Inputs `input_ids`, `attention_mask`, `token_type_ids` (int64, `[batch, tokens]`); output `last_hidden_state` (float32, `[batch, tokens, 384]`), mean-pooled over the attention mask and L2-normalised, the model's reference pooling. Sentences are truncated at 128 tokens as the published tokenizer config does.
- The checksums were recorded on 22 November 2026 from two independent redistributions of the unmodified files (the environment this was built in could not reach huggingface.co directly); they agree with each other, and the vocabulary agrees with the one embedded in the model's `tokenizer.json`. If the upstream files ever change, the checksum fails and the app simply runs without topic boundaries.
