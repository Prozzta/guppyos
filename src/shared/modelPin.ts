/**
 * MODEL-PINBACK: which model an agent runs, and how an in-TUI model switch survives a respawn.
 *
 * THE AUTHORITY. The app's model picker is the authority: the renderer bakes its choice into the
 * spawn command as `--model <picked>` (the REQUESTED model), and a CLI flag beats any `model =` in
 * a config file. A user can still switch model inside the TUI (`/model`). That switch lives only in
 * the running process, so a respawn (restart, rotation, resume) went back to the picked model.
 *
 * THE PIN. Main observes the LIVE model (Claude: the status line; Codex: the rollout's
 * `turn_context.payload.model`; Antigravity: the statusline's `model.id`). When the live model
 * CHANGES away from what this process was launched with, the user switched: the new model is
 * pinned on the agent's registry entry together with the requested model it replaced
 * (`modelPinnedFrom`). The next spawn uses the pin ONLY while the renderer still requests that same
 * model; a different request means the picker was used since, so the picker wins and the pin is
 * dropped. A live switch back to the requested model clears the pin.
 *
 * WHAT IS NEVER A SWITCH:
 *   - the first observation when the launch model is unknown (no `--model`: the CLI's own
 *     default) - it only establishes the baseline;
 *   - an observation equal to the last live (or launch) model, e.g. a thread's first turn_context;
 *   - an observation stamped before this process was launched (a stale rollout line from the
 *     previous process of a resumed thread).
 *
 * USER OR AUTO. A CLI can also change model ON ITS OWN (a plan-limit Opus->Sonnet fallback, or
 * a Codex/AGY equivalent) and report it as the live model; the observation itself cannot tell
 * that from a user's `/model`. So every pin carries a SOURCE, decided by the only evidence main
 * has: whether HUMAN input (renderer-originated terminal input, `shared/inputOrigin.ts`; app
 * writes are PROGRAMMATIC or CONTROL and never count) reached this agent's pty since the
 * previous live-model observation (or since launch). Yes = 'user', no = 'auto'.
 *   - A 'user' pin is kept across a respawn (while the picker is unchanged).
 *   - An 'auto' pin is shown and logged but NOT kept: the respawn runs the picker model and logs
 *     the auto pin as dropped.
 * The signal is necessary, not sufficient: a fallback that happens in a turn the human just
 * typed a prompt for is classified 'user'. A pin from before this rule has no source and is
 * kept as it always was. A purely provider-side reroute that the CLI does not report is
 * invisible and pins nothing.
 */

export type ModelPinSource = 'user' | 'auto';

export interface ModelPinFields {
  /** The pinned live model (a user's in-TUI switch), if any. */
  model?: string;
  /** The requested (picker) model in force when the pin was recorded; absent = none requested. */
  modelPinnedFrom?: string;
  /** The renderer's `--model` at the last spawn; absent = none. */
  requestedModel?: string;
  /** The `--model` this process was actually launched with; absent = the CLI's own default. */
  launchModel?: string;
  /** The last live model observed from this process. */
  liveModel?: string;
  /** When this process was launched (ms). Absent = spawned before MODEL-PINBACK. */
  launchedAt?: number;
  /** Who made the pin: 'user' (human input preceded it) or 'auto' (none did). Absent = a pin
   *  from before this rule, kept as before. */
  modelPinSource?: ModelPinSource;
}

const norm = (m: string | undefined | null): string => (m ?? '').trim().toLowerCase();

/** Two model ids name the same model (whitespace/case only). `[1m]` stays significant. */
export function sameModel(a: string | undefined | null, b: string | undefined | null): boolean {
  return norm(a) === norm(b);
}

/** The value of `--model` in an argv (`--model X` or `--model=X`), if present. */
export function modelFlagValue(args: readonly string[], flag = '--model'): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) {
      const v = args[i + 1];
      return typeof v === 'string' && v.trim() ? v : undefined;
    }
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1) || undefined;
  }
  return undefined;
}

/** The argv with its `--model` value replaced by `model` (appended when absent). */
export function withModelFlag(args: readonly string[], model: string, flag = '--model'): string[] {
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === flag && i + 1 < out.length) { out[i + 1] = model; return out; }
    if (out[i].startsWith(`${flag}=`)) { out[i] = `${flag}=${model}`; return out; }
  }
  out.push(flag, model);
  return out;
}

/**
 * The model a spawn should run. `requested` is the renderer's `--model` (undefined = none). The pin
 * is used only while the request is the one it was pinned against; otherwise the request wins and
 * the pin is stale (`dropPin`).
 */
export function resolveSpawnModel(
  entry: ModelPinFields | undefined,
  requested: string | undefined
): { model: string | undefined; pinApplied: boolean; dropPin: boolean; dropReason?: 'auto-not-kept' | 'picker-changed' } {
  const req = requested?.trim() || undefined;
  const pin = entry?.model?.trim() || undefined;
  if (!pin) return { model: req, pinApplied: false, dropPin: false };
  // An automatic switch is never carried into a new process: the picker model runs again.
  if (entry?.modelPinSource === 'auto') return { model: req, pinApplied: false, dropPin: true, dropReason: 'auto-not-kept' };
  if (sameModel(entry?.modelPinnedFrom, req)) return { model: pin, pinApplied: true, dropPin: false };
  return { model: req, pinApplied: false, dropPin: true, dropReason: 'picker-changed' };
}

