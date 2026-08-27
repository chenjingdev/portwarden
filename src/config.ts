import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Conf from 'conf';
import {z} from 'zod';

import {isSnapshotPersistable, parseCommandSnapshot, sanitizeText} from './core/commands.js';

const graveyardRecordSchema = z.object({
  id: z.string().min(1),
  listenerKey: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  host: z.string(),
  project: z.string(),
  cwd: z.string(),
  argv: z.array(z.string().min(1)).min(1),
  env: z.record(z.string(), z.string()),
  capturedAt: z.string().min(1),
});

const configSchema = z.object({
  browser: z.string().default(''),
  confirmActions: z.boolean().default(false),
  pinnedListenerKeys: z.array(z.string()).default([]),
  orderedEntryKeys: z.array(z.string()).default([]),
  graveyard: z.array(graveyardRecordSchema).default([]),
  refreshSeconds: z.number().min(0.5).max(60).default(2),
});

export type GraveyardRecord = z.infer<typeof graveyardRecordSchema>;
export type PortwardenConfig = z.infer<typeof configSchema>;

const DEFAULT_CONFIG: PortwardenConfig = {
  browser: '',
  confirmActions: false,
  pinnedListenerKeys: [],
  orderedEntryKeys: [],
  graveyard: [],
  refreshSeconds: 2,
};

export interface ConfigPathOptions {
  configDirectory?: string;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  xdgConfigHome?: string;
}

export class ConfigRepository {
  readonly path: string;
  private readonly store: Conf<PortwardenConfig>;

  private constructor(store: Conf<PortwardenConfig>) {
    this.store = store;
    this.path = store.path;
  }

  static open(options: ConfigPathOptions = {}): ConfigRepository {
    const paths = resolveConfigPaths(options);
    const sourcePath = fs.existsSync(paths.current) ? paths.current : fs.existsSync(paths.legacy) ? paths.legacy : '';
    const source = sourcePath ? readJson(sourcePath) : null;
    const normalized = normalizeConfig(source);

    const store = new Conf<PortwardenConfig>({
      cwd: path.dirname(paths.current),
      configName: 'config',
      defaults: DEFAULT_CONFIG,
      clearInvalidConfig: false,
      configFileMode: 0o600,
      accessPropertiesByDotNotation: false,
      schema: {
        browser: {type: 'string'},
        confirmActions: {type: 'boolean'},
        pinnedListenerKeys: {type: 'array', items: {type: 'string'}},
        orderedEntryKeys: {type: 'array', items: {type: 'string'}},
        graveyard: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'listenerKey', 'port', 'host', 'project', 'cwd', 'argv', 'env', 'capturedAt'],
            properties: {
              id: {type: 'string'},
              listenerKey: {type: 'string'},
              port: {type: 'number', minimum: 1, maximum: 65_535},
              host: {type: 'string'},
              project: {type: 'string'},
              cwd: {type: 'string'},
              argv: {type: 'array', items: {type: 'string'}},
              env: {type: 'object', additionalProperties: {type: 'string'}},
              capturedAt: {type: 'string'},
            },
          },
        },
        refreshSeconds: {type: 'number', minimum: 0.5, maximum: 60},
      },
    });

    if (source !== null || sourcePath === paths.legacy) {
      store.store = normalized;
    }

    return new ConfigRepository(store);
  }

  get(): PortwardenConfig {
    return structuredClone(this.store.store);
  }

  save(config: PortwardenConfig): PortwardenConfig {
    const normalized = normalizeConfig(config);
    this.store.store = normalized;
    return structuredClone(normalized);
  }

  update(patch: Partial<PortwardenConfig>): PortwardenConfig {
    return this.save({...this.get(), ...patch});
  }
}

export function resolveConfigPaths(options: ConfigPathOptions = {}): {current: string; legacy: string} {
  if (options.configDirectory) {
    return {
      current: path.join(options.configDirectory, 'config.json'),
      legacy: path.join(options.configDirectory, 'legacy-config.json'),
    };
  }

  const home = options.homeDirectory ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const xdg = options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME;
  if (xdg) {
    return {
      current: path.join(xdg, 'portwarden', 'config.json'),
      legacy: path.join(xdg, 'dev-port-watch', 'config.json'),
    };
  }
  if (platform === 'darwin') {
    return {
      current: path.join(home, 'Library', 'Application Support', 'portwarden', 'config.json'),
      legacy: path.join(home, 'Library', 'Application Support', 'dev-port-watch', 'config.json'),
    };
  }
  return {
    current: path.join(home, '.config', 'portwarden', 'config.json'),
    legacy: path.join(home, '.config', 'dev-port-watch', 'config.json'),
  };
}

export function normalizeConfig(input: unknown): PortwardenConfig {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const migratedGraveyard = Array.isArray(raw.graveyard) ? raw.graveyard : migrateLegacyGraveyard(raw.revivablePins);
  const parsed = configSchema.safeParse({...raw, graveyard: migratedGraveyard});
  if (!parsed.success) {
    throw new Error(`Invalid Portwarden config: ${z.prettifyError(parsed.error)}`);
  }

  return {
    ...parsed.data,
    browser: sanitizeText(parsed.data.browser),
    pinnedListenerKeys: uniqueStrings(parsed.data.pinnedListenerKeys),
    orderedEntryKeys: uniqueStrings(parsed.data.orderedEntryKeys).filter((key) => !key.startsWith('group:')),
    graveyard: parsed.data.graveyard.slice(0, 100),
  };
}

function migrateLegacyGraveyard(input: unknown): GraveyardRecord[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return [];
  }

  const records: GraveyardRecord[] = [];
  for (const [listenerKey, value] of Object.entries(input)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    const legacy = value as Record<string, unknown>;
    const snapshot = parseCommandSnapshot(String(legacy.cmd ?? ''));
    const capturedAt = String(legacy.capturedAt ?? '');
    const port = Number(/::port:(\d+)/.exec(listenerKey)?.[1] ?? 0);
    if (!snapshot || !isSnapshotPersistable(snapshot) || !capturedAt || port < 1 || port > 65_535) {
      continue;
    }
    const cwd = String(legacy.cwd ?? '');
    records.push({
      id: `${listenerKey}:${capturedAt}`,
      listenerKey,
      port,
      host: /host:(.*?)::port:/.exec(listenerKey)?.[1] ?? '',
      project: sanitizeText(path.basename(cwd)) || 'unknown',
      cwd,
      argv: snapshot.argv,
      env: snapshot.env,
      capturedAt,
    });
  }
  return records.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => sanitizeText(value)).filter(Boolean))];
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read config ${filePath}: ${message}`);
  }
}
