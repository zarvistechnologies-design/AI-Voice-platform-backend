import { ProviderIntegrationModel } from "../models/ProviderIntegration.js";
import { HttpError } from "../utils/httpError.js";
import { decryptSecret, encryptSecret } from "../utils/secretCrypto.js";
import { listVobizOwnedNumbers, type VobizCredentials } from "./vobizService.js";

export async function getVobizIntegration(ownerId: string) {
  return ProviderIntegrationModel.findOne({ ownerId, provider: "vobiz" });
}

export async function getVobizCredentials(ownerId: string): Promise<VobizCredentials> {
  const integration = await ProviderIntegrationModel.findOne({
    ownerId,
    provider: "vobiz",
  }).select("+secretEncrypted");
  if (!integration) {
    throw new HttpError(409, "Connect your Vobiz account before managing phone numbers.");
  }
  let authToken = "";
  try {
    authToken = decryptSecret(integration.secretEncrypted);
  } catch {
    await ProviderIntegrationModel.updateOne(
      { _id: integration._id },
      { status: "error" },
    );
    throw new HttpError(
      409,
      "Your saved Vobiz credentials can no longer be decrypted. Restore the original INTEGRATION_ENCRYPTION_KEY or disconnect and reconnect your Vobiz account.",
    );
  }
  return {
    authId: integration.accountId,
    authToken,
  };
}

export async function connectVobiz(ownerId: string, credentials: VobizCredentials) {
  const numbers = await listVobizOwnedNumbers(credentials, 1, 1);
  return ProviderIntegrationModel.findOneAndUpdate(
    { ownerId, provider: "vobiz" },
    {
      ownerId,
      provider: "vobiz",
      accountId: credentials.authId,
      secretEncrypted: encryptSecret(credentials.authToken),
      status: "connected",
      lastVerifiedAt: new Date(),
      metadata: { ownedNumberCount: numbers.total },
    },
    { new: true, upsert: true, runValidators: true },
  );
}

export async function disconnectVobiz(ownerId: string) {
  await ProviderIntegrationModel.deleteOne({ ownerId, provider: "vobiz" });
}
