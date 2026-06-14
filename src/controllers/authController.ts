import bcrypt from "bcryptjs";
import type { Request, Response } from "express";

import { type AuthenticatedRequest } from "../middleware/auth.js";
import { UserModel, toPublicUser } from "../models/User.js";
import { HttpError } from "../utils/httpError.js";
import { signAuthToken } from "../utils/jwt.js";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type AuthBody = {
  name?: string;
  email?: string;
  password?: string;
};

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function validateEmail(email: string) {
  if (!emailPattern.test(email)) {
    throw new HttpError(400, "Enter a valid email address.");
  }
}

function validatePassword(password: string) {
  if (password.length < 6) {
    throw new HttpError(400, "Password must be at least 6 characters.");
  }
}

export async function register(request: Request, response: Response) {
  const { name, email, password } = request.body as AuthBody;
  const normalizedName = name?.trim();
  const normalizedEmail = normalizeEmail(email ?? "");
  const rawPassword = password ?? "";

  if (!normalizedName || normalizedName.length < 2) {
    throw new HttpError(400, "Name must be at least 2 characters.");
  }

  validateEmail(normalizedEmail);
  validatePassword(rawPassword);

  const existingUser = await UserModel.findOne({ email: normalizedEmail });

  if (existingUser) {
    throw new HttpError(409, "An account with this email already exists.");
  }

  const passwordHash = await bcrypt.hash(rawPassword, 12);
  const user = await UserModel.create({
    name: normalizedName,
    email: normalizedEmail,
    passwordHash,
  });
  const token = signAuthToken(user.id);

  response.status(201).json({
    token,
    user: toPublicUser(user),
  });
}

export async function login(request: Request, response: Response) {
  const { email, password } = request.body as AuthBody;
  const normalizedEmail = normalizeEmail(email ?? "");
  const rawPassword = password ?? "";

  validateEmail(normalizedEmail);
  validatePassword(rawPassword);

  const user = await UserModel.findOne({ email: normalizedEmail }).select(
    "+passwordHash",
  );

  if (!user) {
    throw new HttpError(401, "Invalid email or password.");
  }

  const isPasswordValid = await bcrypt.compare(rawPassword, user.passwordHash);

  if (!isPasswordValid) {
    throw new HttpError(401, "Invalid email or password.");
  }

  const token = signAuthToken(user.id);

  response.status(200).json({
    token,
    user: toPublicUser(user),
  });
}

export async function me(request: AuthenticatedRequest, response: Response) {
  response.status(200).json({
    user: request.user,
  });
}
