/**
 * Voice Transcriber
 *
 * Transcribes voice messages using Deepgram API.
 */

interface TranscriptionResult {
  text?: string;
  error?: string;
}

interface DeepgramResponse {
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
      }>;
    }>;
  };
  error?: string;
}

export class VoiceTranscriber {
  private apiKey: string | undefined;

  constructor() {
    this.apiKey = process.env.DEEPGRAM_API_KEY;
  }

  /**
   * Check if the transcriber is configured with an API key
   */
  isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Transcribe audio buffer to text using Deepgram
   */
  async transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptionResult> {
    if (!this.apiKey) {
      return { error: 'DEEPGRAM_API_KEY is not configured' };
    }

    try {
      const response = await fetch(
        'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true',
        {
          method: 'POST',
          headers: {
            Authorization: `Token ${this.apiKey}`,
            'Content-Type': mimeType,
          },
          body: audioBuffer,
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        return { error: `Deepgram API error (${response.status}): ${errorText}` };
      }

      const data = (await response.json()) as DeepgramResponse;

      // Extract transcript from response
      const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript;

      if (!transcript || transcript.trim() === '') {
        return { error: 'Could not transcribe voice message (no speech detected)' };
      }

      return { text: transcript };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { error: `Transcription failed: ${message}` };
    }
  }
}
