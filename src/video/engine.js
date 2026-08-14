import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output,
  VideoSampleSink
} from 'mediabunny';
import { detectVideoWatermarkFromFrames, estimateAlphaGain, scoreRegion } from './detect.js';
import { getVideoAlphaMap } from './alpha.js';
import { applyEdgePolish, inverseAlphaRestore, stabilizeCorrection, toImageDataLike } from './restore.js';

const DEFAULT_COLOR_SPACE = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };

function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas is unavailable');
  return ctx;
}

function createInput(file) {
  return new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
}

async function metadataOf(input, track, { includeStats = false } = {}) {
  const [width, height, firstTimestamp, codec, durationMeta] = await Promise.all([
    track.getDisplayWidth(),
    track.getDisplayHeight(),
    track.getFirstTimestamp().catch(() => 0),
    track.getCodec().catch(() => null),
    input.getDurationFromMetadata([track], { skipLiveWait: true }).catch(() => null)
  ]);

  const duration = Number.isFinite(durationMeta) && durationMeta > 0
    ? durationMeta
    : await track.computeDuration({ skipLiveWait: true }).catch(() => null);

  const packetStats = includeStats
    ? await track.computePacketStats(90, { skipLiveWait: true }).catch(() => null)
    : null;

  const frameRate = Number.isFinite(packetStats?.averagePacketRate) && packetStats.averagePacketRate > 0
    ? packetStats.averagePacketRate
    : 30;

  return {
    width,
    height,
    firstTimestamp: Number.isFinite(firstTimestamp) ? firstTimestamp : 0,
    codec,
    duration: Number.isFinite(duration) ? duration : null,
    frameRate,
    frameCountEstimate: Number.isFinite(duration) ? Math.max(1, Math.round(duration * frameRate)) : null,
    averageBitrate: packetStats?.averageBitrate || null
  };
}

function targetTimes(metadata, sampleCount) {
  const count = Math.max(3, Math.min(24, Math.round(sampleCount || 12)));
  if (!metadata.duration) return [metadata.firstTimestamp];
  const interval = metadata.duration / (count + 1);
  return Array.from({ length: count }, (_, index) => metadata.firstTimestamp + interval * (index + 1));
}

async function sampleFrames(track, metadata, sampleCount, onProgress, shouldCancel) {
  const canvas = createCanvas(metadata.width, metadata.height);
  const ctx = context2d(canvas);
  const sink = new VideoSampleSink(track);
  const targets = targetTimes(metadata, sampleCount);
  const frames = [];
  let targetIndex = 0;

  for await (const sample of sink.samples()) {
    try {
      if (shouldCancel?.()) throw new DOMException('Cancelled', 'AbortError');
      if (targetIndex >= targets.length) break;
      if (sample.timestamp < targets[targetIndex]) continue;
      sample.draw(ctx, 0, 0, metadata.width, metadata.height);
      frames.push({ timestamp: sample.timestamp, imageData: ctx.getImageData(0, 0, metadata.width, metadata.height) });
      targetIndex++;
      onProgress?.({
        phase: 'detect',
        status: `Sampling frame ${frames.length}/${targets.length}`,
        progress: 0.05 + 0.45 * frames.length / targets.length
      });
    } finally {
      sample.close();
    }
  }
  return frames;
}

function cropImageData(imageData, position) {
  const width = Math.max(1, Math.round(position.width));
  const height = Math.max(1, Math.round(position.height));
  const x0 = Math.round(position.x);
  const y0 = Math.round(position.y);
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    const sourceStart = ((y0 + y) * imageData.width + x0) * 4;
    const sourceEnd = sourceStart + width * 4;
    data.set(imageData.data.subarray(sourceStart, sourceEnd), y * width * 4);
  }

  return { width, height, data };
}

function createDetectionPreview(frames, detection, edgePolish = 0.35) {
  if (!frames?.length || !detection?.position || !detection?.alphaMap) return null;
  const frame = frames[Math.floor(frames.length / 2)];
  const original = cropImageData(frame.imageData, detection.position);
  let cleaned = inverseAlphaRestore(original, detection.alphaMap, detection.alphaGain ?? 1);
  cleaned = applyEdgePolish(cleaned, detection.alphaMap, edgePolish);
  return {
    timestamp: frame.timestamp,
    original,
    cleaned
  };
}

