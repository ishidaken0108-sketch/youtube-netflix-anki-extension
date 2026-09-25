class AnkiRingCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = 4096;
    this.chunk = new Float32Array(this.chunkSize);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (!channel || !channel.length) return true;

    let srcOffset = 0;
    while (srcOffset < channel.length) {
      const remaining = this.chunkSize - this.offset;
      const take = Math.min(remaining, channel.length - srcOffset);
      this.chunk.set(channel.subarray(srcOffset, srcOffset + take), this.offset);
      this.offset += take;
      srcOffset += take;

      if (this.offset >= this.chunkSize) {
        const completed = this.chunk;
        this.port.postMessage(completed, [completed.buffer]);
        this.chunk = new Float32Array(this.chunkSize);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('anki-ring-capture', AnkiRingCaptureProcessor);
