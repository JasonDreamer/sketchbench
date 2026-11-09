// 書き出した動画ファイルの中身を読む(コーデック、解像度、尺、フレーム数、fps)。
// 使い方: node tools/probe-media.mjs <ファイル>
import { ALL_FORMATS, FilePathSource, Input } from "mediabunny";

const file = process.argv[2];
const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
const video = await input.getPrimaryVideoTrack();
const stats = await video.computePacketStats();
const out = {
  file,
  mimeType: await input.getMimeType(),
  duration: await input.computeDuration(),
  codec: video.codec,
  codecString: await video.getCodecParameterString(),
  width: video.displayWidth,
  height: video.displayHeight,
  frames: stats.packetCount,
  fps: stats.averagePacketRate,
  bitrate: Math.round(stats.averageBitrate),
  colorSpace: await video.getColorSpace?.(),
};
console.log(JSON.stringify(out, null, 2));