export type LiveModelAction = 'stale' | 'unknown-launch' | 'baseline' | 'unchanged' | 'pin' | 'unpin';

/**
 * Apply one live-model observation to an entry, IN PLACE. Returns what happened and whether the
 * entry changed (so the caller persists only on a change).
 *
 * `fallbackBaseline` is the model the agent runs when nothing is requested (Claude: the app
 * default). It is also what makes a pre-MODEL-PINBACK Claude entry (no launch record) keep the old
 * behaviour: pin a divergence from the default, clear the pin on a return to it.
 */
export function applyLiveModel(
  entry: ModelPinFields,
  liveRaw: string,
  opts: { observedAt?: number; fallbackBaseline?: string; humanInputSince?: boolean } = {}
): { action: LiveModelAction; changed: boolean } {
  const source: ModelPinSource = opts.humanInputSince === true ? 'user' : 'auto';
  const live = liveRaw.trim();
  if (!live) return { action: 'unchanged', changed: false };
  const baseline = entry.requestedModel ?? opts.fallbackBaseline;
  const setPin = (): { action: LiveModelAction; changed: boolean } => {
    if (baseline !== undefined && sameModel(live, baseline)) {
      if (entry.model === undefined && entry.modelPinnedFrom === undefined) return { action: 'unpin', changed: false };
      delete entry.model;
      delete entry.modelPinnedFrom;
      delete entry.modelPinSource;
      return { action: 'unpin', changed: true };
    }
    if (sameModel(entry.model, live) && sameModel(entry.modelPinnedFrom, entry.requestedModel)) {
      return { action: 'pin', changed: false };
    }
    entry.model = live;
    entry.modelPinSource = source;
    if (entry.requestedModel !== undefined) entry.modelPinnedFrom = entry.requestedModel;
    else delete entry.modelPinnedFrom;
    return { action: 'pin', changed: true };
  };

  if (entry.launchedAt === undefined) {
    // Spawned before this version: only Claude had a pin, against its app default.
    if (opts.fallbackBaseline === undefined) return { action: 'unknown-launch', changed: false };
    return setPin();
  }
  // A line written before this process started belongs to a previous process (a resumed
  // thread's rollout still ends with the old turns). Codex stamps whole seconds, so compare
  // against the launch second.
  if (opts.observedAt !== undefined && opts.observedAt < Math.floor(entry.launchedAt / 1000) * 1000) {
    return { action: 'stale', changed: false };
  }
  const previous = entry.liveModel ?? entry.launchModel;
  if (previous === undefined) {
    // Launched on the CLI's own default: the first observation is that default, not a switch.
    entry.liveModel = live;
    return { action: 'baseline', changed: true };
  }
  if (sameModel(previous, live)) return { action: 'unchanged', changed: false };
  entry.liveModel = live;
  setPin();
  return { action: sameModel(live, baseline) ? 'unpin' : 'pin', changed: true };
}

/** G3 panel text for an agent's model: a small marker and a plain tooltip. The marker is only
 *  present while a pin is in force, and says which kind. */
export function modelPinLabel(entry: ModelPinFields | undefined, picked?: string): { model?: string; marker: '' | 'pinned' | 'auto'; tooltip: string } {
  const model = effectiveModel(entry);
  if (!model) return { marker: '', tooltip: '' };
  const over = picked && entry?.model && !sameModel(picked, entry.model) ? ` over the picked ${picked}` : '';
  if (entry?.model && entry.modelPinSource === 'auto') {
    return { model, marker: 'auto', tooltip: `Runs ${entry.model}. Auto: the CLI switched model on its own (e.g. a usage-limit fallback)${over}; not kept after a restart.` };
  }
  if (entry?.model) {
    return { model, marker: 'pinned', tooltip: `Runs ${entry.model}. Pinned: switched by you in the terminal${over}; kept after a restart. Change the model picker to override.` };
  }
  return { model, marker: '', tooltip: `Runs ${model}.` };
}

/** The model an agent is running as far as main knows: live, else launched, else pinned. */
export function effectiveModel(entry: ModelPinFields | undefined): string | undefined {
  return entry?.liveModel ?? entry?.launchModel ?? entry?.model;
}

/**
 * A spawn's argv with the model it really runs: the renderer's `--model` (the request), replaced
 * by a pin that still applies, or `fallback` when neither exists (Claude: the app default).
 * Returns the request and the launch model for the registry record.
 */
export function resolveSpawnArgs(
  entry: ModelPinFields | undefined,
  args: readonly string[],
  opts: { flag?: string; fallback?: string } = {}
): { args: string[]; requested?: string; launch?: string } {
  const flag = opts.flag ?? '--model';
  const requested = modelFlagValue(args, flag)?.trim() || undefined;
  const launch = resolveSpawnModel(entry, requested).model ?? (opts.fallback?.trim() || undefined);
  const out = launch && !sameModel(launch, requested) ? withModelFlag(args, launch, flag) : [...args];
  return { args: out, requested, launch };
}
