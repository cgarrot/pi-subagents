/**
 * src/models/provider-extensions.ts — provider-extension resolution for child
 * spawns (P2).
 *
 * pi-subagents children are spawned with `--no-extensions` (hermetic child
 * context), so a child running a CUSTOM-PROVIDER model (e.g.
 * `ollama-cloud/...`) has no provider extension loaded and crashes with
 * 'Model not found'. This module resolves provider id -> local extension
 * entry path so the engine can re-add `-e <path>` to the child argv:
 *
 *   - `providerOfModel`: extract the provider prefix of a `provider/model`
 *     string (builtin/bare ids carry no provider -> no extension).
 *   - `buildProviderExtensionResolver`: config map (`.subagents/config.json`
 *     `providerExtensions`) over the built-in defaults (`ollama-cloud`,
 *     `opencode-go-auto`, `opencode-go-2`), guarded by existsSync — a path
 *     that does not exist is NEVER returned (no hard-coded dead paths).
 *     Injectable exists/home for hermetic tests; results are memoized per
 *     provider.
 *
 * Pure module except the existsSync default: zero @earendil-works/* imports,
 * zero child_process.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Resolver: provider id -> extension entry path (undefined = none). */
export type ProviderExtensionResolver = (provider: string) => string | undefined;

/** Built-in default-mapped provider (custom pi provider behind an extension). */
export const DEFAULT_PROVIDER_EXTENSION_PROVIDER = "ollama-cloud";

/** Default extension entry for the built-in provider, under a given home. */
export function defaultOllamaCloudExtensionPath(home: string = homedir()): string {
  return join(home, "pi-provider-ollama-cloud", "src", "index.ts");
}

/**
 * Built-in provider -> extension-entry defaults, under a given home dir.
 *
 * Keys are pi provider ids that only exist behind a user-level extension:
 * children are spawned `--no-extensions` (hermetic), so any model whose
 * provider matches one of these defaults gets `-e <path>` re-added to its
 * spawn argv (and to availability probes). Every candidate stays
 * existsSync-guarded — a path that does not exist on this machine is NEVER
 * injected. Explicit `.subagents/config.json` `providerExtensions` entries
 * take precedence over these defaults.
 */
export const BUILT_IN_PROVIDER_EXTENSION_DEFAULTS: Readonly<
  Record<string, (home: string) => string>
> = {
  [DEFAULT_PROVIDER_EXTENSION_PROVIDER]: (home) => defaultOllamaCloudExtensionPath(home),
  // OpenCode Go multi-account failover (user extension registers BOTH the
  // `opencode-go-auto` failover provider and the `opencode-go-2` account slot;
  // the builtin `opencode-go` provider needs no extension).
  "opencode-go-auto": (home) => join(home, ".pi", "agent", "extensions", "opencode-go-auto.ts"),
  "opencode-go-2": (home) => join(home, ".pi", "agent", "extensions", "opencode-go-auto.ts"),
};

/** Resolve the built-in default extension entry of a provider (undefined = none). */
export function defaultProviderExtensionPath(provider: string, home: string = homedir()): string | undefined {
  const build = BUILT_IN_PROVIDER_EXTENSION_DEFAULTS[provider];
  return build ? build(home) : undefined;
}

/**
 * Extract the provider prefix of a `provider/model` model string. Builtin/bare
 * ids (no slash, leading slash, empty) carry no provider -> undefined.
 */
export function providerOfModel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = trimmed.slice(0, slash).trim();
  return provider ? provider : undefined;
}

/** Options for {@link buildProviderExtensionResolver} (injectable for tests). */
export interface BuildProviderExtensionResolverOptions {
  /** Home dir for the built-in default path (default: os.homedir()). */
  home?: string;
  /** Path predicate (default: existsSync) — every candidate is guarded. */
  exists?: (path: string) => boolean;
}

/**
 * Build a provider-extension resolver: explicit config map entries first,
 * then the built-in `ollama-cloud` default. Every candidate path is guarded by
 * the exists predicate (never inject a dead path); unknown providers get
 * undefined (no `-e`). Results are memoized per provider id.
 */
export function buildProviderExtensionResolver(
  configMap: Record<string, string> | undefined,
  options: BuildProviderExtensionResolverOptions = {},
): ProviderExtensionResolver {
  const exists = options.exists ?? existsSync;
  const map = configMap ?? {};
  const cache = new Map<string, string | undefined>();
  const resolve = (provider: string): string | undefined => {
    if (cache.has(provider)) return cache.get(provider);
    const explicit = map[provider];
    const candidate =
      explicit !== undefined ? explicit : defaultProviderExtensionPath(provider, options.home);
    const value = candidate && candidate.trim() !== "" && exists(candidate) ? candidate : undefined;
    cache.set(provider, value);
    return value;
  };
  return (provider: string) => {
    const key = provider.trim();
    return key ? resolve(key) : undefined;
  };
}
