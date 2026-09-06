import mongoose from "mongoose";

import { connectDatabase } from "../config/database.js";
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
    const user = await UserModel.findOne({ email }).select("+platformRole");
    if (!user) throw new Error("User not found.");
    if (!user.emailVerified) throw new Error("Platform roles can be assigned only to a verified user.");
    const previousRole = user.platformRole;
    user.platformRole = role as typeof user.platformRole;
    await user.save();
    console.log(JSON.stringify({ userId: user.id, email: user.email, previousRole, role }));
  } finally {
    await mongoose.disconnect();
  }
}

