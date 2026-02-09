/**
 * AudioWorklet processor for capturing PCM audio data.
 *
 * This file runs in the AudioWorklet context, which is a separate thread
 * from the main browser thread. It has no access to DOM or most browser APIs.
 * Communication with the main thread happens via message passing through `this.port`.
 *
 * The processor captures audio in 80ms chunks (1280 samples at 16kHz),
 * converts Float32 samples to Int16 PCM format (which Deepgram expects),
 * and posts the binary data to the main thread.
 *
 * Usage:
 *   await audioContext.audioWorklet.addModule('/path/to/audio-worklet-processor.js');
 *   const node = new AudioWorkletNode(audioContext, 'pcm-capture-processor');
 *   node.port.onmessage = (e) => handlePcmBuffer(e.data);
 */

// AudioWorklet global types - these are only available in the worklet context
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;

const BUFFER_SIZE = 1280; // 80ms at 16kHz

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private buffer: Float32Array;
  private bufferIndex: number;

  constructor() {
    super();
    this.buffer = new Float32Array(BUFFER_SIZE);
    this.bufferIndex = 0;
  }

  process(
    inputs: Float32Array[][],
    _outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    const input = inputs[0]?.[0];
    if (!input) {
      return true;
    }

    for (let i = 0; i < input.length; i++) {
      this.buffer[this.bufferIndex++] = input[i];

      if (this.bufferIndex >= BUFFER_SIZE) {
        // Convert float32 to int16 PCM
        const pcm = new Int16Array(BUFFER_SIZE);
        for (let j = 0; j < BUFFER_SIZE; j++) {
          const s = Math.max(-1, Math.min(1, this.buffer[j]));
          pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        // Transfer the buffer to the main thread
        // Using transferable objects for efficiency (avoids copying)
        this.port.postMessage(pcm.buffer, [pcm.buffer]);

        // Allocate a new buffer for the next chunk
        this.buffer = new Float32Array(BUFFER_SIZE);
        this.bufferIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
