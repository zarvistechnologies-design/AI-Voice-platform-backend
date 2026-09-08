import { tokenize, tts } from "@livekit/agents";
import { firstVoiceClauseBoundary } from "./voicePhraseBoundary.js";

const terminalPunctuation = /[.!?…।॥。！？؟]["'”’)\]}]*\s*$/u;
// A period after a digit may be the start of a decimal in the next LLM chunk.
// Common titles likewise need their following name before they are spoken.
const ambiguousTerminalPeriod = /(?:\p{N}|\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St))\.\s*$/iu;

/**
 * LiveKit's default streaming sentence tokenizer waits for text from the next
 * sentence before releasing the previous one. For voice replies that adds an
 * avoidable LLM-completion pause before TTS can start. This tokenizer releases
 * a complete phrase as soon as terminal punctuation arrives while retaining a
 * small buffer for abbreviations and very short acknowledgements.
 */
export class LowLatencySentenceTokenizer extends tokenize.SentenceTokenizer {
  constructor(private readonly earlyClauses: boolean | "first" = false) {
    super();
  }
  private readonly delegate = new tokenize.basic.SentenceTokenizer({
    minSentenceLength: 8,
    streamContextLength: 1,
  });

  override tokenize(text: string, language?: string) {
    return this.delegate.tokenize(text, language);
  }

  override stream() {
    let releasedFirstPhrase = false;
    return new tokenize.BufferedSentenceStream((text) => {
      const sentences = this.delegate.tokenize(text);
      const canReleaseClause = this.earlyClauses && (this.earlyClauses !== "first" || !releasedFirstPhrase);
      const boundary = canReleaseClause ? firstVoiceClauseBoundary(text) : undefined;
      // Prefer an earlier sentence boundary if a single LLM chunk contains
      // multiple sentences; clause streaming must not merge them together.
      if (boundary !== undefined && (sentences.length <= 1 || boundary < sentences[0]!.length)) {
        releasedFirstPhrase = true;
        const remainder = text.slice(boundary).trim();
        return [text.slice(0, boundary).trim(), ...(
          remainder ? this.delegate.tokenize(remainder) : [""]
        )];
      }
      // BufferedSentenceStream intentionally retains its final token. An empty
      // sentinel proves the preceding token is complete, so it is emitted now.
      const tokens = terminalPunctuation.test(text) && !ambiguousTerminalPeriod.test(text) && sentences.length
        ? [...sentences, ""]
        : sentences;
      if (tokens.length > 1) releasedFirstPhrase = true;
      return tokens;
    }, 8, 1);
  }
}

/** Preserve provider/model metrics while adapting HTTP audio streams to eager phrases. */
export class LowLatencyTtsStreamAdapter extends tts.StreamAdapter {
  private closing?: Promise<void>;

  constructor(private readonly delegate: tts.TTS) {
    // Send a substantial first clause early, then retain complete sentences.
    // This bounds extra HTTP requests and preserves context for later speech.
    super(delegate, new LowLatencySentenceTokenizer("first"));
  }

  override get model() {
    return this.delegate.model;
  }

  override get provider() {
    return this.delegate.provider;
  }

  override close() {
    // LiveKit's adapter only detaches listeners; it does not close its provider.
    // Cancel provider requests/connections when the call's adapter is closed.
    this.closing ??= Promise.all([super.close(), this.delegate.close()]).then(() => undefined);
    return this.closing;
  }
}

export function createLowLatencySentenceTokenizer() {
  return new LowLatencySentenceTokenizer("first");
}
