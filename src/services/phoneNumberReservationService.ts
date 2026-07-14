import { randomUUID } from "node:crypto";
import type { ClientSession } from "mongoose";

import { PhoneNumberModel } from "../models/PhoneNumber.js";
import { PhoneNumberReservationModel } from "../models/PhoneNumberReservation.js";
import { HttpError } from "../utils/httpError.js";

const reservationLeaseMs = 5 * 60 * 1_000;
const reservationHeartbeatMs = 60 * 1_000;
const abandonedImportCleanupMs = 24 * 60 * 60 * 1_000;

function isDuplicateKeyError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === 11000);
}

async function existingPhoneNumberError(ownerId: string, number: string) {
  const existing = await PhoneNumberModel.findOne({ number }).select("ownerId").lean();
  if (!existing) return null;
  return existing.ownerId === ownerId
    ? new HttpError(409, "This phone number has already been imported.")
    : new HttpError(
        409,
        "This phone number is already connected to another workspace. Remove it there before importing it here.",
      );
}

export async function phoneNumberConflictError(ownerId: string, number: string) {
  return (await existingPhoneNumberError(ownerId, number))
    ?? new HttpError(409, "This phone number was imported by another request. Refresh phone numbers and try again.");
}

export async function assertPhoneNumberAvailable(ownerId: string, number: string) {
  const error = await existingPhoneNumberError(ownerId, number);
  if (error) throw error;
}

/**
 * Reserves one E.164 number across every application replica before provider
 * verification or purchase. MongoDB's `_id` uniqueness is the lock; Redis is
 * intentionally not part of this correctness path.
 */
