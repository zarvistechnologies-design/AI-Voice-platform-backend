import mongoose from "mongoose";

import { connectDatabase } from "../config/database.js";
import { env } from "../config/env.js";
import { UserModel } from "../models/User.js";

const emailArgument = process.argv.find((argument) => argument.startsWith("--email="));
const roleArgument = process.argv.find((argument) => argument.startsWith("--role="));
const confirmed = process.argv.includes("--confirm");
const email = emailArgument?.slice("--email=".length).trim().toLowerCase() ?? "";
const role = roleArgument?.slice("--role=".length).trim() ?? "";

if (!confirmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !["user", "support", "super_admin"].includes(role)) {
  console.error(
    "Usage: npm run admin:set-role -- --email=verified@example.com --role=super_admin --confirm",
  );
  process.exitCode = 2;
} else {
  await connectDatabase({ autoIndex: false });
  try {
    const user = await UserModel.findOne({ email }).select("+platformRole +passwordHash");
    if (!user) throw new Error("User not found.");
    if (!user.emailVerified) throw new Error("Platform roles can be assigned only to a verified user.");
    if (role === "super_admin") {
      if (!user.passwordHash) throw new Error("Super administrators must set a password before promotion.");
      if (!user.twoFactorEnabled) throw new Error("Super administrators must enable two-factor authentication before promotion.");
      if (!env.platformAdminEmails.includes(email)) {
        throw new Error("This email is not in PLATFORM_ADMIN_EMAILS.");
      }
    }
    const previousRole = user.platformRole;
    user.platformRole = role as typeof user.platformRole;
    await user.save();
    console.log(JSON.stringify({ userId: user.id, email: user.email, previousRole, role }));
  } finally {
    await mongoose.disconnect();
  }
}

