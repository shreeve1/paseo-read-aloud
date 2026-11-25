import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { isIP } from "node:net";
import { URL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import protocol from "../shared/hub-protocol-v1.json" with { type: "json" };

type ManagedPaths = { config: string; ca: string; helper: string };
const paths: ManagedPaths = {
  config: protocol.client_files.managed_config,
  ca: protocol.client_files.ca_file,
  helper: protocol.client_files.credential_helper,
};

export type Mode =
  | { kind: "personal" }
  | { kind: "managed"; hub: HubClient }
  | { kind: "managed-unavailable"; reason: string };

const configSchema = z.strictObject({ version: z.literal(protocol.version), origin: z.url() });
export const hubVoicesSchema = z.object({ voices: z.array(z.object({ id: z.string(), name: z.string() })) });
const hubErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const bearerPattern = new RegExp(protocol.transport.bearer_pattern);
const runFile = promisify(execFile);
const helperTimeoutMs = 1_000;
const requestTimeoutMs =
  (protocol.limits.cliproxy_check_timeout_seconds + protocol.limits.vendor_timeout_seconds + 5) * 1_000;

type ProtocolErrorCode = keyof typeof protocol.errors.codes;
type HubErrorCode = ProtocolErrorCode | "invalid_response" | "unreachable" | "credential_unavailable";

const problems: Record<HubErrorCode, string> = {
  bad_request: "The speech service could not read the request.",
  unauthorized: "The speech service did not accept this login.",
  not_granted: "Central voice is not enabled for this login.",
  voice_not_allowed: "That voice is no longer available for this login. Choose another Central voice.",
  text_not_allowed: `The pilot only reads “${protocol.pilot.fixture_text}”`,
  not_found: "The requested speech service address was not found.",
  too_large: "This reply is too long for Central voice.",
  quota_exceeded: "The monthly Central voice allowance has been used.",
  rate_limited: "Central voice has received too many requests. Try again in a minute.",
  busy: "The speech service is busy. Try again shortly.",
  auth_unavailable: "The speech service could not check this login. Try again shortly.",
  vendor_error: "The speech provider could not generate audio. Try again shortly.",
  invalid_response: "The speech service returned an unexpected reply.",
  unreachable: "Could not connect securely to the speech service or it took too long to reply.",
  credential_unavailable: "Paseo could not get this login's speech credential.",
};

export function withLocalOption(reason: string): string {
  return reason + " You can still choose Paseo voice settings for local playback.";
}

export class HubError extends Error {
  readonly code: HubErrorCode;

  constructor(code: HubErrorCode) {
    super(withLocalOption(problems[code]));
    this.code = code;
  }
}

function openTrustedFile(path: string, ownerUid: number): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== ownerUid || (stat.mode & 0o022)) {
      throw new Error("Unsafe managed file");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function managedOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== protocol.transport.scheme + ":" || isIP(url.hostname.replace(/^\[|\]$/g, ""))
      || url.href !== url.origin + "/") {
    throw new Error("Expected an HTTPS origin with a DNS name");
  }
  return url;
}

function errno(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

export function loadMode(files: ManagedPaths = paths, ownerUid = 0): Mode {
  let configFd: number;
  try {
    configFd = openTrustedFile(files.config, ownerUid);
  } catch (error) {
    if (errno(error) === "ENOENT") return { kind: "personal" };
    return { kind: "managed-unavailable", reason: withLocalOption("The Central voice configuration could not be trusted.") };
  }

  try {
    const config = configSchema.parse(JSON.parse(readFileSync(configFd, "utf8")));
    const origin = managedOrigin(config.origin);
    const caFd = openTrustedFile(files.ca, ownerUid);
    let ca: Buffer;
    try {
      ca = readFileSync(caFd);
      new X509Certificate(ca);
    } finally {
      closeSync(caFd);
    }
    closeSync(openTrustedFile(files.helper, ownerUid));
    return { kind: "managed", hub: new HubClient(origin, ca, files.helper, ownerUid) };
  } catch {
    return { kind: "managed-unavailable", reason: withLocalOption("The Central voice configuration, certificate or helper is missing or invalid.") };
  } finally {
    closeSync(configFd);
  }
}

function decodeJson(body: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new HubError("invalid_response");
  }
}

