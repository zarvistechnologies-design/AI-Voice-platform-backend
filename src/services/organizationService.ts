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
  whiteLabelAccountId?: string;
  whiteLabelBrandId?: string;
  provisioningSource?: "self_serve" | "partner" | "platform" | "migration";
  externalCustomerId?: string;
}) {
  const organization = await OrganizationModel.create({
    ...(input.useOwnerIdAsOrganizationId ? { _id: input.ownerUserId } : {}),
    name: input.name,
    slug: await uniqueSlug(input.name),
    ownerUserId: input.ownerUserId,
    whiteLabelAccountId: input.whiteLabelAccountId,
    whiteLabelBrandId: input.whiteLabelBrandId,
    provisioningSource: input.provisioningSource ?? "self_serve",
    externalCustomerId: input.externalCustomerId ?? "",
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

export async function resolvePlatformOrganization(user: UserDocument, requestedOrgId?: string) {
  const memberships = await OrganizationMemberModel.find({ userId: user._id }).sort({ createdAt: 1 });
  if (!memberships.length) return ensureDefaultOrganization(user);
  const membershipByOrgId = new Map(memberships.map((membership) => [String(membership.orgId), membership]));
  const organizations = await OrganizationModel.find({
    _id: { $in: memberships.map((membership) => membership.orgId) },
    whiteLabelAccountId: { $exists: false },
    lifecycleStatus: { $ne: "archived" },
  }).sort({ createdAt: 1 });
  const requested = requestedOrgId
    ? organizations.find((organization) => organization.id === requestedOrgId)
    : undefined;
  const organization = requested ?? organizations[0];
  if (!organization) return null;
  const membership = membershipByOrgId.get(organization.id);
  return membership ? { organization, membership } : null;
}

export async function resolveWhiteLabelOrganization(
  user: UserDocument,
  input: { accountId: string; brandId: string; requestedOrgId?: string },
) {
  const memberships = await OrganizationMemberModel.find({ userId: user._id }).sort({ createdAt: 1 });
  if (!memberships.length) return null;
  const membershipByOrgId = new Map(memberships.map((membership) => [String(membership.orgId), membership]));
  const organizationIds = memberships.map((membership) => membership.orgId);
  const filter = {
    _id: { $in: organizationIds },
    whiteLabelAccountId: input.accountId,
    whiteLabelBrandId: input.brandId,
    lifecycleStatus: { $ne: "archived" },
  };
  const organizations = await OrganizationModel.find(filter).sort({ createdAt: 1 });
  const requested = input.requestedOrgId
    ? organizations.find((organization) => organization.id === input.requestedOrgId)
    : undefined;
  const organization = requested ?? organizations[0];
  if (!organization) return null;
  const membership = membershipByOrgId.get(organization.id);
  return membership ? { organization, membership } : null;
}

export function roleAllowed(role: OrganizationRole, allowed: readonly OrganizationRole[]) {
  return allowed.includes(role);
}
