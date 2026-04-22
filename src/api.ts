import { existsSync } from "node:fs";
import { join } from "node:path";
import { TlsClient } from "browser-tls-fetch";
import { CookieJar } from "tough-cookie";

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
};

const HARDCODED_BEARER_TOKEN = "ace044fb-f8e0-48b5-be80-4e78dfd2380e";

export class FoetexApiClient {
  private readonly tlsClient: TlsClient;

  private readonly cookieJar = new CookieJar();

  constructor(private readonly baseUrl: string) {
    ensureTlsClientLibraryPath();
    this.tlsClient = new TlsClient({
      profile: "chrome_133"
    });
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const cookieHeader = await this.cookieJar.getCookieString(url);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${HARDCODED_BEARER_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    };

    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    const response = await this.tlsClient.fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    const setCookieValues = response.headers.getSetCookie();
    for (const setCookieValue of setCookieValues) {
      await this.cookieJar.setCookie(setCookieValue, url);
    }

    const raw = await response.text();
    const payload = parseResponse(raw);

    if (!response.ok) {
      throw new Error(
        `API ${response.status} ${response.statusText} on ${path}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`
      );
    }

    return payload as T;
  }
}

function parseResponse(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return raw;
  }
}

function ensureTlsClientLibraryPath(): void {
  if (process.env.BROWSER_TLS_FETCH_LIB_PATH) {
    return;
  }

  const platformArch = `${process.platform}-${process.arch}`;
  const extension = process.platform === "win32" ? "dll" : process.platform === "darwin" ? "dylib" : "so";
  const packageLibraryPath = join(
    process.cwd(),
    "node_modules",
    "@browser-tls-fetch",
    platformArch,
    `tls-client.${extension}`
  );

  if (existsSync(packageLibraryPath)) {
    process.env.BROWSER_TLS_FETCH_LIB_PATH = packageLibraryPath;
  }
}
