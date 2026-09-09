import { tokenize, tts } from "@livekit/agents";

const terminalPunctuation = /[.!?…।॥。！？؟]["'”’)\]}]*\s*$/u;

/**
 * LiveKit's default streaming sentence tokenizer waits for text from the next
 * sentence before releasing the previous one. For voice replies that adds an
 * avoidable LLM-completion pause before TTS can start. This tokenizer releases
 * a complete phrase as soon as terminal punctuation arrives while retaining a
 * small buffer for abbreviations and very short acknowledgements.
 */
export class LowLatencySentenceTokenizer extends tokenize.SentenceTokenizer {
  private readonly delegate = new tokenize.basic.SentenceTokenizer({
    minSentenceLength: 8,
    streamContextLength: 1,
  });

  override tokenize(text: string, language?: string) {
    return this.delegate.tokenize(text, language);
  }

  override stream() {
    return new tokenize.BufferedSentenceStream((text) => {
      const sentences = this.delegate.tokenize(text);
      // BufferedSentenceStream intentionally retains its final token. An empty
      // sentinel proves the preceding token is complete, so it is emitted now.
      return terminalPunctuation.test(text) && sentences.length
        ? [...sentences, ""]
        : sentences;
    }, 8, 1);
  }
}

/** Preserve provider/model metrics while adapting HTTP audio streams to eager phrases. */
export class LowLatencyTtsStreamAdapter extends tts.StreamAdapter {
  constructor(private readonly delegate: tts.TTS) {
    super(delegate, new LowLatencySentenceTokenizer());
  }

  override get model() {
    return this.delegate.model;
  }

  override get provider() {
    return this.delegate.provider;
  }
}

export function createLowLatencySentenceTokenizer() {
  return new LowLatencySentenceTokenizer();
}
