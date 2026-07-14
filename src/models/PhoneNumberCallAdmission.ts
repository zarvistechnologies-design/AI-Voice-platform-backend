import { Schema, model, type InferSchemaType } from "mongoose";

const phoneNumberCallAdmissionSchema = new Schema(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true },
    phoneNumberId: { type: Schema.Types.ObjectId, ref: "PhoneNumber", required: true },
    campaignId: { type: Schema.Types.ObjectId, ref: "Campaign", default: null },
    setupToken: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
  },
  {
    _id: false,
    timestamps: true,
    versionKey: false,
  },
);

phoneNumberCallAdmissionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
phoneNumberCallAdmissionSchema.index({ ownerId: 1, phoneNumberId: 1, expiresAt: 1 });
phoneNumberCallAdmissionSchema.index({ campaignId: 1, expiresAt: 1 });
phoneNumberCallAdmissionSchema.index({ setupToken: 1, expiresAt: 1 });

export type PhoneNumberCallAdmission = InferSchemaType<typeof phoneNumberCallAdmissionSchema>;
export const PhoneNumberCallAdmissionModel = model<PhoneNumberCallAdmission>(
  "PhoneNumberCallAdmission",
  phoneNumberCallAdmissionSchema,
);
