import { randomUUID } from "node:crypto";
import { startSession, type ClientSession, type HydratedDocument } from "mongoose";

import { PhoneNumberCallAdmissionModel } from "../models/PhoneNumberCallAdmission.js";
import { PhoneNumberModel, type PhoneNumber } from "../models/PhoneNumber.js";
import { HttpError } from "../utils/httpError.js";

const admissionLeaseMs = 2 * 60 * 1_000;
const admissionHeartbeatMs = 30 * 1_000;
const admissionReleaseRetryDelaysMs = [0, 75, 250, 750] as const;

type PhoneNumberDocument = HydratedDocument<PhoneNumber>;

export type PhoneNumberCallAdmissionLease = {
  phone: PhoneNumberDocument;
  assertHeld: () => Promise<void>;
  linearizeCallStart: <T>(work: (session: ClientSession, setupToken: string) => Promise<T>) => Promise<T>;
  fenceCallStep: <T>(work: (session: ClientSession, setupToken: string) => Promise<T>) => Promise<T>;
  release: () => Promise<void>;
};

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function deleteAdmissionWithRetry(filter: {
  _id: string;
  ownerId: string;
  phoneNumberId: string;
}) {
  let lastError: unknown;
  for (const delay of admissionReleaseRetryDelaysMs) {
    if (delay) await wait(delay);
    try {
      await PhoneNumberCallAdmissionModel.deleteOne(filter);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("The phone-number call admission could not be released.");
}

/**
 * Shared call-start admission. Multiple calls may hold rows concurrently, but
 * every route mutation first marks the PhoneNumber with an exclusive token.
 * Creating this row before re-reading the PhoneNumber closes both orderings:
 * a mutation either sees the admission, or this read sees its mutation token.
 */
export async function acquirePhoneNumberCallAdmission(
  ownerId: string,
  phoneNumberId: string,
  options: { campaignId?: string } = {},
): Promise<PhoneNumberCallAdmissionLease> {
  const admissionId = randomUUID();
  const setupToken = randomUUID();
  await PhoneNumberCallAdmissionModel.create({
    _id: admissionId,
    ownerId,
    phoneNumberId,
    campaignId: options.campaignId || null,
    setupToken,
    expiresAt: new Date(Date.now() + admissionLeaseMs),
  });

  let phone: PhoneNumberDocument | null = null;
  try {
    // Fence an abandoned exclusive mutation before admitting the call.
    // Clearing the expired token makes any old holder's conditional write fail.
    await PhoneNumberModel.updateOne(
      {
        _id: phoneNumberId,
        ownerId,
        lifecycle: { $ne: "deleting" },
        mutationExpiresAt: { $lte: new Date() },
      },
      { $set: { mutationToken: "", mutationExpiresAt: null } },
    );

    phone = await PhoneNumberModel.findOne({
      _id: phoneNumberId,
      ownerId,
      lifecycle: { $ne: "deleting" },
      $or: [
        { mutationToken: "" },
        { mutationToken: null },
        { mutationToken: { $exists: false } },
      ],
    }).select("+mutationToken +mutationExpiresAt");

    if (!phone) {
      const existing = await PhoneNumberModel.exists({ _id: phoneNumberId, ownerId });
      if (!existing) throw new HttpError(404, "Phone number not found.");
      throw new HttpError(409, "This phone number is being updated. Wait for that operation to finish before calling.");
    }
  } catch (error) {
    await deleteAdmissionWithRetry({
      _id: admissionId,
      ownerId,
      phoneNumberId,
    }).catch((cleanupError) => {
      console.error(JSON.stringify({
        event: "phone-number-call-admission-acquire-cleanup-failed",
        phoneNumberId,
        ownerId,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      }));
    });
    throw error;
  }

  let finished = false;
  let lost = false;
  const renew = async () => {
    if (finished || lost) {
      throw new HttpError(409, "The outbound call lost its phone-number admission lease.");
    }
    const now = new Date();
    const result = await PhoneNumberCallAdmissionModel.updateOne(
      { _id: admissionId, ownerId, phoneNumberId, expiresAt: { $gt: now } },
      { $set: { expiresAt: new Date(now.getTime() + admissionLeaseMs) } },
    );
    if (result.matchedCount !== 1) {
      lost = true;
      throw new HttpError(409, "The outbound call lost its phone-number admission lease.");
    }
  };

  const runFencedTransaction = async <T>(work: (session: ClientSession) => Promise<T>) => {
    if (finished || lost) {
      throw new HttpError(409, "The outbound call lost its phone-number admission lease.");
    }

    const callStartFence = randomUUID();
    const session = await startSession();
    let result!: T;
    let completed = false;
    try {
      await session.withTransaction(async () => {
        if (finished || lost) {
          throw new HttpError(409, "The outbound call lost its phone-number admission lease.");
        }

        const now = new Date();
        const admission = await PhoneNumberCallAdmissionModel.updateOne(
          { _id: admissionId, ownerId, phoneNumberId, expiresAt: { $gt: now } },
          { $set: { expiresAt: new Date(now.getTime() + admissionLeaseMs) } },
          { session },
        );
        if (admission.matchedCount !== 1) {
          lost = true;
          throw new HttpError(409, "The outbound call lost its phone-number admission lease.");
        }

        // This write is deliberately short-lived: it serializes CDR creation
        // with the mutation token flip, while shared admissions still allow
        // any number of calls to proceed concurrently once their CDRs exist.
        const phoneFence = await PhoneNumberModel.updateOne(
          {
            _id: phone._id,
            ownerId,
            number: phone.number,
            agentId: phone.agentId ?? null,
            status: phone.status,
            direction: phone.direction,
            lifecycle: { $ne: "deleting" },
            $or: [
              { mutationToken: "" },
              { mutationToken: null },
              { mutationToken: { $exists: false } },
            ],
          },
          { $set: { callStartFence } },
          { session, timestamps: false },
        );
        if (phoneFence.matchedCount !== 1) {
          lost = true;
          throw new HttpError(
            409,
            "The outbound phone number changed before the call started. Refresh phone numbers before calling.",
          );
        }

        result = await work(session);
        completed = true;
      }, {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
      });

      if (!completed) {
        throw new Error("The outbound call-start transaction completed without a result.");
      }
      return result;
    } finally {
      await session.endSession();
    }
  };

  const linearizeCallStart = <T>(
    work: (session: ClientSession, currentSetupToken: string) => Promise<T>,
  ) => runFencedTransaction((session) => work(session, setupToken));

  const fenceCallStep = <T>(
    work: (session: ClientSession, currentSetupToken: string) => Promise<T>,
  ) => runFencedTransaction((session) => work(session, setupToken));

  const heartbeat = setInterval(() => {
    void renew().catch((error) => {
      console.error(JSON.stringify({
        event: "phone-number-call-admission-heartbeat-failed",
        phoneNumberId,
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  }, admissionHeartbeatMs);
  heartbeat.unref();

  let released = false;
  let releasePromise: Promise<void> | null = null;

  return {
    phone,
    assertHeld: renew,
    linearizeCallStart,
    fenceCallStep,
    async release() {
      if (released) return;
      if (releasePromise) return releasePromise;
      finished = true;
      clearInterval(heartbeat);
      const pendingRelease = deleteAdmissionWithRetry({
        _id: admissionId,
        ownerId,
        phoneNumberId,
      });
      releasePromise = pendingRelease;
      try {
        await pendingRelease;
        released = true;
      } finally {
        if (releasePromise === pendingRelease) releasePromise = null;
      }
    },
  };
}
