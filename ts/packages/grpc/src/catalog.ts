import {
  ArgumentsSchema,
  COMPOSIO_TOOL_NAMESPACE,
  type ComposioGrpcToolInput,
  type ComposioGrpcToolView,
  DEFAULT_MAX_OUTPUT_BYTES,
  canonicalSlug,
  composioToolId,
  readOnlyFromTags,
} from './schema';

interface StoredTool {
  readonly input: ComposioGrpcToolInput;
  nameOverride?: string;
  descriptionOverride?: string;
  paramsJson?: string;
}

export interface FinalizeViolation {
  toolId: string;
  message: string;
  category: string;
}

export interface TruncationSettings {
  defaultMaxOutputBytes: number;
  perToolMaxOutputBytes: Record<string, number>;
}

/**
 * In-memory tool catalog for one gRPC server.
 * Before finalize, every loaded tool can run. Finalize locks the set.
 */
export class ToolCatalog {
  private tools = new Map<string, StoredTool>();
  private enabled: Set<string> | undefined;
  private aliases = new Map<string, string>();
  truncation: TruncationSettings = {
    defaultMaxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    perToolMaxOutputBytes: {},
  };
  systemRemindersEnabled = false;
  behaviorPreset = 'current';
  sessionId: string | undefined;
  restoredState: unknown;

  get finalized(): boolean {
    return this.enabled !== undefined;
  }

  replace(inputs: readonly ComposioGrpcToolInput[]): void {
    const next = new Map<string, StoredTool>();
    for (const input of inputs) {
      const previous = this.tools.get(input.slug);
      next.set(input.slug, {
        input,
        nameOverride: previous?.nameOverride,
        descriptionOverride: previous?.descriptionOverride,
        paramsJson: previous?.paramsJson,
      });
    }
    this.tools = next;
    if (this.enabled) {
      this.enabled = new Set([...this.enabled].filter(slug => next.has(slug)));
    }
    this.rebuildAliases();
  }

  list(includeDisabled: boolean): ComposioGrpcToolView[] {
    const views: ComposioGrpcToolView[] = [];
    for (const stored of this.tools.values()) {
      const enabled = this.isEnabled(stored.input.slug);
      if (!enabled && !includeDisabled) continue;
      views.push(this.view(stored, enabled));
    }
    return views;
  }

  resolve(toolName: string): ComposioGrpcToolView | undefined {
    const slug = canonicalSlug(toolName, this.aliases);
    if (!slug) return undefined;
    const stored = this.tools.get(slug);
    if (!stored) return undefined;
    return this.view(stored, this.isEnabled(slug));
  }

  isEnabled(slug: string): boolean {
    if (!this.enabled) return this.tools.has(slug);
    return this.enabled.has(slug);
  }

  /**
   * Lock the catalog to `entries`. Returns violations and leaves the previous
   * lock untouched when validation fails.
   */
  finalize(entries: readonly FinalizeEntry[]): { violations: FinalizeViolation[] } {
    const violations: FinalizeViolation[] = [];
    const nextEnabled = new Set<string>();
    const pending = new Map<
      string,
      { nameOverride?: string; descriptionOverride?: string; paramsJson?: string }
    >();
    const overrideOwners = new Map<string, string>();

    entries.forEach((entry, index) => {
      const rawId = entry.id?.trim() ?? '';
      if (rawId.length === 0) {
        violations.push({
          toolId: `(tools[${index}])`,
          message: 'Tool id is empty',
          category: 'tool_id',
        });
        return;
      }
      const slug = canonicalSlug(rawId, this.aliases);
      if (!slug || !this.tools.has(slug)) {
        violations.push({
          toolId: rawId,
          message: `Unknown Composio tool "${rawId}"`,
          category: 'unknown_tool',
        });
        return;
      }
      if (entry.paramsJson && entry.paramsJson.length > 0) {
        const parsed = ArgumentsSchema.safeParse(parseJson(entry.paramsJson));
        if (!parsed.success) {
          violations.push({
            toolId: rawId,
            message: 'params_json must be a JSON object',
            category: 'params_json_parse',
          });
          return;
        }
      }
      const nameOverride = blankToUndefined(entry.nameOverride);
      if (nameOverride) {
        const owner = overrideOwners.get(nameOverride.toUpperCase());
        if (owner && owner !== slug) {
          violations.push({
            toolId: rawId,
            message: `Name override "${nameOverride}" is already used by ${owner}`,
            category: 'name_override_conflict',
          });
          return;
        }
        overrideOwners.set(nameOverride.toUpperCase(), slug);
      }
      if (nextEnabled.has(slug)) {
        violations.push({
          toolId: rawId,
          message: `Tool ${slug} is listed more than once`,
          category: 'duplicate_tool',
        });
        return;
      }
      nextEnabled.add(slug);
      pending.set(slug, {
        nameOverride,
        descriptionOverride: blankToUndefined(entry.descriptionOverride),
        paramsJson: entry.paramsJson,
      });
    });

    if (violations.length > 0) return { violations };

    this.enabled = nextEnabled;
    for (const [slug, patch] of pending) {
      const stored = this.tools.get(slug);
      if (!stored) continue;
      this.tools.set(slug, { ...stored, ...patch });
    }
    this.rebuildAliases();
    return { violations: [] };
  }

  maxOutputBytes(slug: string): number {
    return this.truncation.perToolMaxOutputBytes[slug] ?? this.truncation.defaultMaxOutputBytes;
  }

  stateJson(): string {
    const params: Record<string, unknown> = {};
    for (const [slug, stored] of this.tools) {
      if (!stored.paramsJson) continue;
      params[composioToolId(slug)] = { paramsJson: stored.paramsJson };
    }
    return JSON.stringify({
      params,
      state: {
        finalized: this.finalized,
        enabled: this.enabled ? [...this.enabled] : [...this.tools.keys()],
        behaviorPreset: this.behaviorPreset,
        sessionId: this.sessionId ?? null,
        restored: this.restoredState ?? null,
      },
    });
  }

  private view(stored: StoredTool, enabled: boolean): ComposioGrpcToolView {
    const { input } = stored;
    const name = stored.nameOverride ?? input.slug;
    return {
      slug: input.slug,
      id: composioToolId(input.slug),
      name,
      displayName: input.name && input.name.length > 0 ? input.name : input.slug,
      description: stored.descriptionOverride ?? input.description ?? '',
      inputSchemaJson: JSON.stringify(input.inputParameters ?? { type: 'object', properties: {} }),
      outputSchemaJson: JSON.stringify(input.outputParameters ?? { type: 'object' }),
      version: input.version && input.version.length > 0 ? input.version : 'current',
      enabled,
      readOnly: readOnlyFromTags(input.tags),
    };
  }

  private rebuildAliases(): void {
    this.aliases = new Map();
    for (const [slug, stored] of this.tools) {
      this.aliases.set(slug, slug);
      this.aliases.set(slug.toUpperCase(), slug);
      this.aliases.set(composioToolId(slug), slug);
      this.aliases.set(`${COMPOSIO_TOOL_NAMESPACE}:${slug}`.toUpperCase(), slug);
      if (stored.nameOverride) {
        this.aliases.set(stored.nameOverride, slug);
        this.aliases.set(stored.nameOverride.toUpperCase(), slug);
      }
    }
  }
}

export interface FinalizeEntry {
  id?: string;
  paramsJson?: string;
  nameOverride?: string;
  descriptionOverride?: string;
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