export async function inspectVideo(file, options = {}) {
  const input = createInput(file);
  const track = await input.getPrimaryVideoTrack();
  if (!track) { input.dispose(); throw new Error('No video track found'); }
  try {
    options.onProgress?.({ phase: 'detect', status: 'Reading metadata', progress: 0.02 });
    const metadata = await metadataOf(input, track, { includeStats: false });
    const frames = await sampleFrames(track, metadata, options.sampleCount, options.onProgress, options.shouldCancel);
    if (!frames.length) throw new Error('Could not sample video frames');

    options.onProgress?.({ phase: 'detect', status: 'Scoring watermark candidates', progress: 0.58 });
    const detection = await detectVideoWatermarkFromFrames({
      frames,
      width: metadata.width,
      height: metadata.height,
      minConfidence: options.minConfidence ?? 0.12
    });

    const preview = createDetectionPreview(frames, detection, options.edgePolish ?? 0.35);
    const publicDetection = { ...detection };
    delete publicDetection.alphaMap;
    delete publicDetection.frameScores;

    return { metadata, detection: publicDetection, preview, internalDetection: detection };
  } finally {
    input.dispose();
  }
}

function normalizePacketTimestamp(packet, startTimestamp) {
  const shifted = packet.timestamp - startTimestamp;
  if (shifted >= 0) return packet;
  if (packet.timestamp + packet.duration <= startTimestamp) return null;
  return packet.clone({ timestamp: 0, duration: Math.max(0, packet.duration + shifted) });
}

async function prepareAudioCopy(input, output, format, startTimestamp) {
  const track = await input.getPrimaryAudioTrack().catch(() => null);
  if (!track) return { source: null, track: null, result: { copied: false, reason: 'no-audio-track' } };
  const codec = await track.getCodec().catch(() => null);
  if (!codec || !format.getSupportedAudioCodecs().includes(codec)) {
    return { source: null, track, result: { copied: false, reason: 'unsupported-audio-codec', codec } };
  }
  const source = new EncodedAudioPacketSource(codec);
  output.addAudioTrack(source);
  const decoderConfig = await track.getDecoderConfig().catch(() => null);
  return { source, track, startTimestamp, meta: { decoderConfig: decoderConfig ?? undefined }, result: { copied: false, codec } };
}

async function copyAudio(audio) {
  if (!audio.source || !audio.track) return audio.result;
  const sink = new EncodedPacketSink(audio.track);
  let count = 0;
  for await (const packet of sink.packets()) {
    const normalized = normalizePacketTimestamp(packet, audio.startTimestamp || 0);
    if (!normalized) continue;
    await audio.source.add(normalized, audio.meta);
    count++;
  }
  audio.source.close();
  return { copied: count > 0, packetCount: count, codec: audio.result.codec };
}

function meanRoiLumaDelta(current, previous) {
  if (!previous || current.width !== previous.width || current.height !== previous.height) return 0;
  let sum = 0;
  let count = 0;
  const stride = current.width * current.height > 6000 ? 2 : 1;
  for (let y = 0; y < current.height; y += stride) {
    for (let x = 0; x < current.width; x += stride) {
      const idx = (y * current.width + x) * 4;
      const a = 0.2126 * current.data[idx] + 0.7152 * current.data[idx + 1] + 0.0722 * current.data[idx + 2];
      const b = 0.2126 * previous.data[idx] + 0.7152 * previous.data[idx + 1] + 0.0722 * previous.data[idx + 2];
      sum += Math.abs(a - b);
      count++;
    }
  }
  return count ? sum / count : 0;
}

function frameGain(roi, alphaMap, requested, previous, adaptive, score) {
  if (!adaptive || score < 0.12) return requested;
  const local = estimateAlphaGain(
    { width: roi.width, height: roi.height, data: roi.data },
    { x: 0, y: 0, width: roi.width, height: roi.height },
    alphaMap
  );
  const blended = requested * 0.45 + local * 0.55;
  if (!Number.isFinite(previous)) return blended;
  return Math.max(previous - 0.04, Math.min(previous + 0.04, blended));
}

