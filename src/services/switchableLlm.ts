import { llm } from "@livekit/agents";

/**
 * Keeps an AgentSession subscribed to one stable LLM while allowing future
 * generations to use a replacement model. Metrics and errors from every model
 * are forwarded so an in-flight request still reports usage after a switch.
 */
export class SwitchableLlm<TModel extends llm.LLM = llm.LLM> extends llm.LLM {
  private activeModel: TModel;
  private readonly models = new Set<TModel>();

  constructor(initialModel: TModel) {
    super();
    this.activeModel = initialModel;
    this.track(initialModel);
  }

  private track(model: TModel) {
    if (this.models.has(model)) return;
    this.models.add(model);
    model.on("metrics_collected", (metrics) => this.emit("metrics_collected", metrics));
    model.on("error", (error) => this.emit("error", error));
  }

  activate(model: TModel) {
    this.track(model);
    this.activeModel = model;
  }

  label() {
    return this.activeModel.label();
  }

  override get model() {
    return this.activeModel.model;
  }

  override get provider() {
    return this.activeModel.provider;
  }

  override prewarm() {
    this.activeModel.prewarm();
  }

  override async aclose() {
    await Promise.allSettled([...this.models].map((model) => model.aclose()));
  }

  override chat(args: Parameters<llm.LLM["chat"]>[0]) {
    return this.activeModel.chat(args);
  }
}
