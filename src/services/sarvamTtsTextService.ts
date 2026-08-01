import { tokenize } from "@livekit/agents";

const sarvamSupportedLetter = /[\p{Script=Latin}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Oriya}]/u;
const numericCharacter = /\p{Number}/u;

export function normalizeSarvamTtsToken(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (sarvamSupportedLetter.test(trimmed)) return trimmed;
  if (numericCharacter.test(trimmed)) return `Number ${trimmed}`;
  return "";
}

class SarvamSentenceStream extends tokenize.SentenceStream {
  constructor(
    private readonly delegate: tokenize.SentenceStream,
    private readonly onSkippedToken?: (text: string) => void,
  ) {
    super();
  }

  override get closed() {
    return this.delegate.closed;
  }

  override pushText(text: string) {
    this.delegate.pushText(text);
  }

  override flush() {
    this.delegate.flush();
  }

  override endInput() {
    this.delegate.endInput();
  }

  override close() {
    this.delegate.close();
  }

  override async next(): Promise<IteratorResult<tokenize.TokenData>> {
    while (true) {
      const result = await this.delegate.next();
      if (result.done) return result;

      const token = normalizeSarvamTtsToken(result.value.token);
      if (token) {
        return {
          done: false,
          value: { ...result.value, token },
        };
      }
      this.onSkippedToken?.(result.value.token);
    }
  }
}

export class SarvamSafeSentenceTokenizer extends tokenize.SentenceTokenizer {
  private readonly delegate = new tokenize.basic.SentenceTokenizer({ minSentenceLength: 8 });

  constructor(private readonly onSkippedToken?: (text: string) => void) {
    super();
  }

  override tokenize(text: string, language?: string) {
    return this.delegate
      .tokenize(text, language)
      .map(normalizeSarvamTtsToken)
      .filter(Boolean);
  }

  override stream() {
    return new SarvamSentenceStream(this.delegate.stream(), this.onSkippedToken);
  }
}
