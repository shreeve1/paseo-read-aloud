import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { isIP } from "node:net";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { URL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { managedVoices, replyMode, retryAfter } from "../shared/managed";
import protocol from "../shared/hub-protocol-v1.json" with { type: "json" };

type ManagedPaths = { config: string; ca: string; helper: string };
const paths: ManagedPaths = {
  config: protocol.client_files.managed_config,
  ca: protocol.client_files.ca_file,
  helper: protocol.client_files.credential_helper,
};

export type Mode =
  | { kind: "personal" }
  | { kind: "managed"; hub: HubClient; standard?: true }
  | { kind: "managed-local"; reason?: string }
  | { kind: "managed-unavailable"; reason: string };

const configSchema = z.strictObject({ version: z.literal(protocol.version), origin: z.url() });
const profileSchema = z.discriminatedUnion("mode", [
  z.strictObject({ version: z.literal(protocol.version), mode: z.literal("local") }),
  z.strictObject({ version: z.literal(protocol.version), mode: z.literal("central"), origin: z.url() }),
]);
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
  readonly retryAfterSeconds?: number;

  constructor(code: HubErrorCode, retryAfterSeconds?: number) {
    super(withLocalOption(problems[code]));
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function trustDirectory(path: string, ownerUid: number) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== ownerUid || (stat.mode & 0o022)) {
    throw new Error("Unsafe managed file directory");
  }
}

function openTrustedFile(path: string, ownerUid: number): number {
  trustDirectory(dirname(path), ownerUid);
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

function readTrustedFile(path: string, ownerUid: number): Buffer {
  const fd = openTrustedFile(path, ownerUid);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function loadHub(files: ManagedPaths, origin: string, ownerUid: number): HubClient {
  const url = managedOrigin(origin);
  const ca = readTrustedFile(files.ca, ownerUid);
  new X509Certificate(ca);
  closeSync(openTrustedFile(files.helper, ownerUid));
  return new HubClient(url, ca, files.helper, ownerUid);
}

type Profiles = { directory: string; login: () => string };
const standardProfiles: Profiles = {
  directory: protocol.client_files.standard_profiles,
  login: () => userInfo().username,
};

function loadProfile({ directory, login }: Profiles, ownerUid: number): Mode | undefined {
  const local: Mode = { kind: "managed-local" };
  const unavailable: Mode = {
    ...local, reason: "The Central voice profile could not be trusted. Read Aloud will use Local voice.",
  };
  try {
    trustDirectory(directory, ownerUid);
  } catch (error) {
    return errno(error) === "ENOENT" ? undefined : unavailable;
  }
  let loginDirectory: string;
  try {
    const account = login();
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(account)) return unavailable;
    loginDirectory = join(directory, account);
  } catch {
    return unavailable;
  }
  try {
    trustDirectory(loginDirectory, ownerUid);
  } catch (error) {
    return errno(error) === "ENOENT" ? undefined : unavailable;
  }
  const files = {
    config: join(loginDirectory, "managed.json"),
    ca: join(loginDirectory, "hub-ca.pem"),
    helper: join(loginDirectory, "hub-credential"),
  };
  try {
    const profile = profileSchema.parse(JSON.parse(readTrustedFile(files.config, ownerUid).toString("utf8")));
    return profile.mode === "local"
      ? local : { kind: "managed", standard: true, hub: loadHub(files, profile.origin, ownerUid) };
  } catch {
    return unavailable;
  }
}

export function loadMode(files: ManagedPaths = paths, ownerUid = 0, profiles = standardProfiles): Mode {
  const profile = loadProfile(profiles, ownerUid);
  if (profile) return profile;
  let config: Buffer;
  try {
    config = readTrustedFile(files.config, ownerUid);
  } catch (error) {
    if (errno(error) === "ENOENT") return { kind: "personal" };
    return { kind: "managed-unavailable", reason: withLocalOption("The Central voice configuration could not be trusted.") };
  }
  try {
    const { origin } = configSchema.parse(JSON.parse(config.toString("utf8")));
    return { kind: "managed", hub: loadHub(files, origin, ownerUid) };
  } catch {
    return { kind: "managed-unavailable", reason: withLocalOption("The Central voice configuration, certificate or helper is missing or invalid.") };
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

  async voices(): Promise<z.output<typeof managedVoices.output>> {
    const body = await this.send(protocol.routes.voices);
    const envelope = managedVoices.output.extend({ reply_mode: z.unknown().optional() }).safeParse(decodeJson(body));
    if (!envelope.success) throw new HubError("invalid_response");
    const mode = replyMode.safeParse(envelope.data.reply_mode);
    return { voices: envelope.data.voices, ...(mode.success ? { reply_mode: mode.data } : {}) };
  }

  async synthesize(voiceId: string, text: string, signal?: AbortSignal): Promise<Buffer> {
    if (Buffer.from(text).toString("utf8") !== text) throw new HubError("bad_request");
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
      if (isProtocolError(code) && protocol.errors.codes[code] === response.statusCode) {
        const header = response.headersDistinct["retry-after"];
        const seconds = header?.length === 1 && /^[0-9]{1,2}$/.test(header[0]) ? Number(header[0]) : undefined;
        const wait = retryAfter.safeParse(seconds);
        throw new HubError(code, code === "rate_limited" && wait.success ? wait.data : undefined);
      }
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