export async function reservePhoneNumber(
  ownerId: string,
  number: string,
  options: { operation?: "import" | "purchase" } = {},
) {
  await assertPhoneNumberAvailable(ownerId, number);

  const operation = options.operation ?? "import";
  const token = randomUUID();
  let idempotencyKey: string = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + reservationLeaseMs);
  const cleanupAt = new Date(now.getTime() + abandonedImportCleanupMs);
  let acquired = false;
  let purchaseRecovery: "none" | "unconfirmed" | "confirmed" = "none";
  let confirmedProviderNumber: Record<string, unknown> | null = null;

  try {
    await PhoneNumberReservationModel.create({
      _id: number,
      ownerId,
      token,
      status: "pending",
      operation,
      idempotencyKey,
      expiresAt,
      cleanupAt: operation === "import" ? cleanupAt : null,
    });
    acquired = true;
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    const existingError = await existingPhoneNumberError(ownerId, number);
    if (existingError) throw existingError;

    const previous = await PhoneNumberReservationModel.findById(number).lean();
    if (!previous) {
      throw new HttpError(409, "Phone-number ownership changed. Refresh phone numbers before trying again.");
    }
    const previousPurchaseState = previous.status === "purchase-confirmed"
      ? "confirmed"
      : previous.status === "purchase-unconfirmed"
        ? "unconfirmed"
        : "none";
    const previousLeaseExpired = !previous.expiresAt || previous.expiresAt <= now;
    const canRecoverPurchase = previousPurchaseState !== "none"
      && previous.ownerId === ownerId
      && previousLeaseExpired;
    const canRecoverOrdinary = (
      (previous.status === "pending" && previousLeaseExpired)
      || previous.status === "active"
    );
    if (!canRecoverPurchase && !canRecoverOrdinary) {
      throw new HttpError(
        409,
        "This phone number is currently being imported or purchased. Wait for that request to finish before trying again.",
      );
    }

    if (canRecoverPurchase) {
      purchaseRecovery = previousPurchaseState;
      idempotencyKey = previous.idempotencyKey;
      confirmedProviderNumber = previous.status === "purchase-confirmed"
        && previous.providerNumber
        && typeof previous.providerNumber === "object"
        ? previous.providerNumber as Record<string, unknown>
        : null;
    }

    const reclaimed = await PhoneNumberReservationModel.findOneAndUpdate(
      {
        _id: number,
        ownerId: previous.ownerId,
        token: previous.token,
        status: previous.status,
        ...(previous.status === "active"
          ? { phoneNumberId: previous.phoneNumberId ?? null }
          : { expiresAt: previous.expiresAt ?? null }),
      },
      {
        $set: {
          ownerId,
          token,
          status: canRecoverPurchase ? previous.status : "pending",
          operation,
          idempotencyKey,
          phoneNumberId: null,
          expiresAt,
          cleanupAt: operation === "import" ? cleanupAt : null,
        },
      },
      { new: true, runValidators: true },
    ).lean();
    acquired = reclaimed?.token === token;
  }

  if (!acquired) {
    const existingError = await existingPhoneNumberError(ownerId, number);
    if (existingError) throw existingError;
    throw new HttpError(
      409,
      "This phone number is currently being imported or purchased. Wait for that request to finish before trying again.",
    );
  }

  // Close the gap with older application instances that do not acquire the
  // reservation but may have inserted the number after the first check.
  const existingError = await existingPhoneNumberError(ownerId, number);
  if (existingError) {
    await PhoneNumberReservationModel.deleteOne({ _id: number, token });
    throw existingError;
  }

  let released = false;
  let lost = false;
  let purchaseState: "none" | "unconfirmed" | "confirmed" = purchaseRecovery;

  const renew = async () => {
    if (released || lost) return false;
    const result = await PhoneNumberReservationModel.updateOne(
      {
        _id: number,
        ownerId,
        token,
        status: { $in: ["pending", "purchase-unconfirmed", "purchase-confirmed"] },
      },
      { $set: { expiresAt: new Date(Date.now() + reservationLeaseMs) } },
    );
    if (result.matchedCount !== 1) lost = true;
    return !lost;
  };
  const heartbeat = setInterval(() => {
    void renew().catch((error) => {
      console.error(JSON.stringify({
        event: "phone-number-reservation-heartbeat-failed",
        number,
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  }, reservationHeartbeatMs);
  heartbeat.unref();

  const stopHeartbeat = () => clearInterval(heartbeat);

  return {
    token,
    idempotencyKey,
    purchaseRecovery,
    confirmedProviderNumber,
    async assertHeld() {
      if (!await renew()) {
        throw new HttpError(
          409,
          "The phone-number operation lost its ownership lease. Refresh phone numbers before trying again.",
        );
      }
    },
    async beginPurchaseAttempt() {
      if (operation !== "purchase") throw new Error("Only purchase reservations can start a provider purchase.");
      const result = await PhoneNumberReservationModel.updateOne(
        {
          _id: number,
          ownerId,
          token,
          status: { $in: ["pending", "purchase-unconfirmed", "purchase-confirmed"] },
        },
        {
          $set: { status: "purchase-unconfirmed", expiresAt: new Date(Date.now() + reservationLeaseMs) },
          $unset: { cleanupAt: 1 },
        },
      );
      if (result.matchedCount !== 1) {
        lost = true;
        throw new HttpError(409, "The phone-number purchase lease was lost before the provider request.");
      }
      purchaseState = "unconfirmed";
    },
    async markPurchaseConfirmed(providerNumber: Record<string, unknown>) {
      const result = await PhoneNumberReservationModel.updateOne(
        {
          _id: number,
          ownerId,
          token,
          status: { $in: ["pending", "purchase-unconfirmed", "purchase-confirmed"] },
        },
        {
          $set: {
            status: "purchase-confirmed",
            providerNumber,
            expiresAt: new Date(Date.now() + reservationLeaseMs),
          },
          $unset: { cleanupAt: 1 },
        },
      );
      if (result.matchedCount !== 1) {
        lost = true;
        throw new HttpError(409, "The purchased number was confirmed, but its ownership lease was lost.");
      }
      purchaseState = "confirmed";
    },
    async markPurchaseUnconfirmed() {
      if (released) return;
      released = true;
      stopHeartbeat();
      await PhoneNumberReservationModel.updateOne(
        {
          _id: number,
          ownerId,
          token,
          status: { $in: ["pending", "purchase-unconfirmed", "purchase-confirmed"] },
        },
        {
          $set: { status: "purchase-unconfirmed", expiresAt: new Date() },
          $unset: { cleanupAt: 1 },
        },
      );
      purchaseState = "unconfirmed";
    },
    async markPurchaseFailed() {
      if (released) return;
      purchaseState = "none";
      await PhoneNumberReservationModel.updateOne(
        { _id: number, ownerId, token },
        {
          $set: {
            status: "pending",
            expiresAt: new Date(Date.now() + reservationLeaseMs),
            cleanupAt,
          },
          $unset: { providerNumber: 1 },
        },
      );
    },
    async finalize(phoneNumberId: string) {
      if (released) return;
      released = true;
      stopHeartbeat();
      try {
        const result = await PhoneNumberReservationModel.updateOne(
          {
            _id: number,
            ownerId,
            token,
            status: { $in: ["pending", "purchase-unconfirmed", "purchase-confirmed"] },
          },
          {
            $set: { status: "active", phoneNumberId },
            $unset: { expiresAt: 1, cleanupAt: 1 },
          },
        );
        if (result.matchedCount !== 1) {
          console.warn(JSON.stringify({
            event: "phone-number-reservation-finalize-missed",
            number,
            ownerId,
            phoneNumberId,
          }));
        }
      } catch (error) {
        // The PhoneNumber insert already committed and remains the source of
        // truth. A later import still sees it before attempting a reservation.
        console.error(JSON.stringify({
          event: "phone-number-reservation-finalize-failed",
          number,
          ownerId,
          phoneNumberId,
          error: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        lost = false;
      }
    },
    async release() {
      if (released) return;
      released = true;
      stopHeartbeat();
      if (purchaseState === "confirmed" || purchaseState === "unconfirmed") {
        await PhoneNumberReservationModel.updateOne(
          { _id: number, ownerId, token },
          { $set: { expiresAt: new Date() }, $unset: { cleanupAt: 1 } },
        );
        return;
      }
      await PhoneNumberReservationModel.deleteOne({ _id: number, ownerId, token, status: "pending" });
    },
  };
}

export async function releasePhoneNumberOwnership(
  ownerId: string,
  number: string,
  _phoneNumberId: string,
  session?: ClientSession,
) {
  // While the mutation-locked PhoneNumber still exists, the global unique
  // index prevents a new owner from reserving this E.164 value. Remove any
  // exact same-owner saga state as part of the delete transaction, including
  // a claim left behind by a crash before reservation finalization.
  await PhoneNumberReservationModel.deleteOne(
    { _id: number, ownerId },
    session ? { session } : undefined,
  );
}

export type PhoneNumberReservationLease = Awaited<ReturnType<typeof reservePhoneNumber>>;
