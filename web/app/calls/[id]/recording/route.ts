import { hasSession } from "@/lib/auth";
import { getRecordingAudio } from "@/lib/queries";
import { stereoWav } from "@/lib/wav";

export const dynamic = "force-dynamic";

/**
 * GET /calls/<id>/recording: the call's recording as a stereo WAV (caller
 * left, Ava right), built from the stored mu-law tracks. Supports a single
 * byte range so the browser's player can seek.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await hasSession())) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const callId = Number.parseInt(id, 10);
  if (!Number.isFinite(callId)) return new Response("Not found", { status: 404 });

  const audio = await getRecordingAudio(callId);
  if (!audio) return new Response("No recording for this call", { status: 404 });
  const wav = stereoWav(audio.caller_audio, audio.ava_audio, audio.sample_rate);

  const headers: Record<string, string> = {
    "Content-Type": "audio/wav",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "Content-Disposition": `inline; filename="call-${callId}.wav"`,
  };

  const range = request.headers.get("range");
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, wav.length - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), wav.length - 1) : wav.length - 1;
    if (start > end || start >= wav.length) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${wav.length}` } });
    }
    const slice = wav.subarray(start, end + 1);
    return new Response(new Uint8Array(slice), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${wav.length}`, "Content-Length": String(slice.length) },
    });
  }
  return new Response(new Uint8Array(wav), { status: 200, headers: { ...headers, "Content-Length": String(wav.length) } });
}
