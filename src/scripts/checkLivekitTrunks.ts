import { SipClient } from "livekit-server-sdk";
import { env } from "../config/env.js";

async function run() {
  const sip = new SipClient(env.livekitUrl.replace("wss://", "https://"), env.livekitApiKey, env.livekitApiSecret);
  const trunks = await sip.listSipOutboundTrunk();
  console.log("LIVEKIT_OUTBOUND_TRUNKS:", JSON.stringify(trunks, null, 2));
  process.exit(0);
}

run().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
