import "server-only";

export type TranscriptionResult =
  | { ok: true; text: string; language?: string }
  | { ok: false; error: string };

/**
 * Transcribes a customer voice note using ElevenLabs Speech-to-Text Scribe API.
 * Uses the cost-effective `scribe_v2` model with diarization/tagging disabled
 * to maintain the lowest possible compute cost.
 */
export async function transcribeVoiceNote(
  audioBuffer: Buffer | Uint8Array,
  mimetype: string = "audio/ogg"
): Promise<TranscriptionResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      error: "ELEVENLABS_API_KEY is not configured in environment variables.",
    };
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    return { ok: false, error: "Empty audio buffer received." };
  }

  try {
    const formData = new FormData();
    const audioBytes = audioBuffer instanceof Buffer ? new Uint8Array(audioBuffer) : audioBuffer;
    const cleanMime = mimetype.split(";")[0].trim() || "audio/ogg";
    const extension = cleanMime.includes("mp4") || cleanMime.includes("m4a") ? "m4a" : "ogg";

    const blob = new Blob([audioBytes as unknown as BlobPart], { type: cleanMime });
    formData.append("file", blob, `voicenote.${extension}`);
    formData.append("model_id", "scribe_v2");
    formData.append("tag_audio_events", "false");
    formData.append("diarize", "false");

    const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error("elevenlabs_stt_error", response.status, errorText);
      return {
        ok: false,
        error: `ElevenLabs transcription error (${response.status}): ${errorText.slice(0, 200)}`,
      };
    }

    const data = (await response.json()) as { text?: string; language_code?: string };
    const text = (data.text || "").trim();

    if (!text) {
      return { ok: false, error: "No audible speech recognized in voice note." };
    }

    return { ok: true, text, language: data.language_code };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown transcription error";
    console.error("elevenlabs_transcription_failed", err);
    return { ok: false, error: message };
  }
}
