import assert from "node:assert/strict";
import test from "node:test";

import { modelCatalog } from "../src/services/modelCatalog.js";
import {
  canonicalPricingProvider,
  missingPricingForModel,
} from "../src/services/modelPricingService.js";

test("publishes Mercury 2.5 as an Inception pipeline LLM", () => {
  const inception = modelCatalog.llm.find((provider) => provider.provider === "inception");
  assert.deepEqual(inception?.models, ["mercury-2.5"]);
});

test("prices and canonicalizes Inception Mercury usage", () => {
  assert.equal(canonicalPricingProvider("api.inceptionlabs.ai"), "inception");
  assert.equal(missingPricingForModel("llm", "inception", "mercury-2.5"), null);
  assert.equal(missingPricingForModel("llm", "inception", "mercury-voice"), null);
});
