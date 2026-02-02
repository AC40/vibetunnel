/**
 * Voice Transcription Service
 *
 * Handles transcription of voice messages using DeepGram API.
 */

import chalk from 'chalk';

// Debug mode: set TELEGRAM_DEBUG=true or TELEGRAM_DEBUG=1 for verbose logging
const isDebug = process.env.TELEGRAM_DEBUG === 'true' || process.env.TELEGRAM_DEBUG === '1';
const noop = () => {};

const createLogger = (name: string) => ({
  log: isDebug ? (...args: unknown[]) => console.log(chalk.blue(`[${name}]`), ...args) : noop,
  error: (...args: unknown[]) => console.error(chalk.red(`[${name}]`), ...args),
  warn: (...args: unknown[]) => console.warn(chalk.yellow(`[${name}]`), ...args),
  debug: isDebug ? (...args: unknown[]) => console.debug(chalk.gray(`[${name}]`), ...args) : noop,
});

const logger = createLogger('voice-transcription');

export interface VoiceTranscriptionConfig {
  deepgramApiKey: string;
  /** Model to use for transcription. Default: 'nova-2' */
  model?: string;
  /** Language code for transcription. Default: 'en' */
  language?: string;
}

export interface TranscriptionResult {
  text: string;
  confidence?: number;
  duration?: number;
}

/**
 * DeepGram API response structure
 */
interface DeepgramResponse {
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
        confidence?: number;
      }>;
    }>;
  };
  metadata?: {
    duration?: number;
  };
}

/**
 * Service for transcribing voice messages using DeepGram API.
 */
export class VoiceTranscriptionService {
  private apiKey: string;
  private model: string;
  private language: string;

  constructor(config: VoiceTranscriptionConfig) {
    this.apiKey = config.deepgramApiKey;
    this.model = config.model ?? 'nova-2';
    this.language = config.language ?? 'en';
  }

  /**
   * Check if the service is configured and ready to use.
   */
  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Transcribe audio from a URL (e.g., Telegram file URL).
   *
   * @param audioUrl - URL to the audio file
   * @returns Transcription result with text and metadata
   */
  async transcribeFromUrl(audioUrl: string): Promise<TranscriptionResult> {
    logger.log(`Transcribing audio from URL: ${audioUrl.slice(0, 50)}...`);

    const response = await fetch(
      `https://api.deepgram.com/v1/listen?model=${this.model}&language=${this.language}&smart_format=true`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: audioUrl }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`DeepGram API error: ${response.status} - ${errorText}`);
      throw new Error(`DeepGram API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as DeepgramResponse;
    logger.debug('DeepGram response:', JSON.stringify(data, null, 2));

    const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
    const confidence = data.results?.channels?.[0]?.alternatives?.[0]?.confidence;
    const duration = data.metadata?.duration;

    if (!transcript) {
      logger.warn('No transcript returned from DeepGram');
    }

    logger.log(
      `Transcription complete: "${transcript.slice(0, 100)}..." (${duration?.toFixed(1)}s)`
    );

    return {
      text: transcript,
      confidence,
      duration,
    };
  }

  /**
   * Transcribe audio from a buffer.
   *
   * @param audioBuffer - Buffer containing the audio data
   * @param mimeType - MIME type of the audio (e.g., 'audio/ogg')
   * @returns Transcription result with text and metadata
   */
  async transcribeFromBuffer(
    audioBuffer: Buffer,
    mimeType: string = 'audio/ogg'
  ): Promise<TranscriptionResult> {
    logger.log(`Transcribing audio from buffer (${audioBuffer.length} bytes, ${mimeType})`);

    const response = await fetch(
      `https://api.deepgram.com/v1/listen?model=${this.model}&language=${this.language}&smart_format=true`,
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
      logger.error(`DeepGram API error: ${response.status} - ${errorText}`);
      throw new Error(`DeepGram API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as DeepgramResponse;
    logger.debug('DeepGram response:', JSON.stringify(data, null, 2));

    const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
    const confidence = data.results?.channels?.[0]?.alternatives?.[0]?.confidence;
    const duration = data.metadata?.duration;

    if (!transcript) {
      logger.warn('No transcript returned from DeepGram');
    }

    logger.log(
      `Transcription complete: "${transcript.slice(0, 100)}..." (${duration?.toFixed(1)}s)`
    );

    return {
      text: transcript,
      confidence,
      duration,
    };
  }
}