type HubRoute = (typeof protocol.routes)[keyof typeof protocol.routes];
const [audioHeader, audioFormat] = protocol.routes.synthesize.response_200.audio_format_header.split(": ");

export class HubClient {
  private readonly origin: URL;
  private readonly ca: Buffer;
  private readonly helper: string;
  private readonly ownerUid: number;

  constructor(origin: URL, ca: Buffer, helper: string, ownerUid = 0) {
    this.origin = origin;
    this.ca = ca;
    this.helper = helper;
    this.ownerUid = ownerUid;
  }

  async voices(): Promise<z.output<typeof hubVoicesSchema>> {
    const body = await this.send(protocol.routes.voices);
    const result = hubVoicesSchema.safeParse(decodeJson(body));
    if (!result.success) throw new HubError("invalid_response");
    return result.data;
  }

  async synthesize(voiceId: string, text: string, signal?: AbortSignal): Promise<Buffer> {
    const payload = JSON.stringify({ voice_id: voiceId, text });
    if (Buffer.byteLength(payload) > protocol.limits.max_request_bytes ||
        [...text].length > protocol.limits.max_text_chars) {
      throw new HubError("too_large");
    }
    const body = await this.send(protocol.routes.synthesize, payload, signal);
    if (body.length === 0 || body.length % 2 !== 0) throw new HubError("invalid_response");
    return body;
  }

  private async credential(signal: AbortSignal): Promise<string> {
    try {
      closeSync(openTrustedFile(this.helper, this.ownerUid));
      const { stdout } = await runFile(this.helper, [], {
        shell: false, timeout: helperTimeoutMs, maxBuffer: 1_024, signal,
      });
      const lines = stdout.split("\n");
      if (lines.length === 2 && lines[1] === "" && lines[0].match(bearerPattern)?.[0] === lines[0]) {
        return lines[0];
      }
    } catch {
      // Child errors may contain its stdout or stderr. Surface only our own message.
    }
    throw new HubError("credential_unavailable");
  }

  private async send(route: HubRoute, payload?: string, consumerSignal?: AbortSignal): Promise<Buffer> {
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const signal = consumerSignal ? AbortSignal.any([timeout, consumerSignal]) : timeout;
    const bearer = await this.credential(signal);
    const headers = {
      Authorization: `Bearer ${bearer}`,
      ...(payload === undefined ? {} : {
        "Content-Type": protocol.routes.synthesize.request_content_type,
        "Content-Length": Buffer.byteLength(payload),
      }),
    };
    try {
      const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        const req = request(new URL(route.path, this.origin), {
          method: route.method,
          ca: this.ca,
          servername: this.origin.hostname,
          rejectUnauthorized: true,
          agent: false,
          headers,
          signal,
        }, resolve);
        req.once("error", reject);
        req.end(payload);
      });

      const ok = response.statusCode === 200;
      const cap = ok ? route.response_200.max_bytes : protocol.routes.voices.response_200.max_bytes;
      const expectedType = ok ? route.response_200.content_type : protocol.errors.content_type;
      const contentType = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
      if (contentType !== expectedType
          || (ok && route === protocol.routes.synthesize && response.headers[audioHeader.toLowerCase()] !== audioFormat)
          || Number(response.headers["content-length"]) > cap) {
        response.destroy();
        throw new HubError("invalid_response");
      }
      const parts: Buffer[] = [];
      let length = 0;
      for await (const part of response) {
        length += part.length;
        if (length > cap) throw new HubError("invalid_response");
        parts.push(part);
      }
      const body = Buffer.concat(parts, length);
      if (ok) return body;

      const result = hubErrorSchema.safeParse(decodeJson(body));
      const code = result.success ? result.data.error.code : "";
      if (isProtocolError(code) && protocol.errors.codes[code] === response.statusCode) throw new HubError(code);
      throw new HubError("invalid_response");
    } catch (error) {
      if (error instanceof HubError) throw error;
      throw new HubError("unreachable");
    }
  }
}

function isProtocolError(code: string): code is ProtocolErrorCode {
  return Object.hasOwn(protocol.errors.codes, code);
}
