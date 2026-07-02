import { existsSync } from "fs";

export type YtDlpAuthMode = "cookies_file" | "browser" | "none";

export function getYtDlpAuthMode(): YtDlpAuthMode {
  const cookiesFile = process.env.YT_DLP_COOKIES_FILE?.trim();
  if (cookiesFile && existsSync(cookiesFile)) {
    return "cookies_file";
  }

  const cookiesBrowser = process.env.YT_DLP_COOKIES_FROM_BROWSER?.trim();
  if (cookiesBrowser) {
    return "browser";
  }

  return "none";
}

/**
 * Route yt-dlp egress through a residential/rotating proxy. This is the actual
 * fix for the datacenter-IP "Sign in to confirm you're not a bot" error: it
 * changes the IP YouTube sees, even though the app keeps running on AWS.
 */
export function getYtDlpProxyArgs(): string[] {
  const proxy = process.env.YT_DLP_PROXY?.trim();
  return proxy ? ["--proxy", proxy] : [];
}

/** Extra yt-dlp argv for YouTube sign-in / age-restricted videos. */
export function getYtDlpAuthArgs(): string[] {
  const proxyArgs = getYtDlpProxyArgs();

  const cookiesFile = process.env.YT_DLP_COOKIES_FILE?.trim();
  if (cookiesFile) {
    if (!existsSync(cookiesFile)) {
      throw new Error(
        `YT_DLP_COOKIES_FILE is set but file not found: ${cookiesFile}`
      );
    }
    return [...proxyArgs, "--cookies", cookiesFile];
  }

  const cookiesBrowser = process.env.YT_DLP_COOKIES_FROM_BROWSER?.trim();
  if (cookiesBrowser) {
    return [...proxyArgs, "--cookies-from-browser", cookiesBrowser];
  }

  return proxyArgs;
}

export function isAgeRestrictedYtDlpError(message: string): boolean {
  return (
    message.includes("Sign in to confirm your age") ||
    message.includes("confirm you're not a bot") ||
    message.includes("confirm you’re not a bot")
  );
}

export function formatYtDlpAuthHint(errorMessage: string): string {
  if (!isAgeRestrictedYtDlpError(errorMessage)) {
    return errorMessage;
  }

  const mode = getYtDlpAuthMode();
  if (mode === "none") {
    return (
      `${errorMessage}\n\n` +
      "This video requires a signed-in YouTube session. Set one of:\n" +
      "  YT_DLP_COOKIES_FROM_BROWSER=chrome   (browser where you're signed into YouTube)\n" +
      "  YT_DLP_COOKIES_FILE=/path/to/cookies.txt\n" +
      "Then restart the dev server. See .env.example in the project root."
    );
  }

  return (
    `${errorMessage}\n\n` +
    "YouTube cookies are configured but may be expired or from an account that has not confirmed age for this video. " +
    "Re-export cookies from a browser where you can play this video, or sign in and confirm your age on YouTube first."
  );
}

export function logYtDlpFailure(
  location: string,
  error: unknown,
  context: Record<string, unknown> = {}
) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn("yt-dlp failed", {
    location,
    ...context,
    authMode: getYtDlpAuthMode(),
    ageRestricted: isAgeRestrictedYtDlpError(message),
    errorPreview: message.slice(0, 500),
  });
}
