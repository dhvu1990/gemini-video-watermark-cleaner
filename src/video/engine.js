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
import {
  applyPaddedTextureRepair,
  applyTemporalDonorRepair,
  cropRegion,
  embedAlphaMap,
  expandedRegion,
  pasteRegion
} from './textureRepair.js';
import { applyBackgroundAtlas, buildBackgroundAtlas, summarizeAtlas } from './multiFrameRepair.js';

const DEFAULT_COLOR_SPACE = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
const REPAIR_PADDING = 14;
const MAX_ATLAS_HISTORY = 8;

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

function targetTimes(metadata, sampleCount, scanFraction = 1) {
  const count = Math.max(3, Math.min(24, Math.round(sampleCount || 12)));
  if (!metadata.duration) return [metadata.firstTimestamp];
  const fraction = Math.max(0.1, Math.min(1, Number.isFinite(scanFraction) ? scanFraction : 1));
  const windowDuration = metadata.duration * fraction;
  const interval = windowDuration / (count + 1);
  return Array.from({ length: count }, (_, index) => metadata.firstTimestamp + interval * (index + 1));
}

async function sampleFrames(track, metadata, sampleCount, onProgress, shouldCancel, scanFraction = 1) {
  const canvas = createCanvas(metadata.width, metadata.height);
  const ctx = context2d(canvas);
  const sink = new VideoSampleSink(track);
  const targets = targetTimes(metadata, sampleCount, scanFraction);
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

function repairPaddedRegion(paddedOriginal, inner, alphaMap, gain, edgePolish, history = [], allowMaskedDonors = false) {
  const original = cropRegion(paddedOriginal, inner.offsetX, inner.offsetY, inner.width, inner.height);
  let cleaned = inverseAlphaRestore(original, alphaMap, gain);
  cleaned = applyEdgePolish(cleaned, alphaMap, edgePolish);

  const paddedAlpha = embedAlphaMap(
    alphaMap,
    inner.width,
    inner.height,
    paddedOriginal.width,
    paddedOriginal.height,
    inner.offsetX,
    inner.offsetY
  );
  let repaired = pasteRegion(paddedOriginal, cleaned, inner.offsetX, inner.offsetY);
  repaired = applyPaddedTextureRepair(repaired, paddedAlpha, 0.68);

  let atlasSummary = { donorCount: 0, supportedPixels: 0, meanConfidence: 0 };
  if (history.length) {
    const atlas = buildBackgroundAtlas(paddedOriginal, history, paddedAlpha, {
      maxHistory: MAX_ATLAS_HISTORY,
      maxShift: 9,
      minImprovement: 0.06,
      allowMaskedDonors
    });
    atlasSummary = summarizeAtlas(atlas);
    const minimumDonors = allowMaskedDonors ? 3 : 2;
    if (atlasSummary.donorCount >= minimumDonors && atlasSummary.supportedPixels >= Math.max(24, inner.width)) {
      repaired = applyBackgroundAtlas(repaired, paddedAlpha, atlas, allowMaskedDonors ? 0.88 : 0.94);
    } else if (!allowMaskedDonors) {
      const previousPadded = history[history.length - 1];
      if (previousPadded) repaired = applyTemporalDonorRepair(repaired, paddedOriginal, previousPadded, paddedAlpha, 0.52);
    }
  }

  return {
    original,
    cleaned: cropRegion(repaired, inner.offsetX, inner.offsetY, inner.width, inner.height),
    repairedPadded: repaired,
    paddedAlpha,
    atlasSummary
  };
}

function createDetectionPreview(frames, detection, edgePolish = 0.35) {
  if (!frames?.length || !detection?.position || !detection?.alphaMap) return null;
  const index = Math.floor(frames.length / 2);
  const frame = frames[index];
  const expanded = expandedRegion(detection.position, frame.imageData.width, frame.imageData.height, REPAIR_PADDING);
  const padded = cropImageData(frame.imageData, expanded);
  const history = frames
    .slice(0, index)
    .map((item) => cropImageData(item.imageData, expanded))
    .slice(-MAX_ATLAS_HISTORY);
  const inner = {
    offsetX: expanded.offsetX,
    offsetY: expanded.offsetY,
    width: detection.position.width,
    height: detection.position.height
  };
  const repaired = repairPaddedRegion(
    padded,
    inner,
    detection.alphaMap,
    detection.alphaGain ?? 1,
    edgePolish,
    history,
    false
  );
  return {
    timestamp: frame.timestamp,
    original: repaired.original,
    cleaned: repaired.cleaned,
    atlas: repaired.atlasSummary
  };
}

export async function inspectVideo(file, options = {}) {
  const input = createInput(file);
  const track = await input.getPrimaryVideoTrack();
  if (!track) { input.dispose(); throw new Error('No video track found'); }
  try {
    options.onProgress?.({ phase: 'detect', status: 'Reading metadata', progress: 0.02 });
    const metadata = await metadataOf(input, track, { includeStats: false });
    const frames = await sampleFrames(
      track,
      metadata,
      options.sampleCount,
      options.onProgress,
      options.shouldCancel,
      options.scanFraction ?? 1
    );
    if (!frames.length) throw new Error('Could not sample video frames');

    options.onProgress?.({ phase: 'detect', status: 'Scoring watermark candidates', progress: 0.58 });
    const detection = await detectVideoWatermarkFromFrames({
      frames,
      width: metadata.width,
      height: metadata.height,
      minConfidence: options.minConfidence ?? 0.12,
      edgePolish: options.edgePolish ?? 0.35
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
  const blended = requested * 0.7 + local * 0.3;
  const aroundCalibration = Math.max(requested - 0.06, Math.min(requested + 0.06, blended));
  if (!Number.isFinite(previous)) return aroundCalibration;
  return Math.max(previous - 0.025, Math.min(previous + 0.025, aroundCalibration));
}

function normalizeRegion(region) {
  if (!region || !Number.isFinite(region.x) || !Number.isFinite(region.y) || !Number.isFinite(region.size)) return null;
  const size = Math.round(region.size);
  return {
    x: Math.round(region.x),
    y: Math.round(region.y),
    width: size,
    height: size
  };
}

export async function cleanVideo(file, options = {}) {
  const manual = normalizeRegion(options.manual);
  const detectedRegion = normalizeRegion(options.detectedRegion);
  let analysis = null;

  if (!manual && !detectedRegion) {
    analysis = await inspectVideo(file, options);
    if (!analysis.internalDetection.detected && !options.forceCleanup) {
      throw new Error(`Watermark confidence ${analysis.internalDetection.confidence.toFixed(3)} is below threshold. Enable force cleanup or use manual mode.`);
    }
  }

  const input = createInput(file);
  const track = await input.getPrimaryVideoTrack();
  if (!track) { input.dispose(); throw new Error('No video track found'); }
  const metadata = await metadataOf(input, track, { includeStats: true });
  const position = manual || detectedRegion || analysis.internalDetection.position;

  if (position.x < 0 || position.y < 0 || position.x + position.width > metadata.width || position.y + position.height > metadata.height) {
    input.dispose();
    throw new Error('Watermark region is outside the video frame');
  }

  const alphaMap = manual || detectedRegion
    ? await getVideoAlphaMap(position.width)
    : analysis.internalDetection.alphaMap;
  const requestedGain = Number.isFinite(options.alphaGain) ? options.alphaGain : (analysis?.internalDetection.alphaGain ?? 1);
  const expanded = expandedRegion(position, metadata.width, metadata.height, REPAIR_PADDING);
  const inner = { offsetX: expanded.offsetX, offsetY: expanded.offsetY, width: position.width, height: position.height };

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
  let history = [];
  let atlasFrames = 0;
  let atlasDonorsPeak = 0;
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
        const paddedOriginal = ctx.getImageData(expanded.x, expanded.y, expanded.width, expanded.height);
        const original = cropRegion(paddedOriginal, inner.offsetX, inner.offsetY, inner.width, inner.height);
        const score = scoreRegion(original, { x: 0, y: 0, width: position.width, height: position.height }, alphaMap).confidence;
        const shouldProcess = options.forceCleanup || manual || score >= lowGate;
        if (shouldProcess) {
          const shotDelta = meanRoiLumaDelta(original, previousTemporal?.original);
          const shotChanged = shotDelta >= (Number.isFinite(options.shotCutThreshold) ? options.shotCutThreshold : 34);
          if (shotChanged) {
            previousGain = Number.NaN;
            previousTemporal = null;
            history = [];
          }
          const gain = frameGain(original, alphaMap, requestedGain, previousGain, options.adaptiveAlpha !== false, score);
          previousGain = gain;
          const repaired = repairPaddedRegion(
            paddedOriginal,
            inner,
            alphaMap,
            gain,
            options.edgePolish ?? 0.35,
            options.temporalStabilize !== false ? history : [],
            options.temporalStabilize !== false
          );
          let processed = repaired.cleaned;
          if (repaired.atlasSummary?.donorCount >= 3) {
            atlasFrames++;
            atlasDonorsPeak = Math.max(atlasDonorsPeak, repaired.atlasSummary.donorCount);
          }
          if (options.temporalStabilize !== false) {
            processed = stabilizeCorrection(original, processed, previousTemporal, alphaMap, 0.45);
          }
          const finalPadded = pasteRegion(repaired.repairedPadded, processed, inner.offsetX, inner.offsetY);
          ctx.putImageData(toImageDataLike(finalPadded), expanded.x, expanded.y);
          previousTemporal = { original, processed, paddedOriginal };
          history.push(finalPadded);
          if (history.length > MAX_ATLAS_HISTORY) history.shift();
        } else {
          skippedFrames++;
          previousTemporal = null;
          history = [];
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
        version: '1.0.14',
        position,
        alphaGain: previousGain,
        processedFrames,
        skippedFrames,
        audio: audioResult,
        repair: {
          padding: REPAIR_PADDING,
          paddedTexture: true,
          multiFrameAtlas: options.temporalStabilize !== false,
          atlasFrames,
          atlasDonorsPeak,
          historyLimit: MAX_ATLAS_HISTORY
        },
        detection: analysis?.detection || (detectedRegion ? { detected: true, position } : null)
      }
    };
  } finally {
    input.dispose();
  }
}
