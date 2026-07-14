import { randomUUID } from "node:crypto";
import { startSession, type ClientSession, type HydratedDocument, type UpdateQuery } from "mongoose";

import { CallDetailRecordModel } from "../models/CallDetailRecord.js";
import { PhoneNumberCallAdmissionModel } from "../models/PhoneNumberCallAdmission.js";
import { PhoneNumberModel, type PhoneNumber } from "../models/PhoneNumber.js";
import { HttpError } from "../utils/httpError.js";

const mutationLeaseMs = 5 * 60 * 1_000;
const mutationHeartbeatMs = 60 * 1_000;

export function phoneNumberMutationLeaseExpiry() {
  return new Date(Date.now() + mutationLeaseMs);
}

type PhoneNumberDocument = HydratedDocument<PhoneNumber>;

function mutationLease(
  ownerId: string,
  phoneNumberId: string,
  phone: PhoneNumberDocument,
  token: string,
  options: { deleting?: boolean; wasDeleting?: boolean } = {},
) {
  let finished = false;
  let lost = false;

  const mutationFilter = {
    _id: phone._id,
    ownerId,
    mutationToken: token,
    lifecycle: options.deleting ? "deleting" : { $ne: "deleting" },
  };

  const renew = async () => {
    if (finished || lost) {
      throw new HttpError(409, "The phone-number update lease was lost. Sync phone routes before retrying.");
    }
    const result = await PhoneNumberModel.updateOne(
      mutationFilter,
      { $set: { mutationExpiresAt: new Date(Date.now() + mutationLeaseMs) } },
    );
    if (result.matchedCount !== 1) {
      lost = true;
      throw new HttpError(409, "The phone-number update lease was lost. Sync phone routes before retrying.");
    }
  };
  const heartbeat = setInterval(() => {
    void renew().catch((error) => {
      console.error(JSON.stringify({
        event: "phone-number-mutation-heartbeat-failed",
        phoneNumberId,
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  }, mutationHeartbeatMs);
  heartbeat.unref();

  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
  };

  return {
    phone,
    token,
    assertHeld: renew,
    async updateLocked(update: UpdateQuery<PhoneNumber>, session?: ClientSession) {
      if (finished || lost) {
        throw new HttpError(409, "The phone-number update lease was lost. Sync phone routes before retrying.");
      }
      const updated = await PhoneNumberModel.findOneAndUpdate(
        mutationFilter,
        update,
        { new: true, runValidators: true, ...(session ? { session } : {}) },
      ).select("+mutationToken +mutationExpiresAt");
      if (!updated) {
        lost = true;
        throw new HttpError(409, "The phone number changed while it was being updated. Sync phone routes before retrying.");
      }
      return updated;
    },
    async release() {
      if (finished) return;
      finish();
      if (options.deleting) {
        await PhoneNumberModel.updateOne(
          mutationFilter,
          { $set: { mutationExpiresAt: new Date() } },
        );
        return;
      }
      await PhoneNumberModel.updateOne(
        mutationFilter,
        { $set: { mutationToken: "", mutationExpiresAt: null } },
      );
    },
    async deleteLocked(session?: ClientSession) {
      if (!options.deleting) throw new Error("A normal phone-number mutation cannot delete the record.");
      if (finished || lost) {
        throw new HttpError(409, "The phone-number delete lease was lost. Refresh phone numbers before retrying.");
      }
      const result = await PhoneNumberModel.deleteOne(
        mutationFilter,
        session ? { session } : undefined,
      );
      if (result.deletedCount !== 1) {
        lost = true;
        throw new HttpError(409, "The phone-number delete lease was lost. Refresh phone numbers before retrying.");
      }
      // A transaction may still abort after this statement. Keep its heartbeat
      // alive until the caller confirms the transaction committed.
      if (!session) finish();
    },
    async cancelDelete() {
      if (!options.deleting) throw new Error("Only a delete mutation can be cancelled.");
      if (finished || lost) {
        throw new HttpError(409, "The phone-number delete lease was lost. Refresh phone numbers before retrying.");
      }
      const result = await PhoneNumberModel.updateOne(
        mutationFilter,
        {
          $set: {
            lifecycle: options.wasDeleting ? "deleting" : "active",
            mutationToken: "",
            mutationExpiresAt: null,
          },
        },
      );
      if (result.matchedCount !== 1) {
        lost = true;
        throw new HttpError(409, "The phone-number delete lease was lost. Refresh phone numbers before retrying.");
      }
      finish();
    },
    complete() {
      finish();
    },
  };
}

export async function acquirePhoneNumberMutation(
  ownerId: string,
  phoneNumberId: string,
  options: { deleting?: boolean } = {},
) {
  const token = randomUUID();
  const session = await startSession();
  const acquireWithLifecycle = (lifecycleFilter: Record<string, unknown>, attemptNow: Date) =>
    PhoneNumberModel.findOneAndUpdate(
      {
        _id: phoneNumberId,
        ownerId,
        $and: [
          lifecycleFilter,
          {
            $or: [
              { mutationToken: "" },
              { mutationToken: null },
              { mutationToken: { $exists: false } },
              { mutationExpiresAt: { $lte: attemptNow } },
            ],
          },
        ],
      },
      {
        $set: {
          lifecycle: options.deleting ? "deleting" : "active",
          mutationToken: token,
          mutationExpiresAt: new Date(attemptNow.getTime() + mutationLeaseMs),
        },
      },
      { new: true, runValidators: true, session },
    ).select("+mutationToken +mutationExpiresAt");

  type AcquisitionOutcome =
    | { kind: "acquired"; phone: PhoneNumberDocument; wasDeleting: boolean }
    | { kind: "missing" }
    | { kind: "busy"; lifecycle?: string };

  let outcome: AcquisitionOutcome | undefined;
  try {
    await session.withTransaction(async () => {
      outcome = undefined;
      const attemptNow = new Date();
      let wasDeleting = false;
      let phone = options.deleting
        ? await acquireWithLifecycle({ lifecycle: "deleting" }, attemptNow)
        : await acquireWithLifecycle({ lifecycle: { $ne: "deleting" } }, attemptNow);
      if (options.deleting && phone) {
        wasDeleting = true;
      } else if (options.deleting) {
        phone = await acquireWithLifecycle({
          $or: [{ lifecycle: "active" }, { lifecycle: { $exists: false } }],
        }, attemptNow);
      }

      if (!phone) {
        const existing = await PhoneNumberModel.findOne({ _id: phoneNumberId, ownerId })
          .select("lifecycle")
          .session(session)
          .lean();
        outcome = existing
          ? { kind: "busy", lifecycle: existing.lifecycle }
          : { kind: "missing" };
        return;
      }

      const activeCallAdmission = await PhoneNumberCallAdmissionModel.exists({
        ownerId,
        phoneNumberId: phone._id,
        expiresAt: { $gt: new Date() },
      }).session(session);
      const pendingOutboundSetup = await CallDetailRecordModel.exists({
        ownerId,
        phoneNumberId: phone._id,
        outboundSetupPending: true,
      }).session(session);
      if (activeCallAdmission || pendingOutboundSetup) {
        // Throwing aborts the transaction, so a failed admission read/check can
        // never commit a fresh `deleting` lifecycle tombstone. The durable CDR
        // guard remains authoritative after an in-memory admission lease dies.
        throw new HttpError(409, "This phone number is starting a call. Wait for setup to finish before changing or deleting it.");
      }

      outcome = { kind: "acquired", phone, wasDeleting };
    }, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    });
  } finally {
    await session.endSession();
  }

  if (!outcome) {
    throw new Error("The phone-number mutation transaction completed without a result.");
  }
  if (outcome.kind === "missing") {
    throw new HttpError(404, "Phone number not found.");
  }
  if (outcome.kind === "busy") {
    throw new HttpError(
      409,
      outcome.lifecycle === "deleting"
        ? "This phone number is being deleted."
        : "This phone number is already being updated. Wait for that operation to finish.",
    );
  }

  outcome.phone.$session(null);
  return mutationLease(ownerId, phoneNumberId, outcome.phone, token, {
    ...options,
    wasDeleting: outcome.wasDeleting,
  });
}

export async function adoptPhoneNumberMutation(
  ownerId: string,
  phoneNumberId: string,
  token: string,
) {
  const phone = await PhoneNumberModel.findOneAndUpdate(
    {
      _id: phoneNumberId,
      ownerId,
      lifecycle: { $ne: "deleting" },
      mutationToken: token,
    },
    {
      $set: {
        lifecycle: "active",
        mutationExpiresAt: phoneNumberMutationLeaseExpiry(),
      },
    },
    { new: true, runValidators: true },
  ).select("+mutationToken +mutationExpiresAt");
  if (!phone) {
    throw new HttpError(409, "The newly saved phone number lost its routing lease. Sync phone routes before retrying.");
  }
  return mutationLease(ownerId, phoneNumberId, phone, token);
}
