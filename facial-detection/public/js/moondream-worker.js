/* Lightweight Moondream2 (Xenova ONNX) for detailed scene captions. */
let model = null;
let processor = null;
let tokenizer = null;
let RawImage = null;
let ready = false;
let T = null;

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'init') {
      await init();
      return;
    }
    if (msg.type === 'caption') {
      if (!ready) {
        self.postMessage({ type: 'caption', id: msg.id, text: '' });
        return;
      }
      const text = await caption(msg);
      self.postMessage({ type: 'caption', id: msg.id, text });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, error: (err && err.message) || String(err) });
  }
};

async function init() {
  self.postMessage({ type: 'status', message: 'Downloading Moondream…' });
  T = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1');
  RawImage = T.RawImage;
  const modelId = 'Xenova/moondream2';
  processor = await T.AutoProcessor.from_pretrained(modelId);
  tokenizer = await T.AutoTokenizer.from_pretrained(modelId);
  const dtype = {
    embed_tokens: 'q8',
    vision_encoder: 'q8',
    decoder_model_merged: 'q4'
  };
  let device = 'wasm';
  try {
    model = await T.Moondream1ForConditionalGeneration.from_pretrained(modelId, { dtype, device: 'webgpu' });
    device = 'webgpu';
  } catch {
    model = await T.Moondream1ForConditionalGeneration.from_pretrained(modelId, { dtype, device: 'wasm' });
    device = 'wasm';
  }
  ready = true;
  self.postMessage({ type: 'ready', device });
}

async function caption(msg) {
  const rgb = rgbaToRgb(msg.rgba);
  const image = new RawImage(rgb, msg.width, msg.height, 3);
  const vision = await processor(image);
  const hintBits = [];
  const hints = msg.hints || {};
  if (hints.names && hints.names.length) hintBits.push('Known people: ' + hints.names.join(', ') + '.');
  if (hints.animals && hints.animals.length) hintBits.push('Named animals: ' + hints.animals.join(', ') + '.');
  if (hints.objects && hints.objects.length) hintBits.push('Detected: ' + hints.objects.slice(0, 12).join(', ') + '.');
  const prompt =
    'Describe this security camera frame in detail. Identify every person (clothing, hair, estimated age or gender), every animal (kind, color, count), every vehicle (kind and color), and other objects. Say what each is doing and where they are in the frame.' +
    (hintBits.length ? ' ' + hintBits.join(' ') : '');
  const text = '\n\nQuestion: ' + prompt + '\n\nAnswer:';
  const textInputs = tokenizer(text);
  const output = await model.generate({
    ...textInputs,
    ...vision,
    do_sample: false,
    max_new_tokens: 120
  });
  const decoded = tokenizer.batch_decode(output, { skip_special_tokens: true });
  const raw = String((decoded && decoded[0]) || '');
  const ans = raw.split('Answer:').pop() || raw;
  return ans.replace(/<\|endoftext\|>/g, '').replace(/\s+/g, ' ').trim();
}

function rgbaToRgb(rgba) {
  const n = (rgba && rgba.length) ? (rgba.length / 4) | 0 : 0;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const k = i * 4;
    rgb[j] = rgba[k];
    rgb[j + 1] = rgba[k + 1];
    rgb[j + 2] = rgba[k + 2];
  }
  return rgb;
}
