import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeVoiceNote } from "@/lib/server/audio/elevenlabs";

describe("ElevenLabs Voice Note Parser", () => {
  const originalEnv = process.env.ELEVENLABS_API_KEY;

  afterEach(() => {
    process.env.ELEVENLABS_API_KEY = originalEnv;
    vi.restoreAllMocks();
  });

  it("returns an error if ELEVENLABS_API_KEY is missing", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const result = await transcribeVoiceNote(Buffer.from("fake-audio-bytes"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ELEVENLABS_API_KEY is not configured");
    }
  });

  it("returns an error if empty audio buffer is provided", async () => {
    process.env.ELEVENLABS_API_KEY = "synthetic-test-key";
    const result = await transcribeVoiceNote(Buffer.alloc(0));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Empty audio buffer");
    }
  });

  it("successfully transcribes audio using ElevenLabs Scribe API", async () => {
    process.env.ELEVENLABS_API_KEY = "test-elevenlabs-api-key";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        text: "Sarah please pack 2 extra rotis tomorrow",
        language_code: "eng",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const fakeAudio = Buffer.from("audio-content-test");
    const result = await transcribeVoiceNote(fakeAudio, "audio/ogg; codecs=opus");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("Sarah please pack 2 extra rotis tomorrow");
      expect(result.language).toBe("eng");
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(options.headers["xi-api-key"]).toBe("test-elevenlabs-api-key");
    expect(options.method).toBe("POST");
  });

  it("handles ElevenLabs API errors gracefully", async () => {
    process.env.ELEVENLABS_API_KEY = "test-elevenlabs-api-key";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized: Invalid API key",
    });
    vi.stubGlobal("fetch", mockFetch);

    const fakeAudio = Buffer.from("audio-content-test");
    const result = await transcribeVoiceNote(fakeAudio, "audio/ogg");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("401");
      expect(result.error).toContain("Unauthorized");
    }
  });
});
