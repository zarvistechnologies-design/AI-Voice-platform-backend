import { OrganizationModel } from "../models/Organization.js";
import {
  OrganizationMemberModel,
  type OrganizationRole,
} from "../models/OrganizationMember.js";
import type { UserDocument } from "../models/User.js";

function slugBase(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "workspace"
  );
}

async function uniqueSlug(value: string) {
  const base = slugBase(value);
  let slug = base;
  let attempt = 1;
  while (await OrganizationModel.exists({ slug })) {
    attempt += 1;
    slug = `${base}-${attempt}`;
  }
  return slug;
}

export async function createOrganization(input: {
  name: string;
  ownerUserId: string;
  useOwnerIdAsOrganizationId?: boolean;
}) {
  const organization = await OrganizationModel.create({
    ...(input.useOwnerIdAsOrganizationId ? { _id: input.ownerUserId } : {}),
    name: input.name,
    slug: await uniqueSlug(input.name),
    ownerUserId: input.ownerUserId,
  });
  await OrganizationMemberModel.create({
    orgId: organization._id,
    userId: input.ownerUserId,
    role: "owner",
  });
  return organization;
}

export async function ensureDefaultOrganization(user: UserDocument) {
  const membership = await OrganizationMemberModel.findOne({ userId: user._id }).sort({
    createdAt: 1,
  });
  if (membership) {
    const organization = await OrganizationModel.findById(membership.orgId);
    if (organization) return { organization, membership };
  }

  const existing = await OrganizationModel.findById(user._id);
  const organization =
    existing ??
    (await createOrganization({
      name: `${user.name}'s workspace`,
      ownerUserId: user.id,
      useOwnerIdAsOrganizationId: true,
    }));
  const ensuredMembership = await OrganizationMemberModel.findOneAndUpdate(
    { orgId: organization._id, userId: user._id },
    { $setOnInsert: { role: "owner", joinedAt: new Date() } },
    { new: true, upsert: true, runValidators: true },
  );
  return { organization, membership: ensuredMembership };
}

export async function resolveActiveOrganization(user: UserDocument, requestedOrgId?: string) {
  if (requestedOrgId) {
    const membership = await OrganizationMemberModel.findOne({
      userId: user._id,
      orgId: requestedOrgId,
    });
    if (membership) {
      const organization = await OrganizationModel.findById(membership.orgId);
      if (organization) return { organization, membership };
    }
  }
  return ensureDefaultOrganization(user);
}

export function roleAllowed(role: OrganizationRole, allowed: readonly OrganizationRole[]) {
  return allowed.includes(role);
}
