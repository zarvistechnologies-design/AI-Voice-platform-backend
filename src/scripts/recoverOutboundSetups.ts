import mongoose, { isValidObjectId } from "mongoose";

import { connectDatabase } from "../config/database.js";
import { recoverOutboundSetupsAfterProcessDrain } from "../services/outboundSetupRecoveryService.js";

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length).trim() ?? "";
}

const confirmed = argument("confirm-processes-drained");
const callId = argument("call-id");
const phoneNumberId = argument("phone-number-id");
const campaignId = argument("campaign-id");
const scopes = [callId, phoneNumberId, campaignId].filter(Boolean);

if (confirmed !== "YES") {
  throw new Error(
    "Refusing recovery. Stop/drain every API and worker process that could own outbound setup, then pass --confirm-processes-drained=YES.",
  );
}
if (scopes.length !== 1 || !isValidObjectId(scopes[0])) {
  throw new Error("Pass exactly one valid --call-id, --phone-number-id, or --campaign-id ObjectId.");
}

await connectDatabase({ autoIndex: false });
try {
  const result = await recoverOutboundSetupsAfterProcessDrain(
    {
      ...(callId ? { callId } : {}),
      ...(phoneNumberId ? { phoneNumberId } : {}),
      ...(campaignId ? { campaignId } : {}),
    },
    { processesDrained: true, limit: 100 },
  );
  console.log(JSON.stringify({ event: "outbound-setup-recovery-complete", ...result }));
  if (result.blocked > 0 || result.remaining > 0) process.exitCode = 2;
} finally {
  await mongoose.disconnect();
}
