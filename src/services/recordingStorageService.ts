import { createHash, createHmac } from "node:crypto";

import { env } from "../config/env.js";

const service = "s3";

function trimSlashes(value: string) {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function encodedKeyPath(key: string) {
  return key
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function hashHex(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string) {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: Buffer | string, value: string) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function credentialScope(dateStamp: string) {
  return `${dateStamp}/${recordingS3Region()}/${service}/aws4_request`;
}

function signingKey(dateStamp: string) {
  const dateKey = hmac(`AWS4${env.livekitRecordingS3Secret}`, dateStamp);
  const regionKey = hmac(dateKey, recordingS3Region());
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

function amzTimestamp(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function normalizeHeaderValue(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function s3EndpointBase() {
  return new URL(env.livekitRecordingS3Endpoint || `https://s3.${recordingS3Region()}.amazonaws.com`);
}

function usePathStyleEndpoint() {
  return Boolean(env.livekitRecordingS3ForcePathStyle);
}

function objectUrl(key: string) {
  const bucket = env.livekitRecordingS3Bucket.trim();
  const encodedKey = encodedKeyPath(key);

  if (!env.livekitRecordingS3Endpoint && !usePathStyleEndpoint()) {
    return new URL(`https://${bucket}.s3.${recordingS3Region()}.amazonaws.com/${encodedKey}`);
  }

  const base = s3EndpointBase();
  const basePath = trimSlashes(base.pathname);
  const pathPrefix = basePath ? `${basePath}/` : "";
  if (usePathStyleEndpoint()) {
    return new URL(`${base.protocol}//${base.host}/${pathPrefix}${encodeURIComponent(bucket)}/${encodedKey}`);
  }
  return new URL(`${base.protocol}//${bucket}.${base.host}/${pathPrefix}${encodedKey}`);
}

function signedHeaders(headers: Record<string, string>) {
  return Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), normalizeHeaderValue(value)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

function authorizationHeader(input: {
  method: "GET" | "HEAD" | "PUT";
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  dateStamp: string;
  amzDate: string;
}) {
  const headers = signedHeaders(input.headers);
  const canonicalHeaders = headers.map(([key, value]) => `${key}:${value}\n`).join("");
  const signedHeaderNames = headers.map(([key]) => key).join(";");
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    input.url.searchParams.toString(),
    canonicalHeaders,
    signedHeaderNames,
    input.payloadHash,
  ].join("\n");
  const scope = credentialScope(input.dateStamp);
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    scope,
    hashHex(canonicalRequest),
  ].join("\n");
  const signature = hmacHex(signingKey(input.dateStamp), stringToSign);
  return `AWS4-HMAC-SHA256 Credential=${env.livekitRecordingS3AccessKey}/${scope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`;
}

async function signedS3Request(input: {
  method: "GET" | "HEAD" | "PUT";
  key: string;
  body?: Buffer;
  contentType?: string;
  range?: string;
}) {
  const url = objectUrl(input.key);
  const payloadHash = input.body ? hashHex(input.body) : hashHex("");
  const { amzDate, dateStamp } = amzTimestamp();
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (input.contentType) headers["content-type"] = input.contentType;
  if (input.range) headers.range = input.range;
  headers.authorization = authorizationHeader({
    method: input.method,
    url,
    headers,
    payloadHash,
    dateStamp,
    amzDate,
  });

  const body = input.body
    ? input.body.buffer.slice(input.body.byteOffset, input.body.byteOffset + input.body.byteLength) as ArrayBuffer
    : undefined;

  return fetch(url, {
    method: input.method,
    headers,
    body,
  });
}

export function recordingS3Region() {
  return env.livekitRecordingS3Region.trim() || "us-east-1";
}

export function recordingS3Configured() {
  return Boolean(
    env.livekitRecordingS3Bucket.trim()
      && env.livekitRecordingS3AccessKey.trim()
      && env.livekitRecordingS3Secret.trim(),
  );
}

export function recordingS3ConfigError() {
  return "S3 recording storage is not configured. Set AWS_RECORDING_S3_BUCKET, AWS_RECORDING_S3_REGION, AWS_RECORDING_S3_ACCESS_KEY_ID, and AWS_RECORDING_S3_SECRET_ACCESS_KEY.";
}

export function recordingPrefix() {
  return trimSlashes(env.livekitRecordingPrefix) || "recordings";
}

export function recordingPublicUrl(key: string) {
  const base = env.livekitRecordingPublicBaseUrl.trim().replace(/\/+$/g, "");
  return base ? `${base}/${key.replace(/^\/+/g, "")}` : "";
}

export async function uploadRecordingObject(key: string, body: Buffer, contentType: string) {
  if (!recordingS3Configured()) throw new Error(recordingS3ConfigError());
  const response = await signedS3Request({
    method: "PUT",
    key,
    body,
    contentType,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`S3 recording upload failed with HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}`);
  }
}

export async function getRecordingObject(key: string, range = "") {
  if (!recordingS3Configured()) throw new Error(recordingS3ConfigError());
  return signedS3Request({
    method: "GET",
    key,
    range,
  });
}