export async function cleanVideo(file, options = {}) {
  const manual = options.manual && Number.isFinite(options.manual.x) && Number.isFinite(options.manual.y) && Number.isFinite(options.manual.size)
    ? options.manual
    : null;
  let analysis = null;
  if (!manual) {
    analysis = await inspectVideo(file, options);
    if (!analysis.internalDetection.detected && !options.forceCleanup) {
      throw new Error(`Watermark confidence ${analysis.internalDetection.confidence.toFixed(3)} is below threshold. Enable force cleanup or use manual mode.`);
    }
  }

  const input = createInput(file);
  const track = await input.getPrimaryVideoTrack();
  if (!track) { input.dispose(); throw new Error('No video track found'); }
  const metadata = await metadataOf(input, track, { includeStats: true });
  const position = manual
    ? { x: Math.round(manual.x), y: Math.round(manual.y), width: Math.round(manual.size), height: Math.round(manual.size) }
    : analysis.internalDetection.position;
  if (position.x < 0 || position.y < 0 || position.x + position.width > metadata.width || position.y + position.height > metadata.height) {
    input.dispose();
    throw new Error('Watermark region is outside the video frame');
  }
  const alphaMap = manual
    ? await getVideoAlphaMap(position.width)
    : analysis.internalDetection.alphaMap;
  const requestedGain = Number.isFinite(options.alphaGain) ? options.alphaGain : (analysis?.internalDetection.alphaGain ?? 1);

  const canvas = createCanvas(metadata.width, metadata.height);
  const ctx = context2d(canvas);
  const target = new BufferTarget();
  const format = new Mp4OutputFormat({ fastStart: 'in-memory' });
  const output = new Output({ format, target });
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: Number.isFinite(options.bitrate) ? options.bitrate : 12_000_000,
    alpha: 'discard',
    keyFrameInterval: 2,
    latencyMode: 'quality',
    bitrateMode: 'constant',
    hardwareAcceleration: 'no-preference',
    contentHint: 'detail',
    onEncodedPacket(_packet, meta) {
      if (meta?.decoderConfig) meta.decoderConfig.colorSpace = { ...DEFAULT_COLOR_SPACE };
    }
  });
  output.addVideoTrack(source, { frameRate: metadata.frameRate });
  const audio = await prepareAudioCopy(input, output, format, metadata.firstTimestamp);

  let processedFrames = 0;
  let skippedFrames = 0;
  let previousGain = requestedGain;
  let previousTemporal = null;
  const lowGate = Number.isFinite(options.lowGate) ? options.lowGate : 0.025;
  const fallbackDuration = 1 / Math.max(1, metadata.frameRate);

  try {
    await output.start();
    const audioPromise = copyAudio(audio);
    const sink = new VideoSampleSink(track);
    for await (const sample of sink.samples()) {
      const rawTimestamp = sample.timestamp;
      const rawDuration = sample.duration;
      try {
        if (options.shouldCancel?.()) throw new DOMException('Cancelled', 'AbortError');
        sample.draw(ctx, 0, 0, metadata.width, metadata.height);
        const original = ctx.getImageData(position.x, position.y, position.width, position.height);
        const score = scoreRegion(original, { x: 0, y: 0, width: position.width, height: position.height }, alphaMap).confidence;
        const shouldProcess = options.forceCleanup || manual || score >= lowGate;
        if (shouldProcess) {
          const shotDelta = meanRoiLumaDelta(original, previousTemporal?.original);
          const shotChanged = shotDelta >= (Number.isFinite(options.shotCutThreshold) ? options.shotCutThreshold : 34);
          if (shotChanged) {
            previousGain = Number.NaN;
            previousTemporal = null;
          }
          const gain = frameGain(original, alphaMap, requestedGain, previousGain, options.adaptiveAlpha !== false, score);
          previousGain = gain;
          let processed = inverseAlphaRestore(original, alphaMap, gain);
          processed = applyEdgePolish(processed, alphaMap, options.edgePolish ?? 0.35);
          if (options.temporalStabilize !== false) {
            processed = stabilizeCorrection(original, processed, previousTemporal, alphaMap, 0.7);
          }
          ctx.putImageData(toImageDataLike(processed), position.x, position.y);
          previousTemporal = { original, processed };
        } else {
          skippedFrames++;
          previousTemporal = null;
        }
      } finally {
        sample.close();
      }

      const timestamp = Math.max(0, rawTimestamp - metadata.firstTimestamp);
      const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : fallbackDuration;
      await source.add(timestamp, duration);
      processedFrames++;
      const estimate = metadata.frameCountEstimate || Math.max(processedFrames, 1);
      options.onProgress?.({
        phase: 'export',
        status: `Exporting frame ${processedFrames}${metadata.frameCountEstimate ? `/${metadata.frameCountEstimate}` : ''}`,
        progress: 0.65 + 0.34 * Math.min(1, processedFrames / estimate)
      });
    }
    source.close();
    const audioResult = await audioPromise;
    await output.finalize();
    if (!target.buffer) throw new Error('Video export produced an empty buffer');
    return {
      buffer: target.buffer,
      meta: {
        version: '1.0.6',
        position,
        alphaGain: previousGain,
        processedFrames,
        skippedFrames,
        audio: audioResult,
        detection: analysis?.detection || null
      }
    };
  } finally {
    input.dispose();
  }
}
